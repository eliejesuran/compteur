import { DurableObject } from 'cloudflare:workers';

const MAX_EVENTS = 50; // R4/L1 : plafond du nombre d'événements (archivés inclus — anti-saturation storage)

export class RegistryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._code     = null;  // admin code
    this._permCode = null;  // U16: PERM code (null = désactivé)
    this._events   = null;  // {[id]: {id,name,capacity,createdAt,archived}}
    this._loaded   = false;
  }

  async _load() {
    if (this._loaded) return;
    const [code, permCode, events] = await Promise.all([
      this.ctx.storage.get('adminCode'),
      this.ctx.storage.get('permCode'),
      this.ctx.storage.get('events'),
    ]);
    this._code     = code     ?? 'admin123';
    this._permCode = permCode ?? null;
    this._events   = events   ?? {};
    this._loaded   = true;
  }

  async fetch(request) {
    await this._load();
    const url = new URL(request.url);
    const path = url.pathname;
    let body = null;
    if (request.method !== 'GET') {
      try { body = await request.json(); } catch { body = {}; }
    }

    if (path === '/admin-code' && request.method === 'GET') {
      return Response.json({ code: this._code });
    }

    if (path === '/admin-code' && request.method === 'POST') {
      this._code = body.code;
      await this.ctx.storage.put('adminCode', this._code);
      return Response.json({ ok: true });
    }

    // U16: perm code endpoints
    if (path === '/perm-code' && request.method === 'GET') {
      return Response.json({ code: this._permCode });
    }

    if (path === '/perm-code' && request.method === 'POST') {
      const c = body?.code;
      this._permCode = (typeof c === 'string' && c.length >= 4) ? c : null;
      await this.ctx.storage.put('permCode', this._permCode);
      return Response.json({ ok: true });
    }

    if (path === '/events' && request.method === 'GET') {
      const list = Object.values(this._events)
        .filter(e => !e.archived)
        .sort((a, b) => a.createdAt - b.createdAt);
      return Response.json({ events: list });
    }

    // U15: archived events list
    if (path === '/events/archived' && request.method === 'GET') {
      const list = Object.values(this._events)
        .filter(e => e.archived)
        .sort((a, b) => a.createdAt - b.createdAt);
      return Response.json({ events: list });
    }

    // U15: delete event from registry
    if (path === '/events/delete' && request.method === 'POST') {
      const { id } = body ?? {};
      if (id) {
        delete this._events[id];
        await this.ctx.storage.put('events', this._events);
      }
      return Response.json({ ok: true });
    }

    // POST /events — enregistre un nouvel événement dans l'index
    if (path === '/events' && request.method === 'POST') {
      const { id, name, capacity = 100 } = body ?? {};
      // R4/L1 : refuse au-delà du plafond (sauf ré-enregistrement d'un id déjà présent)
      if (!this._events[id] && Object.keys(this._events).length >= MAX_EVENTS) {
        return Response.json(
          { error: `Limite atteinte : ${MAX_EVENTS} événements maximum. Supprimez-en avant d'en créer un nouveau.` },
          { status: 409 },
        );
      }
      this._events[id] = { id, name, capacity, createdAt: Date.now(), archived: false };
      await this.ctx.storage.put('events', this._events);
      return Response.json({ ok: true });
    }

    // POST /events/update — synchronise metadata après config admin
    if (path === '/events/update' && request.method === 'POST') {
      const { id, name, capacity, archived } = body ?? {};
      const evt = this._events[id];
      if (evt) {
        if (typeof name === 'string' && name.trim()) evt.name = name.trim().slice(0, 40);
        if (Number.isFinite(capacity) && capacity > 0) evt.capacity = Math.round(capacity);
        if (archived === true)  evt.archived = true;
        if (archived === false) evt.archived = false;
        await this.ctx.storage.put('events', this._events);
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
