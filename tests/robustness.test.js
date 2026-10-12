'use strict';

// Robustesse du serveur LOCAL — ce que le contrat d'API (contract.test.js) ne peut pas
// couvrir en restant dans le processus de test :
//   1. le VRAI processus `node server.js` (bloc `require.main`) : démarrage, restauration
//      de state.json, fichier corrompu, arrêt ;
//   2. les requêtes qui font TOMBER le processus — on ne peut les jouer que dans un enfant.
// Plus quelques invariants internes (rate-limit, persistance) accessibles par import.
//
// Les cas « le serveur survit », « arrêt propre » et « tout juste créés » décrivent des
// défauts trouvés le 2026-10-12 et corrigés depuis (V1, V3, V9 dans CLAUDE.md).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net  = require('node:net');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const RACINE = path.join(__dirname, '..');
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'compteur-robustesse-'));

// AVANT le require de server.js (STATE_FILE est lu à l'import).
process.env.STATE_FILE = path.join(TMP, 'in-process.json');
process.env.NODE_ENV = 'test';
const srv = require('../server');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T = { timeout: 30_000 }; // processus enfants : large, la machine peut être chargée

// ── Outils : un vrai serveur dans un processus enfant ────────────────────────

let n = 0;
const fichierEtat = () => path.join(TMP, `state-${++n}.json`);

function portLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Le port est choisi puis relâché avant que l'enfant ne l'écoute : un autre fichier de
// test (ils tournent en parallèle) peut le prendre entre-temps. Rare, mais on réessaie.
async function lancer(stateFile) {
  for (let essai = 1; ; essai++) {
    try { return await lancerUneFois(stateFile); }
    catch (err) { if (essai === 3) throw err; }
  }
}

async function lancerUneFois(stateFile) {
  const port = await portLibre();
  const cp = spawn(process.execPath, [path.join(RACINE, 'server.js')], {
    env: { ...process.env, PORT: String(port), STATE_FILE: stateFile, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sortie = '', erreurs = '';
  cp.stdout.on('data', (d) => { sortie += d; });
  cp.stderr.on('data', (d) => { erreurs += d; });
  const mort = new Promise((resolve) => cp.once('exit', (code, signal) => resolve({ code, signal })));

  // Prêt = la bannière de démarrage est affichée (server.listen a abouti).
  const debut = Date.now();
  while (!sortie.includes('Code admin')) {
    if (cp.exitCode !== null || cp.signalCode !== null) throw new Error(`le serveur n'a pas démarré :\n${erreurs}`);
    if (Date.now() - debut > 20_000) { cp.kill('SIGKILL'); throw new Error('démarrage trop long'); }
    await pause(25);
  }

  const proc = {
    port, cp, mort,
    sortie: () => sortie,
    erreurs: () => erreurs,
    vivant: () => cp.exitCode === null && cp.signalCode === null,
    async arreter(signal = 'SIGKILL') {
      if (proc.vivant()) cp.kill(signal);
      return mort;
    },
    requete(method, chemin, corps) {
      return new Promise((resolve) => {
        const data = corps === undefined ? null : JSON.stringify(corps);
        const headers = data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
        const req = http.request({ host: '127.0.0.1', port, path: chemin, method, headers, agent: false }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { text += d; });
          res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
        });
        req.on('error', (err) => resolve({ status: 0, erreur: err.code })); // serveur tombé
        req.setTimeout(8000, () => req.destroy());
        if (data !== null) req.write(data);
        req.end();
      });
    },
    get: (chemin) => proc.requete('GET', chemin),
    post: (chemin, corps) => proc.requete('POST', chemin, corps),
    async creerEvenement(name = 'Soirée') {
      const r = await proc.post('/api/events', { code: 'admin123', name });
      assert.equal(r.status, 200, 'création de l\'événement');
      return { e: r.json.id, g: r.json.groups[0].id };
    },
    // « Répond encore » : plus parlant que « le processus existe » (un serveur bloqué existe).
    async repondEncore() {
      await pause(300); // laisse à l'exception le temps de tuer le processus
      if (!proc.vivant()) return false;
      return (await proc.get('/api/events?code=admin123')).status === 200;
    },
  };
  return proc;
}

// Attend que state.json contienne `motif` (écriture différée de 500 ms après un comptage).
async function attendreSurDisque(stateFile, motif, ms = 10_000) {
  const debut = Date.now();
  while (Date.now() - debut < ms) {
    try { if (fs.readFileSync(stateFile, 'utf8').includes(motif)) return; } catch {}
    await pause(50);
  }
  throw new Error(`« ${motif} » jamais écrit dans ${path.basename(stateFile)}`);
}

// ── 1. Requêtes qui ne doivent pas faire tomber le serveur ───────────────────
// Une exception dans `wss.on('connection')` remonte en uncaughtException et TUE le
// processus. Le WebSocket n'est pas authentifié : avant le correctif, une seule requête
// depuis n'importe quel appareil du réseau suffisait (`?e=__proto__`, URL invalide).

describe('Le serveur survit aux requêtes hostiles', () => {
  for (const cible of ['?e=__proto__', '?e=__proto__&g=x', '?e=constructor', '?e=toString&g=a', '?e=hasOwnProperty']) {
    test(`WebSocket ${cible} : fermé en 4004 comme n'importe quel événement inconnu`, T, async (t) => {
      const p = await lancer(fichierEtat());
      t.after(() => p.arreter());
      const { e, g } = await p.creerEvenement();

      const ws = new WebSocket(`ws://127.0.0.1:${p.port}/${cible}`);
      ws.on('error', () => {});
      t.after(() => ws.terminate());
      const code = await Promise.race([new Promise((resolve) => ws.once('close', resolve)), pause(5000).then(() => 'aucune fermeture')]);

      assert.equal(await p.repondEncore(), true, `serveur tombé :\n${p.erreurs().split('\n').slice(0, 6).join('\n')}`);
      assert.equal(code, 4004);
      assert.equal((await p.get(`/api/state?e=${e}&g=${g}`)).status, 200, 'les événements existants répondent toujours');
    });
  }

  test('requête d\'upgrade WebSocket dont l\'URL est invalide', T, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());

    const sock = net.connect(p.port, '127.0.0.1', () => {
      sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('error', () => {});
    t.after(() => sock.destroy());

    assert.equal(await p.repondEncore(), true, `serveur tombé :\n${p.erreurs().split('\n').slice(0, 6).join('\n')}`);
  });

  // R3 (CLAUDE.md) : handler Express async. Le rejet de QRCode.toDataURL n'était pas
  // « juste » non géré : depuis Node 15 un rejet non géré arrête le processus, et le code
  // PERM (lecture seule) suffisait à le déclencher.
  test('/api/qr avec des identifiants trop longs pour tenir dans un QR code : 404, le serveur vit', T, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());

    const r = await p.get(`/api/qr?code=admin123&e=${'a'.repeat(4000)}&g=x`);
    assert.equal(await p.repondEncore(), true, `serveur tombé :\n${p.erreurs().split('\n').slice(0, 6).join('\n')}`);
    assert.equal(r.status, 404, 'événement inconnu : aucun QR n\'est fabriqué');
  });

  // Même avec un événement et un groupe valides, l'URL encodée contient l'en-tête Host :
  // démesuré, il ne tient pas dans un QR code et QRCode rejette. Le rejet doit être rattrapé.
  test('/api/qr quand la génération échoue (en-tête Host démesuré) : 500 en JSON, le serveur vit', T, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());
    const { e, g } = await p.creerEvenement();

    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p.port, path: `/api/qr?code=admin123&e=${e}&g=${g}`, agent: false,
        headers: { Host: `${'h'.repeat(3500)}.example` } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
      });
      req.on('error', (err) => resolve({ status: 0, erreur: err.code }));
      req.end();
    });
    assert.equal(await p.repondEncore(), true, `serveur tombé :\n${p.erreurs().split('\n').slice(0, 6).join('\n')}`);
    assert.equal(r.status, 500);
    assert.equal(typeof r.json?.error, 'string');
    assert.equal((await p.get(`/api/qr?code=admin123&e=${e}&g=${g}`)).status, 200, 'la requête normale suivante passe');
  });

  test('messages WebSocket hostiles sur une vraie connexion (binaire, 1 Mo, JSON piégé)', T, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());
    const { e, g } = await p.creerEvenement();

    const ws = new WebSocket(`ws://127.0.0.1:${p.port}/?e=${e}&g=${g}`);
    t.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    for (const bruit of ['{"type":"hello","name":"__proto__"}', '{"__proto__":{"type":"ping"}}', '{"type":"hello","name":"x","constructor":{"prototype":1}}',
      'x'.repeat(1024 * 1024), Buffer.alloc(64 * 1024, 0xff), '{'.repeat(10_000)]) {
      ws.send(bruit);
    }
    assert.equal(await p.repondEncore(), true, `serveur tombé :\n${p.erreurs().split('\n').slice(0, 6).join('\n')}`);
    assert.equal((await p.post('/api/count', { e, g, delta: 1, uuid: 'apres-bruit' })).json.total, 1, 'le comptage continue');
  });

  test('rafale de 50 connexions WebSocket ouvertes puis coupées net', T, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());
    const { e, g } = await p.creerEvenement();

    const socks = Array.from({ length: 50 }, () => new WebSocket(`ws://127.0.0.1:${p.port}/?e=${e}&g=${g}`));
    t.after(() => socks.forEach((s) => s.terminate()));
    await Promise.all(socks.map((s) => new Promise((resolve) => { s.once('open', resolve); s.once('error', resolve); })));
    socks.forEach((s, i) => { try { s.send(JSON.stringify({ type: 'hello', name: `Op${i}` })); } catch {} });
    const nommes = async () => (await p.get(`/api/clients?code=admin123&e=${e}`)).json?.clients.length ?? 0;
    for (let i = 0; i < 100 && await nommes() < 50; i++) await pause(50); // les 50 hello sont traités
    assert.equal(await nommes(), 50, 'les 50 opérateurs sont connectés');

    socks.forEach((s) => s.terminate()); // coupure sans poignée de main de fermeture
    assert.equal(await p.repondEncore(), true);
    assert.equal(await nommes(), 50, 'tous restent listés pendant la période de grâce');
  });
});

// N9 : le serveur envoie un ping WebSocket toutes les 30 s et coupe au tir suivant les
// connexions qui n'ont pas répondu — sans ça les connexions TCP mortes (téléphone sorti
// du Wi-Fi sans fermer) s'accumulent. Test LENT par nature (deux tirs de 30 s).
describe('Heartbeat serveur (N9)', () => {
  const lent = process.env.TESTS_LENTS ? false : 'lent (≈ 65 s) — pour le jouer : TESTS_LENTS=1 npm run test:local';

  test('une connexion qui ne répond plus aux pings est coupée, une connexion vivante est gardée', { timeout: 120_000, skip: lent }, async (t) => {
    const p = await lancer(fichierEtat());
    t.after(() => p.arreter());
    const { e, g } = await p.creerEvenement();

    // Vivante : un vrai client WebSocket répond aux pings tout seul.
    const vivante = new WebSocket(`ws://127.0.0.1:${p.port}/?e=${e}&g=${g}`);
    t.after(() => vivante.terminate());
    // Morte : poignée de main faite à la main sur une socket brute, qui ne répondra jamais.
    const morte = net.connect(p.port, '127.0.0.1');
    t.after(() => morte.destroy());
    morte.on('error', () => {});
    morte.on('data', () => {});
    await new Promise((resolve) => morte.once('connect', resolve));
    morte.write(`GET /?e=${e}&g=${g} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');

    const debut = Date.now();
    const duree = await new Promise((resolve) => morte.once('close', () => resolve(Date.now() - debut)));
    assert.ok(duree > 25_000 && duree < 75_000, `connexion muette coupée après ${duree} ms (attendu : entre un et deux tirs de 30 s)`);
    assert.equal(vivante.readyState, WebSocket.OPEN, 'la connexion qui répond aux pings ne doit pas être coupée');
  });
});

// ── 2. Démarrage, restauration, arrêt ────────────────────────────────────────

describe('Démarrage et persistance (vrai processus)', () => {
  test('redémarrage brutal : événements, compteurs, opérateurs, codes et uuid déjà vus sont restaurés', T, async (t) => {
    const etat = fichierEtat();
    let p = await lancer(etat);
    t.after(() => p.arreter());

    const { e, g } = await p.creerEvenement('Nuit blanche');
    await p.post('/api/admin/config', { code: 'admin123', e, capacity: 250, newPermCode: 'perm-1234' });
    await p.post('/api/count', { e, g, delta: 5, uuid: 'deja-vu', name: 'Alice' });
    await attendreSurDisque(etat, 'deja-vu');
    await p.arreter('SIGKILL'); // panne : aucune chance de sauvegarder en partant

    p = await lancer(etat);
    assert.match(p.sortie(), /État restauré : 1 événement/);
    assert.deepEqual((await p.get(`/api/state?e=${e}&g=${g}`)).json,
      { total: 5, groupCount: 5, capacity: 250, eventName: 'Nuit blanche', groupName: 'Principal' });
    const h = (await p.get(`/api/history?code=perm-1234&e=${e}`)).json;
    assert.deepEqual(h.groups[0].opStats, { Alice: { in: 5, out: 0 } }, 'stats opérateur + code PERM restaurés');
    // L'opérateur dont l'accusé de réception s'est perdu renvoie son op après le redémarrage.
    assert.deepEqual((await p.post('/api/count', { e, g, delta: 5, uuid: 'deja-vu', name: 'Alice' })).json,
      { total: 5, dup: true }, 'un uuid d\'avant la panne reste un doublon');
  });

  // Le fichier illisible doit être mis de côté : sans ça le serveur démarre à vide et
  // l'ÉCRASE à la première sauvegarde — la soirée est perdue sans récupération possible.
  test('state.json corrompu : mis de côté sous .corrupt-*, jamais écrasé, le serveur démarre', T, async (t) => {
    const etat = fichierEtat();
    const casse = '{"adminCode":"admin123","events":{"abc123":{"id":"abc123","name":"Soirée","groups":{"def4';
    fs.writeFileSync(etat, casse);

    const p = await lancer(etat);
    t.after(() => p.arreter());
    assert.deepEqual((await p.get('/api/events?code=admin123')).json.events, [], 'démarre sans événement');

    const copies = fs.readdirSync(TMP).filter((f) => f.startsWith(`${path.basename(etat)}.corrupt-`));
    assert.equal(copies.length, 1, 'une copie .corrupt-<horodatage>');
    assert.equal(fs.readFileSync(path.join(TMP, copies[0]), 'utf8'), casse, 'contenu d\'origine intact');

    // Le serveur reprend une vie normale, et la copie n'est pas touchée par les écritures.
    const { e, g } = await p.creerEvenement();
    await p.post('/api/count', { e, g, delta: 1, uuid: 'apres-corruption' });
    await attendreSurDisque(etat, 'apres-corruption');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(etat, 'utf8')), 'le nouveau state.json est complet');
    assert.equal(fs.readFileSync(path.join(TMP, copies[0]), 'utf8'), casse);
  });

  test('state.json vide, ancien format ou .tmp orphelin d\'un crash précédent : le serveur démarre et sauvegarde', T, async (t) => {
    for (const [nom, contenu, tmp] of [['vide', '', false], ['ancien format', '{"count":12,"capacity":80}', false], ['null', 'null', false], ['.tmp orphelin', null, true]]) {
      const etat = fichierEtat();
      if (contenu !== null) fs.writeFileSync(etat, contenu);
      if (tmp) fs.writeFileSync(`${etat}.tmp`, '{"events":{"moitié d\'écri');

      const p = await lancer(etat);
      t.after(() => p.arreter());
      const { e, g } = await p.creerEvenement();
      assert.equal((await p.post('/api/count', { e, g, delta: 1, uuid: `u-${nom}` })).json.total, 1, nom);
      await attendreSurDisque(etat, `u-${nom}`);
      assert.equal(JSON.parse(fs.readFileSync(etat, 'utf8')).events[e].groups[g].count, 1, nom);
      assert.equal(fs.existsSync(`${etat}.tmp`), false, `${nom} : pas de .tmp résiduel après une écriture réussie`);
      await p.arreter();
    }
  });

  // Sans scheduleSave() à la création, rien n'était écrit avant le premier comptage ou la
  // sauvegarde périodique (30 s) : un redémarrage dans l'intervalle, et les QR codes déjà
  // distribués pointaient vers un événement qui n'existait plus.
  test('un événement tout juste créé survit à un redémarrage', T, async (t) => {
    const etat = fichierEtat();
    let p = await lancer(etat);
    t.after(() => p.arreter());
    const { e, g } = await p.creerEvenement('Créé à l\'instant');
    await pause(1500); // bien plus que les 500 ms de l'écriture différée, bien moins que les 30 s
    await p.arreter('SIGKILL');

    p = await lancer(etat);
    assert.equal((await p.get(`/api/state?e=${e}&g=${g}`)).status, 200, 'le QR distribué avant la panne doit encore fonctionner');
  });

  // Deux tests séparés : créés coup sur coup, la sauvegarde de l'un emporterait l'autre et
  // masquerait l'oubli (constaté : un seul test ne faisait tomber aucune des deux mutations).
  test('un groupe tout juste créé survit à un redémarrage', T, async (t) => {
    const etat = fichierEtat();
    let p = await lancer(etat);
    t.after(() => p.arreter());
    const { e } = await p.creerEvenement();
    await attendreSurDisque(etat, e); // l'événement est écrit : seule la création du groupe reste à sauver
    const g2 = (await p.post('/api/groups', { code: 'admin123', e, name: 'Porte B' })).json.id;
    await pause(1500);
    await p.arreter('SIGKILL');

    p = await lancer(etat);
    assert.equal((await p.get(`/api/state?e=${e}&g=${g2}`)).status, 200, 'le QR du nouveau groupe doit encore fonctionner');
  });

  // Ctrl+C pendant la soirée : l'écriture est différée de 500 ms après chaque comptage. Le
  // dernier clic a été acquitté — il n'est donc plus dans la file du téléphone — mais il
  // n'est pas encore sur le disque.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`arrêt propre (${signal}) juste après un comptage : le comptage acquitté est sur le disque`, T, async (t) => {
      const etat = fichierEtat();
      let p = await lancer(etat);
      t.after(() => p.arreter());
      const { e, g } = await p.creerEvenement();
      await p.post('/api/count', { e, g, delta: 1, uuid: 'premier' });
      await attendreSurDisque(etat, 'premier');

      const r = await p.post('/api/count', { e, g, delta: 1, uuid: 'dernier-clic' });
      assert.equal(r.json.total, 2, 'le serveur a acquitté le deuxième clic');
      await p.arreter(signal);

      p = await lancer(etat);
      assert.equal((await p.get(`/api/state?e=${e}&g=${g}`)).json.total, 2, 'le clic acquitté a disparu au redémarrage');
    });
  }
});

// ── 3. Invariants internes (dans le processus de test) ───────────────────────

const EVT = 'abc123', GRP = 'def456';

function etatNeuf() {
  srv.state.adminCode = 'admin123';
  srv.state.permCode  = null;
  srv.state.events = {
    [EVT]: {
      id: EVT, name: 'Test', capacity: 100, history: [], historyCoarse: [], createdAt: Date.now(), archived: false,
      groups: { [GRP]: { id: GRP, name: 'Principal', count: 0, totalIn: 0, totalOut: 0, opStats: {} } },
    },
  };
  srv.eventSeenOps.clear();
  srv.eventSeenOps.set(EVT, new Set());
  srv.rlBuckets.clear();
}

let port = 0;
before(() => new Promise((resolve) => srv.server.listen(0, () => { port = srv.server.address().port; resolve(); })));
after(() => new Promise((resolve) => srv.server.close(resolve)));
beforeEach(etatNeuf);

function compter(corps) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ e: EVT, g: GRP, ...corps });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/count', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, retryAfter: res.headers['retry-after'] }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('Rate-limit local (token bucket par IP)', () => {
  const bucket = () => [...srv.rlBuckets.values()][0];

  // Le bucket se recharge avec le temps (20 jetons/s) : entre « je vide le bucket » et « je
  // vérifie le 429 », 50 ms suffisent à rendre un jeton. Horloge FIGÉE → le test ne dépend
  // plus de la vitesse de la machine. (Serveur et test partagent le même processus.)
  async function horlogeFigee(fn) {
    const maintenant = Date.now(), vraieHorloge = Date.now;
    Date.now = () => maintenant;
    try { return await fn(maintenant); } finally { Date.now = vraieHorloge; }
  }

  test('un 429 ne « brûle » pas l\'uuid : l\'op rejouée plus tard est comptée, une seule fois', async () => {
    await compter({ delta: 1, uuid: 'amorce' });
    await horlogeFigee(async () => {
      bucket().tokens = 0; // bucket vidé, comme après une rafale

      const refus = await compter({ delta: 1, uuid: 'limite' });
      assert.equal(refus.status, 429);
      assert.equal(refus.retryAfter, '1');
      assert.equal(srv.state.events[EVT].groups[GRP].count, 1, 'rien n\'est compté pendant le 429');

      bucket().tokens = 5; // le bucket s'est rechargé
      assert.deepEqual((await compter({ delta: 1, uuid: 'limite' })).json, { total: 2, alert: false });
      assert.deepEqual((await compter({ delta: 1, uuid: 'limite' })).json, { total: 2, dup: true });
    });
  });

  test('le bucket se recharge à 20 jetons par seconde, plafonné à 300', async () => {
    await compter({ delta: 1, uuid: 'a' });
    await horlogeFigee(async (maintenant) => {
      const b = bucket();
      b.tokens = 0;
      b.lastMs = maintenant - 1000; // une seconde s'est écoulée
      assert.equal((await compter({ delta: 1, uuid: 'b' })).status, 200);
      assert.equal(b.tokens, 19, '20 jetons rendus en 1 s, 1 consommé');

      b.tokens = 0;
      b.lastMs = maintenant - 3_600_000; // une heure : pas plus que le plafond
      await compter({ delta: 1, uuid: 'c' });
      assert.equal(b.tokens, 299, 'plafonné à 300, 1 consommé');
    });
  });

  test('le bucket d\'une IP épuisée ne bloque pas les autres', async () => {
    srv.rlBuckets.set('203.0.113.50', { tokens: 0, lastMs: Date.now() });
    assert.equal((await compter({ delta: 1, uuid: 'x' })).status, 200);
  });

  test('au-delà de 500 IP, celles inactives depuis plus d\'une heure sont purgées', async () => {
    const vieux = Date.now() - 3_700_000;
    for (let i = 0; i < 600; i++) srv.rlBuckets.set(`10.0.${i >> 8}.${i & 255}`, { tokens: 300, lastMs: vieux });
    srv.rlBuckets.set('10.9.9.9', { tokens: 300, lastMs: Date.now() }); // active : conservée
    await compter({ delta: 1, uuid: 'purge' });
    assert.ok(srv.rlBuckets.size <= 3, `${srv.rlBuckets.size} entrées après la purge`);
    assert.ok(srv.rlBuckets.has('10.9.9.9'));
  });
});

describe('Persistance — aller-retour complet par le fichier', () => {
  test('tout ce qui est sauvegardé est relu à l\'identique', () => {
    const evt = srv.state.events[EVT];
    srv.state.adminCode = 'code & spécial "é"';
    srv.state.permCode  = 'perm-1234';
    evt.capacity = 250;
    evt.groups[GRP] = { id: GRP, name: 'Entrée "Nord" <b>', count: -3, totalIn: 40, totalOut: 43, opStats: { 'Zoé 🎉': { in: 40, out: 43 } } };
    evt.history = [{ t: 1, c: 5, i: 5, o: 0, g: { [GRP]: 5 } }, { t: 2, c: 0, g: {} }];
    evt.historyCoarse = [{ t: 1, c: 5, i: 5, o: 0 }];
    srv.eventSeenOps.set(EVT, new Set(['u1', 'u2']));
    const attendu = JSON.parse(JSON.stringify(srv.buildSnapshot()));

    srv.flushSave();
    const relu = JSON.parse(fs.readFileSync(srv.STATE_FILE, 'utf8'));
    assert.deepEqual(relu, attendu);

    etatNeuf(); // « redémarrage »
    srv.applySnapshot(relu);
    assert.deepEqual(JSON.parse(JSON.stringify(srv.buildSnapshot())), attendu);
    assert.equal(srv.checkAuth('perm-1234'), 'perm');
    assert.equal(srv.checkAuth('code & spécial "é"'), 'admin');
    assert.equal(srv.checkAuth('admin123'), null, 'l\'ancien code par défaut n\'ouvre plus rien');
  });

  test('applySnapshot ignore un contenu inutilisable sans toucher à l\'état courant', () => {
    srv.state.events[EVT].groups[GRP].count = 9;
    for (const mauvais of [null, undefined, 42, 'texte', [], {}, { adminCode: 'pirate' }, { events: null }]) {
      assert.doesNotThrow(() => srv.applySnapshot(mauvais), JSON.stringify(mauvais));
    }
    assert.equal(srv.state.events[EVT].groups[GRP].count, 9);
    assert.equal(srv.state.adminCode, 'admin123', 'un fichier sans `events` ne doit pas changer le code admin');
  });

  test('uuid déjà vus au mauvais format dans le fichier : ignorés, pas d\'exception', () => {
    const snap = { ...srv.buildSnapshot(), seenOps: { [EVT]: 'pas un tableau', autre: { a: 1 }, vide: null } };
    assert.doesNotThrow(() => srv.applySnapshot(snap));
    assert.ok(srv.eventSeenOps.get(EVT) instanceof Set);
  });

  test('le plafond de 50 événements compte les archivés ; en supprimer un libère une place', async () => {
    const creer = (name) => new Promise((resolve, reject) => {
      const data = JSON.stringify({ code: 'admin123', name });
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(data);
    });
    for (let i = 0; i < 49; i++) assert.equal((await creer(`E${i}`)).status, 200);
    srv.state.events[EVT].archived = true; // archiver ne libère PAS de place
    assert.equal((await creer('de trop')).status, 409);
    delete srv.state.events[EVT];
    assert.equal((await creer('place libérée')).status, 200);
  });
});

// Un state.json écrit AVANT le correctif peut contenir un total négatif (groupe d'entrée
// supprimé alors qu'un groupe de sortie était négatif). La formule de bornage suppose un
// total ≥ 0 : sans précaution, le premier clic « −1 » ajoutait |total| personnes, en entrées.
describe('Total négatif hérité d\'un ancien état', () => {
  test('le premier comptage ramène le total à 0, sans inventer d\'entrées', async () => {
    const evt = srv.state.events[EVT];
    evt.groups[GRP].count = -3; // comme après la suppression du groupe d'entrée
    evt.groups[GRP].totalOut = 3;

    assert.deepEqual((await compter({ delta: -1, uuid: 'moins', name: 'Zoé' })).json, { total: 0, alert: false });
    assert.deepEqual([evt.groups[GRP].count, evt.groups[GRP].totalIn, evt.groups[GRP].totalOut], [0, 0, 3]);
    assert.deepEqual(evt.groups[GRP].opStats, {}, 'aucune entrée attribuée à qui a cliqué « −1 »');

    assert.deepEqual((await compter({ delta: 1, uuid: 'plus', name: 'Zoé' })).json, { total: 1, alert: false });
    assert.deepEqual([evt.groups[GRP].count, evt.groups[GRP].totalIn], [1, 1], 'un +1 vaut une entrée, pas quatre');
  });
});

// « __proto__ » ne peut pas être une clé ordinaire : `opStats['__proto__'] = {…}` ne crée
// pas une entrée, il REMPLACE LE PROTOTYPE de la table. Rien ne fuit vers Object.prototype,
// mais la table des opérateurs n'est plus un objet ordinaire.
describe('Prénom « __proto__ »', () => {
  test('compté, pas suivi, et le prototype de la table des opérateurs n\'est pas remplacé', async () => {
    assert.deepEqual((await compter({ delta: 1, uuid: 'proto-1', name: '__proto__' })).json, { total: 1, alert: false });
    const { opStats, totalIn } = srv.state.events[EVT].groups[GRP];
    assert.equal(Object.getPrototypeOf(opStats), Object.prototype);
    assert.deepEqual(Object.keys(opStats), []);
    assert.equal(totalIn, 1);
  });
});

describe('WebSocket — entrée', () => {
  const fermeture = (url) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('aucune fermeture')); }, 5000);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.on('error', () => {});
  });

  test('sans paramètre e, ou avec un e vide → 4004', async () => {
    assert.equal(await fermeture(`ws://127.0.0.1:${port}/`), 4004);
    assert.equal(await fermeture(`ws://127.0.0.1:${port}/?e=`), 4004);
    assert.equal(await fermeture(`ws://127.0.0.1:${port}/?g=${GRP}`), 4004);
  });

  test('quel que soit le chemin de l\'URL, seuls e et g comptent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/n/importe/quoi?e=${EVT}&g=${GRP}`);
    const init = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pas d\'init')), 5000);
      ws.once('message', (d) => { clearTimeout(timer); resolve(JSON.parse(d)); });
      ws.once('error', reject);
    }).finally(() => ws.terminate());
    assert.equal(init.type, 'init');
  });
});
