'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');

const { server, state, seenOps, trimSeenOps } = require('../server');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function resetState() {
  state.count    = 0;
  state.totalIn  = 0;
  state.totalOut = 0;
  state.capacity = 100;
  state.adminCode = 'admin123';
  state.history  = [];
  seenOps.clear();
}

before(() => new Promise(resolve => server.listen(0, resolve)));
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(resetState);

// ── GET /api/state ────────────────────────────────────────────────────────────

describe('GET /api/state', () => {
  test('retourne count et capacity', async () => {
    const res = await request(server).get('/api/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.equal(res.body.capacity, 100);
  });

  test('reflète les mutations d\'état', async () => {
    state.count = 42;
    state.capacity = 300;
    const res = await request(server).get('/api/state');
    assert.equal(res.body.count, 42);
    assert.equal(res.body.capacity, 300);
  });
});

// ── POST /api/count — validation entrées ──────────────────────────────────────

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

// ── POST /api/count — mutations d\'état ───────────────────────────────────────

describe('POST /api/count — mutations', () => {
  test('+1 incrémente', async () => {
    const res = await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(state.count, 1);
  });

  test('+5 incrémente de 5', async () => {
    const res = await request(server).post('/api/count').send({ delta: 5, uuid: randomUUID() });
    assert.equal(res.body.count, 5);
  });

  test('-1 décrémente', async () => {
    state.count = 5;
    const res = await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    assert.equal(res.body.count, 4);
  });

  test('-5 décrémente de 5', async () => {
    state.count = 10;
    const res = await request(server).post('/api/count').send({ delta: -5, uuid: randomUUID() });
    assert.equal(res.body.count, 5);
  });

  test('plusieurs opérations s\'accumulent', async () => {
    await request(server).post('/api/count').send({ delta: 1,  uuid: randomUUID() });
    await request(server).post('/api/count').send({ delta: 1,  uuid: randomUUID() });
    await request(server).post('/api/count').send({ delta: 5,  uuid: randomUUID() });
    const res = await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    assert.equal(res.body.count, 6);
  });

  test('totalIn et totalOut trackés correctement', async () => {
    await request(server).post('/api/count').send({ delta: 5,  uuid: randomUUID() });
    await request(server).post('/api/count').send({ delta: 1,  uuid: randomUUID() });
    await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    assert.equal(state.totalIn,  6);
    assert.equal(state.totalOut, 1);
  });

  test('50 opérations concurrentes sans corruption', async () => {
    const ops = Array.from({ length: 50 }, () =>
      request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() })
    );
    await Promise.all(ops);
    assert.equal(state.count,   50);
    assert.equal(state.totalIn, 50);
  });
});

// ── POST /api/count — plancher à zéro ────────────────────────────────────────

describe('POST /api/count — jamais négatif', () => {
  test('-1 depuis 0 reste à 0', async () => {
    const res = await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    assert.equal(res.body.count, 0);
    assert.equal(state.count,    0);
  });

  test('-5 depuis 3 reste à 0', async () => {
    state.count = 3;
    const res = await request(server).post('/api/count').send({ delta: -5, uuid: randomUUID() });
    assert.equal(res.body.count, 0);
  });

  test('10 soustractions depuis 5 ne passent jamais sous 0', async () => {
    state.count = 5;
    for (let i = 0; i < 10; i++) {
      await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    }
    assert.equal(state.count, 0);
  });
});

// ── POST /api/count — alerte capacité ────────────────────────────────────────

describe('POST /api/count — alerte capacité', () => {
  test('alert=false sous la capacité', async () => {
    state.count = 98;
    const res = await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    assert.equal(res.body.alert, false);
  });

  test('alert=true quand count atteint exactement la capacité', async () => {
    state.count = 99;
    const res = await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    assert.equal(res.body.count, 100);
    assert.equal(res.body.alert, true);
  });

  test('alert=true quand count dépasse la capacité', async () => {
    state.count    = 100;
    state.capacity = 100;
    const res = await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    assert.equal(res.body.alert, true);
  });

  test('alert=false après redescente sous la capacité', async () => {
    state.count    = 100;
    state.capacity = 100;
    const res = await request(server).post('/api/count').send({ delta: -1, uuid: randomUUID() });
    assert.equal(res.body.alert, false);
  });
});

// ── POST /api/count — déduplication UUID ─────────────────────────────────────

describe('POST /api/count — déduplication', () => {
  test('même UUID → 2e appel retourne dup:true, count inchangé', async () => {
    const uuid = randomUUID();
    await request(server).post('/api/count').send({ delta: 1, uuid });
    const res = await request(server).post('/api/count').send({ delta: 1, uuid });
    assert.equal(res.body.dup,   true);
    assert.equal(res.body.count, 1);
    assert.equal(state.count,    1);
  });

  test('UUIDs différents → tous appliqués', async () => {
    await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    await request(server).post('/api/count').send({ delta: 1, uuid: randomUUID() });
    assert.equal(state.count, 2);
  });

  test('replay de queue offline : 3 envois du même UUID → compté une seule fois', async () => {
    const uuid = randomUUID();
    const [r1, r2, r3] = await Promise.all([
      request(server).post('/api/count').send({ delta: 1, uuid }),
      request(server).post('/api/count').send({ delta: 1, uuid }),
      request(server).post('/api/count').send({ delta: 1, uuid }),
    ]);
    const dups = [r1.body.dup, r2.body.dup, r3.body.dup];
    assert.equal(dups.filter(d => !d).length, 1,  'exactement 1 opération acceptée');
    assert.equal(dups.filter(Boolean).length,  2,  '2 doublons rejetés');
    assert.equal(state.count, 1);
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
    state.count    = 42;
    state.capacity = 200;
    state.totalIn  = 55;
    state.totalOut = 13;
    const res = await request(server).get('/api/history?code=admin123');
    assert.equal(res.status, 200);
    assert.equal(res.body.count,    42);
    assert.equal(res.body.capacity, 200);
    assert.equal(res.body.totalIn,  55);
    assert.equal(res.body.totalOut, 13);
    assert.ok(Array.isArray(res.body.history));
  });
});

// ── POST /api/admin/config ────────────────────────────────────────────────────

describe('POST /api/admin/config', () => {
  test('mauvais code → 403', async () => {
    const res = await request(server)
      .post('/api/admin/config')
      .send({ code: 'wrong', capacity: 50 });
    assert.equal(res.status, 403);
  });

  test('mise à jour de la capacité', async () => {
    const res = await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', capacity: 250 });
    assert.equal(res.body.ok,       true);
    assert.equal(res.body.capacity, 250);
    assert.equal(state.capacity,    250);
  });

  test('capacité arrondie à l\'entier', async () => {
    await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', capacity: 150.7 });
    assert.equal(state.capacity, 151);
  });

  test('capacité négative → ignorée', async () => {
    await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', capacity: -10 });
    assert.equal(state.capacity, 100);
  });

  test('capacité zéro → ignorée', async () => {
    await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', capacity: 0 });
    assert.equal(state.capacity, 100);
  });

  test('reset=true → count=0, totalIn=0, totalOut=0, seenOps vidé', async () => {
    state.count    = 50;
    state.totalIn  = 60;
    state.totalOut = 10;
    seenOps.add('old-uuid');

    const res = await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', reset: true });
    assert.equal(res.body.ok,  true);
    assert.equal(state.count,    0);
    assert.equal(state.totalIn,  0);
    assert.equal(state.totalOut, 0);
    assert.equal(seenOps.size,   0);
  });

  test('changement de code : nouveau code fonctionne, ancien échoue', async () => {
    await request(server)
      .post('/api/admin/config')
      .send({ code: 'admin123', newCode: 'newpass99' });
    assert.equal(state.adminCode, 'newpass99');

    const bad = await request(server).get('/api/history?code=admin123');
    assert.equal(bad.status, 403);

    const ok = await request(server).get('/api/history?code=newpass99');
    assert.equal(ok.status, 200);
  });

  test('nouveau code trop court (<4 car.) → ignoré', async () => {
    await request(server)
      .post('/api/admin/config')
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
    const res = await request(server).get('/api/qr?code=admin123');
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
    for (let i = 0; i < 100; i++) seenOps.add(String(i));
    trimSeenOps();
    assert.equal(seenOps.size, 100);
  });

  test('exactement 20 001 entrées → trimmé à 10 000', () => {
    for (let i = 0; i < 20001; i++) seenOps.add(String(i));
    trimSeenOps();
    assert.equal(seenOps.size, 10000);
  });

  test('après trim, les 10 000 plus récents sont conservés', () => {
    for (let i = 0; i < 20001; i++) seenOps.add(String(i));
    trimSeenOps();
    // premiers (anciens) absents
    assert.ok(!seenOps.has('0'));
    assert.ok(!seenOps.has('9999'));
    // derniers (récents) présents
    assert.ok(seenOps.has('10001'));
    assert.ok(seenOps.has('20000'));
  });

  test('double trim → taille stable à 10 000', () => {
    for (let i = 0; i < 20001; i++) seenOps.add(String(i));
    trimSeenOps();
    trimSeenOps(); // 10 000 < seuil → pas de second trim
    assert.equal(seenOps.size, 10000);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

describe('WebSocket', () => {
  function wsUrl() {
    return `ws://localhost:${server.address().port}`;
  }

  test('connexion → reçoit message init avec count et capacity', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', (data) => {
      const msg = JSON.parse(data);
      assert.equal(msg.type, 'init');
      assert.equal(typeof msg.count,    'number');
      assert.equal(typeof msg.capacity, 'number');
      ws.close();
      done();
    });
    ws.on('error', done);
  });

  test('POST /api/count → broadcast type:update à tous les clients', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      // init reçu — on attend maintenant l'update
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type,  'update');
        assert.equal(msg.delta,  1);
        assert.equal(msg.count,  1);
        assert.equal(typeof msg.alert, 'boolean');
        ws.close();
        done();
      });
      request(server)
        .post('/api/count')
        .send({ delta: 1, uuid: randomUUID() })
        .end(() => {});
    });
    ws.on('error', done);
  });

  test('POST /api/admin/config → broadcast type:config', (_t, done) => {
    const ws = new WebSocket(wsUrl());
    ws.once('message', () => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data);
        assert.equal(msg.type,     'config');
        assert.equal(msg.capacity,  500);
        ws.close();
        done();
      });
      request(server)
        .post('/api/admin/config')
        .send({ code: 'admin123', capacity: 500 })
        .end(() => {});
    });
    ws.on('error', done);
  });
});
