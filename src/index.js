import QRCode from 'qrcode';
import { RegistryDO } from './registry.js';
import { EventDO    } from './event.js';

export { RegistryDO, EventDO };

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexId() {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function iReq(path, method = 'GET', body = null) {
  const opts = { method };
  if (body !== null) {
    opts.body    = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(`http://do${path}`, opts);
}

function eventStub(env, eventId) {
  return env.EVENT.get(env.EVENT.idFromName(eventId));
}

function registryStub(env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
}

async function getAdminCode(env) {
  const r = await registryStub(env).fetch(iReq('/admin-code'));
  return (await r.json()).code;
}

async function generateQR(url) {
  // QRCode.toString avec type svg n'utilise pas Canvas — fonctionne en Workers
  const svg = await QRCode.toString(url, { type: 'svg', width: 400, margin: 2 });
  const b64 = btoa(encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g,
    (_, p) => String.fromCharCode(parseInt(p, 16))));
  return `data:image/svg+xml;base64,${b64}`;
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // WebSocket — délégué directement à l'EventDO
    if (request.headers.get('Upgrade') === 'websocket') {
      const e = url.searchParams.get('e');
      if (!e) return new Response('Missing e', { status: 400 });
      return eventStub(env, e).fetch(request);
    }

    if (path.startsWith('/api/')) return handleAPI(request, env, url, path);

    // Fichiers statiques (public/)
    return env.ASSETS.fetch(request);
  },
};

// ── API router ────────────────────────────────────────────────────────────────

async function handleAPI(request, env, url, path) {
  const method = request.method;
  let body = null;
  if (method !== 'GET') {
    try { body = await request.json(); } catch { body = {}; }
  }

  // ── Routes sans auth ───────────────────────────────────────────────────────

  if (path === '/api/count' && method === 'POST') {
    const { e, g } = body ?? {};
    if (!e || !g) return Response.json({ error: 'e and g required' }, { status: 400 });
    return eventStub(env, e).fetch(iReq('/count', 'POST', body));
  }

  if (path === '/api/state' && method === 'GET') {
    const e = url.searchParams.get('e');
    const g = url.searchParams.get('g');
    if (!e || !g) return Response.json({ error: 'e and g required' }, { status: 400 });
    return eventStub(env, e).fetch(iReq(`/state?g=${g}`));
  }

  // ── Vérification admin ─────────────────────────────────────────────────────

  const code      = method === 'GET' ? url.searchParams.get('code') : body?.code;
  const adminCode = await getAdminCode(env);
  if (code !== adminCode) return Response.json({ error: 'forbidden' }, { status: 403 });

  // ── Routes admin ───────────────────────────────────────────────────────────

  if (path === '/api/events' && method === 'GET') {
    const reg     = registryStub(env);
    const listRes = await reg.fetch(iReq('/events'));
    const { events: meta } = await listRes.json();

    // Fan-out vers chaque EventDO pour les totaux en temps réel
    const events = await Promise.all(meta.map(async (m) => {
      try {
        const r   = await eventStub(env, m.id).fetch(iReq('/summary'));
        const { total, groups } = await r.json();
        return { ...m, total, groups };
      } catch {
        return { ...m, total: 0, groups: [] };
      }
    }));

    return Response.json({ events });
  }

  if (path === '/api/events' && method === 'POST') {
    const name = (typeof body?.name === 'string' ? body.name.trim() : '').slice(0, 40) || 'Nouvel événement';
    const id   = hexId();

    await registryStub(env).fetch(iReq('/events', 'POST', { id, name }));
    const r = await eventStub(env, id).fetch(iReq('/init', 'POST', { id, name, capacity: 100 }));
    const data = await r.json();
    return Response.json(data);
  }

  if (path === '/api/groups' && method === 'POST') {
    const { e, name: groupName } = body ?? {};
    if (!e) return Response.json({ error: 'e required' }, { status: 400 });
    return eventStub(env, e).fetch(iReq('/groups', 'POST', { name: groupName }));
  }

  if (path === '/api/history' && method === 'GET') {
    const e = url.searchParams.get('e');
    if (!e) return Response.json({ error: 'e required' }, { status: 400 });
    return eventStub(env, e).fetch(iReq('/history'));
  }

  if (path === '/api/admin/config' && method === 'POST') {
    const { e, g, capacity, newCode, reset, name, archived, deleteGroup } = body ?? {};

    if (typeof newCode === 'string' && newCode.length >= 4) {
      await registryStub(env).fetch(iReq('/admin-code', 'POST', { code: newCode }));
    }

    if (e) {
      const configResp = await eventStub(env, e).fetch(
        iReq('/config', 'POST', { g, capacity, reset, name, archived, deleteGroup })
      );
      // Sync metadata vers le registre si le nom/capacité/archivé a changé
      if (name !== undefined || capacity !== undefined || archived !== undefined) {
        await registryStub(env).fetch(
          iReq('/events/update', 'POST', { id: e, name, capacity, archived })
        );
      }
      return configResp;
    }

    return Response.json({ ok: true });
  }

  if (path === '/api/qr' && method === 'GET') {
    const e = url.searchParams.get('e');
    const g = url.searchParams.get('g');
    if (!e || !g) return Response.json({ error: 'e and g required' }, { status: 400 });

    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    const host  = request.headers.get('host');
    const opUrl = `${proto}://${host}/?e=${e}&g=${g}`;
    const qr    = await generateQR(opUrl);
    return Response.json({ qr, url: opUrl });
  }

  if (path === '/api/clients' && method === 'GET') {
    const e = url.searchParams.get('e');
    if (!e) return Response.json({ error: 'e required' }, { status: 400 });
    return eventStub(env, e).fetch(iReq('/clients'));
  }

  // Endpoint de compatibilité (inutile en cloud, retourne vide)
  if (path === '/api/ips') {
    return Response.json({ ips: [], port: 443 });
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}
