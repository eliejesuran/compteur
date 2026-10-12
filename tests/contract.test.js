'use strict';

// Contrat de l'API joué sur le serveur LOCAL (Express + ws).
// Les scénarios sont dans tests/shared/api-contract.mjs, partagés avec le Worker
// (tests/worker/contract.test.js) : ce fichier ne fait que brancher la plateforme.

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const http = require('node:http');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

// AVANT le require de server.js (STATE_FILE est lu à l'import, cf. server.test.js).
process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'compteur-contrat-')), 'state.json');
// Express n'écrit pas la pile des erreurs 4xx/5xx sur stderr en environnement de test :
// les corps volontairement illisibles du contrat noyaient la sortie.
process.env.NODE_ENV = 'test';

const { server, state, eventSeenOps, wsClients, recentlyDisconnected, rlBuckets, recordHistory, recordHistoryCoarse } = require('../server');

let port = 0;
const ouverts = new Set(); // sockets du test en cours : TOUJOURS fermés en fin de test

before(() => new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); })));
after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  state.adminCode = 'admin123';
  state.permCode  = null;
  state.events    = {};
  eventSeenOps.clear();
  recentlyDisconnected.clear();
  rlBuckets.clear(); // toutes les requêtes viennent de la même IP (loopback)
});

// Un socket laissé ouvert empêche server.close() de résoudre : la suite pendrait.
afterEach(async () => {
  const fermetures = [...ouverts].map((sock) => new Promise((resolve) => {
    if (sock.readyState === WebSocket.CLOSED) return resolve();
    sock.once('close', resolve);
    sock.terminate();
  }));
  ouverts.clear();
  await Promise.all(fermetures);
  wsClients.clear();
});

function requete(method, chemin, { corps, brut, type } = {}) {
  return new Promise((resolve, reject) => {
    const data = brut !== undefined ? brut : (corps !== undefined && corps !== null ? JSON.stringify(corps) : null);
    const headers = {};
    if (data !== null) {
      headers['Content-Type'] = type ?? 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    // agent:false → une connexion par requête, fermée aussitôt (rien ne retient server.close()).
    const req = http.request({ host: '127.0.0.1', port, path: chemin, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json, header: (n) => res.headers[n.toLowerCase()] });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function ouvrirWS(e, g, creerBoite) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/?${new URLSearchParams(g ? { e, g } : { e })}`);
  ouverts.add(sock);
  const boite = creerBoite();
  const ferme = new Promise((resolve) => {
    sock.on('close', (code) => resolve(code));
    sock.on('unexpected-response', (_req, res) => { resolve(`refus:${res.statusCode}`); sock.terminate(); });
    sock.on('error', () => {}); // suivi d'un close
  });
  sock.on('message', (data, binaire) => boite.recevoir(binaire ? '(binaire)' : data.toString()));
  await Promise.race([new Promise((resolve) => sock.once('open', resolve)), ferme]);
  return {
    attendre: boite.attendre,
    silence:  boite.silence,
    ferme,
    envoyer(x) {
      sock.send(typeof x === 'string' || x instanceof Uint8Array ? x : JSON.stringify(x));
    },
    fermer() { sock.close(); },
  };
}

describe('Contrat API — serveur local', async () => {
  const { casDuContrat, creerBoite } = await import('./shared/api-contract.mjs');

  const api = {
    plateforme: 'local',
    ADMIN: 'admin123',
    get:  (chemin) => requete('GET', chemin),
    post: (chemin, corps, opts = {}) => requete('POST', chemin, { corps, ...opts }),
    echantillonner() { recordHistory(); recordHistoryCoarse(); },
    ws: (e, g) => ouvrirWS(e, g, creerBoite),
  };

  for (const c of casDuContrat()) {
    const opts = { timeout: 30_000 };
    if (c.defaut.local) opts.todo = `défaut connu — ${c.defaut.local}`;
    test(`${c.groupe} — ${c.nom}`, opts, () => c.run(api));
  }
});
