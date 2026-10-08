'use strict';
// ── Coquille hors ligne de l'écran opérateur ─────────────────────────────────
// REX 2026-10 : réseau saturé, 2 opérateurs sur 12 dont la page s'est RECHARGÉE (onglet
// purgé par iOS, appli relancée, geste « recharger ») sont tombés sur la page d'erreur
// du navigateur. Leur file d'attente (localStorage) était intacte — il ne manquait que
// l'écran pour s'en servir. Ce service worker garde cet écran en cache.
//
// Périmètre VOLONTAIREMENT étroit : la coquille (index.html + logos + manifest + les
// 2 libs QR). Liste blanche, pas liste noire → /api/* n'y entre jamais (un total servi
// depuis un cache serait faux), ni admin/stats (inutiles sans réseau). Les POST et le
// WebSocket ne passent de toute façon pas par un service worker.
// La file d'attente, elle, reste en localStorage : Background Sync n'existe pas sur
// Safari iOS.

const CACHE = 'compteur-shell-v1'; // changer le suffixe = repartir d'un cache vide

// '/' = index.html, seule entrée obligatoire à l'installation.
const SHELL = ['/', '/manifest.json', '/logo.png', '/logo_white.png', '/icon.svg'];

// Libs QR de index.html : URL → empreinte SRI. URLs versionnées, donc immuables → cache
// d'abord. Le service worker les télécharge TOUJOURS avec cette empreinte : une réponse
// qui ne correspond pas est rejetée et n'entre jamais dans le cache. Sinon « cache
// d'abord » la resservirait indéfiniment, bloquée à chaque fois par le SRI de la balise
// <script>, sans que rien ne vienne la remplacer.
// À garder alignées avec les <script> de index.html (tests/sw.test.js échoue sinon).
const CDN = new Map([
  ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
    'sha384-hStSInNIZ8ljtOVrmrgf7zdHMapaLBWoSnPTtF0nzsybp4+LuhDz6sHuEVpWIX8o'],
  ['https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js',
    'sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA'],
]);

// Réseau d'abord, mais pas indéfiniment : sur un réseau SATURÉ (≠ coupé) la requête
// n'échoue pas, elle traîne. Passé ce délai on sert la copie en cache.
const NET_TIMEOUT_MS = 2000;

// Borne de la LECTURE du cache. Elle répond en quelques ms ; cette borne ne sert que si
// le stockage du téléphone ne répond plus du tout. Large exprès : trop courte, elle
// ferait croire « rien en cache » à un téléphone hors ligne dont le stockage est lent.
const CACHE_TIMEOUT_MS = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// '/index.html' et '/?e=…&g=…' désignent la même coquille que '/'.
function shellKey(url) {
  const p = url.pathname === '/index.html' ? '/' : url.pathname;
  return SHELL.includes(p) ? p : null;
}

// RÉSEAU SEUL — ne touche jamais au stockage. Rend { res, copy } : `copy()` fabrique un
// exemplaire à ranger dans le cache, ou vaut null si ce n'est pas un vrai 200 (5xx,
// redirection, réponse opaque : jamais en cache).
// Le corps est lu EN ENTIER avant de répondre, et la réponse reconstruite :
//  1. réseau saturé = les en-têtes arrivent, puis le corps cale. Tant qu'il n'est pas
//     complet, on ne considère pas que le réseau a répondu (cf. networkFirst) ;
//  2. une réponse reconstruite n'est jamais « redirected » — Workers Assets redirige
//     /x.html → /x, et une réponse redirigée ne peut pas servir une navigation.
async function download(request) {
  const res = await fetch(request);
  if (!res.ok) return { res, copy: null };
  const body = await res.blob();
  const copy = () => new Response(body, {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
  return { res: copy(), copy };
}

async function store(key, copy) {
  const cache = await caches.open(CACHE);
  await cache.put(key, copy());
}

// Lecture du cache BORNÉE, qui ne rejette jamais : entrée absente, stockage refusé ou
// stockage qui ne répond pas → undefined.
function lookup(key) {
  const hit = caches.open(CACHE)
    .then((cache) => cache.match(key, { ignoreVary: true }))
    .catch(() => undefined);
  return Promise.race([hit, sleep(CACHE_TIMEOUT_MS)]);
}

// La requête par laquelle le service worker va lui-même chercher une entrée du cache.
function netRequest(url) {
  return CDN.has(url)
    ? new Request(url, { integrity: CDN.get(url) })
    // no-cache = revalidation forcée : ne pas précacher une copie HTTP périmée.
    : new Request(url, { cache: 'no-cache' });
}

async function precache(url) {
  const { res, copy } = await download(netRequest(url));
  if (!copy) throw new Error(`${url} → ${res.status}`);
  await store(url, copy);
}

// Les deux stratégies rendent { response, done } SANS RIEN ATTENDRE, pour que le handler
// fetch appelle respondWith() et waitUntil() de façon synchrone (un waitUntil() tardif,
// après un await, repose sur une tolérance qu'on ne peut pas vérifier sur Safari iOS).
// `done` = le rangement dans le cache, qui se poursuit après la réponse.

function networkFirst(request, key) {
  // Le réseau part TOUT DE SUITE et ne dépend pas du stockage : tant qu'il répond, la
  // page se charge comme avant le service worker, quoi que fasse le cache.
  const dl     = download(request);
  const net    = dl.then(({ res }) => res);
  const cached = lookup(key);

  const response = (async () => {
    let res = null;
    try { res = await Promise.race([net, sleep(NET_TIMEOUT_MS)]); } catch {} // réseau coupé
    if (res && res.ok) return res;  // le réseau a répondu à temps
    // Trop lent, coupé, ou erreur serveur → la copie en cache. Rien en cache → on
    // continue d'attendre le réseau (ou son échec), comme sans service worker.
    return (await cached) || net;
  })();

  // Même si on a déjà répondu depuis le cache, la requête réseau va au bout : c'est elle
  // qui rafraîchit la copie pour le prochain chargement.
  const done = dl.then(({ copy }) => copy && store(key, copy)).catch(() => {});
  return { response, done };
}

function cacheFirst(request) {
  const url = request.url;
  const dl  = lookup(url).then((hit) => (hit ? { res: hit, copy: null } : download(netRequest(url))));
  return {
    response: dl.then(({ res }) => res),
    done: dl.then(({ copy }) => copy && store(url, copy)).catch(() => {}),
  };
}

// Filet de sécurité. Quoi qu'il arrive dans ce fichier (cas non prévu, téléchargement
// épinglé en échec), une page ne doit JAMAIS se charger moins bien qu'avant le service
// worker : en dernier recours, la requête part telle quelle sur le réseau.
const orNetwork = (response, request) => response.catch(() => fetch(request));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // Sans '/', pas d'installation : le navigateur réessaiera au prochain chargement.
    await precache('/');
    // Le reste est accessoire (logos, scan QR) : un échec ne bloque rien, le handler
    // fetch complètera le cache au fil des chargements.
    const extras = [...SHELL.filter((u) => u !== '/'), ...CDN.keys()];
    await Promise.allSettled(extras.map(precache));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('compteur-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  let plan = null;
  if (url.origin === self.location.origin) {
    const key = shellKey(url);
    if (key) plan = networkFirst(req, key);
  } else if (CDN.has(req.url)) {
    plan = cacheFirst(req);
  }
  if (!plan) return; // tout le reste (API, admin, stats…) : le navigateur fait comme d'habitude
  e.respondWith(orNetwork(plan.response, req));
  e.waitUntil(plan.done);
});
