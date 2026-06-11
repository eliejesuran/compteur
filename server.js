const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, 'state.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- State ---
// events: {[eventId]: {id, name, capacity, history, createdAt, archived, groups: {[groupId]: Group}}}
// Group: {id, name, count, totalIn, totalOut, opStats: {[name]: {in, out}}}
let state = {
  adminCode: 'admin123',
  permCode:  null,   // U16: null = PERM désactivé
  events: {},
};

// --- Auth helpers ---

function checkAdmin(code) { return code === state.adminCode; }

function checkAuth(code) {
  if (code === state.adminCode) return 'admin';
  if (state.permCode && code === state.permCode) return 'perm';
  return null;
}

// Runtime-only (not persisted)
const eventSeenOps = new Map(); // eventId → Set<uuid>
const wsClients = new Map();    // ws → {name, connectedAt, eventId, groupId}

// --- Helpers ---

function makeGroup(id, name) {
  return { id, name, count: 0, totalIn: 0, totalOut: 0, opStats: {} };
}

function makeEvent(id, name) {
  const gId = crypto.randomBytes(3).toString('hex');
  return {
    id, name,
    capacity: 100,
    history: [],
    createdAt: Date.now(),
    archived: false,
    groups: { [gId]: makeGroup(gId, 'Principal') },
  };
}

function eventTotal(evt) {
  return Object.values(evt.groups).reduce((sum, g) => sum + g.count, 0);
}

function groupSummary(evt) {
  return Object.values(evt.groups).map(g => ({ id: g.id, name: g.name, count: g.count }));
}

function ensureSeenOps(id) {
  if (!eventSeenOps.has(id)) eventSeenOps.set(id, new Set());
  return eventSeenOps.get(id);
}

function trimSeenOps(set) {
  if (set.size > 20000) {
    const arr = [...set];
    set.clear();
    arr.slice(-10000).forEach(id => set.add(id));
  }
}

function getLocalIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

// --- Broadcast ---

function broadcastEvent(eventId, delta) {
  const evt = state.events[eventId];
  if (!evt) return;
  const total = eventTotal(evt);
  const msg = JSON.stringify({
    type: 'update',
    total,
    delta,
    alert: total >= evt.capacity,
    capacity: evt.capacity,
    groups: groupSummary(evt),
  });
  for (const [ws, c] of wsClients) {
    if (c.eventId === eventId && ws.readyState === 1) ws.send(msg);
  }
}

function broadcastClientsForEvent(eventId) {
  const evt = state.events[eventId];
  const seen = new Set();
  const clients = [];
  for (const c of wsClients.values()) {
    if (c.eventId !== eventId || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    clients.push({ name: c.name, groupName: c.groupId ? evt?.groups[c.groupId]?.name ?? null : null });
  }
  const msg = JSON.stringify({ type: 'clients', clients });
  for (const [ws, c] of wsClients) {
    if (c.eventId === eventId && ws.readyState === 1) ws.send(msg);
  }
}

function logClients(action, name, eventId, groupId) {
  const active = [...wsClients.values()].filter(c => c.eventId === eventId && c.name).length;
  const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const grpTag = groupId ? `/${groupId}` : '';
  console.log(`[${t}][${eventId}${grpTag}] ${name} ${action} — ${active} opérateur(s)`);
}

// --- API ---

// Core counting — scoped to a group within an event
app.post('/api/count', (req, res) => {
  const { delta, uuid, name, e, g } = req.body ?? {};
  if (typeof uuid !== 'string' || !uuid) return res.status(400).json({ error: 'uuid required' });
  if (![-5, -1, 1, 5].includes(delta)) return res.status(400).json({ error: 'invalid delta' });
  if (!e || !g) return res.status(400).json({ error: 'e and g required' });

  const evt = state.events[e];
  if (!evt || evt.archived) return res.status(404).json({ error: 'event not found' });
  const grp = evt.groups[g];
  if (!grp) return res.status(404).json({ error: 'group not found' });

  const seenOps = ensureSeenOps(e);
  if (seenOps.has(uuid)) return res.json({ total: eventTotal(evt), dup: true });

  seenOps.add(uuid);
  trimSeenOps(seenOps);

  grp.count = Math.max(0, grp.count + delta);
  if (delta > 0) grp.totalIn += delta;
  else grp.totalOut += Math.abs(delta);

  if (typeof name === 'string') {
    const n = name.trim().slice(0, 32);
    if (n) {
      if (!grp.opStats[n]) grp.opStats[n] = { in: 0, out: 0 };
      if (delta > 0) grp.opStats[n].in += delta;
      else grp.opStats[n].out += Math.abs(delta);
    }
  }

  const total = eventTotal(evt);
  broadcastEvent(e, delta);
  res.json({ total, alert: total >= evt.capacity });
});

// Initial state for an operator (total + their group count)
app.get('/api/state', (req, res) => {
  const { e, g } = req.query;
  if (!e || !g) return res.status(400).json({ error: 'e and g required' });
  const evt = state.events[e];
  if (!evt || evt.archived) return res.status(404).json({ error: 'event not found' });
  const grp = evt.groups[g];
  if (!grp) return res.status(404).json({ error: 'group not found' });
  res.json({
    total: eventTotal(evt),
    groupCount: grp.count,
    capacity: evt.capacity,
    eventName: evt.name,
    groupName: grp.name,
  });
});

// List events — admin or perm
app.get('/api/events', (req, res) => {
  const role = checkAuth(req.query.code);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  const events = Object.values(state.events)
    .filter(e => !e.archived)
    .map(e => ({
      id: e.id, name: e.name,
      total: eventTotal(e), capacity: e.capacity,
      createdAt: e.createdAt, groups: groupSummary(e),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ events, role });
});

// List archived events — admin only
app.get('/api/events/archived', (req, res) => {
  if (!checkAdmin(req.query.code)) return res.status(403).json({ error: 'forbidden' });
  const events = Object.values(state.events)
    .filter(e => e.archived)
    .map(e => ({
      id: e.id, name: e.name,
      total: eventTotal(e), capacity: e.capacity,
      createdAt: e.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ events });
});

// Create event — auto-creates one "Principal" group
app.post('/api/events', (req, res) => {
  if (!checkAdmin(req.body?.code)) return res.status(403).json({ error: 'forbidden' });
  const id = crypto.randomBytes(3).toString('hex');
  const name = (typeof req.body.name === 'string' ? req.body.name.trim() : '').slice(0, 40) || 'Nouvel événement';
  state.events[id] = makeEvent(id, name);
  ensureSeenOps(id);
  const evt = state.events[id];
  res.json({ id, name: evt.name, total: 0, capacity: evt.capacity, groups: groupSummary(evt) });
});

// Create group within an event
app.post('/api/groups', (req, res) => {
  const { code, e, name } = req.body ?? {};
  if (!checkAdmin(code)) return res.status(403).json({ error: 'forbidden' });
  const evt = state.events[e];
  if (!evt) return res.status(404).json({ error: 'event not found' });
  const id = crypto.randomBytes(3).toString('hex');
  const groupName = (typeof name === 'string' ? name.trim() : '').slice(0, 40) || 'Nouveau groupe';
  evt.groups[id] = makeGroup(id, groupName);
  broadcastEvent(e, 0); // Notify admin of new group
  res.json({ id, name: groupName });
});

// History + per-group stats — admin or perm
app.get('/api/history', (req, res) => {
  if (!checkAuth(req.query.code)) return res.status(403).json({ error: 'forbidden' });
  const evt = state.events[req.query.e];
  if (!evt) return res.status(404).json({ error: 'event not found' });
  const totalIn  = Object.values(evt.groups).reduce((s, g) => s + g.totalIn, 0);
  const totalOut = Object.values(evt.groups).reduce((s, g) => s + g.totalOut, 0);
  res.json({
    history: evt.history,
    total: eventTotal(evt),
    capacity: evt.capacity,
    totalIn, totalOut,
    groups: Object.values(evt.groups).map(g => ({
      id: g.id, name: g.name,
      count: g.count, totalIn: g.totalIn, totalOut: g.totalOut,
      opStats: g.opStats,
    })),
  });
});

// Admin: configure event or group
app.post('/api/admin/config', (req, res) => {
  const { code, e, g, capacity, newCode, newPermCode, reset, name, archived, deleteGroup, deleteEvent } = req.body ?? {};
  if (!checkAdmin(code)) return res.status(403).json({ error: 'forbidden' });

  if (typeof newCode === 'string' && newCode.length >= 4) state.adminCode = newCode;
  if (newPermCode !== undefined) {
    state.permCode = (typeof newPermCode === 'string' && newPermCode.length >= 4) ? newPermCode : null;
  }

  const evt = state.events[e];
  if (evt) {
    if (deleteEvent === true) {
      delete state.events[e];
      eventSeenOps.delete(e);
      return res.json({ ok: true });
    }
    if (g) {
      // Group-level
      const grp = evt.groups[g];
      if (grp) {
        if (typeof name === 'string' && name.trim()) grp.name = name.trim().slice(0, 40);
        if (deleteGroup === true) {
          if (Object.keys(evt.groups).length > 1) {
            delete evt.groups[g];
          } else {
            return res.json({ ok: false, error: 'cannot delete last group' });
          }
        }
        if (reset === true) {
          grp.count = 0; grp.totalIn = 0; grp.totalOut = 0; grp.opStats = {};
        }
      }
      broadcastEvent(e, 0);
    } else {
      // Event-level
      if (Number.isFinite(capacity) && capacity > 0) evt.capacity = Math.round(capacity);
      if (typeof name === 'string' && name.trim()) evt.name = name.trim().slice(0, 40);
      if (archived === true) evt.archived = true;
      if (archived === false) evt.archived = false;
      if (reset === true) {
        for (const grp of Object.values(evt.groups)) {
          grp.count = 0; grp.totalIn = 0; grp.totalOut = 0; grp.opStats = {};
        }
        evt.history = [];
        const ops = eventSeenOps.get(e);
        if (ops) ops.clear();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
      }
      broadcastEvent(e, 0);
    }
  }

  res.json({ ok: true });
});

// QR code for a specific group URL — admin or perm
app.get('/api/qr', async (req, res) => {
  if (!checkAuth(req.query.code)) return res.status(403).json({ error: 'forbidden' });
  const { e, g } = req.query;
  if (!e || !g) return res.status(400).json({ error: 'e and g required' });
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const url = `${proto}://${host}/?e=${e}&g=${g}`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qr, url });
});

// Connected operators for an event (with group names) — admin or perm
app.get('/api/clients', (req, res) => {
  if (!checkAuth(req.query.code)) return res.status(403).json({ error: 'forbidden' });
  const evt = state.events[req.query.e];
  if (!evt) return res.status(404).json({ error: 'event not found' });
  const seen = new Set();
  const clients = [];
  for (const c of wsClients.values()) {
    if (c.eventId !== req.query.e || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    clients.push({ name: c.name, groupName: c.groupId ? evt.groups[c.groupId]?.name ?? null : null, connectedAt: c.connectedAt });
  }
  res.json({ clients });
});

// Local IPs — admin or perm
app.get('/api/ips', (req, res) => {
  if (!checkAuth(req.query.code)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ips: getLocalIPs(), port: PORT });
});

// --- WebSocket ---

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const eventId = params.get('e');
  const groupId = params.get('g'); // null = admin connection (no group)

  if (!eventId) { ws.close(4004, 'Event required'); return; }
  const evt = state.events[eventId];
  if (!evt || evt.archived) { ws.close(4004, 'Event not found'); return; }
  if (groupId && !evt.groups[groupId]) { ws.close(4004, 'Group not found'); return; }

  wsClients.set(ws, { name: null, connectedAt: Date.now(), eventId, groupId });

  ws.send(JSON.stringify({
    type: 'init',
    total: eventTotal(evt),
    capacity: evt.capacity,
    eventName: evt.name,
    groups: groupSummary(evt),
  }));

  // Send current operator list to this new client
  const seen = new Set();
  const currentClients = [];
  for (const c of wsClients.values()) {
    if (c.eventId !== eventId || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    currentClients.push({ name: c.name, groupName: c.groupId ? evt.groups[c.groupId]?.name ?? null : null });
  }
  if (currentClients.length > 0) {
    ws.send(JSON.stringify({ type: 'clients', clients: currentClients }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello' && typeof msg.name === 'string') {
        const name = msg.name.trim().slice(0, 32);
        if (!name) return;
        const client = wsClients.get(ws);
        const prevName = client.name;
        client.name = name;
        if (!prevName || prevName !== name) {
          logClients(prevName ? `renommé(e) → ${name}` : 'connecté(e)', name, eventId, groupId);
        }
        broadcastClientsForEvent(eventId);
      }
    } catch {}
  });

  ws.on('close', () => {
    const client = wsClients.get(ws);
    wsClients.delete(ws);
    if (client?.name) {
      logClients('déconnecté(e)', client.name, client.eventId, client.groupId);
      broadcastClientsForEvent(client.eventId);
    }
  });

  ws.on('error', () => {});
});

// --- Start ---
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.events) {
        Object.assign(state, saved);
        console.log(`État restauré : ${Object.keys(state.events).length} événement(s)`);
      } else {
        console.log('Ancien format ignoré — état réinitialisé.');
      }
    } catch {
      console.warn('Impossible de lire state.json.');
    }
  }

  for (const id of Object.keys(state.events)) ensureSeenOps(id);

  // Persist every 30s
  setInterval(() => fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'), 30000);

  // Record history (total count per event) every 30s
  setInterval(() => {
    for (const evt of Object.values(state.events)) {
      if (evt.archived) continue;
      evt.history.push({ t: Date.now(), c: eventTotal(evt) });
      if (evt.history.length > 2880) evt.history.shift();
    }
  }, 30000);

  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║      COMPTEUR ÉVÉNEMENT  v3.0        ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Local   : http://localhost:${PORT}       ║`);
    ips.forEach(ip => console.log(`║  Réseau  : http://${ip}:${PORT}  ║`));
    console.log(`║                                      ║`);
    console.log(`║  Code admin : ${state.adminCode.padEnd(22)}║`);
    console.log(`║  Admin   : http://localhost:${PORT}/admin ║`);
    console.log('╚══════════════════════════════════════╝\n');
  });
}

module.exports = { app, server, state, eventSeenOps, trimSeenOps, wsClients, checkAdmin, checkAuth };
