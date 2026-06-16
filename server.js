const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, 'state.json');

// R4/L1/L2 : plafonds anti-saturation (DoS doux) — alignés sur le Worker CF
const MAX_EVENTS = 50;   // événements au total (archivés inclus)
const MAX_GROUPS = 20;   // groupes par événement
const MAX_OPS    = 100;  // opérateurs distincts (opStats) par groupe
const MAX_HISTORY = 2880; // points d'historique max (24h @ 30s) — aligné local/cloud

// S3 : rate-limit local (token bucket par IP) — mêmes valeurs que le Worker CF (L3)
const RL_CAPACITY = 300; // burst max d'une salve
const RL_RATE     = 20;  // tokens/s rechargés (débit soutenu)

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
const eventSeenOps       = new Map(); // eventId → Set<uuid>
const wsClients          = new Map(); // ws → {name, connectedAt, eventId, groupId}
const recentlyDisconnected = new Map(); // U4: `${eventId}:${name}` → {name,groupId,eventId,disconnectedAt}
const rlBuckets          = new Map(); // S3: ip → {tokens, lastMs} (token bucket)

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

// Point d'historique : total + détail du count par groupe (g[groupId])
function historyPoint(evt) {
  const g = {};
  for (const grp of Object.values(evt.groups)) g[grp.id] = grp.count;
  return { t: Date.now(), c: eventTotal(evt), g };
}

// Échantillonne l'historique de tous les events actifs (appelé toutes les 30 s)
function recordHistory() {
  for (const evt of Object.values(state.events)) {
    if (evt.archived) continue;
    evt.history.push(historyPoint(evt));
    if (evt.history.length > MAX_HISTORY) evt.history.shift();
  }
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

// S3: token bucket par IP — miroir local de _rl_check (event.js). false si rate limited.
function rlCheck(ip) {
  const now = Date.now();
  // purge des IPs inactives depuis >1h quand la Map dépasse 500 entrées
  if (rlBuckets.size > 500) {
    for (const [k, v] of rlBuckets) {
      if (now - v.lastMs > 3_600_000) rlBuckets.delete(k);
    }
  }
  let b = rlBuckets.get(ip);
  if (!b) { b = { tokens: RL_CAPACITY, lastMs: now }; rlBuckets.set(ip, b); }
  const elapsed = (now - b.lastMs) / 1000;
  b.tokens = Math.min(RL_CAPACITY, b.tokens + elapsed * RL_RATE);
  b.lastMs = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// --- Persistence ---

function buildSnapshot() {
  return {
    ...state,
    seenOps: Object.fromEntries(
      [...eventSeenOps.entries()].map(([id, s]) => [id, [...s].slice(-5000)])
    ),
  };
}

function applySnapshot(data) {
  if (!data || !data.events) return;
  const { seenOps: savedSeenOps, ...rest } = data;
  Object.assign(state, rest);
  if (savedSeenOps && typeof savedSeenOps === 'object') {
    for (const [id, arr] of Object.entries(savedSeenOps)) {
      if (Array.isArray(arr)) eventSeenOps.set(id, new Set(arr));
    }
  }
}

let _saveTimer = null;

function flushSave() {
  _saveTimer = null;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(buildSnapshot()), 'utf8'); } catch (e) { console.error('[save]', e.message); }
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, 500);
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
  const now = Date.now();
  const seen = new Set();
  const clients = [];

  // U4: purge entries > 30s
  for (const [key, v] of recentlyDisconnected) {
    if (now - v.disconnectedAt > 30_000) recentlyDisconnected.delete(key);
  }

  for (const c of wsClients.values()) {
    if (c.eventId !== eventId || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    clients.push({ name: c.name, groupName: c.groupId ? evt?.groups[c.groupId]?.name ?? null : null });
  }

  // U4: recently disconnected (grace period 30s)
  for (const v of recentlyDisconnected.values()) {
    if (v.eventId !== eventId || seen.has(v.name)) continue;
    seen.add(v.name);
    clients.push({ name: v.name, groupName: v.groupId ? evt?.groups[v.groupId]?.name ?? null : null });
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
  // S3: rate-limit par IP (token bucket) AVANT tout traitement
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rlCheck(ip)) return res.status(429).set('Retry-After', '1').json({ error: 'rate limited' });

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
    // R4/L2 : un nouveau nom au-delà de MAX_OPS n'est plus tracké (opStats),
    // mais le comptage total/groupe reste intact — jamais de perte de compte.
    if (n && (grp.opStats[n] || Object.keys(grp.opStats).length < MAX_OPS)) {
      if (!grp.opStats[n]) grp.opStats[n] = { in: 0, out: 0 };
      if (delta > 0) grp.opStats[n].in += delta;
      else grp.opStats[n].out += Math.abs(delta);
    }
  }

  const total = eventTotal(evt);
  broadcastEvent(e, delta);
  scheduleSave();
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
  // R4/L1 : plafond du nombre d'événements
  if (Object.keys(state.events).length >= MAX_EVENTS) {
    return res.status(409).json({ error: `Limite atteinte : ${MAX_EVENTS} événements maximum. Supprimez-en avant d'en créer un nouveau.` });
  }
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
  // R4/L1 : plafond du nombre de groupes par événement
  if (Object.keys(evt.groups).length >= MAX_GROUPS) {
    return res.status(409).json({ error: `Limite atteinte : ${MAX_GROUPS} groupes maximum par événement.` });
  }
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
      // B5: ferme les WS clients connectés à cet event
      for (const [ws, c] of wsClients) {
        if (c.eventId === e && ws.readyState < 2) ws.close(4004, 'Event deleted');
      }
      scheduleSave();
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
        flushSave();
      }
      broadcastEvent(e, 0);
    }
  }

  scheduleSave(); // B6: persiste les changements de config (capacity, name, code, perm…)
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
  const now = Date.now();
  const seen = new Set();
  const clients = [];
  for (const c of wsClients.values()) {
    if (c.eventId !== req.query.e || !c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    clients.push({ name: c.name, groupName: c.groupId ? evt.groups[c.groupId]?.name ?? null : null, connectedAt: c.connectedAt });
  }
  // U4: recently disconnected (grace period 30s)
  for (const v of recentlyDisconnected.values()) {
    if (v.eventId !== req.query.e || seen.has(v.name) || now - v.disconnectedAt > 30_000) continue;
    seen.add(v.name);
    clients.push({ name: v.name, groupName: v.groupId ? evt.groups[v.groupId]?.name ?? null : null, connectedAt: null });
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
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
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
      // U4: grâce déco — garde l'op dans la liste pendant 30s
      const key = `${client.eventId}:${client.name}`;
      const disconnectedAt = Date.now();
      recentlyDisconnected.set(key, {
        name: client.name, groupId: client.groupId, eventId: client.eventId, disconnectedAt,
      });
      broadcastClientsForEvent(client.eventId);
      setTimeout(() => {
        const entry = recentlyDisconnected.get(key);
        if (entry && entry.disconnectedAt === disconnectedAt) {
          recentlyDisconnected.delete(key);
          broadcastClientsForEvent(client.eventId);
        }
      }, 30_000);
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
        applySnapshot(saved);
        console.log(`État restauré : ${Object.keys(state.events).length} événement(s)`);
      } else {
        console.log('Ancien format ignoré — état réinitialisé.');
      }
    } catch {
      console.warn('Impossible de lire state.json.');
    }
  }

  for (const id of Object.keys(state.events)) ensureSeenOps(id);

  // Sauvegarde de secours toutes les 30s (scheduleSave après chaque count couvre le cas normal)
  setInterval(flushSave, 30000);

  // Record history (total + détail par groupe) every 30s
  setInterval(recordHistory, 30000);

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

module.exports = { app, server, state, eventSeenOps, trimSeenOps, wsClients, recentlyDisconnected, rlBuckets, checkAdmin, checkAuth, buildSnapshot, applySnapshot, recordHistory };
