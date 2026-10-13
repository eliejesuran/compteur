'use strict';

// Faux navigateur pour exécuter le <script> des pages de public/ sans navigateur.
// Le projet n'a ni build ni framework : toute la logique client (file d'attente hors
// ligne, reconnexion WebSocket, relecture des stats…) vit dans des scripts en ligne, que
// rien ne testait. On extrait le script de la page et on l'exécute dans un contexte `vm`
// dont le DOM, le réseau, le stockage et l'HORLOGE sont simulés — donc pilotables :
//   page.reseau.repondre = (req) => …      ce que le serveur répond à chaque fetch
//                                           (appelé au tour de microtâches SUIVANT, comme un
//                                           vrai fetch : faire `await stabiliser()` avant de
//                                           changer la réponse, sinon elle vaut aussi pour
//                                           la requête déjà partie)
//   page.reseau.sourd = true                le navigateur n'honore pas abort()
//   corpsQuiCale()                          réponse dont les en-têtes arrivent, jamais le corps
//   page.sockets                            les WebSocket ouverts par la page
//   await page.avancer(ms)                  fait passer le temps (setTimeout / setInterval)
//   page.lire('queue.length')               évalue une expression dans la page
//
// Ce que ce harnais ne prouve PAS : le rendu, le CSS, les vraies API du téléphone
// (vibration, audio, caméra, service worker). Ça se vérifie dans un navigateur — cf. CLAUDE.md.

const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function lirePage(nom) {
  return fs.readFileSync(path.join(PUBLIC, nom), 'utf8');
}

// Le <script> en ligne (sans src) qui contient `marqueur`.
function extraireScript(html, marqueur) {
  const blocs = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const trouve = blocs.filter((b) => b.includes(marqueur));
  if (trouve.length !== 1) throw new Error(`${trouve.length} script(s) en ligne contenant « ${marqueur} » (1 attendu)`);
  return trouve[0];
}

// Laisse se vider les microtâches et les promesses en chaîne.
const tour = () => new Promise((resolve) => setImmediate(resolve));
async function stabiliser(tours = 8) { for (let i = 0; i < tours; i++) await tour(); }

// ── Éléments du DOM ──────────────────────────────────────────────────────────

function creerElement(id) {
  const ecouteurs = {};
  const el = {
    id,
    style: { setProperty(k, v) { this[k] = v; } },
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    href: '',
    src: '',
    type: 'text',
    children: [],
    offsetWidth: 0,
    ouvert: false, // <dialog>
    ecouteurs,
    classList: {
      _lire: () => new Set(el.className.split(/\s+/).filter(Boolean)),
      _ecrire(set) { el.className = [...set].join(' '); },
      add(...noms) { const s = this._lire(); noms.forEach((n) => s.add(n)); this._ecrire(s); },
      remove(...noms) { const s = this._lire(); noms.forEach((n) => s.delete(n)); this._ecrire(s); },
      contains(nom) { return this._lire().has(nom); },
      toggle(nom, force) {
        const s = this._lire();
        const mettre = force === undefined ? !s.has(nom) : !!force;
        if (mettre) s.add(nom); else s.delete(nom);
        this._ecrire(s);
        return mettre;
      },
    },
    addEventListener(type, fn) { (ecouteurs[type] ??= []).push(fn); },
    removeEventListener(type, fn) { ecouteurs[type] = (ecouteurs[type] ?? []).filter((f) => f !== fn); },
    // Déclenche les écouteurs posés par la page (clic, pointerdown, keydown…).
    emettre(type, ev = {}) {
      const evt = { type, target: el, preventDefault() {}, stopPropagation() {}, ...ev };
      for (const fn of ecouteurs[type] ?? []) fn(evt);
      return evt;
    },
    focus() {},
    blur() {},
    play() { return Promise.resolve(); },
    getContext() { return { drawImage() {}, getImageData: () => ({ data: [], width: 0, height: 0 }) }; },
    showModal() { el.ouvert = true; },
    close() { el.ouvert = false; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  return el;
}

// ── Horloge ──────────────────────────────────────────────────────────────────

function creerHorloge(depart) {
  const h = { maintenant: depart, minuteurs: new Map(), prochain: 1 };

  h.setTimeout = (fn, ms = 0) => { const id = h.prochain++; h.minuteurs.set(id, { fn, a: h.maintenant + Math.max(0, ms) }); return id; };
  h.setInterval = (fn, ms) => { const id = h.prochain++; h.minuteurs.set(id, { fn, a: h.maintenant + ms, tous: ms }); return id; };
  h.clear = (id) => { h.minuteurs.delete(id); };

  // Fait passer `ms` millisecondes : chaque minuteur échu est exécuté à SON heure, dans
  // l'ordre, et les promesses qu'il déclenche ont le temps d'aboutir avant le suivant.
  h.avancer = async (ms) => {
    const fin = h.maintenant + ms;
    for (;;) {
      let choisi = null;
      for (const [id, m] of h.minuteurs) if (m.a <= fin && (!choisi || m.a < choisi.m.a)) choisi = { id, m };
      if (!choisi) break;
      h.maintenant = Math.max(h.maintenant, choisi.m.a);
      if (choisi.m.tous) choisi.m.a += choisi.m.tous; else h.minuteurs.delete(choisi.id);
      choisi.m.fn();
      await stabiliser(3);
    }
    h.maintenant = fin;
    await stabiliser();
  };

  h.enAttente = (ms) => [...h.minuteurs.values()].filter((m) => !m.tous && (ms === undefined || m.a - h.maintenant === ms)).length;
  return h;
}

// ── Réponses HTTP simulées ───────────────────────────────────────────────────

function reponse(status, corps, { brut } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { if (brut !== undefined) return JSON.parse(brut); return corps; },
    async text() { return brut !== undefined ? brut : JSON.stringify(corps); },
  };
}
const HORS_LIGNE = () => { throw new TypeError('Failed to fetch'); };
const PEND = () => new Promise(() => {}); // la requête ne revient jamais
// Les en-têtes arrivent, le corps jamais (réseau qui tombe ou sature en cours de réponse).
function corpsQuiCale(status = 200) {
  return { ...reponse(status, null), json: PEND, text: PEND };
}

// Promesse résolue à la main : pour répondre à une requête au moment choisi par le test.
function differe() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── La page ──────────────────────────────────────────────────────────────────

function charger(fichier, marqueur, opts = {}) {
  const {
    url = '/',
    protocole = 'https:',
    hote = 'compteur.test',
    stockage = {},            // contenu initial de localStorage
    session = {},             // contenu initial de sessionStorage
    stockageCasse = false,    // 'ecriture' : setItem lève ; 'absent' : localStorage vaut null
    uuidNatif = true,         // crypto.randomUUID disponible (contexte sécurisé)
    cache = false,            // document.hidden
    absents = [],             // ids que getElementById ne trouve pas
    serviceWorker = true,
    vibration = true,
    audio = false,
    partage = false,
    navigateur = {},          // propriétés ajoutées à `navigator` (wakeLock, mediaDevices…)
    globaux = {},             // Chart, XLSX, qrcode…
    repondre = HORS_LIGNE,
    depart = Date.UTC(2026, 9, 12, 20, 0, 0),
  } = opts;

  const source = extraireScript(lirePage(fichier), marqueur);
  const horloge = creerHorloge(depart);
  const elements = new Map();
  const journal = { vibrations: [], bips: 0, navigations: [], alertes: [], confirmations: [], partages: [], copies: [], swEnregistres: [], historique: [] };

  // Réseau. `sourd` : le navigateur n'honore pas abort() — la requête abandonnée par la
  // page ne se termine pas pour autant (le pire cas : seule une minuterie de la page libère).
  const reseau = { appels: [], repondre, sourd: false };
  const fetchSimule = (cible, init = {}) => {
    const appel = {
      url: String(cible),
      method: init.method ?? 'GET',
      corps: (() => { try { return init.body ? JSON.parse(init.body) : undefined; } catch { return init.body; } })(),
      a: horloge.maintenant,
    };
    appel.chemin = appel.url.split('?')[0];
    appel.params = Object.fromEntries(new URLSearchParams(appel.url.split('?')[1] ?? ''));
    reseau.appels.push(appel);
    return new Promise((resolve, reject) => {
      const abandon = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) return abandon();
      init.signal?.addEventListener('abort', () => { if (!reseau.sourd) abandon(); });
      Promise.resolve().then(() => reseau.repondre(appel)).then(resolve, reject);
    });
  };
  reseau.vers = (chemin) => reseau.appels.filter((a) => a.chemin === chemin);
  reseau.oublier = () => { reseau.appels.length = 0; };

  // WebSocket
  const sockets = [];
  class FauxWebSocket {
    constructor(adresse) {
      this.url = adresse; this.readyState = 0; this.envoyes = [];
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.push(this);
    }
    send(donnee) {
      if (this.readyState === 0) throw new Error('InvalidStateError: socket en cours de connexion');
      if (this.readyState === 1) this.envoyes.push(JSON.parse(donnee));
    }
    close(code) { // fermeture demandée par la page
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.fermePar = 'page';
      this.onclose?.({ code: code ?? 1005 });
    }
    // — pilotage par le test —
    ouvrir() { this.readyState = 1; this.onopen?.({}); }
    recevoir(msg) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
    couper(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; this.fermePar = 'serveur'; this.onclose?.({ code }); }
    get types() { return this.envoyes.map((m) => m.type); }
  }
  Object.assign(FauxWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // Stockage
  const creerStockage = (initial, casse) => {
    const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return {
      _m: m,
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem(k, v) {
        if (casse === 'ecriture') throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
        m.set(k, String(v));
      },
      removeItem: (k) => { m.delete(k); },
      clear: () => m.clear(),
      json: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    };
  };
  const local = creerStockage(stockage, stockageCasse);
  const sess  = creerStockage(session, false);

  // DOM
  const ecouteursDoc = {}, ecouteursFenetre = {};
  const el = (id) => { if (!elements.has(id)) elements.set(id, creerElement(id)); return elements.get(id); };
  const document_ = {
    hidden: cache,
    title: '',
    body: creerElement('body'),
    documentElement: creerElement('html'),
    getElementById: (id) => (absents.includes(id) ? null : el(id)),
    querySelectorAll: (sel) => opts.selecteurs?.[sel] ?? [],
    addEventListener(type, fn) { (ecouteursDoc[type] ??= []).push(fn); },
  };

  const [chemin, recherche = ''] = url.split('?');
  const location_ = {
    protocol: protocole, host: hote, origin: `${protocole}//${hote}`, pathname: chemin,
    search: recherche ? `?${recherche}` : '',
    get href() { return `${this.origin}${this.pathname}${this.search}`; },
    set href(v) { journal.navigations.push(v); },
  };

  class FausseDate extends Date {
    constructor(...a) { if (a.length === 0) super(horloge.maintenant); else super(...a); }
    static now() { return horloge.maintenant; }
  }

  class FauxAudio {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; }
    createOscillator() { journal.bips += 1; return { frequency: {}, connect: (x) => x, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
  }

  const navigator_ = { onLine: true };
  if (vibration) navigator_.vibrate = (motif) => { journal.vibrations.push(motif); return true; };
  if (serviceWorker) navigator_.serviceWorker = { register: (u) => { journal.swEnregistres.push(u); return Promise.resolve({}); } };
  if (partage) navigator_.share = async (d) => { journal.partages.push(d); };
  navigator_.clipboard = { writeText: async (t) => { journal.copies.push(t); } };
  Object.assign(navigator_, navigateur);

  let n = 0;
  const bac = {
    document: document_,
    location: location_,
    history: { replaceState(_e, _t, u) { journal.historique.push(u); const [p, s = ''] = u.split('?'); location_.pathname = p; location_.search = s ? `?${s}` : ''; } },
    navigator: navigator_,
    localStorage: stockageCasse === 'absent' ? null : local,
    sessionStorage: sess,
    fetch: fetchSimule,
    WebSocket: FauxWebSocket,
    Date: FausseDate,
    setTimeout: horloge.setTimeout, clearTimeout: horloge.clear,
    setInterval: horloge.setInterval, clearInterval: horloge.clear,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    crypto: uuidNatif ? { randomUUID: () => `uuid-${++n}` } : {},
    AbortController, URL, URLSearchParams, console,
    innerHeight: 800,
    addEventListener(type, fn) { (ecouteursFenetre[type] ??= []).push(fn); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    alert: (m) => { journal.alertes.push(m); },
    confirm: (m) => { journal.confirmations.push(m); return opts.confirmer ?? true; },
    prompt: (m, d) => (typeof opts.saisir === 'function' ? opts.saisir(m, d) : opts.saisir ?? null),
    ...globaux,
  };
  if (audio) bac.AudioContext = FauxAudio;
  bac.window = bac; bac.self = bac; bac.globalThis = bac;

  const ctx = vm.createContext(bac);
  vm.runInContext(source, ctx, { filename: fichier });

  const page = {
    ctx, document: document_, location: location_, navigator: navigator_, horloge, reseau, sockets, journal, local, session: sess,
    el,
    existe: (id) => elements.has(id),
    lire: (expr) => vm.runInContext(expr, ctx),
    // Passage par JSON : un objet né dans un autre contexte `vm` n'est pas deepEqual à un
    // objet d'ici (prototypes distincts).
    valeur: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx) ?? 'null'),
    appeler: (expr) => vm.runInContext(expr, ctx),
    avancer: horloge.avancer,
    stabiliser,
    get socket() { return sockets.at(-1); },
    // Événements de la fenêtre et du document (online, visibilitychange…).
    fenetre(type) { for (const fn of ecouteursFenetre[type] ?? []) fn({ type }); },
    doc(type) { for (const fn of ecouteursDoc[type] ?? []) fn({ type }); },
    async visible(v) { document_.hidden = !v; page.doc('visibilitychange'); await stabiliser(); },
  };
  return page;
}

module.exports = { charger, lirePage, extraireScript, reponse, corpsQuiCale, differe, stabiliser, tour, HORS_LIGNE, PEND };
