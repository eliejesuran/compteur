import { DurableObject } from 'cloudflare:workers';

function makeGroup(id, name) {
  return { id, name, count: 0, totalIn: 0, totalOut: 0, opStats: {} };
}

function hexId() {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export class EventDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._s = null;      // state object
    this._seen = new Set(); // seenOps — not persisted, comme le server.js actuel
  }

  async _load() {
    if (this._s !== null) return;
    this._s = (await this.ctx.storage.get('state')) ?? null;
  }

  async _save() {
    await this.ctx.storage.put('state', this._s);
  }

  _total() {
    return Object.values(this._s.groups).reduce((s, g) => s + g.count, 0);
  }

  _groupSummary() {
    return Object.values(this._s.groups).map(g => ({ id: g.id, name: g.name, count: g.count }));
  }

  _broadcast(delta) {
    const total = this._total();
    const msg = JSON.stringify({
      type: 'update', total, delta,
      alert: total >= this._s.capacity,
      capacity: this._s.capacity,
      groups: this._groupSummary(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  _broadcastClients() {
    const seen = new Set();
    const clients = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() ?? {};
      if (!a.name || seen.has(a.name)) continue;
      seen.add(a.name);
      clients.push({
        name: a.name,
        groupName: a.groupId ? (this._s.groups[a.groupId]?.name ?? null) : null,
      });
    }
    const msg = JSON.stringify({ type: 'clients', clients });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  // ── WebSocket (hibernation API) ─────────────────────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this._handleWS(request);
    }

    await this._load();

    const url = new URL(request.url);
    const path = url.pathname;
    let body = null;
    if (request.method !== 'GET') {
      try { body = await request.json(); } catch { body = {}; }
    }

    // POST /init — crée l'état initial du DO
    if (path === '/init' && request.method === 'POST') {
      if (!this._s) {
        const groupId = hexId();
        this._s = {
          id:        body.id,
          name:      body.name,
          capacity:  body.capacity ?? 100,
          createdAt: Date.now(),
          archived:  false,
          groups:    { [groupId]: makeGroup(groupId, 'Principal') },
          history:   [],
        };
        await this._save();
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      return Response.json({
        id: this._s.id, name: this._s.name,
        capacity: this._s.capacity, total: this._total(),
        groups: this._groupSummary(),
      });
    }

    if (!this._s || this._s.archived) {
      return Response.json({ error: 'event not found' }, { status: 404 });
    }

    // POST /count
    if (path === '/count' && request.method === 'POST') {
      const { delta, uuid, name: opName, g } = body ?? {};
      if (!uuid || ![-5, -1, 1, 5].includes(delta) || !g) {
        return Response.json({ error: 'invalid' }, { status: 400 });
      }
      const grp = this._s.groups[g];
      if (!grp) return Response.json({ error: 'group not found' }, { status: 404 });

      if (this._seen.has(uuid)) return Response.json({ total: this._total(), dup: true });
      this._seen.add(uuid);
      if (this._seen.size > 20_000) {
        const arr = [...this._seen];
        this._seen = new Set(arr.slice(-10_000));
      }

      grp.count = Math.max(0, grp.count + delta);
      if (delta > 0) grp.totalIn  += delta;
      else           grp.totalOut += Math.abs(delta);

      if (typeof opName === 'string') {
        const n = opName.trim().slice(0, 32);
        if (n) {
          if (!grp.opStats[n]) grp.opStats[n] = { in: 0, out: 0 };
          if (delta > 0) grp.opStats[n].in  += delta;
          else           grp.opStats[n].out += Math.abs(delta);
        }
      }

      const total = this._total();
      this._broadcast(delta);
      this.ctx.waitUntil(this._save());
      return Response.json({ total, alert: total >= this._s.capacity });
    }

    // GET /state?g=X
    if (path === '/state' && request.method === 'GET') {
      const g = url.searchParams.get('g');
      const grp = this._s.groups[g];
      if (!grp) return Response.json({ error: 'group not found' }, { status: 404 });
      return Response.json({
        total:      this._total(),
        groupCount: grp.count,
        capacity:   this._s.capacity,
        eventName:  this._s.name,
        groupName:  grp.name,
      });
    }

    // GET /summary — pour la liste admin (total + groups)
    if (path === '/summary' && request.method === 'GET') {
      return Response.json({ total: this._total(), groups: this._groupSummary() });
    }

    // POST /groups
    if (path === '/groups' && request.method === 'POST') {
      const id   = hexId();
      const name = (typeof body?.name === 'string' ? body.name.trim() : '').slice(0, 40) || 'Nouveau groupe';
      this._s.groups[id] = makeGroup(id, name);
      await this._save();
      this._broadcast(0);
      return Response.json({ id, name });
    }

    // GET /history
    if (path === '/history' && request.method === 'GET') {
      const totalIn  = Object.values(this._s.groups).reduce((s, g) => s + g.totalIn,  0);
      const totalOut = Object.values(this._s.groups).reduce((s, g) => s + g.totalOut, 0);
      return Response.json({
        history:  this._s.history,
        total:    this._total(),
        capacity: this._s.capacity,
        totalIn, totalOut,
        groups: Object.values(this._s.groups).map(g => ({
          id: g.id, name: g.name, count: g.count,
          totalIn: g.totalIn, totalOut: g.totalOut, opStats: g.opStats,
        })),
      });
    }

    // POST /config
    if (path === '/config' && request.method === 'POST') {
      const { g, capacity, reset, name, archived, deleteGroup } = body ?? {};
      if (g) {
        const grp = this._s.groups[g];
        if (grp) {
          if (typeof name === 'string' && name.trim()) grp.name = name.trim().slice(0, 40);
          if (deleteGroup === true) {
            if (Object.keys(this._s.groups).length > 1) delete this._s.groups[g];
            else return Response.json({ ok: false, error: 'cannot delete last group' });
          }
          if (reset === true) { grp.count = 0; grp.totalIn = 0; grp.totalOut = 0; grp.opStats = {}; }
        }
      } else {
        if (Number.isFinite(capacity) && capacity > 0) this._s.capacity = Math.round(capacity);
        if (typeof name === 'string' && name.trim()) this._s.name = name.trim().slice(0, 40);
        if (archived === true)  this._s.archived = true;
        if (archived === false) this._s.archived = false;
        if (reset === true) {
          for (const grp of Object.values(this._s.groups)) {
            grp.count = 0; grp.totalIn = 0; grp.totalOut = 0; grp.opStats = {};
          }
          this._s.history = [];
          this._seen.clear();
        }
      }
      await this._save();
      this._broadcast(0);
      return Response.json({ ok: true });
    }

    // GET /clients
    if (path === '/clients' && request.method === 'GET') {
      const seen = new Set();
      const clients = [];
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() ?? {};
        if (!a.name || seen.has(a.name)) continue;
        seen.add(a.name);
        clients.push({
          name:       a.name,
          groupName:  a.groupId ? (this._s.groups[a.groupId]?.name ?? null) : null,
          connectedAt: a.connectedAt,
        });
      }
      return Response.json({ clients });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }

  async _handleWS(request) {
    await this._load();
    const url = new URL(request.url);
    const groupId = url.searchParams.get('g');

    if (!this._s || this._s.archived) {
      return new Response('Event not found', { status: 404 });
    }
    if (groupId && !this._s.groups[groupId]) {
      return new Response('Group not found', { status: 404 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name: null, connectedAt: Date.now(), groupId });

    server.send(JSON.stringify({
      type:      'init',
      total:     this._total(),
      capacity:  this._s.capacity,
      eventName: this._s.name,
      groups:    this._groupSummary(),
    }));

    // Liste des opérateurs déjà connectés
    const seen = new Set();
    const currentClients = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue;
      const a = ws.deserializeAttachment() ?? {};
      if (!a.name || seen.has(a.name)) continue;
      seen.add(a.name);
      currentClients.push({
        name:      a.name,
        groupName: a.groupId ? (this._s.groups[a.groupId]?.name ?? null) : null,
      });
    }
    if (currentClients.length > 0) {
      server.send(JSON.stringify({ type: 'clients', clients: currentClients }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'hello' && typeof msg.name === 'string') {
        const name = msg.name.trim().slice(0, 32);
        if (!name) return;
        const a = ws.deserializeAttachment() ?? {};
        a.name = name;
        ws.serializeAttachment(a);
        this._broadcastClients();
      }
    } catch {}
  }

  async webSocketClose(ws)  { this._broadcastClients(); }
  async webSocketError(ws)  { this._broadcastClients(); }

  // ── Alarme — historique toutes les 30 s ────────────────────────────────────

  async alarm() {
    await this._load();
    if (!this._s || this._s.archived) return; // ne pas replanifier si archivé

    this._s.history.push({ t: Date.now(), c: this._total() });
    if (this._s.history.length > 2880) this._s.history.shift();
    await this._save();
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}
