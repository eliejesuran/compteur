'use strict';

// ── Banc d'essai WebKit ──────────────────────────────────────────────────────
// Les pages de public/ dans un VRAI WebKit (WKWebView : le moteur de Safari — et de
// DuckDuckGo — sur Mac, très proche de celui des iPhone), derrière un relais TCP dont on
// coupe, fige ou étrangle le trafic. C'est ce banc qui a reproduit le blocage du
// 2026-10-13 (file d'attente figée après une coupure) que ni le faux navigateur des tests
// ni Chromium n'avaient montré.
//
//   npm run test:webkit          (≈ 2 min — macOS + Xcode Command Line Tools ; rien ne s'affiche)
//
// Hors de `npm test` : il lui faut un Mac avec une session graphique, et il dure.
// Ce qu'il ne reproduit PAS : une vraie coupure d'interface (Wi-Fi coupé, mode avion) —
// `navigator.onLine` est simulé —, HTTP/2 et HTTP/3 (le relais parle HTTP/1.1), iOS.
// État du serveur isolé (STATE_FILE temporaire) ; données du WKWebView effacées en fin de course.

const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..', '..');
const BINAIRE = 'compteur-wklab'; // WebKit range ses données sous ~/Library/{WebKit,Caches}/<ce nom>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAVARD = process.argv.includes('--bavard');
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)} s]`, ...a);

if (process.platform !== 'darwin') {
  console.log('Banc WebKit : macOS uniquement (WKWebView) — ignoré.');
  process.exit(0);
}

function compiler() {
  const dossier = path.join(os.tmpdir(), `${BINAIRE}-bin`);
  fs.mkdirSync(dossier, { recursive: true });
  const bin = path.join(dossier, BINAIRE), source = path.join(__dirname, 'wklab.swift');
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(source).mtimeMs) return bin;
  log('compilation du harnais…');
  const r = spawnSync('swiftc', ['-swift-version', '5', '-O', '-o', bin, source], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(`Compilation impossible (Xcode Command Line Tools requis) :\n${r.stderr || r.error.message}`);
    process.exit(1);
  }
  return bin;
}

const portLibre = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ── Serveur applicatif (le vrai server.js, état isolé) ───────────────────────

let APP_PORT = 0, RELAIS_PORT = 0;

function api(method, chemin, corps) {
  return new Promise((resolve, reject) => {
    const data = corps ? JSON.stringify(corps) : null;
    const r = http.request({
      host: '127.0.0.1', port: APP_PORT, path: chemin, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function nouvelEvenement() {
  const ev = await api('POST', '/api/events', { code: 'admin123', name: 'Banc WebKit' });
  await api('POST', '/api/admin/config', { code: 'admin123', e: ev.id, capacity: 1000 });
  return { e: ev.id, g: ev.groups[0].id };
}

// ── Relais TCP à pannes ──────────────────────────────────────────────────────
//  ok         tout passe
//  coupe      port fermé + connexions en cours coupées (≈ plus de réseau du tout)
//  muet       les connexions en cours se figent en silence ; les nouvelles sont acceptées
//             mais rien ne passe (≈ Wi-Fi encore associé, internet coupé derrière)
//  corps-cale la réponse aux requêtes visées (relais.vise) s'arrête après ses en-têtes
// Au retour à « ok », une connexion figée RESTE figée : seules les nouvelles passent.

const relais = { mode: 'ok', serveur: null, liens: new Set(), vise: /^POST \/api\/count/ };

function ecouter() {
  if (relais.serveur) return Promise.resolve();
  return new Promise((resolve) => {
    const serveur = net.createServer((client) => {
      const lien = { client, amont: null, fige: relais.mode === 'muet', cale: false, calerLaSuivante: false };
      relais.liens.add(lien);
      client.on('error', () => {});
      client.on('close', () => { relais.liens.delete(lien); if (lien.amont) lien.amont.destroy(); });
      if (lien.fige) { client.on('data', () => {}); return; }
      const amont = lien.amont = net.connect(APP_PORT, '127.0.0.1');
      amont.on('error', () => client.destroy());
      amont.on('close', () => { if (!lien.fige && !lien.cale) client.destroy(); });
      client.on('data', (d) => {
        if (lien.fige) return;
        if (relais.mode === 'corps-cale' && relais.vise.test(d.toString('latin1', 0, 200))) lien.calerLaSuivante = true;
        amont.write(d);
      });
      amont.on('data', (d) => {
        if (lien.fige || lien.cale) return;
        if (lien.calerLaSuivante) {
          const s = d.toString('latin1'), fin = s.indexOf('\r\n\r\n');
          // les en-têtes et un seul octet du corps, puis plus rien — sans fermer la connexion
          if (fin >= 0) { client.write(Buffer.from(s.slice(0, fin + 5), 'latin1')); lien.cale = true; return; }
        }
        client.write(d);
      });
    });
    serveur.listen(RELAIS_PORT, '127.0.0.1', () => { relais.serveur = serveur; resolve(); });
  });
}

async function reseau(mode) {
  relais.mode = mode;
  if (mode === 'coupe') {
    if (relais.serveur) { relais.serveur.close(); relais.serveur = null; }
    for (const l of relais.liens) l.client.destroy();
  } else {
    if (mode === 'muet') for (const l of relais.liens) l.fige = true;
    await ecouter();
  }
  if (BAVARD) log(`  réseau : ${mode}`);
}

// ── Harnais WKWebView ────────────────────────────────────────────────────────

class Harnais {
  constructor(bin) {
    this.enfant = spawn(bin, [path.join(__dirname, 'inject.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.attentes = new Map(); this.prochain = 1; this.navigations = []; this.messages = [];
    this.pret = new Promise((r) => { this._pret = r; });
    readline.createInterface({ input: this.enfant.stdout }).on('line', (ligne) => {
      let m; try { m = JSON.parse(ligne); } catch { return; }
      if (m.ev === 'log') { this.messages.push(m.msg); if (BAVARD) log('  page ›', m.msg); }
      else if (m.ev === 'nav') this.navigations.splice(0).forEach((f) => f(m));
      else if (m.ev === 'ready') this._pret();
      else if (this.attentes.has(m.id)) {
        const { resolve, reject } = this.attentes.get(m.id); this.attentes.delete(m.id);
        if (m.ok) resolve(m.value); else reject(new Error(m.error));
      }
    });
    this.enfant.stderr.on('data', () => {}); // bavardage de WebKit / AppKit
  }
  envoyer(cmd) {
    return new Promise((resolve, reject) => {
      const id = this.prochain++;
      this.attentes.set(id, { resolve, reject });
      this.enfant.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
    });
  }
  async ouvrir(url) {
    const nav = new Promise((r) => this.navigations.push(r));
    await this.envoyer({ op: 'load', url });
    const m = await nav;
    if (m.what !== 'didFinish') throw new Error(`chargement de ${url} : ${m.what} ${m.error || ''}`);
  }
  // `js` = corps de fonction asynchrone exécuté dans la page ; sa valeur de retour passe en JSON.
  // Borné : une page qui attend une réponse pour toujours (c'est le défaut que ce banc
  // traque) ne doit pas faire pendre le banc lui-même.
  async page(js, ms = 30_000) {
    let minuterie;
    const delai = new Promise((_, reject) => { minuterie = setTimeout(() => reject(new Error(`la page n'a pas répondu en ${ms / 1000} s`)), ms); });
    try {
      return JSON.parse(await Promise.race([this.envoyer({ op: 'eval', js: `return JSON.stringify(await (async () => { ${js} })())` }), delai]));
    } finally {
      clearTimeout(minuterie);
    }
  }
  etat() { return this.page('return __lab.snap()'); }
  effacer() { return this.envoyer({ op: 'wipe' }); }
  async quitter() { try { await Promise.race([this.envoyer({ op: 'quit' }), sleep(1000)]); } catch {} this.enfant.kill(); }
}

async function attendre(condition, ms, pas = 250) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await condition();
    if (v) return v;
    if (Date.now() >= fin) return null;
    await sleep(pas);
  }
}

// ── Scénarios ────────────────────────────────────────────────────────────────

// L'écran opérateur : 2 appuis en ligne, PANNE, 3 appuis, retour du réseau. La file doit se
// vider d'elle-même en moins de `maxMs`, et le serveur avoir compté chaque appui une fois.
async function fileApresPanne(h, { panne, horsLigne = false, panneMs, maxMs }) {
  const { e, g } = await nouvelEvenement();
  await h.effacer();
  await h.ouvrir(`http://127.0.0.1:${RELAIS_PORT}/?e=${e}&g=${g}`);
  const pret = await attendre(async () => { const s = await h.etat(); return s.wsOuvert && s.sw && !s.hidden; }, 10_000);
  if (!pret) return { ok: false, detail: `page pas prête : ${JSON.stringify(await h.etat())}` };

  let appuis = 0;
  const appuyer = async (n) => { for (let i = 0; i < n; i++) { await h.page('tap(1); return 1'); appuis++; await sleep(300); } };
  await appuyer(2);
  if (!await attendre(async () => (await h.etat()).file === 0, 3000)) return { ok: false, detail: 'les appuis EN LIGNE ne partent pas' };

  await reseau(panne);
  // « Le navigateur se croit hors ligne » : il le dit pendant la panne… et continue de le
  // dire après, sans jamais émettre l'événement `online`.
  if (horsLigne) await h.page(`__lab.onLine = false; window.dispatchEvent(new Event('offline')); return 1`);
  await sleep(600);
  await appuyer(3);
  await sleep(panneMs);
  // Le WebSocket se reconnecte de lui-même (après 1, 2, 4, 8, 16 s…) et relance alors la
  // file. Pour ne juger QUE la minuterie de la file, on rétablit le réseau juste après son
  // 4e échec : son essai suivant n'aura lieu que 16 s plus tard.
  if (horsLigne && !await attendre(async () => { const s = await h.etat(); return s.wsEssais >= 5 && s.wsDernier.startsWith('fermé'); }, 25_000)) {
    return { ok: false, detail: 'le WebSocket ne tente pas de se reconnecter pendant la panne' };
  }
  const pendant = await h.etat();
  if (pendant.file !== 3) return { ok: false, detail: `pendant la panne : file=${pendant.file} (3 attendus)` };

  await reseau('ok');
  const retour = Date.now();
  const vide = await attendre(async () => (await h.etat()).file === 0, maxMs);
  const duree = ((Date.now() - retour) / 1000).toFixed(1);
  const fin = await h.etat();
  const total = (await api('GET', `/api/state?e=${e}&g=${g}`)).total;
  if (BAVARD) for (const f of fin.fetch) log('   ', f);
  if (!vide) return { ok: false, detail: `file ENCORE BLOQUÉE ${duree} s après le retour — ${fin.badge}, serveur à ${total} pour ${appuis} appuis\n      ${fin.fetch.join('\n      ')}` };
  if (total !== appuis) return { ok: false, detail: `serveur à ${total} pour ${appuis} appuis` };
  return { ok: true, detail: `file vidée ${duree} s après le retour ; ${appuis} appuis, ${total} comptés` };
}

// stats.html : une relecture « en direct » dont le corps n'arrive pas ne doit pas figer les tableaux.
async function statsEnDirect(h) {
  const { e, g } = await nouvelEvenement();
  for (let i = 0; i < 4; i++) await api('POST', '/api/count', { delta: 1, uuid: `amorce-${e}-${i}`, e, g, name: 'Alice' });
  relais.vise = /^GET \/api\/history/;
  try {
    await h.ouvrir(`http://127.0.0.1:${RELAIS_PORT}/stats.html?e=${e}`);
    await sleep(500);
    const lu = await h.page(`
      document.getElementById('code').value = 'admin123';
      await loadStats();
      await new Promise((r) => setTimeout(r, 1000));
      return { presents: document.getElementById('s-count').textContent, ops: document.getElementById('op-list').innerText, ws: statsWs && statsWs.readyState, graphe: typeof Chart !== 'undefined' && !!chart };`);
    if (lu.presents !== '4' || !/Alice/.test(lu.ops) || lu.ws !== 1) return { ok: false, detail: `ouverture : ${JSON.stringify(lu)}` };

    await reseau('corps-cale');
    await api('POST', '/api/count', { delta: 1, uuid: `direct-${e}-1`, e, g, name: 'Dana' });
    await sleep(1500);
    if (!(await h.page('return liveStatsBusy'))) return { ok: false, detail: 'la relecture en direct n\'est pas partie' };
    await reseau('ok');
    const rendu = await attendre(() => h.page('return !liveStatsBusy'), 9000);
    if (!rendu) return { ok: false, detail: 'relecture TOUJOURS verrouillée 9 s après une réponse sans corps' };
    await api('POST', '/api/count', { delta: 1, uuid: `direct-${e}-2`, e, g, name: 'Dana' });
    const aJour = await attendre(() => h.page(`return /Dana[\\s\\S]*\\+2/.test(document.getElementById('op-list').innerText)`), 5000);
    if (!aJour) return { ok: false, detail: 'le tableau par opérateur ne s\'est pas remis à jour' };
    return { ok: true, detail: `graphe ${lu.graphe ? 'tracé' : 'ABSENT (Chart.js non chargé ?)'} ; relecture abandonnée puis tableaux de nouveau à jour` };
  } finally {
    relais.vise = /^POST \/api\/count/;
    await reseau('ok');
  }
}

// admin.html : une réponse sans corps est abandonnée (au lieu d'un bouton sans effet).
async function adminRequetes(h) {
  await nouvelEvenement();
  relais.vise = /^GET \/api\/history/;
  try {
    await h.ouvrir(`http://127.0.0.1:${RELAIS_PORT}/admin.html`);
    await sleep(500);
    const lu = await h.page(`
      document.getElementById('code-input').value = 'admin123';
      await login();
      await new Promise((r) => setTimeout(r, 1000));
      const r = await fetchT('/api/history?' + qs({ code: adminCode, e: currentEvent, since: '1' }));
      return { evenements: events.length, ok: r.ok, groupes: (await r.json()).groups.length };`);
    if (!lu.ok || lu.evenements < 1 || lu.groupes < 1) return { ok: false, detail: `connexion : ${JSON.stringify(lu)}` };

    await reseau('corps-cale');
    const cale = await h.page(`
      const t = performance.now();
      try { await fetchT('/api/history?' + qs({ code: adminCode, e: currentEvent, since: '2' })).then((r) => r.json()); return { recue: true }; }
      catch (err) { return { s: (performance.now() - t) / 1000, message: err.message }; }`);
    if (cale.recue || cale.s < 5 || cale.s > 8) return { ok: false, detail: `réponse sans corps : ${JSON.stringify(cale)}` };
    await reseau('ok');
    const apres = await h.page(`return (await fetchT('/api/history?' + qs({ code: adminCode, e: currentEvent, since: '3' }))).status`);
    if (apres !== 200) return { ok: false, detail: `après la panne : ${apres}` };
    return { ok: true, detail: `réponse sans corps abandonnée en ${cale.s.toFixed(1)} s, la suivante passe` };
  } finally {
    relais.vise = /^POST \/api\/count/;
    await reseau('ok');
  }
}

const SCENARIOS = [
  ['opérateur — réseau coupé net, puis rétabli', (h) => fileApresPanne(h, { panne: 'coupe', panneMs: 6000, maxMs: 6000 })],
  ['opérateur — le navigateur se croit encore hors ligne après le retour', (h) => fileApresPanne(h, { panne: 'coupe', horsLigne: true, panneMs: 6000, maxMs: 6000 })],
  ['opérateur — réseau muet (les requêtes pendent), puis rétabli', (h) => fileApresPanne(h, { panne: 'muet', panneMs: 9000, maxMs: 12_000 })],
  ['opérateur — réponse dont le corps n\'arrive jamais (le blocage du 2026-10-13)', (h) => fileApresPanne(h, { panne: 'corps-cale', panneMs: 4000, maxMs: 14_000 })],
  ['stats — relecture en direct dont le corps n\'arrive jamais', statsEnDirect],
  ['admin — réponse dont le corps n\'arrive jamais', adminRequetes],
];

async function main() {
  const bin = compiler();
  [APP_PORT, RELAIS_PORT] = [await portLibre(), await portLibre()];
  const etat = fs.mkdtempSync(path.join(os.tmpdir(), 'compteur-webkit-'));
  const appli = spawn(process.execPath, ['server.js'], {
    cwd: RACINE, stdio: 'ignore',
    env: { ...process.env, PORT: String(APP_PORT), STATE_FILE: path.join(etat, 'state.json') },
  });
  const h = new Harnais(bin);
  let echecs = 0;
  try {
    if (!await attendre(() => api('GET', '/api/state?e=x&g=x').then(() => true, () => false), 8000, 100)) throw new Error('serveur applicatif injoignable');
    await ecouter();
    await h.pret;
    const filtre = process.argv.slice(2).find((a) => !a.startsWith('--'));
    for (const [nom, jouer] of SCENARIOS) {
      if (filtre && !nom.includes(filtre)) continue;
      h.messages.length = 0;
      let r;
      try { r = await jouer(h); } catch (err) { r = { ok: false, detail: `erreur du banc : ${err.message}` }; }
      const erreurs = h.messages.filter((m) => /^ERREUR|^REJET/.test(m));
      if (r.ok && erreurs.length) r = { ok: false, detail: `${r.detail}\n      mais la page a levé : ${erreurs.join(' | ')}` };
      if (!r.ok) echecs++;
      log(`${r.ok ? '✔' : '✖'} ${nom}\n           ${r.detail}`);
    }
  } catch (err) {
    echecs++;
    log('✖ banc interrompu :', err.message);
  } finally {
    try { await Promise.race([h.effacer(), sleep(3000)]); } catch {}
    await h.quitter();
    appli.kill();
    if (relais.serveur) relais.serveur.close();
    for (const l of relais.liens) l.client.destroy();
    fs.rmSync(etat, { recursive: true, force: true });
    // Ce que WebKit a créé au nom du harnais — et rien d'autre.
    for (const d of ['WebKit', 'Caches', 'HTTPStorages']) fs.rmSync(path.join(os.homedir(), 'Library', d, BINAIRE), { recursive: true, force: true });
  }
  log(echecs ? `${echecs} scénario(s) en échec` : 'tous les scénarios passent');
  setTimeout(() => process.exit(echecs ? 1 : 0), 200);
}

main();
