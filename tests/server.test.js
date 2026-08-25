'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// AVANT le require de server.js : /api/count déclenche scheduleSave() → sans cette
// redirection la suite écrasait le state.json d'exploitation avec ses fixtures.
const TMP_STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'compteur-test-')), 'state.json');
process.env.STATE_FILE = TMP_STATE;

const { server, state, eventSeenOps, trimSeenOps, wsClients, recentlyDisconnected, rlBuckets, buildSnapshot, applySnapshot, recordHistory, recordHistoryCoarse, flushSave } = require('../server');

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
  recentlyDisconnected.clear();
  rlBuckets.clear(); // S3: bucket partagé (même IP loopback) — repartir à plein chaque test
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

// ── POST /api/count — groupe négatif autorisé, total borné à 0 ────────────────

describe('POST /api/count — groupe peut être négatif si le total reste ≥ 0', () => {
  const G2 = 'grp2';
  function addG2() { evt().groups[G2] = { id: G2, name: 'Sortie', count: 0, totalIn: 0, totalOut: 0, opStats: {} }; }

  test('sortie par un autre groupe : count groupe négatif, total positif', async () => {
    addG2();
    grp().count = 5; // groupe A : 5 entrées
    // 3 sorties par le groupe B (personnes entrées par A)
    for (let i = 0; i < 3; i++) {
      await request(server).post('/api/count')
        .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: G2 });
    }
    assert.equal(evt().groups[G2].count, -3); // groupe négatif autorisé
    assert.equal(grp().count,            5);
    assert.equal(eventTotal2(),          2); // total = 5 - 3 ≥ 0
  });

  test('le total ne descend jamais sous 0 même via un groupe', async () => {
    addG2();
    grp().count = 2;
    const res = await request(server).post('/api/count')
      .send({ delta: -5, uuid: randomUUID(), e: EVT_ID, g: G2 });
    assert.equal(res.body.total,         0);   // clampé à 0
    assert.equal(evt().groups[G2].count, -2);  // n'applique que -2 (eff)
    assert.equal(evt().groups[G2].totalOut, 2);
  });
});

function eventTotal2() {
  return Object.values(evt().groups).reduce((s, g) => s + g.count, 0);
}

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
});

// ── POST /api/reset-counts — remet à 0 sans effacer l'historique ──────────────

describe('POST /api/reset-counts', () => {
  test('count=0, mais historique + totalIn/out conservés', async () => {
    grp().count    = 50;
    grp().totalIn  = 60;
    grp().totalOut = 10;
    evt().history  = [{ t: 1, c: 50, g: { [GRP_ID]: 50 } }];

    const res = await request(server).post('/api/reset-counts')
      .send({ code: 'admin123', e: EVT_ID });
    assert.equal(res.body.ok,        true);
    assert.equal(grp().count,        0);
    assert.equal(grp().totalIn,      60);   // conservé
    assert.equal(grp().totalOut,     10);   // conservé
    assert.equal(evt().history.length, 2);  // ancien point + point de remise à zéro
    assert.equal(evt().history.at(-1).c, 0);
  });

  test('autorisé pour le rôle PERM', async () => {
    state.permCode = 'permcode';
    grp().count = 7;
    const res = await request(server).post('/api/reset-counts')
      .send({ code: 'permcode', e: EVT_ID });
    assert.equal(res.status,  200);
    assert.equal(grp().count, 0);
  });

  test('code invalide → 403', async () => {
    const res = await request(server).post('/api/reset-counts')
      .send({ code: 'wrong', e: EVT_ID });
    assert.equal(res.status, 403);
  });
});

describe('config — divers', () => {
  test('changement de code : nouveau code fonctionne, ancien échoue (bis)', async () => {
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

  test('ping → réponse pong (heartbeat anti-zombie N1)', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type, 'pong');
        ws.close();
        done();
      });
      ws.send(JSON.stringify({ type: 'ping' }));
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

  test('déconnexion après hello → op toujours visible pendant grâce 30s', (_t, done) => {
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
            // U4: op reste visible pendant 30s après déconnexion
            assert.ok(leave.clients.some(c => c.name === 'Partant'), 'encore visible pendant la grâce 30s');
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

// ── Grâce déco op 30s — U4 ───────────────────────────────────────────────────

describe('Grâce déco op 30s — U4', () => {
  test('op reste dans /api/clients après déconnexion (grâce active)', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.send(JSON.stringify({ type: 'hello', name: 'EnGrace' }));
      ws.once('message', () => { // clients broadcast après hello
        ws.close();
        setTimeout(async () => {
          const res = await request(server).get(`/api/clients?code=admin123&e=${EVT_ID}`);
          assert.ok(res.body.clients.some(c => c.name === 'EnGrace'), 'encore visible dans les 30s');
          done();
        }, 100);
      });
    });
    ws.on('error', done);
  });

  test('op retiré de /api/clients après expiration grâce (>30s)', async () => {
    const key = `${EVT_ID}:Expiré`;
    recentlyDisconnected.set(key, {
      name: 'Expiré', groupId: GRP_ID, eventId: EVT_ID,
      disconnectedAt: Date.now() - 31_000,
    });
    const res = await request(server).get(`/api/clients?code=admin123&e=${EVT_ID}`);
    assert.ok(!res.body.clients.some(c => c.name === 'Expiré'), 'retiré après 30s');
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

// ── deleteEvent — fermeture WS (B5) ──────────────────────────────────────────

describe('deleteEvent — fermeture WS (B5)', () => {
  test('WS client reçoit close 4004 après deleteEvent', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      // Connexion établie (init reçu) — on supprime l'event
      request(server).post('/api/admin/config')
        .send({ code: 'admin123', e: EVT_ID, deleteEvent: true })
        .end(() => {});
      ws.on('close', (code) => {
        assert.equal(code, 4004, 'doit fermer avec code 4004');
        done();
      });
    });
    ws.on('error', done);
  });

  test('deleteEvent ne ferme pas les WS d\'un autre event', (_t, done) => {
    // Crée un second event
    const EVT2 = 'testev2';
    const GRP2 = 'testgrp2';
    state.events[EVT2] = {
      id: EVT2, name: 'Test 2', capacity: 100, history: [],
      createdAt: Date.now(), archived: false,
      groups: { [GRP2]: { id: GRP2, name: 'Principal', count: 0, totalIn: 0, totalOut: 0, opStats: {} } },
    };
    eventSeenOps.set(EVT2, new Set());

    const ws2 = new WebSocket(`ws://localhost:${server.address().port}?e=${EVT2}&g=${GRP2}`);
    ws2.once('message', () => {
      // Supprime EVT_ID — ws2 (connecté sur EVT2) ne doit pas être fermé
      let closed = false;
      ws2.on('close', () => { closed = true; });
      request(server).post('/api/admin/config')
        .send({ code: 'admin123', e: EVT_ID, deleteEvent: true })
        .end(() => {
          setTimeout(() => {
            assert.ok(!closed, 'ws2 ne doit pas être fermé');
            ws2.close();
            done();
          }, 80);
        });
    });
    ws2.on('error', done);
  });
});

describe('archivage — fermeture WS (N5)', () => {
  test('WS client reçoit close 4004 quand l\'event est archivé', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      request(server).post('/api/admin/config')
        .send({ code: 'admin123', e: EVT_ID, archived: true })
        .end(() => {});
      ws.on('close', (code) => {
        assert.equal(code, 4004, 'doit fermer avec code 4004');
        done();
      });
    });
    ws.on('error', done);
  });
});

// ── Persistance seenOps — C1 ─────────────────────────────────────────────────

// ── Écriture atomique de state.json ──────────────────────────────────────────
// L'ancien flushSave écrivait directement sur state.json : un crash pendant l'écriture
// (elle a lieu toutes les 30 s ET 500 ms après chaque comptage) laissait un JSON tronqué,
// illisible au boot → état vidé puis réécrit. On vérifie ici le contrat qui l'empêche :
// passage par un .tmp, aucun résidu, et state.json toujours relisible d'un bout à l'autre.

describe('Persistance — écriture atomique', () => {
  test('les tests n\'écrivent PAS dans le state.json du projet', () => {
    assert.notEqual(TMP_STATE, path.join(__dirname, '..', 'state.json'));
    assert.ok(TMP_STATE.startsWith(os.tmpdir()), 'STATE_FILE doit pointer vers un tmpdir');
  });

  test('flushSave produit un state.json complet et relisible', () => {
    state.events[EVT_ID].groups[GRP_ID].count = 42;
    flushSave();
    const parsed = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8'));
    assert.equal(parsed.events[EVT_ID].groups[GRP_ID].count, 42);
    assert.equal(parsed.adminCode, 'admin123');
  });

  test('flushSave ne laisse aucun fichier .tmp derrière lui', () => {
    flushSave();
    assert.equal(fs.existsSync(`${TMP_STATE}.tmp`), false, '.tmp orphelin après écriture');
  });

  test('une écriture qui échoue laisse le state.json précédent intact', () => {
    state.events[EVT_ID].groups[GRP_ID].count = 7;
    flushSave();
    const avant = fs.readFileSync(TMP_STATE, 'utf8');

    // .tmp rendu impossible à créer (répertoire à la place du fichier) → openSync throw
    fs.mkdirSync(`${TMP_STATE}.tmp`);
    try {
      state.events[EVT_ID].groups[GRP_ID].count = 999;
      flushSave(); // ne doit pas jeter, et ne doit pas toucher state.json
      assert.equal(fs.readFileSync(TMP_STATE, 'utf8'), avant, 'state.json a été abîmé');
    } finally {
      fs.rmdirSync(`${TMP_STATE}.tmp`);
    }
  });
});

describe('Persistance seenOps (C1)', () => {
  test('buildSnapshot inclut les seenOps sous forme de tableau', () => {
    const uuid = randomUUID();
    eventSeenOps.set(EVT_ID, new Set([uuid, randomUUID()]));
    const snap = buildSnapshot();
    assert.ok(Array.isArray(snap.seenOps[EVT_ID]), 'seenOps[eventId] doit être un tableau');
    assert.ok(snap.seenOps[EVT_ID].includes(uuid), 'le UUID doit être présent');
  });

  test('buildSnapshot plafonne à 5000 entrées par event', () => {
    const big = new Set();
    for (let i = 0; i < 8000; i++) big.add(String(i));
    eventSeenOps.set(EVT_ID, big);
    const snap = buildSnapshot();
    assert.ok(snap.seenOps[EVT_ID].length <= 5000);
    assert.equal(snap.seenOps[EVT_ID].length, 5000);
  });

  test('applySnapshot restaure les seenOps depuis un snapshot', () => {
    const uuid = randomUUID();
    const snap = { ...state, seenOps: { [EVT_ID]: [uuid, randomUUID()] } };
    eventSeenOps.get(EVT_ID).clear();
    applySnapshot(snap);
    assert.ok(eventSeenOps.get(EVT_ID).has(uuid), 'UUID doit être restauré');
  });

  test('applySnapshot sans champ seenOps (ancien format) ne plante pas', () => {
    const snap = { ...state }; // pas de seenOps
    assert.doesNotThrow(() => applySnapshot(snap));
  });

  test('round-trip C1 : UUID connu rejeté comme doublon après applySnapshot', async () => {
    const uuid = randomUUID();
    // Premier envoi — accepté
    const r1 = await request(server).post('/api/count')
      .send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID });
    assert.equal(r1.body.dup, undefined);
    assert.equal(grp().count, 1);

    // Snapshot du state courant (count=1, seenOps contient uuid)
    const snap = buildSnapshot();

    // Simule un redémarrage : vide le seenOps en mémoire
    eventSeenOps.get(EVT_ID).clear();
    assert.equal(eventSeenOps.get(EVT_ID).size, 0);

    // Restaure depuis le snapshot
    applySnapshot(snap);
    assert.ok(eventSeenOps.get(EVT_ID).has(uuid), 'UUID doit être restauré');

    // Retry du même UUID — doit être rejeté
    const r2 = await request(server).post('/api/count')
      .send({ delta: 1, uuid, e: EVT_ID, g: GRP_ID });
    assert.equal(r2.body.dup, true, 'doit être un doublon');
    assert.equal(grp().count, 1, 'le compteur ne doit pas augmenter');
  });

  test('round-trip C1 : nouveau UUID après restore est accepté normalement', async () => {
    const uuid1 = randomUUID();
    await request(server).post('/api/count').send({ delta: 1, uuid: uuid1, e: EVT_ID, g: GRP_ID });

    const snap = buildSnapshot();
    eventSeenOps.get(EVT_ID).clear();
    applySnapshot(snap);

    // UUID différent — doit passer
    const uuid2 = randomUUID();
    const r = await request(server).post('/api/count')
      .send({ delta: 1, uuid: uuid2, e: EVT_ID, g: GRP_ID });
    assert.equal(r.body.dup, undefined);
    assert.equal(grp().count, 2);
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

// ── Plafonds — R4/L1/L2 ───────────────────────────────────────────────────────

describe('Plafond événements (R4/L1)', () => {
  test('refuse le 51ᵉ événement (409)', async () => {
    // resetState → 1 event. On en crée 49 pour atteindre 50, le 51ᵉ est refusé.
    for (let i = 0; i < 49; i++) {
      const r = await request(server).post('/api/events').send({ code: 'admin123', name: `E${i}` });
      assert.equal(r.status, 200);
    }
    assert.equal(Object.keys(state.events).length, 50);
    const over = await request(server).post('/api/events').send({ code: 'admin123', name: 'over' });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /Limite atteinte/);
  });
});

describe('Plafond groupes (R4/L1)', () => {
  test('refuse le 21ᵉ groupe (409)', async () => {
    // resetState → 1 groupe (Principal). 19 ajouts → 20, le 21ᵉ est refusé.
    for (let i = 0; i < 19; i++) {
      const r = await request(server).post('/api/groups').send({ code: 'admin123', e: EVT_ID, name: `G${i}` });
      assert.equal(r.status, 200);
    }
    assert.equal(Object.keys(evt().groups).length, 20);
    const over = await request(server).post('/api/groups').send({ code: 'admin123', e: EVT_ID, name: 'over' });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /Limite atteinte/);
  });
});

describe('Rate-limit local (S3)', () => {
  test('429 + Retry-After au-delà du burst, sans perte de comptage', async () => {
    const N = 400; // > burst (300) → déclenche le rate-limit malgré le refill
    let r200 = 0, r429 = 0, retryAfter = null;
    for (let i = 0; i < N; i++) {
      const res = await request(server).post('/api/count')
        .send({ delta: 1, uuid: `rl${i}`, e: EVT_ID, g: GRP_ID });
      if (res.status === 200) r200++;
      else if (res.status === 429) { r429++; retryAfter = res.headers['retry-after']; }
    }
    assert.ok(r429 >= 1, 'le rate-limit doit déclencher');
    assert.ok(r200 >= 300, 'le burst (~300) doit passer');
    assert.ok(retryAfter, 'le 429 porte un en-tête Retry-After');
    assert.equal(grp().count, r200, 'aucun compte perdu ni dupliqué');
  });
});

describe('Plafond opStats (R4/L2)', () => {
  test('plafonne à 100 sans jamais perdre de comptage', async () => {
    for (let i = 0; i < 100; i++) {
      await request(server).post('/api/count')
        .send({ delta: 1, uuid: `c${i}`, e: EVT_ID, g: GRP_ID, name: `Op${i}` });
    }
    // 101ᵉ opérateur distinct → non tracké
    await request(server).post('/api/count')
      .send({ delta: 1, uuid: 'c100', e: EVT_ID, g: GRP_ID, name: 'Op100' });
    // opérateur existant → continue d'accumuler malgré le plafond
    await request(server).post('/api/count')
      .send({ delta: 1, uuid: 'c101', e: EVT_ID, g: GRP_ID, name: 'Op0' });

    const g = grp();
    assert.equal(Object.keys(g.opStats).length, 100, 'opStats plafonné');
    assert.equal(g.opStats['Op100'], undefined, 'nouveau > cap : non tracké');
    assert.equal(g.opStats['Op0'].in, 2, 'existant : accumule encore');
    assert.equal(g.count, 102, 'comptage jamais perdu');
  });
});

describe('Historique par groupe', () => {
  test('recordHistory enregistre le détail du count par groupe (g)', async () => {
    state.events[EVT_ID].groups['g2'] =
      { id: 'g2', name: 'Entrée B', count: 0, totalIn: 0, totalOut: 0, opStats: {} };
    const send = (g, d) => request(server).post('/api/count')
      .send({ delta: d, uuid: randomUUID(), e: EVT_ID, g });
    await send(GRP_ID, 5);
    await send(GRP_ID, 1);
    await send('g2', 5);

    recordHistory();

    const h = evt().history;
    assert.equal(h.length, 1);
    assert.equal(h[0].c, 11, 'total enregistré');
    assert.equal(h[0].g[GRP_ID], 6, 'count du groupe 1');
    assert.equal(h[0].g['g2'], 5, 'count du groupe 2');
  });

  test('/api/history renvoie les points avec le détail g', async () => {
    grp().count = 4;
    recordHistory();
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.status, 200);
    const last = res.body.history.at(-1);
    assert.equal(last.c, 4);
    assert.equal(last.g[GRP_ID], 4);
  });

  test('plafonne à MAX_HISTORY (2880) points', () => {
    const e = evt();
    for (let i = 0; i < 2880; i++) e.history.push({ t: i, c: 0, g: {} });
    recordHistory();
    assert.equal(e.history.length, 2880, 'shift maintient le plafond');
  });
});

describe('Historique grossier (rétention 60j)', () => {
  test('recordHistoryCoarse enregistre {t,c} (total seul, sans g)', () => {
    grp().count = 7;
    recordHistoryCoarse();
    const c = evt().historyCoarse.at(-1);
    assert.equal(c.c, 7);
    assert.equal(c.g, undefined, 'pas de détail par groupe');
    assert.ok(typeof c.t === 'number');
  });

  test('/api/history renvoie historyCoarse', async () => {
    grp().count = 3;
    recordHistoryCoarse();
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.historyCoarse));
    assert.equal(res.body.historyCoarse.at(-1).c, 3);
  });

  test('plafonne à MAX_HISTORY_COARSE (17280)', () => {
    const e = evt();
    e.historyCoarse = [];
    for (let i = 0; i < 17280; i++) e.historyCoarse.push({ t: i, c: 0 });
    recordHistoryCoarse();
    assert.equal(e.historyCoarse.length, 17280, 'shift maintient le plafond');
  });

  test('reset-counts ajoute un point grossier à 0', async () => {
    grp().count = 10;
    await request(server).post('/api/reset-counts').send({ code: 'admin123', e: EVT_ID });
    assert.equal(evt().historyCoarse.at(-1).c, 0);
  });

  test('backfill : series grossière vide reconstruite depuis l\'historique fin', async () => {
    const e = evt();
    e.historyCoarse = [];
    const base = Math.floor(Date.now() / (30 * 60 * 1000)) * 30 * 60 * 1000;
    // 3 buckets de 30 min, 2 points par bucket → on garde le dernier de chaque
    e.history = [
      { t: base,                 c: 1, g: {} },
      { t: base + 60_000,        c: 2, g: {} },   // même bucket → écrase
      { t: base + 30*60_000,     c: 5, g: {} },   // bucket +1
      { t: base + 60*60_000,     c: 9, g: {} },   // bucket +2
    ];
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.historyCoarse.map(p => p.c), [2, 5, 9]);
  });

  test('backfill ne s\'exécute pas si la série grossière existe déjà', async () => {
    const e = evt();
    e.history = [{ t: 1, c: 7, g: {} }];
    e.historyCoarse = [{ t: 1, c: 42 }];
    await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.deepEqual(evt().historyCoarse.map(p => p.c), [42], 'inchangée');
  });
});

// ── Cumuls entrées/sorties dans l'historique (i/o) ───────────────────────────

describe('Cumuls i/o dans l\'historique', () => {
  test('le point fin porte les cumuls i/o en plus du net c', () => {
    grp().count = 4; grp().totalIn = 30; grp().totalOut = 26;
    recordHistory();
    const h = evt().history.at(-1);
    assert.equal(h.c, 4,  'c = présents (net)');
    assert.equal(h.i, 30, 'i = entrées cumulées');
    assert.equal(h.o, 26, 'o = sorties cumulées');
  });

  test('le point grossier porte aussi i/o', () => {
    grp().count = 4; grp().totalIn = 30; grp().totalOut = 26;
    recordHistoryCoarse();
    const c = evt().historyCoarse.at(-1);
    assert.equal(c.i, 30);
    assert.equal(c.o, 26);
    assert.equal(c.g, undefined, 'toujours pas de détail par groupe');
  });

  test('les cumuls montent quand le net redescend (un −1 ne décrémente pas i)', async () => {
    const e = evt();
    e.history = []; grp().count = 0; grp().totalIn = 0; grp().totalOut = 0;
    await request(server).post('/api/count')
      .send({ delta: 5, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    await request(server).post('/api/count')
      .send({ delta: -1, uuid: randomUUID(), e: EVT_ID, g: GRP_ID });
    recordHistory();
    const h = e.history.at(-1);
    assert.equal(h.c, 4, 'net redescendu');
    assert.equal(h.i, 5, 'entrées cumulées inchangées par la sortie');
    assert.equal(h.o, 1);
  });

  test('reset-counts : c repart à 0, i/o survivent', async () => {
    grp().count = 10; grp().totalIn = 77; grp().totalOut = 67;
    await request(server).post('/api/reset-counts').send({ code: 'admin123', e: EVT_ID });
    const fin = evt().history.at(-1), gros = evt().historyCoarse.at(-1);
    assert.equal(fin.c, 0);
    assert.equal(fin.i, 77, 'cumul conservé dans le point fin');
    assert.equal(gros.c, 0);
    assert.equal(gros.i, 77, 'cumul conservé dans le point grossier');
  });

  test('backfill : i/o repris depuis l\'historique fin', async () => {
    const e = evt();
    e.historyCoarse = [];
    e.history = [{ t: 1, c: 3, i: 9, o: 6, g: {} }];
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.body.historyCoarse.at(-1).i, 9);
    assert.equal(res.body.historyCoarse.at(-1).o, 6);
  });

  test('backfill : point ancien sans i/o → pas de 0 inventé', async () => {
    const e = evt();
    e.historyCoarse = [];
    e.history = [{ t: 1, c: 3, g: {} }]; // point d'avant la feature
    const res = await request(server).get(`/api/history?code=admin123&e=${EVT_ID}`);
    assert.equal(res.body.historyCoarse.at(-1).c, 3);
    assert.equal(res.body.historyCoarse.at(-1).i, undefined, 'champ absent, pas 0');
  });
});
