import { env, runInDurableObject, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, beforeEach, afterEach } from 'vitest';
import worker from '../../src/index.js';
import { casDuContrat, creerBoite } from '../shared/api-contract.mjs';

// Contrat de l'API joué sur le WORKER (index.js + RegistryDO + EventDO, runtime workerd).
// Les scénarios sont dans tests/shared/api-contract.mjs, partagés avec le serveur local
// (tests/contract.test.js) : ce fichier ne fait que brancher la plateforme.
//
// Fichier distinct de worker.test.js → isolate et registre distincts : rien ici ne dépend
// du bloc « Plafond événements », et chaque scénario supprime les événements qu'il crée.

const BASE = 'http://do';

// Le Worker est appelé PAR SON EXPORT, pas par SELF.fetch : la latence de SELF.fetch
// croît avec le nombre d'appels déjà faits dans le fichier (mesuré : ~1 ms au départ,
// plus de 100 ms après 600 appels, même sur une route qui ne touche aucun DO ; 1 000
// appels d'affilée ne finissent pas en 2 min), alors que worker.fetch() reste sous 0,1 ms.
// Ce contrat fait ~1 300 requêtes. Même code exercé (routeur, auth, DO) ; seule la couche
// Workers Assets est court-circuitée, et worker.test.js la couvre (« / », /sw.js, upgrade WS).
async function appeler(url, init) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(url, init), env, ctx);
  return { r, fin: () => waitOnExecutionContext(ctx) };
}

// Une IP par test : les deux token buckets (Worker 600, EventDO 300) sont par IP — sans
// ça un test gourmand viderait le bucket des suivants.
let n = 0;
let ip = '198.51.100.1';
const ouverts = new Set();

beforeEach(() => { n += 1; ip = `198.51.${100 + (n >> 8)}.${n & 255}`; });

afterEach(() => {
  for (const sock of ouverts) { try { sock.close(); } catch {} }
  ouverts.clear();
});

async function requete(method, chemin, { corps, brut, type } = {}) {
  const data = brut !== undefined ? brut : (corps !== undefined && corps !== null ? JSON.stringify(corps) : null);
  const headers = { 'cf-connecting-ip': ip };
  if (data !== null) headers['Content-Type'] = type ?? 'application/json';
  const init = { method, headers };
  if (data !== null) init.body = data;
  const { r, fin } = await appeler(BASE + chemin, init);
  const text = await r.text();
  await fin(); // les ctx.waitUntil() du Worker (recalage du registre) sont terminés
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, header: (nom) => r.headers.get(nom) };
}

async function ouvrirWS(e, g) {
  const { r } = await appeler(`${BASE}/?${new URLSearchParams(g ? { e, g } : { e })}`, {
    headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip },
  });
  const boite = creerBoite();
  if (r.status !== 101 || !r.webSocket) {
    return { attendre: boite.attendre, silence: boite.silence, ferme: Promise.resolve(`refus:${r.status}`), envoyer() {}, fermer() {} };
  }
  const sock = r.webSocket;
  ouverts.add(sock);
  const ferme = new Promise((resolve) => sock.addEventListener('close', (ev) => resolve(ev.code)));
  sock.addEventListener('message', (ev) => boite.recevoir(typeof ev.data === 'string' ? ev.data : '(binaire)'));
  sock.accept();
  return {
    attendre: boite.attendre,
    silence:  boite.silence,
    ferme,
    envoyer(x) { sock.send(typeof x === 'string' || x instanceof Uint8Array ? x : JSON.stringify(x)); },
    fermer() { sock.close(); },
  };
}

const api = {
  plateforme: 'cloud',
  ADMIN: 'admin123',
  get:  (chemin) => requete('GET', chemin),
  post: (chemin, corps, opts = {}) => requete('POST', chemin, { corps, ...opts }),
  // Un tir d'alarme : c'est elle qui échantillonne l'historique (toutes les 30 s en prod).
  echantillonner: (e) => runInDurableObject(env.EVENT.get(env.EVENT.idFromName(e)), (inst) => inst.alarm()),
  ws: (e, g) => ouvrirWS(e, g),
};

describe('Contrat API — Worker Cloudflare', () => {
  for (const c of casDuContrat()) {
    // it.fails : le cas DOIT échouer tant que le défaut est là — et vitest le signale le
    // jour où il passe, pour qu'on retire la mention `defaut` du contrat.
    const enregistrer = c.defaut.cloud ? it.fails : it;
    enregistrer(`${c.groupe} — ${c.nom}`, () => c.run(api), 30_000);
  }
});
