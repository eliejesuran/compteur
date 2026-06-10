const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');
const os = require('os');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- State ---
let state = {
  count: 0,
  totalIn: 0,
  totalOut: 0,
  capacity: 100,
  adminCode: 'admin123',
  history: [], // [{t: timestamp_ms, c: count}]
};
const seenOps = new Set(); // UUID dedup — prevents double-count on retries
const wsClients = new Map(); // ws → {name: null|string, connectedAt: number}

// --- Helpers ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastClients() {
  // Déduplique par nom au cas où un opérateur aurait plusieurs onglets ouverts
  const names = [...new Set(
    [...wsClients.values()].filter(c => c.name).map(c => c.name)
  )];
  broadcast({ type: 'clients', names });
}

function logClients(action, name) {
  const active = [...wsClients.values()].filter(c => c.name).length;
  const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${t}] ${name} ${action} — ${active} opérateur(s) connecté(s)`);
}

function getLocalIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

function trimSeenOps() {
  if (seenOps.size > 20000) {
    const arr = [...seenOps];
    seenOps.clear();
    arr.slice(-10000).forEach(id => seenOps.add(id));
  }
}

// --- API ---

// Apply a delta operation (core endpoint — must be fast and idempotent)
app.post('/api/count', (req, res) => {
  const { delta, uuid } = req.body ?? {};

  if (typeof uuid !== 'string' || !uuid) return res.status(400).json({ error: 'uuid required' });
  if (![-5, -1, 1, 5].includes(delta)) return res.status(400).json({ error: 'invalid delta' });

  // Idempotency: ignore already-seen operations (network retries, offline replay)
  if (seenOps.has(uuid)) return res.json({ count: state.count, dup: true });

  seenOps.add(uuid);
  trimSeenOps();

  state.count = Math.max(0, state.count + delta);
  if (delta > 0) state.totalIn += delta;
  else state.totalOut += Math.abs(delta);

  const alert = state.count >= state.capacity;
  broadcast({ type: 'update', count: state.count, delta, alert, capacity: state.capacity });
  res.json({ count: state.count, alert });
});

// Current state — used by new clients on first load
app.get('/api/state', (_req, res) => {
  res.json({ count: state.count, capacity: state.capacity });
});

// History + stats — admin only
app.get('/api/history', (req, res) => {
  if (req.query.code !== state.adminCode) return res.status(403).json({ error: 'forbidden' });
  res.json({
    history: state.history,
    count: state.count,
    capacity: state.capacity,
    totalIn: state.totalIn,
    totalOut: state.totalOut,
  });
});

// Admin: update config (capacity, code, reset)
app.post('/api/admin/config', (req, res) => {
  const { code, capacity, newCode, reset } = req.body ?? {};
  if (code !== state.adminCode) return res.status(403).json({ error: 'forbidden' });

  if (Number.isFinite(capacity) && capacity > 0) state.capacity = Math.round(capacity);
  if (typeof newCode === 'string' && newCode.length >= 4) state.adminCode = newCode;
  if (reset === true) {
    state.count = 0;
    state.totalIn = 0;
    state.totalOut = 0;
    state.history = [];
    seenOps.clear();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  }

  broadcast({ type: 'config', capacity: state.capacity, count: state.count });
  res.json({ ok: true, capacity: state.capacity });
});

// Admin: generate QR code for the counter page
app.get('/api/qr', async (req, res) => {
  if (req.query.code !== state.adminCode) return res.status(403).json({ error: 'forbidden' });
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const url = `${proto}://${host}/`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qr, url });
});

// Admin: connected operator list (live, WS-tracked)
app.get('/api/clients', (req, res) => {
  if (req.query.code !== state.adminCode) return res.status(403).json({ error: 'forbidden' });
  const clients = [...wsClients.values()]
    .filter(c => c.name)
    .map(c => ({ name: c.name, connectedAt: c.connectedAt }));
  res.json({ clients });
});

// Admin: list local IPs (useful for local deployments)
app.get('/api/ips', (req, res) => {
  if (req.query.code !== state.adminCode) return res.status(403).json({ error: 'forbidden' });
  res.json({ ips: getLocalIPs(), port: PORT });
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  wsClients.set(ws, { name: null, connectedAt: Date.now() });
  ws.send(JSON.stringify({ type: 'init', count: state.count, capacity: state.capacity }));

  // Envoyer la liste courante immédiatement (utile pour la page admin qui vient de s'ouvrir)
  const currentNames = [...new Set(
    [...wsClients.values()].filter(c => c.name).map(c => c.name)
  )];
  if (currentNames.length > 0) {
    ws.send(JSON.stringify({ type: 'clients', names: currentNames }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'hello' && typeof msg.name === 'string') {
        const name = msg.name.trim().slice(0, 32);
        if (!name) return;
        wsClients.get(ws).name = name;
        logClients('connecté(e)', name);
        broadcastClients();
      }
    } catch {}
  });

  ws.on('close', () => {
    const client = wsClients.get(ws);
    wsClients.delete(ws);
    if (client?.name) {
      logClients('déconnecté(e)', client.name);
      broadcastClients();
    }
  });

  ws.on('error', () => {});
});

// --- Start ---
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  // Restore persisted state on startup
  if (fs.existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.assign(state, saved);
      console.log(`État restauré : ${state.count} personnes (capacité : ${state.capacity})`);
    } catch (e) {
      console.warn('Impossible de lire state.json, état réinitialisé.');
    }
  }

  // Persist state to disk every 30s (crash recovery)
  setInterval(() => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  }, 30000);

  // Record one history point every 30s
  setInterval(() => {
    state.history.push({ t: Date.now(), c: state.count });
    if (state.history.length > 2880) state.history.shift();
  }, 30000);

  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║      COMPTEUR ÉVÉNEMENT  v1.0        ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Local   : http://localhost:${PORT}       ║`);
    ips.forEach(ip => console.log(`║  Réseau  : http://${ip}:${PORT}  ║`));
    console.log(`║                                      ║`);
    console.log(`║  Code admin : ${state.adminCode.padEnd(22)}║`);
    console.log(`║  Admin   : http://localhost:${PORT}/admin ║`);
    console.log('╚══════════════════════════════════════╝\n');
  });
}

module.exports = { app, server, state, seenOps, trimSeenOps, wsClients };
