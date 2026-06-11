'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');

const { server, state, eventSeenOps, trimSeenOps, wsClients } = require('../server');

const ARCHIVED_EVT_ID = 'archevt';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EVT_ID = 'testev';
const GRP_ID = 'testgrp';

const evt = () => state.events[EVT_ID];
const grp = () => state.events[EVT_ID].groups[GRP_ID];

function resetState() {
  state.adminCode = 'admin123';
  state.permCode  = null;
  state.events = {
    [EVT_ID]: {
      id: EVT_ID, name: 'Test Event',
      capacity: 100, history: [],
      createdAt: Date.now(), archived: false,
      groups: {
        [GRP_ID]: { id: GRP_ID, name: 'Principal', count: 0, totalIn: 0, totalOut: 0, opStats: {} },
      },
    },
  };
  eventSeenOps.clear();
  eventSeenOps.set(EVT_ID, new Set());
  wsClients.clear();
}

function wsUrl(groupId = GRP_ID) {
  const port = server.address().port;
  const base = `ws://localhost:${port}?e=${EVT_ID}`;
  return groupId ? `${base}&g=${groupId}` : base;
}

before(() => new Promise(resolve => server.listen(0, resolve)));
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(resetState);

// ── GET /api/state ────────────────────────────────────────────────────────────

describe('GET /api/state', () => {
  test('retourne total et capacity', async () => {
    const res = await request(server).get(`/api/state?e=${EVT_ID}&g=${GRP_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total,    0);
    assert.equal(res.body.capacity, 100);
  });

  test('reflète les mutations d\'état', async () => {
    grp().count    = 42;
    evt().capacity = 300;
    const res = await request(server).get(`/api/state?e=${EVT_ID}&g=${GRP_ID}`);
    assert.equal(res.body.total,    42);
    assert.equal(res.body.capacity, 300);
  });
});

// ── POST /api/count — validation entrées ─────────────────────────────────────

describe('POST /api/count — validation', () => {
  test('uuid absent → 400', async () => {
    const res = await request(server).post('/api/count').send({ delta: 1 });
    assert.equal(res.status, 400);
  });

  test('uuid vide → 400', async () => {
    const res = await request(server).post('/api/count').send({ delta: 1, uuid: '' });
    assert.equal(res.status, 400);
  });

  test('delta 0 → 400', async () => {
    const res = await request(server).post('/api/count').send({ delta: 0, uuid: randomUUID() });
    assert.equal(res.status, 400);
  });

  test('delta 2 (non autorisé) → 400', async () => {
    const res = await request(server).post('/api/count').send({ delta: 2, uuid: randomUUID() });
    assert.equal(res.status, 400);
  });

  test('delta string → 400', async () => {
    const res = await request(server).post('/api/count').send({ delta: 'bad', uuid: randomUUID() });
    assert.equal(res.status, 400);
  });

  test('body vide → 400', async () => {
    const res = await request(server).post('/api/count').send({});
    assert.equal(res.status, 400);
  });
});

// ── POST /api/count — mutations d'état ───────────────────────────────────────

describe('POST /api/count — mutations', () => {
  test('+1 incrémente', async () => {
    const res = await request(server).post('/api/count')
      .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.status,    200);
    assert.equal(res.body.total, 1);
    assert.equal(grp().count,    1);
  });

  test('+5 incrémente de 5', async () => {
    const res = await request(server).post('/api/count')
      .send({ delta: 5, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 5);
  });

  test('-1 décrémente', async () => {
    grp().count = 5;
    const res = await request(server).post('/api/count')
      .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 4);
  });

  test('-5 décrémente de 5', async () => {
    grp().count = 10;
    const res = await request(server).post('/api/count')
      .send({ delta: -5, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 5);
  });

  test('plusieurs opérations s\'accumulent', async () => {
    const send = d => request(server).post('/api/count')
      .send({ delta: d, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    await send(1); await send(1); await send(5);
    const res = await send(-1);
    assert.equal(res.body.total, 6);
  });

  test('totalIn et totalOut trackés correctement', async () => {
    const send = d => request(server).post('/api/count')
      .send({ delta: d, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    await send(5); await send(1); await send(-1);
    assert.equal(grp().totalIn,  6);
    assert.equal(grp().totalOut, 1);
  });

  test('50 opérations concurrentes sans corruption', async () => {
    const ops = Array.from({ length: 50 }, () =>
      request(server).post('/api/count')
        .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID })
    );
    await Promise.all(ops);
    assert.equal(grp().count,   50);
    assert.equal(grp().totalIn, 50);
  });
});

// ── POST /api/count — plancher à zéro ────────────────────────────────────────

describe('POST /api/count — jamais négatif', () => {
  test('-1 depuis 0 reste à 0', async () => {
    const res = await request(server).post('/api/count')
      .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 0);
    assert.equal(grp().count,    0);
  });

  test('-5 depuis 3 reste à 0', async () => {
    grp().count = 3;
    const res = await request(server).post('/api/count')
      .send({ delta: -5, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 0);
  });

  test('10 soustractions depuis 5 ne passent jamais sous 0', async () => {
    grp().count = 5;
    for (let i = 0; i < 10; i++) {
      await request(server).post('/api/count')
        .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    }
    assert.equal(grp().count, 0);
  });
});

// ── POST /api/count — alerte capacité ────────────────────────────────────────

describe('POST /api/count — alerte capacité', () => {
  test('alert=false sous la capacité', async () => {
    grp().count = 98;
    const res = await request(server).post('/api/count')
      .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.alert, false);
  });

  test('alert=true quand count atteint exactement la capacité', async () => {
    grp().count = 99;
    const res = await request(server).post('/api/count')
      .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.total, 100);
    assert.equal(res.body.alert, true);
  });

  test('alert=true quand count dépasse la capacité', async () => {
    grp().count    = 100;
    evt().capacity = 100;
    const res = await request(server).post('/api/count')
      .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.alert, true);
  });

  test('alert=false après redescente sous la capacité', async () => {
    grp().count    = 100;
    evt().capacity = 100;
    const res = await request(server).post('/api/count')
      .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.alert, false);
  });
});

// ── POST /api/count — déduplication UUID ─────────────────────────────────────

describe('POST /api/count — déduplication', () => {
  test('même UUID → 2e appel retourne dup:true, count inchangé', async () => {
    const uuid = randomUUID();
    await request(server).post('/api/count').send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID });
    const res = await request(server).post('/api/count').send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID });
    assert.equal(res.body.dup,   true);
    assert.equal(res.body.total, 1);
    assert.equal(grp().count,    1);
  });

  test('UUIDs différents → tous appliqués', async () => {
    await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    assert.equal(grp().count, 2);
  });

  test('replay de queue offline : 3 envois du même UUID → compté une seule fois', async () => {
    const uuid = randomUUID();
    const [r1, r2, r3] = await Promise.all([
      request(server).post('/api/count').send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID }),
      request(server).post('/api/count').send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID }),
      request(server).post('/api/count').send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID }),
    ]);
    const dups = [r1.body.dup, r2.body.dup, r3.body.dup];
    assert.equal(dups.filter(d => !d).length, 1, 'exactement 1 opération acceptée');
    assert.equal(dups.filter(Boolean).length,  2, '2 doublons rejetés');
    assert.equal(grp().count, 1);
  });
});

// ── GET /api/history ──────────────────────────────────────────────────────────

describe('GET /api/history', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).get('/api/history?code=wrong');
    assert.equal(res.status, 403);
  });

  test('code absent → 403', async () => {
    const res = await request(server).get('/api/history');
    assert.equal(res.status, 403);
  });

  test('bon code → structure complète', async () => {
    grp().count    = 42;
    grp().totalIn  = 55;
    grp().totalOut = 13;
    evt().capacity = 200;
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.status,         200);
    assert.equal(res.body.total,     42);
    assert.equal(res.body.capacity,  200);
    assert.equal(res.body.totalIn,   55);
    assert.equal(res.body.totalOut,  13);
    assert.ok(Array.isArray(res.body.history));
  });
});

// ── POST /api/admin/config ────────────────────────────────────────────────────

describe('POST /api/admin/config', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).post('/api/admin/config')
      .send({ code: 'wrong', e: EVT_ID, capacity: 50 });
    assert.equal(res.status, 403);
  });

  test('mise à jour de la capacité', async () => {
    const res = await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, capacity: 250 });
    assert.equal(res.body.ok,    true);
    assert.equal(evt().capacity, 250);
  });

  test('capacité arrondie à l\'entier', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, capacity: 150.7 });
    assert.equal(evt().capacity, 151);
  });

  test('capacité négative → ignorée', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, capacity: -10 });
    assert.equal(evt().capacity, 100);
  });

  test('capacité zéro → ignorée', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, capacity: 0 });
    assert.equal(evt().capacity, 100);
  });

  test('reset=true → count=0, totalIn=0, totalOut=0, seenOps vidé', async () => {
    grp().count    = 50;
    grp().totalIn  = 60;
    grp().totalOut = 10;
    eventSeenOps.get(EVT_ID).add('old-uuid');

    const res = await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, reset: true });
    assert.equal(res.body.ok,                          true);
    assert.equal(grp().count,                          0);
    assert.equal(grp().totalIn,                        0);
    assert.equal(grp().totalOut,                       0);
    assert.equal(eventSeenOps.get(EVT_ID).size,        0);
  });

  test('changement de code : nouveau code fonctionne, ancien échoue', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', newCode: 'newpass99' });
    assert.equal(state.adminCode, 'newpass99');

    const bad = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(bad.status, 403);

    const ok = await request(server).get(`/api/history?code=newpass99&e=${EVT_ID}`);
    assert.equal(ok.status, 200);
  });

  test('nouveau code trop court (<4 car.) → ignoré', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', newCode: 'ab' });
    assert.equal(state.adminCode, 'admin123');
  });
});

// ── GET /api/qr ───────────────────────────────────────────────────────────────

describe('GET /api/qr', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).get('/api/qr?code=wrong');
    assert.equal(res.status, 403);
  });

  test('bon code → dataURL PNG et url HTTP', async () => {
    const res = await request(server).get(`/api/qr?code=admin123&e=${EVT_ID}&g=${GRP_ID}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.qr.startsWith('data:image/png;base64,'), 'QR doit être un PNG en base64');
    assert.ok(res.body.url.startsWith('http'), 'URL doit commencer par http');
  });
});

// ── GET /api/ips ──────────────────────────────────────────────────────────────

describe('GET /api/ips', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).get('/api/ips?code=wrong');
    assert.equal(res.status, 403);
  });

  test('bon code → tableau ips et port numérique', async () => {
    const res = await request(server).get('/api/ips?code=admin123');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.ips));
    assert.equal(typeof res.body.port, 'number');
  });
});

// ── trimSeenOps — gestion mémoire ────────────────────────────────────────────

describe('trimSeenOps', () => {
  test('sous 20 000 → aucun trim', () => {
    const s = new Set();
    for (let i = 0; i < 100; i++) s.add(String(i));
    trimSeenOps(s);
    assert.equal(s.size, 100);
  });

  test('exactement 20 001 entrées → trimmé à 10 000', () => {
    const s = new Set();
    for (let i = 0; i < 20001; i++) s.add(String(i));
    trimSeenOps(s);
    assert.equal(s.size, 10000);
  });

  test('après trim, les 10 000 plus récents sont conservés', () => {
    const s = new Set();
    for (let i = 0; i < 20001; i++) s.add(String(i));
    trimSeenOps(s);
    assert.ok(!s.has('0'));
    assert.ok(!s.has('9999'));
    assert.ok(s.has('10001'));
    assert.ok(s.has('20000'));
  });

  test('double trim → taille stable à 10 000', () => {
    const s = new Set();
    for (let i = 0; i < 20001; i++) s.add(String(i));
    trimSeenOps(s);
    trimSeenOps(s);
    assert.equal(s.size, 10000);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

describe('WebSocket', () => {
  test('connexion → reçoit message init avec total et capacity', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', (data) => {
      const msg = JSON.parse(data);
      assert.equal(msg.type,            'init');
      assert.equal(typeof msg.total,    'number');
      assert.equal(typeof msg.capacity, 'number');
      ws.close();
      done();
    });
    ws.on('error', done);
  });

  test('POST /api/count → broadcast type:update à tous les clients', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type,           'update');
        assert.equal(msg.delta,           1);
        assert.equal(msg.total,           1);
        assert.equal(typeof msg.alert,   'boolean');
        ws.close();
        done();
      });
      request(server).post('/api/count')
        .send({ delta: 1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID })
        .end(() => {});
    });
    ws.on('error', done);
  });

  test('POST /api/admin/config → broadcast type:update avec nouvelle capacité', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type,     'update');
        assert.equal(msg.capacity, 500);
        ws.close();
        done();
      });
      request(server).post('/api/admin/config')
        .send({ code: 'admin123', e: EVT_ID, capacity: 500 })
        .end(() => {});
    });
    ws.on('error', done);
  });

  test('hello avec nom → broadcast type:clients avec le nom', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type, 'clients');
        assert.ok(msg.clients.some(c => c.name === 'Testeur'));
        ws.close();
        done();
      });
      ws.send(JSON.stringify({ type: 'hello', name: 'Testeur' }));
    });
    ws.on('error', done);
  });

  test('hello avec nom vide → pas de broadcast clients', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      let gotClients = false;
      ws.on('message', (data) => {
        if (JSON.parse(data).type === 'clients') gotClients = true;
      });
      ws.send(JSON.stringify({ type: 'hello', name: '   ' }));
      setTimeout(() => {
        assert.ok(!gotClients, 'pas de broadcast clients pour un nom vide');
        ws.close();
        done();
      }, 80);
    });
    ws.on('error', done);
  });

  test('déconnexion après hello → broadcast clients mis à jour', (_t, done) => {
    const observer = new WebSocket(wsUrl());
    observer.once('message', () => {
      const actor = new WebSocket(wsUrl());
      actor.once('message', () => {
        actor.send(JSON.stringify({ type: 'hello', name: 'Partant' }));
        observer.once('message', (data) => {
          const join = JSON.parse(data);
          assert.equal(join.type, 'clients');
          assert.ok(join.clients.some(c => c.name === 'Partant'));
          observer.once('message', (data2) => {
            const leave = JSON.parse(data2);
            assert.equal(leave.type, 'clients');
            assert.ok(!leave.clients.some(c => c.name === 'Partant'));
            observer.close();
            done();
          });
          actor.close();
        });
      });
      actor.on('error', done);
    });
    observer.on('error', done);
  });
});

// ── GET /api/clients ──────────────────────────────────────────────────────────

describe('GET /api/clients', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).get('/api/clients?code=wrong');
    assert.equal(res.status, 403);
  });

  test('code absent → 403', async () => {
    const res = await request(server).get('/api/clients');
    assert.equal(res.status, 403);
  });

  test('bon code, aucun client nommé → liste vide', async () => {
    const res = await request(server).get(`/api/clients?code=admin123&e=${EVT_ID}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.clients));
    assert.equal(res.body.clients.length, 0);
  });

  test('bon code, client connecté avec nom → apparaît dans la liste', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.send(JSON.stringify({ type: 'hello', name: 'Alice' }));
      setTimeout(async () => {
        const res = await request(server).get(`/api/clients?code=admin123&e=${EVT_ID}`);
        assert.equal(res.status, 200);
        const names = res.body.clients.map(c => c.name);
        assert.ok(names.includes('Alice'));
        assert.ok(res.body.clients[0].connectedAt > 0);
        ws.close();
        done();
      }, 50);
    });
    ws.on('error', done);
  });

  test('nom tronqué à 32 caractères', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.send(JSON.stringify({ type: 'hello', name: 'A'.repeat(100) }));
      setTimeout(async () => {
        const res = await request(server).get(`/api/clients?code=admin123&e=${EVT_ID}`);
        const names = res.body.clients.map(c => c.name);
        assert.ok(names.some(n => n.length === 32));
        ws.close();
        done();
      }, 50);
    });
    ws.on('error', done);
  });
});

// ── GET /api/events/archived — U15 ───────────────────────────────────────────

describe('GET /api/events/archived', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).get('/api/events/archived?code=wrong');
    assert.equal(res.status, 403);
  });

  test('code absent → 403', async () => {
    const res = await request(server).get('/api/events/archived');
    assert.equal(res.status, 403);
  });

  test('aucun événement archivé → liste vide', async () => {
    const res = await request(server).get('/api/events/archived?code=admin123');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.events));
    assert.equal(res.body.events.length, 0);
  });

  test('après archivage → événement visible dans archived', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, archived: true });
    const res = await request(server).get('/api/events/archived?code=admin123');
    assert.equal(res.status, 200);
    assert.ok(res.body.events.some(e => e.id === EVT_ID));
  });

  test('après archivage → disparaît de /api/events', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, archived: true });
    const res = await request(server).get('/api/events?code=admin123');
    assert.ok(!res.body.events.some(e => e.id === EVT_ID));
  });
});

// ── POST /api/admin/config deleteEvent — U15 ─────────────────────────────────

describe('POST /api/admin/config — deleteEvent', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server).post('/api/admin/config')
      .send({ code: 'wrong', e: EVT_ID, deleteEvent: true });
    assert.equal(res.status, 403);
    assert.ok(state.events[EVT_ID], 'event doit exister encore');
  });

  test('supprime l\'événement de l\'état', async () => {
    const res = await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, deleteEvent: true });
    assert.equal(res.body.ok, true);
    assert.equal(state.events[EVT_ID], undefined);
  });

  test('supprime aussi le seenOps de l\'événement', async () => {
    eventSeenOps.set(EVT_ID, new Set(['old']));
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', e: EVT_ID, deleteEvent: true });
    assert.ok(!eventSeenOps.has(EVT_ID));
  });
});

// ── Rôle PERM — U16 ──────────────────────────────────────────────────────────

describe('Rôle PERM', () => {
  test('permCode null → code perm refusé (403)', async () => {
    state.permCode = null;
    const res = await request(server).get('/api/events?code=quelconque');
    assert.equal(res.status, 403);
  });

  test('permCode configuré → GET /api/events retourne role:perm', async () => {
    state.permCode = 'permpass';
    const res = await request(server).get('/api/events?code=permpass');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'perm');
  });

  test('admin code → GET /api/events retourne role:admin', async () => {
    const res = await request(server).get('/api/events?code=admin123');
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'admin');
  });

  test('permCode → GET /api/history autorisé', async () => {
    state.permCode = 'permpass';
    const res = await request(server).get(`/api/history?code=permpass&e=${EVT_ID}`);
    assert.equal(res.status, 200);
  });

  test('permCode → GET /api/clients autorisé', async () => {
    state.permCode = 'permpass';
    const res = await request(server).get(`/api/clients?code=permpass&e=${EVT_ID}`);
    assert.equal(res.status, 200);
  });

  test('permCode → GET /api/qr autorisé', async () => {
    state.permCode = 'permpass';
    const res = await request(server).get(`/api/qr?code=permpass&e=${EVT_ID}&g=${GRP_ID}`);
    assert.equal(res.status, 200);
  });

  test('permCode → POST /api/admin/config refusé (403)', async () => {
    state.permCode = 'permpass';
    const res = await request(server).post('/api/admin/config')
      .send({ code: 'permpass', e: EVT_ID, capacity: 50 });
    assert.equal(res.status, 403);
    assert.equal(evt().capacity, 100, 'capacité ne doit pas changer');
  });

  test('permCode → POST /api/events refusé (403)', async () => {
    state.permCode = 'permpass';
    const res = await request(server).post('/api/events')
      .send({ code: 'permpass', name: 'Nouvel event' });
    assert.equal(res.status, 403);
  });

  test('permCode → GET /api/events/archived refusé (403)', async () => {
    state.permCode = 'permpass';
    const res = await request(server).get('/api/events/archived?code=permpass');
    assert.equal(res.status, 403);
  });

  test('newPermCode via config → met à jour state.permCode', async () => {
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', newPermCode: 'nouveauperm' });
    assert.equal(state.permCode, 'nouveauperm');
  });

  test('newPermCode null via config → désactive le code perm', async () => {
    state.permCode = 'existant';
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', newPermCode: null });
    assert.equal(state.permCode, null);
  });

  test('newPermCode trop court (<4) → ignoré', async () => {
    state.permCode = 'existant';
    await request(server).post('/api/admin/config')
      .send({ code: 'admin123', newPermCode: 'ab' });
    assert.equal(state.permCode, null, 'trop court → null (désactivé)');
  });
});
