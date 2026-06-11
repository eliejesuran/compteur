import { DurableObject } from 'cloudflare:workers';

export class RegistryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._code = null;   // string
    this._events = null; // {[id]: {id,name,capacity,createdAt,archived}}
  }

  async _load() {
    if (this._code !== null) return;
    const [code, events] = await Promise.all([
      this.ctx.storage.get('adminCode'),
      this.ctx.storage.get('events'),
    ]);
    this._code = code ?? 'admin123';
    this._events = events ?? {};
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

    if (path === '/events' && request.method === 'GET') {
      const list = Object.values(this._events)
        .filter(e => !e.archived)
        .sort((a, b) => a.createdAt - b.createdAt);
      return Response.json({ events: list });
    }

    // POST /events — enregistre un nouvel événement dans l'index
    if (path === '/events' && request.method === 'POST') {
      const { id, name, capacity = 100 } = body ?? {};
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
