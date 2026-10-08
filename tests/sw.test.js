'use strict';

// Service worker de la coquille opérateur (public/sw.js).
// Exécuté dans un contexte `vm` avec de faux `caches` / `fetch` / `setTimeout` : ni
// navigateur ni réseau. Ce que ces tests ne peuvent PAS prouver (le contrôle d'intégrité
// SRI sur une lib sortie du cache, un vrai rechargement serveur coupé) se vérifie dans
// un navigateur — cf. CLAUDE.md.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const SW_SRC = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const INDEX  = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const ORIGIN = 'https://compteur.test';

// Dans un vrai service worker, une URL relative se résout sur son origine.
class Req extends Request {
  constructor(input, init) {
    super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
  }
}

// Réseau simulé. `serve({chemin|url: corps})` : tout le reste répond 404.
const OFFLINE = async () => { throw new TypeError('Failed to fetch'); };
const serve = (map) => async (req) => {
  const u = new URL(req.url);
  const k = u.origin === ORIGIN ? u.pathname : req.url;
  return k in map ? new Response(map[k]) : new Response('introuvable', { status: 404 });
};

// Tous les tests sont BORNÉS. Le sujet ici, ce sont des promesses qui peuvent ne jamais se
// résoudre (réseau qui pend, stockage muet) : sans borne, une régression ferait PENDRE la
// suite au lieu de la faire échouer (constaté en injectant le défaut « la réponse attend
// l'écriture du cache »).
const T = { timeout: 2000 };

// Laisse se vider les microtâches en attente.
const turn = () => new Promise((resolve) => setImmediate(resolve));

function boot() {
  const stores    = new Map(); // nom de cache → Map(url absolue → Response)
  const listeners = {};
  const timers    = [];        // setTimeout capturés : déclenchés à la main par le test
  const net       = { calls: [], reqs: [], impl: OFFLINE };
  // quotaFull : put() rejette · cacheBroken : open() rejette · cacheHangs : open() ne
  // répond jamais · putHangs : put() ne répond jamais.
  const sw        = { stores, timers, net, quotaFull: false, cacheBroken: false, cacheHangs: false, putHangs: false };
  const abs = (k) => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href;

  const caches = {
    async open(name) {
      if (sw.cacheBroken) throw new Error('SecurityError');
      if (sw.cacheHangs) await new Promise(() => {});
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(k) { const r = m.get(abs(k)); return r && r.clone(); },
        async put(k, r) {
          if (sw.quotaFull) throw new Error('QuotaExceededError');
          if (sw.putHangs) await new Promise(() => {});
          m.set(abs(k), r);
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };

  const self = {
    location: new URL('/sw.js', ORIGIN),
    addEventListener(type, fn) { listeners[type] = fn; },
    async skipWaiting() { sw.skipped = true; },
    clients: { async claim() { sw.claimed = true; } },
  };

  const ctx = vm.createContext({
    self, caches, URL, Response, Request: Req,
    fetch: (req) => { net.calls.push(req.url); net.reqs.push(req); return net.impl(req); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  vm.runInContext(SW_SRC, ctx, { filename: 'sw.js' });
  // Passage par JSON : un tableau venu d'un autre contexte vm n'est pas deepEqual à un
  // tableau d'ici (prototypes distincts).
  Object.assign(sw, JSON.parse(vm.runInContext(
    'JSON.stringify({ CACHE, SHELL, CDN: Object.fromEntries(CDN), NET_TIMEOUT_MS, CACHE_TIMEOUT_MS })', ctx,
  )));
  sw.LIBS = Object.keys(sw.CDN); // CDN = { url: empreinte SRI }

  // install / activate → la promesse passée à waitUntil.
  sw.fire = (type) => { let p; listeners[type]({ waitUntil: (x) => { p = x; } }); return p; };

  // fetch → `responded` reste null si le service worker laisse la requête au navigateur.
  // Événement STRICT : respondWith() et waitUntil() doivent être appelés pendant le
  // handler, pas après un await. Les navigateurs tolèrent un waitUntil() tardif tant que
  // la réponse est en cours, mais rien ne permet de le vérifier sur Safari iOS.
  sw.get = (url, init) => {
    let dispatching = true;
    const sync = (what) => { if (!dispatching) throw new Error(`InvalidStateError: ${what} hors du handler`); };
    const ev = {
      request: new Req(url, init), responded: null, waits: [],
      respondWith(p) { sync('respondWith'); ev.responded = p; },
      waitUntil(p) { sync('waitUntil'); ev.waits.push(p); },
    };
    listeners.fetch(ev);
    dispatching = false;
    return ev;
  };

  // Déclenche les faux timers de cette durée (délai réseau ou borne de lecture du cache).
  sw.elapse = (ms) => {
    const due = timers.filter((t) => t.ms === ms);
    assert.ok(due.length > 0, `aucun timer de ${ms} ms en attente`);
    for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };

  sw.cached = async (key, name = sw.CACHE) => {
    const r = stores.get(name)?.get(abs(key));
    return r ? r.clone().text() : null;
  };

  return sw;
}

// Coquille déjà en cache, comme après une première visite avec du réseau.
async function installed() {
  const sw = boot();
  sw.net.impl = serve({ '/': 'coquille v1' });
  await sw.fire('install');
  sw.net.calls.length = 0;
  return sw;
}

const body = async (ev) => (await ev.responded).text();

// ── Installation / activation ────────────────────────────────────────────────

describe('sw.js — installation', () => {
  test('précache la coquille et les libs QR, puis prend la main', T, async () => {
    const sw  = boot();
    const all = [...sw.SHELL, ...sw.LIBS];
    sw.net.impl = serve(Object.fromEntries(all.map((u) => [u, `contenu de ${u}`])));
    await sw.fire('install');
    for (const u of all) assert.equal(await sw.cached(u), `contenu de ${u}`);
    assert.equal(sw.skipped, true);
    // Revalidation forcée : on ne précache pas une copie HTTP périmée de la page.
    assert.equal(sw.net.reqs.find((r) => r.url === `${ORIGIN}/`).cache, 'no-cache');
  });

  test('sans « / », l\'installation échoue — le navigateur réessaiera', T, async () => {
    const sw = boot(); // réseau coupé
    await assert.rejects(sw.fire('install'));
    assert.equal(sw.skipped, undefined);
  });

  test('un accessoire en panne (CDN, logo) ne bloque pas l\'installation', T, async () => {
    const sw = boot();
    sw.net.impl = serve({ '/': 'coquille' }); // tout le reste → 404
    await sw.fire('install');
    assert.equal(await sw.cached('/'), 'coquille');
    assert.equal(await sw.cached(sw.LIBS[0]), null, 'un 404 ne doit pas entrer dans le cache');
    assert.equal(sw.skipped, true);
  });

  test('activation : purge les anciens caches de coquille, pas ceux des autres', T, async () => {
    const sw = boot();
    for (const name of ['compteur-shell-v0', 'autre-chose', sw.CACHE]) sw.stores.set(name, new Map());
    await sw.fire('activate');
    assert.deepEqual([...sw.stores.keys()].sort(), ['autre-chose', sw.CACHE].sort());
    assert.equal(sw.claimed, true);
  });
});

// ── Liste blanche ────────────────────────────────────────────────────────────

describe('sw.js — ce qui ne passe JAMAIS par le service worker', () => {
  // Un total ou un historique servi depuis un cache serait FAUX : rien de l'API n'y entre.
  const cases = [
    ['POST /api/count',    '/api/count', { method: 'POST', body: '{}' }],
    ['GET /api/state',     '/api/state?e=abc123&g=def456'],
    ['GET /api/history',   '/api/history?code=x&e=abc123'],
    ['admin.html',         '/admin.html?from=op'],
    ['stats.html',         '/stats.html'],
    ['sw.js lui-même',     '/sw.js'],
    ['un CDN hors liste',  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'],
  ];
  for (const [label, url, init] of cases) {
    test(label, T, async () => {
      const sw = await installed();
      const ev = sw.get(url, init);
      assert.equal(ev.responded, null);
      assert.deepEqual(sw.net.calls, []);
    });
  }
});

// ── Coquille : réseau d'abord, cache en secours ──────────────────────────────

describe('sw.js — coquille : réseau d\'abord, cache en secours', () => {
  test('réseau OK → la version du réseau, et le cache est rafraîchi', T, async () => {
    const sw = await installed();
    sw.net.impl = serve({ '/': 'coquille v2' });
    const ev = sw.get('/?e=abc123&g=def456');
    assert.equal(ev.waits.length, 1, 'le rafraîchissement doit être confié à waitUntil()');
    assert.equal(await body(ev), 'coquille v2');
    await Promise.all(ev.waits);
    assert.equal(await sw.cached('/'), 'coquille v2');
  });

  test('réseau COUPÉ → la coquille en cache, sans attendre le délai', T, async () => {
    const sw = await installed();
    sw.net.impl = OFFLINE;
    // Aucun faux timer n'est déclenché ici : si la réponse arrive, c'est sans attente.
    assert.equal(await body(sw.get('/?e=abc123&g=def456')), 'coquille v1');
  });

  test('réseau SATURÉ (la requête traîne) → le cache au bout du délai, rafraîchi ensuite', T, async () => {
    const sw = await installed();
    let arrive;
    sw.net.impl = () => new Promise((resolve) => { arrive = resolve; });
    const ev = sw.get('/');
    let res = null;
    ev.responded.then((r) => { res = r; });

    await turn();
    assert.equal(res, null, 'tant que le délai court, on laisse sa chance au réseau');

    sw.elapse(sw.NET_TIMEOUT_MS);
    await turn();
    assert.equal(await res.text(), 'coquille v1');

    // Le réseau finit par répondre : la copie est à jour pour le prochain chargement.
    arrive(new Response('coquille v2'));
    await Promise.all(ev.waits);
    assert.equal(await sw.cached('/'), 'coquille v2');
  });

  test('en-têtes reçus mais corps qui cale → pas considéré comme une réponse', T, async () => {
    const sw = await installed();
    const stalled = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('<html>')); }, // jamais de close()
    });
    sw.net.impl = async () => new Response(stalled);
    const ev = sw.get('/');
    let res = null;
    ev.responded.then((r) => { res = r; });

    await turn();
    assert.equal(res, null, 'une page à moitié reçue ne doit pas être servie');
    sw.elapse(sw.NET_TIMEOUT_MS);
    await turn();
    assert.equal(await res.text(), 'coquille v1');
    assert.equal(await sw.cached('/'), 'coquille v1');
  });

  test('erreur serveur (5xx) → la coquille en cache, qui n\'est pas écrasée', T, async () => {
    const sw = await installed();
    sw.net.impl = async () => new Response('Worker threw exception', { status: 500 });
    assert.equal(await body(sw.get('/')), 'coquille v1');
    assert.equal(await sw.cached('/'), 'coquille v1');
  });

  test('/index.html désigne la même coquille que /', T, async () => {
    const sw = await installed();
    sw.net.impl = OFFLINE;
    assert.equal(await body(sw.get('/index.html')), 'coquille v1');
  });

  test('rien en cache et pas de réseau → échec, comme avant le service worker', T, async () => {
    const sw = boot();
    await assert.rejects(sw.get('/').responded);
  });

  test('stockage plein → la page est servie quand même', T, async () => {
    const sw = boot();
    sw.quotaFull = true;
    sw.net.impl = serve({ '/': 'coquille' });
    assert.equal(await body(sw.get('/')), 'coquille');
    assert.equal(await sw.cached('/'), null);
  });

  // Le service worker ne doit jamais rendre le chargement MOINS fiable qu'avant lui :
  // tant que le réseau répond, la page se charge, quoi que fasse le stockage du téléphone.
  test('stockage inutilisable (caches.open échoue) → la page passe par le réseau', T, async () => {
    const sw = boot();
    sw.cacheBroken = true;
    sw.net.impl = serve({ '/': 'coquille' });
    assert.equal(await body(sw.get('/?e=abc123&g=def456')), 'coquille');
  });

  test('le réseau part tout de suite, sans attendre le cache', T, async () => {
    const sw = boot();
    sw.cacheHangs = true; // le stockage ne répond jamais
    sw.net.impl = serve({ '/': 'coquille' });
    const ev = sw.get('/');
    assert.equal(sw.net.calls.length, 1, 'la requête réseau doit partir dans le handler lui-même');
    // Aucun faux timer n'est déclenché : la réponse n'attend ni le cache ni un délai.
    assert.equal(await body(ev), 'coquille');
  });

  test('écriture du cache qui ne finit jamais → la page est servie quand même', T, async () => {
    const sw = boot();
    sw.putHangs = true;
    sw.net.impl = serve({ '/': 'coquille' });
    assert.equal(await body(sw.get('/')), 'coquille');
  });

  test('stockage muet ET réseau lent → la page arrive quand le réseau répond', T, async () => {
    const sw = boot();
    sw.cacheHangs = true;
    let arrive;
    sw.net.impl = () => new Promise((resolve) => { arrive = resolve; });
    const ev = sw.get('/');
    let res = null;
    ev.responded.then((r) => { res = r; });

    sw.elapse(sw.NET_TIMEOUT_MS);   // le réseau traîne…
    await turn();
    sw.elapse(sw.CACHE_TIMEOUT_MS); // …et le cache ne répondra pas : on arrête de l'attendre
    await turn();
    assert.equal(res, null, 'rien à servir tant que le réseau n\'a pas répondu');

    arrive(new Response('coquille'));
    await turn();
    assert.equal(await res.text(), 'coquille');
  });

  test('la borne de lecture du cache est plus large que le délai réseau', T, () => {
    // Trop courte, elle ferait croire « rien en cache » à un téléphone hors ligne dont le
    // stockage est simplement lent — exactement le cas qu'on veut sauver.
    const sw = boot();
    assert.ok(sw.CACHE_TIMEOUT_MS >= 2 * sw.NET_TIMEOUT_MS);
  });
});

// ── Libs QR : cache d'abord ──────────────────────────────────────────────────

describe('sw.js — libs QR : cache d\'abord', () => {
  test('en cache → servie sans aucune requête réseau', T, async () => {
    const sw = boot();
    sw.net.impl = serve({ '/': 'coquille', [sw.LIBS[0]]: 'code jsQR' });
    await sw.fire('install');
    sw.net.calls.length = 0;
    sw.net.impl = OFFLINE;
    assert.equal(await body(sw.get(sw.LIBS[0])), 'code jsQR');
    assert.deepEqual(sw.net.calls, []);
  });

  test('pas encore en cache → réseau, puis rangée pour la prochaine fois', T, async () => {
    const sw = boot();
    sw.net.impl = serve({ [sw.LIBS[1]]: 'code qrcode' });
    const ev = sw.get(sw.LIBS[1]);
    assert.equal(await body(ev), 'code qrcode');
    await Promise.all(ev.waits);
    assert.equal(await sw.cached(sw.LIBS[1]), 'code qrcode');
  });

  // Sans empreinte, une mauvaise réponse du CDN entrerait dans le cache et y resterait :
  // « cache d'abord » ne la redemande jamais, et le SRI de la balise la bloque à chaque fois.
  test('toujours téléchargée avec son empreinte SRI — au précache comme au rattrapage', T, async () => {
    const sw = boot();
    sw.net.impl = serve({ '/': 'coquille' });
    await sw.fire('install');
    await sw.get(sw.LIBS[0]).responded;
    const libReqs = sw.net.reqs.filter((r) => r.url in sw.CDN);
    assert.equal(libReqs.length, sw.LIBS.length + 1, 'précache de chaque lib + 1 rattrapage');
    for (const r of libReqs) assert.equal(r.integrity, sw.CDN[r.url], r.url);
  });

  // Empreinte fausse dans sw.js seulement (ou téléchargement épinglé en échec) : la balise
  // <script> de la page, elle, doit quand même pouvoir charger sa lib.
  test('téléchargement épinglé en échec → la requête de la page part telle quelle', T, async () => {
    const sw = boot();
    sw.net.impl = async (req) => {
      if (req.integrity === sw.CDN[sw.LIBS[0]]) throw new TypeError('integrity mismatch');
      return new Response('code jsQR');
    };
    assert.equal(await body(sw.get(sw.LIBS[0])), 'code jsQR');
    assert.equal(await sw.cached(sw.LIBS[0]), null, 'une lib non vérifiée ne doit pas entrer dans le cache');
  });
});

// ── Contrat sw.js ↔ index.html ───────────────────────────────────────────────
// Deux listes à tenir alignées à la main (SHELL / CDN d'un côté, les balises de
// index.html de l'autre). Un oubli ne casse rien de visible : la lib n'est simplement
// plus disponible hors ligne. Ces tests rendent l'oubli bruyant.

describe('Contrat sw.js ↔ index.html', () => {
  const { SHELL, CDN } = boot();
  const scripts = [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
    .map((m) => ({ tag: m[0], src: m[1], integrity: (m[0].match(/\sintegrity="([^"]+)"/) || [])[1] }));

  test('libs externes de index.html = celles du service worker, empreintes comprises', T, () => {
    assert.deepEqual(Object.fromEntries(scripts.map((s) => [s.src, s.integrity])), CDN);
  });

  test('aucun script externe bloquant : defer + SRI + crossorigin', T, () => {
    assert.ok(scripts.length > 0);
    for (const { tag, src } of scripts) {
      assert.match(tag, /\sdefer\b/, `${src} : sans defer, écran blanc sur réseau saturé`);
      assert.match(tag, /\sintegrity="sha384-/, `${src} : SRI manquant`);
      assert.match(tag, /\scrossorigin="anonymous"/,
        `${src} : sans crossorigin la réponse est opaque → jamais mise en cache`);
    }
  });

  test('tout fichier same-origin chargé par index.html est dans la coquille', T, () => {
    const refs = [...INDEX.matchAll(/<(?:img|link)\b[^>]*\b(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 3, 'logos + manifest attendus');
    for (const r of refs) assert.ok(SHELL.includes(r), `${r} absent de SHELL`);

    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8'));
    assert.ok(SHELL.includes(manifest.start_url), 'start_url de la PWA absent de SHELL');
    for (const icon of manifest.icons) assert.ok(SHELL.includes(icon.src), `${icon.src} absent de SHELL`);
  });

  test('chaque entrée de la coquille existe dans public/', T, () => {
    for (const u of SHELL) {
      assert.ok(fs.existsSync(path.join(PUBLIC, u === '/' ? 'index.html' : u)), `${u} introuvable`);
    }
  });

  test('index.html enregistre /sw.js', T, () => {
    assert.match(INDEX, /serviceWorker\.register\('\/sw\.js'\)/);
  });
});
