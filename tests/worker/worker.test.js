import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// R5 — tests d'intégration du Worker CF.
// SELF.fetch() exerce index.js (routeur + auth) → EventDO / RegistryDO réels.
// isolatedStorage : chaque test repart d'un storage DO vierge (admin code = admin123).

const ADMIN = 'admin123';
const BASE  = 'http://do';

const J = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createEvent(name = 'Test') {
  const r = await SELF.fetch(`${BASE}/api/events`, J({ code: ADMIN, name }));
  expect(r.status).toBe(200);
  return r.json(); // { id, name, capacity, total, groups:[{id,name,count}] }
}

async function count(e, g, delta, uuid, name) {
  return SELF.fetch(`${BASE}/api/count`, J({ e, g, delta, uuid, name }));
}

async function state(e, g) {
  const r = await SELF.fetch(`${BASE}/api/state?e=${e}&g=${g}`);
  return { status: r.status, body: await r.json() };
}

// ── Création / auth ──────────────────────────────────────────────────────────

describe('POST /api/events — création', () => {
  it('crée un event avec un groupe Principal', async () => {
    const evt = await createEvent('Soirée');
    expect(evt.id).toMatch(/^[0-9a-f]{6}$/);
    expect(evt.name).toBe('Soirée');
    expect(evt.capacity).toBe(100);
    expect(evt.groups).toHaveLength(1);
    expect(evt.groups[0].name).toBe('Principal');
  });

  it('refuse un mauvais code admin (403)', async () => {
    const r = await SELF.fetch(`${BASE}/api/events`, J({ code: 'wrong', name: 'X' }));
    expect(r.status).toBe(403);
  });
});

describe('GET /api/events — liste', () => {
  // Note : le RegistryDO est un singleton dont le cache mémoire persiste entre
  // tests (isolatedStorage ne réinitialise que le storage). On scope donc les
  // assertions sur les ids créés ici, sans supposer un registre vide.
  it('liste les events non archivés avec le rôle', async () => {
    const a = await createEvent('A');
    const b = await createEvent('B');
    const r = await SELF.fetch(`${BASE}/api/events?code=${ADMIN}`);
    expect(r.status).toBe(200);
    const { events, role } = await r.json();
    expect(role).toBe('admin');
    const mine = events.filter(e => e.id === a.id || e.id === b.id);
    expect(mine.map(e => e.name).sort()).toEqual(['A', 'B']);
  });

  it('refuse sans code (403)', async () => {
    const r = await SELF.fetch(`${BASE}/api/events?code=nope`);
    expect(r.status).toBe(403);
  });
});

// ── Comptage ─────────────────────────────────────────────────────────────────

describe('POST /api/count — mutations', () => {
  it('incrémente et reflète dans /api/state', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;

    await count(e, g, 1, 'u1', 'Alice');
    await count(e, g, 5, 'u2', 'Alice');
    const { body } = await state(e, g);
    expect(body.total).toBe(6);
    expect(body.groupCount).toBe(6);
  });

  it('ne descend jamais sous 0', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;
    await count(e, g, -5, 'd1', 'Bob');
    const { body } = await state(e, g);
    expect(body.total).toBe(0);
  });

  it('rejette un delta invalide (400)', async () => {
    const { id: e, groups } = await createEvent();
    const r = await count(e, groups[0].id, 2, 'x', 'Z');
    expect(r.status).toBe(400);
  });

  it('déduplique par uuid (retry réseau)', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;
    await count(e, g, 1, 'same');
    const r2 = await count(e, g, 1, 'same');
    const b2 = await r2.json();
    expect(b2.dup).toBe(true);
    expect(b2.total).toBe(1);
  });

  it('signale alert quand total >= capacity', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;
    await SELF.fetch(`${BASE}/api/admin/config`, J({ code: ADMIN, e, capacity: 1 }));
    const r = await count(e, g, 1, 'cap1');
    const b = await r.json();
    expect(b.alert).toBe(true);
  });
});

// ── Groupes ──────────────────────────────────────────────────────────────────

describe('POST /api/groups', () => {
  it('ajoute un groupe à l\'event', async () => {
    const { id: e } = await createEvent();
    const r = await SELF.fetch(`${BASE}/api/groups`, J({ code: ADMIN, e, name: 'Entrée VIP' }));
    expect(r.status).toBe(200);
    const grp = await r.json();
    expect(grp.name).toBe('Entrée VIP');

    const ev = await SELF.fetch(`${BASE}/api/events?code=${ADMIN}`);
    const { events } = await ev.json();
    const created = events.find(x => x.id === e);
    expect(created.groups).toHaveLength(2);
  });
});

// ── Archivage / suppression ──────────────────────────────────────────────────

describe('Archivage', () => {
  it('archive → /api/state renvoie 404 et l\'event sort de la liste', async () => {
    const { id: e, groups } = await createEvent();
    await SELF.fetch(`${BASE}/api/admin/config`, J({ code: ADMIN, e, archived: true }));

    const { status } = await state(e, groups[0].id);
    expect(status).toBe(404);

    const r = await SELF.fetch(`${BASE}/api/events?code=${ADMIN}`);
    const { events } = await r.json();
    expect(events.find(ev => ev.id === e)).toBeUndefined();
  });
});

describe('Suppression (deleteEvent → terminate/purge N4)', () => {
  it('purge le DO : /api/state 404 après suppression', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;
    await count(e, g, 5, 'pre');

    const del = await SELF.fetch(`${BASE}/api/admin/config`, J({ code: ADMIN, e, deleteEvent: true }));
    expect(del.status).toBe(200);

    const { status } = await state(e, g);
    expect(status).toBe(404);

    const r = await SELF.fetch(`${BASE}/api/events?code=${ADMIN}`);
    const { events } = await r.json();
    expect(events.find(ev => ev.id === e)).toBeUndefined();
  });
});

// ── Plafonds (R4/L1/L2) ──────────────────────────────────────────────────────

describe('Plafond groupes (R4/L1) — 20/event', () => {
  it('refuse le 21ᵉ groupe (409)', async () => {
    const { id: e } = await createEvent(); // 1 groupe (Principal)
    for (let i = 0; i < 19; i++) {
      const r = await SELF.fetch(`${BASE}/api/groups`, J({ code: ADMIN, e, name: `G${i}` }));
      expect(r.status).toBe(200);
    }
    const over = await SELF.fetch(`${BASE}/api/groups`, J({ code: ADMIN, e, name: 'over' }));
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/Limite atteinte/);
  });
});

describe('Plafond opStats (R4/L2) — 100/groupe', () => {
  it('plafonne à 100 sans jamais perdre de comptage', async () => {
    const { id: e, groups } = await createEvent();
    const g = groups[0].id;
    for (let i = 0; i < 100; i++) await count(e, g, 1, `op${i}`, `Op${i}`);
    await count(e, g, 1, 'op100', 'Op100'); // 101ᵉ nom distinct → non tracké
    await count(e, g, 1, 'op101', 'Op0');   // nom existant → accumule encore

    const hist = await (await SELF.fetch(`${BASE}/api/history?code=${ADMIN}&e=${e}`)).json();
    const grp = hist.groups.find(x => x.id === g);
    expect(Object.keys(grp.opStats)).toHaveLength(100);   // plafonné
    expect(grp.opStats['Op100']).toBeUndefined();         // nouveau > cap : non tracké
    expect(grp.opStats['Op0'].in).toBe(2);                // existant : continue d'accumuler
    expect(grp.totalIn).toBe(102);                        // comptage jamais perdu
  });
});

// ⚠️ Doit rester le DERNIER bloc : il remplit le registre jusqu'au plafond.
describe('Plafond événements (R4/L1) — 50 au total', () => {
  async function totalEvents() {
    const a  = await (await SELF.fetch(`${BASE}/api/events?code=${ADMIN}`)).json();
    const ar = await (await SELF.fetch(`${BASE}/api/events/archived?code=${ADMIN}`)).json();
    return a.events.length + ar.events.length;
  }

  it('refuse au-delà de 50 (409) — robuste au registre pré-rempli', async () => {
    const n = await totalEvents();
    // remplit jusqu'au plafond en parallèle (le RegistryDO sérialise les écritures)
    await Promise.all(Array.from({ length: Math.max(0, 50 - n) }, () => createEvent()));
    const over = await SELF.fetch(`${BASE}/api/events`, J({ code: ADMIN, name: 'over' }));
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/Limite atteinte/);
  }, 30000);
});
