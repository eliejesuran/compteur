'use strict';

// Page STATISTIQUES (public/stats.html) — le script de la page exécuté dans un faux
// navigateur (tests/shared/browser-harness.js), face à un serveur simulé qui applique le
// même fenêtrage `since` / `series` que le vrai.
// Couvre ce que CLAUDE.md décrit comme mesuré « à la main dans le navigateur intégré » :
// fenêtre → série → requête, stats par groupe / par opérateur en direct, pic, graphe.
//
// Un défaut connu et pas encore corrigé se note `{ todo: 'défaut connu — …' }` : le test
// est joué, son échec ne casse pas la suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { charger, reponse, corpsQuiCale, differe, stabiliser, HORS_LIGNE, PEND } = require('./shared/browser-harness');

// Constantes du serveur (STATE_FILE redirigé AVANT l'import, cf. server.test.js).
process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'compteur-stats-')), 'state.json');
const { MAX_HISTORY, FINE_INTERVAL_MS } = require('../server');

const T  = { timeout: 10_000 };
const E  = 'abc123', E2 = 'bbb222';
const G1 = 'aaa111', G2 = 'ccc333';
const T0 = Date.UTC(2026, 9, 12, 20, 0, 0); // « maintenant » au chargement de la page
const H  = 3600_000;

// ── Faux Chart.js ────────────────────────────────────────────────────────────

function fauxChart() {
  class Chart {
    constructor(_ctx, config) { this.data = config.data; this.options = config.options; this.rendus = 0; this.detruit = false; Chart.instances.push(this); }
    update() { this.rendus += 1; }
    destroy() { this.detruit = true; }
    isDatasetVisible(i) { return !this.data.datasets[i].hidden; }
  }
  Chart.instances = [];
  Chart.defaults = { plugins: { legend: { onClick(_e, item, legend) { const d = legend.chart.data.datasets[item.datasetIndex]; d.hidden = !d.hidden; } } } };
  return Chart;
}

// ── Serveur simulé ───────────────────────────────────────────────────────────

function soiree() {
  // Série fine : 2 h de points toutes les 30 s ; série longue : 10 jours toutes les 5 min.
  const history = Array.from({ length: 240 }, (_, k) => {
    const c = k; // l'occupation monte de 1 par point
    return { t: T0 - (240 - k) * 30_000, c, i: c + 10, o: 10, g: { [G1]: c - 2, [G2]: 2 } };
  });
  const historyCoarse = Array.from({ length: 2880 }, (_, k) => ({ t: T0 - (2880 - k) * 300_000, c: k % 400, i: k, o: 0 }));
  return {
    history, historyCoarse, total: 240, capacity: 500, peak: 900, totalIn: 250, totalOut: 10,
    groups: [
      { id: G1, name: 'Entrée Nord', count: 238, totalIn: 245, totalOut: 7, opStats: { Alice: { in: 200, out: 5 }, Bob: { in: 45, out: 2 } } },
      { id: G2, name: 'Entrée Sud', count: 2, totalIn: 5, totalOut: 3, opStats: { Alice: { in: 5, out: 3 } } },
    ],
  };
}

function serveur({ code = 'admin123', events = [{ id: E, name: 'Soirée' }] } = {}) {
  const s = { code, events, donnees: new Map([[E, soiree()]]), forcer: null, histo: [] };
  s.evt = (e = E) => s.donnees.get(e);
  s.repondre = (req) => {
    if (req.params.code !== s.code) return reponse(403, { error: 'forbidden' });
    if (req.chemin === '/api/events') return reponse(200, { events: s.events, role: 'admin' });
    if (req.chemin !== '/api/history') return reponse(404, { error: 'not found' });
    s.histo.push(req);
    if (s.forcer) { const r = s.forcer(req); if (r) return r; }
    return s.historique(req);
  };
  // Même découpe que server.js / event.js.
  s.historique = (req) => {
    const d = s.evt(req.params.e);
    if (!d) return reponse(404, { error: 'event not found' });
    const depuis = Number(req.params.since);
    const couper = (arr) => (Number.isFinite(depuis) && depuis > 0 ? arr.filter((h) => h.t >= depuis) : arr);
    return reponse(200, JSON.parse(JSON.stringify({
      ...d,
      history: req.params.series === 'coarse' ? [] : couper(d.history),
      historyCoarse: req.params.series === 'fine' ? [] : couper(d.historyCoarse),
    })));
  };
  // Un clic d'opérateur : met à jour l'état du serveur et rend le message WS `update`.
  s.clic = (delta, g = G1, nom = 'Alice') => {
    const d = s.evt(), grp = d.groups.find((x) => x.id === g);
    grp.count += delta; d.total += delta;
    const st = (grp.opStats[nom] ??= { in: 0, out: 0 });
    if (delta > 0) { grp.totalIn += delta; d.totalIn += delta; st.in += delta; }
    else { grp.totalOut -= delta; d.totalOut -= delta; st.out -= delta; }
    return s.update(delta);
  };
  s.update = (delta = 0, e = E) => {
    const d = s.evt(e);
    return { type: 'update', total: d.total, delta, alert: d.total >= d.capacity, capacity: d.capacity, groups: d.groups.map(({ id, name, count }) => ({ id, name, count })) };
  };
  s.init = (e = E) => {
    const d = s.evt(e);
    return { type: 'init', total: d.total, capacity: d.capacity, eventName: 'Soirée', groups: d.groups.map(({ id, name, count }) => ({ id, name, count })) };
  };
  return s;
}

// Une relecture « en direct » demande since = maintenant ; une lecture de fenêtre, since = maintenant − N heures.
const estDirecte = (req) => req.params.series === 'fine' && Number(req.params.since) >= req.a - 1000;

async function ouvrir({ srv = serveur(), connecter = true, ...opts } = {}) {
  const Chart = fauxChart();
  const page = charger('stats.html', 'function loadStats', { globaux: { Chart }, repondre: (req) => srv.repondre(req), depart: T0, ...opts });
  if (connecter) {
    page.el('code').value = srv.code;
    await page.appeler('loadStats()');
    await stabiliser();
    page.socket.ouvrir();
    page.socket.recevoir(srv.init(page.lire('currentEvent')));
    await stabiliser();
  }
  page.reseau.oublier();
  srv.histo.length = 0;
  return { page, srv, Chart, graphe: () => Chart.instances.at(-1) };
}

// Tableaux rendus en innerHTML → texte des cellules.
const lignes = (html) => html.split('<tr>').slice(1).map((r) => [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim()));
const operateurs = (html) => [...html.matchAll(/<span class="op-name">([\s\S]*?)<span class="op-grp"> · ([\s\S]*?)<\/span><\/span>\s*<span class="op-in">([^<]*)<\/span>\s*<span class="op-out">([^<]*)<\/span>\s*<span class="op-net">([^<]*)<\/span>/g)]
  .map((m) => m.slice(1, 6).map((x) => x.trim()));
const tuiles = (page) => ['s-count', 's-peak', 's-in', 's-cap'].map((id) => page.el(id).textContent);
// Les données du graphe sont des objets nés dans le contexte `vm` de la page : passage par
// JSON avant toute comparaison (sinon deepEqual les dit « de même structure mais différents »).
const net = (v) => JSON.parse(JSON.stringify(v));
const dernier = (jeu) => net(jeu.data.at(-1));

// ── Connexion ────────────────────────────────────────────────────────────────

describe('Stats — connexion', () => {
  test('code incorrect : message sur place, rien d\'autre ne se charge', T, async () => {
    const { page } = await ouvrir({ connecter: false });
    page.el('code').value = 'mauvais';
    await page.appeler('loadStats()');
    assert.equal(page.el('err').textContent, 'Code incorrect');
    assert.equal(page.el('err').style.display, 'block');
    assert.notEqual(page.el('stats-view').style.display, 'block');
    assert.equal(page.sockets.length, 0);
    assert.deepEqual(page.reseau.appels.map((a) => a.chemin), ['/api/events']);
  });

  test('champ vide : aucune requête', T, async () => {
    const { page } = await ouvrir({ connecter: false });
    page.el('code').value = '   ';
    await page.appeler('loadStats()');
    assert.equal(page.reseau.appels.length, 0);
  });

  // Le code est libre : sans encodage, un `&` ou un `#` coupe la query et le serveur
  // reçoit un code tronqué → 403 partout sauf à la connexion.
  test('code à caractères spéciaux : TOUTES les requêtes le transmettent intact', T, async () => {
    const code = 'a&b=c #1+é%20';
    const { page, srv } = await ouvrir({ srv: serveur({ code }) });
    assert.equal(page.el('stats-view').style.display, 'block');
    await page.appeler('setRange(168, null)');   // changement de fenêtre
    page.socket.recevoir(srv.clic(1));           // relecture en direct
    await page.avancer(61_000);                  // rafraîchissement périodique
    assert.ok(page.reseau.appels.length >= 3);
    for (const a of page.reseau.appels) assert.equal(a.params.code, code, a.url);
  });

  // Connexion « Graphiques » d'admin.html : le code arrive par sessionStorage.
  test('arrivée depuis admin : code lu dans sessionStorage, effacé aussitôt, jamais dans l\'URL', T, async () => {
    const srv = serveur();
    const page = charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart() }, session: { stats_code: 'admin123' }, repondre: (req) => srv.repondre(req), depart: T0 });
    assert.equal(page.session.getItem('stats_code'), null, 'effacé dès la lecture');
    assert.equal(page.el('login-view').style.display, 'none', 'formulaire masqué pendant la vérification');
    await stabiliser();
    assert.equal(page.el('stats-view').style.display, 'block');
    assert.equal(page.el('s-count').textContent, 240);
    assert.ok(!page.location.href.includes('admin123'));
    assert.deepEqual(page.journal.historique, [], 'l\'URL n\'est pas réécrite');
  });

  test('arrivée depuis admin avec un code refusé entre-temps : le formulaire revient, code pré-rempli', T, async () => {
    const srv = serveur({ code: 'nouveau-code' });
    const page = charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart() }, session: { stats_code: 'admin123' }, repondre: (req) => srv.repondre(req), depart: T0 });
    await stabiliser();
    assert.equal(page.el('login-view').style.display, '');
    assert.equal(page.el('code').value, 'admin123');
    assert.equal(page.el('err').textContent, 'Code incorrect');
  });

  test('serveur injoignable à l\'arrivée depuis admin : le formulaire revient, pas d\'écran vide', T, async () => {
    const page = charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart() }, session: { stats_code: 'admin123' }, repondre: HORS_LIGNE, depart: T0 });
    await stabiliser();
    assert.equal(page.el('login-view').style.display, '');
  });

  test('plusieurs événements : sélecteur affiché, ?e= présélectionne, un id inconnu retombe sur le premier', T, async () => {
    const events = [{ id: E, name: 'Soirée <1>' }, { id: E2, name: 'Gala & Co' }];
    const srv = serveur({ events });
    srv.donnees.set(E2, { ...soiree(), total: 7 });

    const pre = await ouvrir({ srv, url: `/stats.html?e=${E2}` });
    assert.equal(pre.page.lire('currentEvent'), E2);
    assert.equal(pre.page.el('s-count').textContent, 7);
    const html = pre.page.el('event-sel').innerHTML;
    assert.match(html, new RegExp(`<option value="${E2}" selected>Gala &amp; Co</option>`));
    assert.match(html, /Soirée &lt;1&gt;/, 'les noms sont échappés');
    assert.equal(pre.page.el('event-card').style.display, '');

    const inconnu = await ouvrir({ srv, url: '/stats.html?e=zzzzzz' });
    assert.equal(inconnu.page.lire('currentEvent'), E);

    const seul = await ouvrir();
    assert.equal(seul.page.existe('event-sel'), false, 'un seul événement : le sélecteur n\'est même pas rempli');
  });

  test('champs « code » : repassés en type=password si le navigateur ne sait pas masquer en CSS', T, async () => {
    const champ = { type: 'text' };
    charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart() }, selecteurs: { 'input.secret': [champ] } });
    assert.equal(champ.type, 'password', 'Firefox : mieux vaut la question que le code en clair');

    const masque = { type: 'text' };
    charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart(), CSS: { supports: (p, v) => p === '-webkit-text-security' && v === 'disc' } }, selecteurs: { 'input.secret': [masque] } });
    assert.equal(masque.type, 'text', 'Safari / Chrome : reste un champ texte (pas d\'invite d\'enregistrement)');
  });
});

// ── Fenêtre affichée ─────────────────────────────────────────────────────────

describe('Stats — fenêtre, série et requête', () => {
  test('FINE_RETENTION_H = rétention réelle de la série fine côté serveur', () => {
    const { page } = { page: charger('stats.html', 'function loadStats', { globaux: { Chart: fauxChart() } }) };
    assert.equal(page.lire('FINE_RETENTION_H'), (MAX_HISTORY * FINE_INTERVAL_MS) / H,
      'constante dupliquée : à réaligner si la cadence ou le plafond change');
  });

  test('chaque fenêtre demande la bonne série, bornée à sa durée', T, async () => {
    const { page, srv } = await ouvrir();
    for (const [heures, serie] of [[2, 'fine'], [6, 'fine'], [24, 'fine'], [36, 'fine'], [48, 'coarse'], [168, 'coarse'], [720, 'coarse']]) {
      srv.histo.length = 0;
      await page.appeler(`setRange(${heures}, null)`);
      const { params } = srv.histo[0];
      assert.equal(params.series, serie, `${heures} h`);
      assert.equal(Number(params.since), T0 - heures * H, `${heures} h : since`);
      assert.equal(params.e, E);
    }
    srv.histo.length = 0;
    await page.appeler('setRange(0, null)'); // « Début »
    assert.equal(srv.histo[0].params.series, 'coarse');
    assert.equal('since' in srv.histo[0].params, false, '« Début » : pas de borne');
  });

  // Le serveur renvoie VIDE la série qu'on ne lui a pas demandée : la recopier effacerait
  // des données encore affichables.
  test('une réponse ne remplace que la série demandée, l\'autre est conservée', T, async () => {
    const { page } = await ouvrir();
    assert.equal(page.lire('fullHistory.length'), 240);
    assert.equal(page.lire('fullHistoryCoarse.length'), 0, 'vue 24 h : la série longue n\'a pas été demandée');

    await page.appeler('setRange(168, null)');
    assert.equal(page.lire('fullHistory.length'), 240, 'la série fine survit au passage en vue 7 j');
    assert.equal(page.lire('fullHistoryCoarse.length'), 2016, '7 jours à un point / 5 min');

    await page.appeler('setRange(2, null)');
    assert.equal(page.lire('fullHistory.length'), 240);
    assert.equal(page.lire('fullHistoryCoarse.length'), 2016, 'et la série longue survit au retour en vue 2 h');
  });

  test('changement de fenêtre sans réseau : le graphe est redessiné avec ce qu\'on a déjà', T, async () => {
    const { page, srv, Chart } = await ouvrir();
    const avant = Chart.instances.length;
    srv.repondre = HORS_LIGNE;
    await assert.doesNotReject(page.appeler('setRange(6, null)'));
    assert.equal(Chart.instances.length, avant + 1);
    assert.equal(page.lire('chartWindowH'), 6);
    assert.equal(Chart.instances.at(-1).data.datasets[0].data.length, 241, '240 points + « maintenant »');
  });

  // Deux clics rapprochés sur les boutons de fenêtre, réseau lent : les réponses reviennent
  // dans le désordre. La réponse « 30 j » (série fine vide) arrive après celle de « 2 h ».
  test('réponse en retard d\'une fenêtre précédente : ignorée', T, async () => {
    const { page, srv } = await ouvrir();
    const lente = differe();
    srv.forcer = (req) => (req.params.series === 'coarse' ? lente.promise.then(() => srv.historique(req)) : null);
    const clic30j = page.appeler('setRange(720, null)');
    const clic2h  = page.appeler('setRange(2, null)');
    await clic2h;
    lente.resolve();
    await clic30j;
    assert.equal(page.lire('chartWindowH'), 2);
    assert.equal(page.lire('fullHistory.length'), 240, 'la série de la fenêtre affichée a été vidée');
    assert.equal(page.lire('fullHistoryCoarse.length'), 0, 'la réponse périmée n\'est appliquée nulle part');
  });

  // À l'inverse, le DERNIER clic doit toujours gagner, même si sa réponse arrive la première.
  test('trois clics rapprochés : c\'est la fenêtre du dernier qui s\'affiche, quel que soit l\'ordre des réponses', T, async () => {
    const { page, srv, graphe } = await ouvrir();
    const portes = [];
    srv.forcer = (req) => new Promise((resolve) => portes.push(() => resolve(srv.historique(req))));
    const clics = [page.appeler('setRange(2, null)'), page.appeler('setRange(720, null)'), page.appeler('setRange(6, null)')];
    await stabiliser();
    portes[2](); portes[0](); portes[1](); // la réponse du dernier clic arrive EN PREMIER
    await Promise.all(clics);
    assert.equal(page.lire('chartWindowH'), 6);
    assert.equal(page.lire('fullHistory.length'), 240);
    assert.equal(graphe().data.datasets[0].data.length, 241, 'le graphe montre la série fine de la vue 6 h');
  });

  // Une lecture périmée ne doit pas laisser la page à moitié initialisée : le chargement
  // d'un événement remplit aussi les tuiles et ouvre le WebSocket.
  test('clic sur une fenêtre PENDANT le chargement initial : la page finit complètement initialisée', T, async () => {
    const srv = serveur();
    const Chart = fauxChart();
    const page = charger('stats.html', 'function loadStats', { globaux: { Chart }, repondre: (req) => srv.repondre(req), depart: T0 });
    let premiere;
    srv.forcer = (req) => { if (premiere) return null; return new Promise((resolve) => { premiere = () => resolve(srv.historique(req)); }); };
    page.el('code').value = 'admin123';
    const connexion = page.appeler('loadStats()');
    await stabiliser();                        // la lecture initiale est en vol
    const clic = page.appeler('setRange(2, null)'); // l'utilisateur change déjà de fenêtre
    await stabiliser();
    premiere();                                // la lecture initiale revient, périmée
    await Promise.all([connexion, clic]);
    await stabiliser();
    assert.deepEqual(tuiles(page), [240, 900, 250, 500], 'tuiles remplies');
    assert.equal(page.sockets.length, 1, 'WebSocket ouvert');
    assert.equal(lignes(page.el('grp-body').innerHTML).length, 2, 'tableaux rendus');
    assert.equal(Chart.instances.at(-1).detruit, false);
  });
});

// ── Tuiles et pic ────────────────────────────────────────────────────────────

describe('Stats — tuiles', () => {
  test('à l\'ouverture : présents, pic, entrées, capacité viennent du serveur', T, async () => {
    const { page } = await ouvrir();
    assert.deepEqual(tuiles(page), [240, 900, 250, 500]);
  });

  // Le pic est calculé serveur sur les DEUX séries (60 j). Une lecture fenêtrée ne doit
  // jamais le faire redescendre, et un total en direct plus haut le fait monter.
  test('le pic ne recule jamais, et suit un total en direct qui le dépasse', T, async () => {
    const { page, srv } = await ouvrir();
    srv.evt().peak = 300; // une réponse (anormalement) plus basse
    await page.appeler('setRange(2, null)');
    await page.avancer(61_000);
    assert.equal(page.el('s-peak').textContent, 900);

    srv.evt().total = 950;
    page.socket.recevoir(srv.update(5));
    assert.equal(page.el('s-peak').textContent, 950);
    srv.evt().total = 100;
    page.socket.recevoir(srv.update(-5));
    assert.equal(page.el('s-peak').textContent, 950);
    assert.equal(page.el('s-count').textContent, 100);
  });

  test('« Entrées » : un +N l\'augmente tout de suite, un −N n\'y touche pas', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = () => reponse(500, null, { brut: 'x' }); // pas de resynchronisation : on ne regarde que le direct
    page.socket.recevoir({ ...srv.update(5), total: 245 });
    assert.equal(page.el('s-in').textContent, 255);
    page.socket.recevoir({ ...srv.update(-1), total: 244 });
    page.socket.recevoir({ ...srv.update(-5), total: 239 });
    assert.equal(page.el('s-in').textContent, 255);
    page.socket.recevoir({ ...srv.update(0), total: 239 }); // réglage admin
    assert.equal(page.el('s-in').textContent, 255);
  });

  test('la capacité modifiée par l\'admin est reprise sans recharger, ligne du graphe comprise', T, async () => {
    const { page, srv, graphe } = await ouvrir();
    srv.evt().capacity = 800;
    page.socket.recevoir(srv.update(0));
    assert.equal(page.el('s-cap').textContent, 800);
    assert.deepEqual(net(graphe().data.datasets[1].data).map((p) => p.y), [800, 800]);
  });
});

// ── Graphique ────────────────────────────────────────────────────────────────

describe('Stats — graphique', () => {
  const etiquettes = (g) => net(g.data.datasets.map((d) => d.label));

  test('vue fine, plusieurs groupes : présents, capacité, entrées cumulées (masquée) et une ligne par groupe', T, async () => {
    const { graphe } = await ouvrir();
    const g = graphe();
    assert.deepEqual(etiquettes(g), ['Présents', 'Capacité', 'Entrées cumulées', 'Entrée Nord', 'Entrée Sud']);
    assert.equal(g.data.datasets[2].hidden, true, 'masquée par défaut');
    assert.equal(g.data.datasets[2].yAxisID, 'y1', 'sur son propre axe, à droite');
    assert.equal(g.options.scales.x.type, 'linear', 'axe du temps réel, pas un axe à cases');
    assert.equal(g.options.scales.y1.display, 'auto');

    const presents = g.data.datasets[0].data;
    assert.equal(presents.length, 241);
    assert.deepEqual(net(presents[0]), { x: T0 - 240 * 30_000, y: 0 });
    assert.deepEqual(dernier(g.data.datasets[0]), { x: T0, y: 240 }, 'dernier point = « maintenant », au total en direct');
    assert.deepEqual(net(g.data.datasets[3].data[5]), { x: T0 - 235 * 30_000, y: 3 }, 'évolution réelle du groupe (h.g[id])');
    assert.deepEqual(dernier(g.data.datasets[3]), { x: T0, y: 238 });
    assert.deepEqual(net(g.data.datasets[1].data), [{ x: T0 - 240 * 30_000, y: 500 }, { x: T0, y: 500 }], 'capacité : du premier point à maintenant');
  });

  test('vue longue (> 36 h) : pas de ligne par groupe, la série longue ne les porte pas', T, async () => {
    const { page, graphe } = await ouvrir();
    await page.appeler('setRange(168, null)');
    assert.deepEqual(etiquettes(graphe()), ['Présents', 'Capacité', 'Entrées cumulées']);
    assert.equal(graphe().data.datasets[0].data.length, 2017);
  });

  test('un seul groupe : pas de ligne par groupe', T, async () => {
    const srv = serveur();
    srv.evt().groups.length = 1;
    const { graphe } = await ouvrir({ srv });
    assert.deepEqual(etiquettes(graphe()), ['Présents', 'Capacité', 'Entrées cumulées']);
  });

  // Points enregistrés avant l'ajout des cumuls (i/o) ou du détail par groupe (g) : le
  // champ est ABSENT. Le tracer à 0 inventerait une donnée.
  test('points anciens sans cumuls ni détail par groupe : tracés comme des trous, jamais comme des zéros', T, async () => {
    const srv = serveur();
    srv.evt().history = [{ t: T0 - 90_000, c: 5 }, { t: T0 - 60_000, c: 6, g: {} }, { t: T0 - 30_000, c: 7, i: 12, o: 5, g: { [G1]: 7 } }];
    const { graphe } = await ouvrir({ srv });
    const [, , cumul, nord, sud] = graphe().data.datasets;
    assert.deepEqual(net(cumul.data).map((p) => p.y), [null, null, 12, 250]);
    assert.deepEqual(net(nord.data).map((p) => p.y), [null, null, 7, 238]);
    assert.deepEqual(net(sud.data).map((p) => p.y), [null, null, null, 2]);
    assert.equal(cumul.spanGaps && nord.spanGaps, true);
  });

  test('un message en direct déplace le dernier point, il n\'en ajoute pas', T, async () => {
    const { page, srv, graphe, Chart } = await ouvrir();
    const g = graphe();
    const tailles = () => net(g.data.datasets.map((d) => d.data.length));
    const avant = tailles();
    for (let i = 0; i < 50; i++) { await page.avancer(100); page.socket.recevoir(srv.clic(1)); }
    assert.deepEqual(tailles(), avant, '50 clics : pas un point de plus');
    assert.equal(Chart.instances.at(-1), g, 'et le graphe n\'est pas reconstruit à chaque clic');
    assert.deepEqual(dernier(g.data.datasets[0]), { x: T0 + 5000, y: 290 });
    assert.deepEqual(dernier(g.data.datasets[3]), { x: T0 + 5000, y: 288 });
    assert.equal(dernier(g.data.datasets[1]).x, T0 + 5000, 'la ligne de capacité suit « maintenant »');
  });

  // renderChart() détruit et reconstruit le graphe à chaque fenêtre et toutes les 60 s.
  test('« Entrées cumulées » affichée d\'un clic sur la légende : le choix survit aux reconstructions', T, async () => {
    const { page, graphe } = await ouvrir();
    const g = graphe();
    g.options.plugins.legend.onClick.call({}, {}, { datasetIndex: 2 }, { chart: g });
    assert.equal(page.lire('showCumul'), true);

    await page.appeler('setRange(6, null)');
    assert.equal(g.detruit, true, 'l\'ancien graphe est libéré');
    assert.equal(graphe().data.datasets[2].hidden, false);
    await page.avancer(61_000);
    assert.equal(graphe().data.datasets[2].hidden, false);

    // un clic sur une AUTRE série de la légende ne change pas ce choix
    graphe().options.plugins.legend.onClick.call({}, {}, { datasetIndex: 0 }, { chart: graphe() });
    assert.equal(page.lire('showCumul'), true);
  });

  test('graduations de l\'axe du temps : heure jusqu\'à 24 h, date + heure à 48 h, date au-delà', T, async () => {
    const { page } = await ouvrir();
    const fmt = (h) => { page.appeler(`chartWindowH = ${h}`); return page.lire(`fmt(${T0})`); };
    const heure = /^\d{2}:\d{2}$/, date = /^\d{2}\/\d{2}$/;
    for (const h of [2, 6, 24]) assert.match(fmt(h), heure, `${h} h`);
    assert.match(fmt(48), /^\d{2}\/\d{2}.+\d{2}:\d{2}$/, '48 h, à cheval sur deux jours');
    for (const h of [168, 720, 0]) assert.match(fmt(h), date, `${h} h`);
  });
});

// ── Stats par groupe / par opérateur en direct ───────────────────────────────

describe('Stats — tableaux par groupe et par opérateur, en direct', () => {
  test('à l\'ouverture : une ligne par groupe + total, opérateurs cumulés sur tous les groupes et triés', T, async () => {
    const { page } = await ouvrir();
    assert.deepEqual(lignes(page.el('grp-body').innerHTML), [['Entrée Nord', '238', '+245', '−7'], ['Entrée Sud', '2', '+5', '−3']]);
    assert.deepEqual(lignes(page.el('grp-foot').innerHTML), [['Total', '240', '+250', '−10']]);
    assert.deepEqual(operateurs(page.el('op-list').innerHTML),
      [['Alice', 'Entrée Sud', '+205', '−8', '197 net'], ['Bob', 'Entrée Nord', '+45', '−2', '43 net']]);
  });

  test('un clic : compteur du groupe à jour tout de suite, entrées / sorties et opérateurs dans la foulée', T, async () => {
    const { page, srv } = await ouvrir();
    page.socket.recevoir(srv.clic(5, G2, 'Chloé'));
    assert.deepEqual(lignes(page.el('grp-body').innerHTML)[1], ['Entrée Sud', '7', '+5', '−3'],
      'le compteur vient du WebSocket ; le reste attend la relecture');

    await page.avancer(1000);
    assert.equal(srv.histo.length, 1, 'une seule relecture');
    assert.deepEqual(lignes(page.el('grp-body').innerHTML)[1], ['Entrée Sud', '7', '+10', '−3']);
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => o[0]), ['Alice', 'Bob', 'Chloé']);
    assert.deepEqual(operateurs(page.el('op-list').innerHTML)[2], ['Chloé', 'Entrée Sud', '+5', '−0', '5 net']);
  });

  // La relecture ne rapatrie AUCUN point d'historique : since = maintenant. Sa réponse ne
  // doit jamais passer par applyHistory(), qui remplacerait la série affichée par [].
  test('la relecture est minimale (series=fine, since=maintenant) et ne touche pas à la courbe', T, async () => {
    const { page, srv, graphe } = await ouvrir();
    const g = graphe();
    await page.avancer(5000);
    page.socket.recevoir(srv.clic(1));
    await page.avancer(1000);

    assert.equal(srv.histo.length, 1);
    const { params } = srv.histo[0];
    assert.deepEqual([params.series, params.e, params.code], ['fine', E, 'admin123']);
    assert.ok(Math.abs(Number(params.since) - (T0 + 5000)) <= 1000, `since = maintenant (reçu ${params.since})`);
    assert.equal(page.lire('fullHistory.length'), 240, 'la série fine est intacte');
    assert.equal(g.data.datasets[0].data.length, 241);
    assert.equal(g.detruit, false, 'pas de reconstruction du graphe');
  });

  // Mesuré dans le navigateur (CLAUDE.md) : 20 clics en 1,3 s → 3 relectures.
  test('rafale de 20 clics en 1,3 s : au plus une relecture par seconde, jamais deux à la fois, une dernière après la rafale', T, async () => {
    const { page, srv } = await ouvrir();
    let enVol = 0, maxEnVol = 0;
    const departs = [];
    srv.forcer = (req) => {
      enVol += 1; maxEnVol = Math.max(maxEnVol, enVol); departs.push(req.a);
      // la réponse met 150 ms à revenir, et reflète l'état du serveur à SON départ
      const corps = srv.historique(req);
      return new Promise((resolve) => page.horloge.setTimeout(() => { enVol -= 1; resolve(corps); }, 150));
    };
    for (let i = 0; i < 20; i++) { page.socket.recevoir(srv.clic(1, i % 2 ? G1 : G2, i % 2 ? 'Alice' : 'Bob')); await page.avancer(65); }
    await page.avancer(3000);

    assert.equal(maxEnVol, 1, 'deux relectures en parallèle');
    assert.ok(departs.length >= 2 && departs.length <= 3, `${departs.length} relectures pour 20 clics`);
    for (let i = 1; i < departs.length; i++) assert.ok(departs[i] - departs[i - 1] >= 1000, 'moins d\'une seconde entre deux relectures');

    // Après la rafale, la page dit exactement ce que dit le serveur.
    const d = srv.evt();
    assert.deepEqual(lignes(page.el('grp-body').innerHTML), d.groups.map((x) => [x.name, String(x.count), `+${x.totalIn}`, `−${x.totalOut}`]));
    assert.equal(page.el('s-in').textContent, d.totalIn);
    assert.equal(page.el('s-count').textContent, d.total);
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => [o[0], o[2]]), [['Alice', '+215'], ['Bob', '+55']]);
  });

  // Réponse partie AVANT un clic, arrivée APRÈS : elle est en retard sur le WebSocket.
  test('un clic arrivé pendant la relecture : la tuile « Entrées » ne recule pas', T, async () => {
    const { page, srv } = await ouvrir();
    const lente = differe();
    let premiere = true;
    srv.forcer = (req) => { if (!premiere) return null; premiere = false; const figee = srv.historique(req); return lente.promise.then(() => figee); };

    page.socket.recevoir(srv.clic(1));   // entrées : 251 — relecture n°1 partie avec 251
    await page.avancer(10);
    page.socket.recevoir(srv.clic(5));   // entrées : 256 pendant que la n°1 est en vol
    assert.equal(page.el('s-in').textContent, 256);

    lente.resolve();
    await stabiliser();
    assert.equal(page.el('s-in').textContent, 256, 'la réponse en retard (251) a fait reculer la tuile');
    assert.equal(lignes(page.el('grp-body').innerHTML)[0][1], '244', 'et le compteur du groupe reste celui du WebSocket');

    await page.avancer(1500); // la relecture de rattrapage
    assert.equal(srv.histo.length, 2);
    assert.equal(page.el('s-in').textContent, 256);
    assert.deepEqual(lignes(page.el('grp-body').innerHTML)[0], ['Entrée Nord', '244', '+251', '−7']);
  });

  test('page cachée : aucune relecture ; au retour, la reconnexion du WebSocket resynchronise tout', T, async () => {
    const { page, srv } = await ouvrir();
    page.document.hidden = true;
    for (let i = 0; i < 5; i++) { page.socket.recevoir(srv.clic(1, G1, 'Dana')); await page.avancer(2000); }
    assert.equal(srv.histo.length, 0, 'onglet en arrière-plan : pas de requête');

    await page.visible(true);          // wsReconnectNow → nouveau socket
    page.socket.ouvrir();
    page.socket.recevoir(srv.init());
    await stabiliser();
    assert.ok(operateurs(page.el('op-list').innerHTML).some((o) => o[0] === 'Dana' && o[2] === '+5'));
    assert.equal(page.el('s-in').textContent, 255);
  });

  test('relecture en échec (réseau, 500, 403) : sans effet, et le clic suivant en relance une', T, async () => {
    const { page, srv } = await ouvrir();
    for (const panne of [HORS_LIGNE, () => reponse(500, null, { brut: 'oups' }), () => reponse(403, { error: 'forbidden' })]) {
      srv.forcer = panne;
      const avant = page.el('op-list').innerHTML;
      page.socket.recevoir(srv.clic(1));
      await page.avancer(1500);
      assert.equal(page.el('op-list').innerHTML, avant, 'le tableau n\'est ni vidé ni remplacé par une erreur');
    }
    srv.forcer = null;
    srv.histo.length = 0;
    page.socket.recevoir(srv.clic(1));
    await page.avancer(1500);
    assert.equal(srv.histo.length, 1);
    assert.equal(operateurs(page.el('op-list').innerHTML)[0][2], '+209');
  });

  // Même trou que dans la file de l'écran opérateur (2026-10-13) : le corps de la réponse
  // était attendu sans limite, et `liveStatsBusy` restait pris pour toujours — tableaux
  // figés jusqu'au rechargement, pendant que les tuiles, elles, suivaient le WebSocket.
  for (const [nom, panne, sourd] of [
    ['corps qui n\'arrive jamais', () => corpsQuiCale(), false],
    ['requête qui ne revient jamais, navigateur sourd à abort()', PEND, true],
  ]) {
    test(`relecture en direct — ${nom} : abandonnée au bout de 6 s, puis les tableaux se remettent à jour`, T, async () => {
      const { page, srv } = await ouvrir();
      page.reseau.sourd = sourd;
      srv.forcer = panne;
      page.socket.recevoir(srv.clic(1)); // relecture n°1 : ne reviendra pas
      await page.avancer(100);
      assert.equal(srv.histo.length, 1);

      srv.forcer = null;
      page.socket.recevoir(srv.clic(1)); // un autre clic pendant qu'elle est attendue
      await page.avancer(5800);
      assert.equal(srv.histo.length, 1, 'jamais deux relectures à la fois');
      assert.equal(operateurs(page.el('op-list').innerHTML)[0][2], '+205', 'tableau encore figé');

      await page.avancer(1200); // 6 s : abandonnée — et la relecture de rattrapage part
      assert.equal(srv.histo.length, 2);
      assert.equal(operateurs(page.el('op-list').innerHTML)[0][2], '+207');
    });
  }

  test('groupe créé, renommé ou supprimé par l\'admin : le tableau suit sans recharger', T, async () => {
    const { page, srv } = await ouvrir();
    const d = srv.evt();
    d.groups.push({ id: 'ddd444', name: 'Porte <VIP>', count: 0, totalIn: 0, totalOut: 0, opStats: {} });
    page.socket.recevoir(srv.update(0));
    assert.deepEqual(lignes(page.el('grp-body').innerHTML)[2], ['Porte &lt;VIP&gt;', '0', '+0', '−0'],
      'nouveau groupe visible avant même la relecture, nom échappé');

    d.groups[1].name = 'Sud (renommée)';
    page.socket.recevoir(srv.update(0));
    assert.equal(lignes(page.el('grp-body').innerHTML)[1][0], 'Sud (renommée)');

    d.total -= d.groups[0].count;
    d.groups.shift(); // suppression de « Entrée Nord »
    page.socket.recevoir(srv.update(0));
    assert.deepEqual(lignes(page.el('grp-body').innerHTML).map((l) => l[0]), ['Sud (renommée)', 'Porte &lt;VIP&gt;']);
    assert.equal(lignes(page.el('grp-foot').innerHTML)[0][1], '2');
  });

  test('remise à zéro des compteurs : les compteurs tombent à 0, entrées et sorties restent', T, async () => {
    const { page, srv } = await ouvrir();
    const d = srv.evt();
    d.groups.forEach((x) => { x.count = 0; });
    d.total = 0;
    page.socket.recevoir(srv.update(0));
    await page.avancer(1000);
    assert.deepEqual(lignes(page.el('grp-body').innerHTML), [['Entrée Nord', '0', '+245', '−7'], ['Entrée Sud', '0', '+5', '−3']]);
    assert.equal(page.el('s-count').textContent, 0);
    assert.equal(page.el('s-peak').textContent, 900, 'le pic survit');
  });

  test('un seul groupe : pas de tableau par groupe ; aucun opérateur nommé : pas de tableau par opérateur', T, async () => {
    const srv = serveur();
    srv.evt().groups = [{ id: G1, name: 'Principal', count: 3, totalIn: 3, totalOut: 0, opStats: { Fantôme: { in: 0, out: 0 } } }];
    const { page } = await ouvrir({ srv });
    assert.equal(page.el('grp-card').style.display, 'none');
    assert.equal(page.el('op-card').style.display, 'none', 'un opérateur à 0 / 0 n\'est pas listé');
  });

  // Le prénom sert de clé d'objet : « constructor » trouvait une propriété héritée.
  test('opérateurs nommés constructor, toString, __proto__ : affichés comme les autres, rien de pollué', T, async () => {
    const srv = serveur();
    srv.evt().groups[0].opStats = JSON.parse('{"constructor":{"in":7,"out":1},"toString":{"in":3,"out":0},"__proto__":{"in":2,"out":2}}');
    const { page } = await ouvrir({ srv });
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => [o[0], o[2], o[3]]),
      [['constructor', '+7', '−1'], ['Alice', '+5', '−3'], ['toString', '+3', '−0'], ['__proto__', '+2', '−2']]);
    assert.deepEqual(page.valeur('Object.keys(Object.prototype)'), []);
    assert.equal(page.lire('typeof Object.in'), 'undefined');
  });

  test('prénoms et noms de groupe hostiles : échappés, jamais interprétés', T, async () => {
    const srv = serveur();
    srv.evt().groups[0].name = '<img src=x onerror=alert(1)>';
    srv.evt().groups[0].opStats = { '<script>alert(1)</script>': { in: 3, out: 0 } };
    const { page } = await ouvrir({ srv });
    for (const id of ['grp-body', 'op-list']) {
      const html = page.el(id).innerHTML;
      assert.ok(!/<script|<img/i.test(html), `${id} : balise injectée`);
      assert.match(html, /&lt;(script|img)/);
    }
  });
});

// ── Sans internet ────────────────────────────────────────────────────────────

describe('Stats — sans Chart.js', () => {
  // Chart.js vient d'un CDN. En LAN sans internet (le mode de repli), `Chart` n'existe
  // pas : `new Chart()` lève dans renderChart(), AVANT le rendu des tableaux et l'ouverture
  // du WebSocket. Il ne reste que quatre tuiles figées.
  test('bibliothèque de graphes absente : tuiles, tableaux et direct fonctionnent quand même', T, async () => {
    const srv = serveur();
    const page = charger('stats.html', 'function loadStats', { repondre: (req) => srv.repondre(req), depart: T0 }); // pas de Chart
    page.el('code').value = 'admin123';
    await page.appeler('loadStats()');
    await stabiliser();
    assert.deepEqual(tuiles(page), [240, 900, 250, 500]);
    assert.equal(lignes(page.el('grp-body').innerHTML).length, 2, 'tableau par groupe');
    assert.equal(operateurs(page.el('op-list').innerHTML).length, 2, 'tableau par opérateur');
    assert.equal(page.sockets.length, 1, 'WebSocket ouvert');

    // …et tout ce qui redessine le graphe d'habitude passe sans lever.
    page.socket.ouvrir();
    page.socket.recevoir(srv.init());
    await stabiliser();
    page.socket.recevoir(srv.clic(5, G2, 'Chloé'));
    await page.avancer(1000);
    await page.appeler('setRange(168, null)');
    await page.avancer(61_000);
    assert.equal(page.el('s-count').textContent, 245);
    assert.ok(operateurs(page.el('op-list').innerHTML).some((o) => o[0] === 'Chloé'), 'le direct suit sans graphe');
  });
});

// ── Rafraîchissement périodique et WebSocket ─────────────────────────────────

describe('Stats — rafraîchissement et connexion', () => {
  test('toutes les 60 s : relit la fenêtre affichée et reconstruit le graphe ; jamais en arrière-plan', T, async () => {
    const { page, srv, Chart } = await ouvrir();
    const avant = Chart.instances.length;
    await page.avancer(60_000);
    assert.equal(srv.histo.length, 1);
    assert.deepEqual([srv.histo[0].params.series, Number(srv.histo[0].params.since)], ['fine', T0 + 60_000 - 24 * H], 'la fenêtre glisse');
    assert.equal(Chart.instances.length, avant + 1);

    page.document.hidden = true;
    await page.avancer(300_000);
    assert.equal(srv.histo.length, 1, 'onglet caché : aucune requête');
  });

  test('sans WebSocket ouvert, le rafraîchissement périodique fait foi pour le total et les compteurs', T, async () => {
    const { page, srv, graphe } = await ouvrir();
    page.document.hidden = true;  // coupure sans reconnexion automatique
    page.socket.couper();
    page.document.hidden = false;
    const d = srv.evt();
    d.total = 300; d.groups[0].count = 298;
    await page.avancer(60_000);
    assert.equal(lignes(page.el('grp-body').innerHTML)[0][1], '298');
    assert.equal(dernier(graphe().data.datasets[0]).y, 300);
  });

  test('WebSocket : sans groupe dans l\'adresse, reconnexion après coupure, retour au premier plan immédiat', T, async () => {
    const { page, srv } = await ouvrir();
    assert.equal(page.socket.url, `wss://compteur.test?e=${E}`);
    page.socket.couper();
    await page.avancer(999);
    assert.equal(page.sockets.length, 1);
    await page.avancer(1);
    assert.equal(page.sockets.length, 2, 'reconnexion à 1 s');

    const zombie = page.socket;
    zombie.ouvrir();
    await page.visible(true);
    assert.equal(zombie.fermePar, 'page');
    assert.equal(page.sockets.length, 3);
    zombie.onmessage?.({ data: JSON.stringify({ ...srv.update(0), total: 5 }) });
    assert.equal(page.el('s-count').textContent, 240, 'un ancien socket ne peut plus rien afficher');
  });

  test('reconnexion : le message init déclenche une relecture complète (des clics ont pu être manqués)', T, async () => {
    const { page, srv } = await ouvrir();
    page.socket.couper();
    srv.clic(5, G2, 'Émile'); srv.clic(5, G2, 'Émile'); // pendant la coupure
    await page.avancer(1000);
    page.socket.ouvrir();
    page.socket.recevoir(srv.init());
    await stabiliser();
    assert.equal(page.el('s-count').textContent, 250);
    assert.equal(page.el('s-in').textContent, 260);
    assert.deepEqual(lignes(page.el('grp-body').innerHTML)[1], ['Entrée Sud', '12', '+15', '−3']);
    assert.ok(operateurs(page.el('op-list').innerHTML).some((o) => o[0] === 'Émile'));
  });

  test('changement d\'événement : tout repart de zéro, l\'ancien socket est fermé, le nouveau vise le bon événement', T, async () => {
    const srv = serveur({ events: [{ id: E, name: 'A' }, { id: E2, name: 'B' }] });
    srv.donnees.set(E2, { history: [], historyCoarse: [], total: 3, capacity: 50, peak: 4, totalIn: 4, totalOut: 1, groups: [{ id: 'eee555', name: 'Principal', count: 3, totalIn: 4, totalOut: 1, opStats: { Zoé: { in: 4, out: 1 } } }] });
    const { page, graphe } = await ouvrir({ srv });
    const ancien = page.socket, vieuxGraphe = graphe();

    await page.appeler(`switchEvent(${JSON.stringify(E2)})`);
    assert.equal(ancien.fermePar, 'page');
    assert.equal(vieuxGraphe.detruit, true);
    assert.equal(page.socket.url, `wss://compteur.test?e=${E2}`);
    assert.deepEqual(tuiles(page), [3, 4, 4, 50], 'ni le pic ni les entrées de l\'ancien événement');
    assert.equal(page.lire('fullHistory.length'), 0);
    assert.equal(page.el('grp-card').style.display, 'none');
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => o[0]), ['Zoé']);

    ancien.onmessage?.({ data: JSON.stringify({ type: 'update', total: 999, delta: 1, capacity: 500, groups: [] }) });
    assert.equal(page.el('s-count').textContent, 3, 'un message tardif de l\'ancien événement est ignoré');
  });

  test('relecture en direct partie avant un changement d\'événement : sa réponse est ignorée', T, async () => {
    const srv = serveur({ events: [{ id: E, name: 'A' }, { id: E2, name: 'B' }] });
    srv.donnees.set(E2, { history: [], historyCoarse: [], total: 3, capacity: 50, peak: 4, totalIn: 4, totalOut: 1, groups: [{ id: 'eee555', name: 'Principal', count: 3, totalIn: 4, totalOut: 1, opStats: { Zoé: { in: 4, out: 1 } } }] });
    const { page } = await ouvrir({ srv });
    const lente = differe();
    srv.forcer = (req) => (req.params.e === E && estDirecte(req) ? lente.promise.then(() => srv.historique(req)) : null);
    page.socket.recevoir(srv.clic(1));
    await page.avancer(10); // la relecture de A est en vol
    await page.appeler(`switchEvent(${JSON.stringify(E2)})`);
    lente.resolve();
    await stabiliser();
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => o[0]), ['Zoé'], 'les opérateurs de A ne doivent pas s\'afficher sous B');
    assert.equal(page.el('s-in').textContent, 4);
  });

  // Même garde pour le rafraîchissement de 60 s et setRange() : une lecture n'est appliquée
  // que si aucune autre n'est partie depuis (cf. historySeq).
  test('rafraîchissement de 60 s parti avant un changement d\'événement : sa réponse est ignorée', T, async () => {
    const srv = serveur({ events: [{ id: E, name: 'A' }, { id: E2, name: 'B' }] });
    srv.donnees.set(E2, { history: [], historyCoarse: [], total: 3, capacity: 50, peak: 4, totalIn: 4, totalOut: 1, groups: [{ id: 'eee555', name: 'Principal', count: 3, totalIn: 4, totalOut: 1, opStats: { Zoé: { in: 4, out: 1 } } }] });
    const { page } = await ouvrir({ srv });
    const lente = differe();
    srv.forcer = (req) => (req.params.e === E ? lente.promise.then(() => srv.historique(req)) : null);
    await page.avancer(60_000);  // le rafraîchissement de A part…
    await page.appeler(`switchEvent(${JSON.stringify(E2)})`);
    lente.resolve();             // …et revient après le passage à B
    await stabiliser();
    assert.equal(page.el('s-in').textContent, 4, 'entrées de A affichées sous B');
    assert.equal(page.lire('fullHistory.length'), 0, 'courbe de A affichée sous B');
    assert.deepEqual(operateurs(page.el('op-list').innerHTML).map((o) => o[0]), ['Zoé']);
  });
});

// ── fetchT : le corps est lu sous délai, morceau par morceau ─────────────────
// (le même code est recopié dans admin.html — tests/static-contracts.test.js le vérifie)

describe('Stats — requêtes bornées de bout en bout', () => {
  // Réponse dont le corps arrive par morceaux, chacun libéré par le test.
  function enMorceaux(texte, coupes) {
    const octets = new TextEncoder().encode(texte);
    const parts = [];
    let debut = 0;
    for (const c of [...coupes, octets.length]) { parts.push(octets.slice(debut, c)); debut = c; }
    const lectures = [];
    const flux = {
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({ read: () => { const d = differe(); lectures.push(d); return d.promise; } }) },
    };
    return {
      flux, parts,
      morceau: (i) => lectures[i].resolve({ done: false, value: parts[i] }),
      fin: () => lectures.at(-1).resolve({ done: true, value: undefined }),
    };
  }
  const ouvrirNu = (repondre) => charger('stats.html', 'function loadStats', { globaux: { TextDecoder }, repondre, depart: T0 });

  test('gros corps sur réseau lent : le délai repart à chaque morceau, la réponse arrive entière', T, async () => {
    const texte = JSON.stringify({ nom: 'Chloé — soirée d\'été', history: [1, 2, 3] });
    const iAccent = new TextEncoder().encode(texte.slice(0, texte.indexOf('é'))).length;
    const m = enMorceaux(texte, [5, iAccent + 1, 30]); // la 2e coupe tombe AU MILIEU du « é » (2 octets)
    const enTetes = differe();
    const page = ouvrirNu(() => enTetes.promise);
    const recu = page.appeler("fetchT('/api/history?x=1').then((r) => r.json())");
    await page.avancer(5000);
    enTetes.resolve(m.flux); // les en-têtes ont déjà mis 5 s : le corps repart d'un délai entier
    await stabiliser();
    for (let i = 0; i < m.parts.length; i++) { await page.avancer(5000); m.morceau(i); await stabiliser(); }
    await page.avancer(5000);
    m.fin();
    assert.deepEqual(net(await recu), JSON.parse(texte), '30 s au total, jamais 6 s sans rien recevoir');
  });

  test('corps qui s\'arrête en route : abandonné 6 s après le dernier morceau, même si le navigateur est sourd à abort()', T, async () => {
    const m = enMorceaux('{"history":[1,2,3]}', [8]);
    const page = ouvrirNu(() => m.flux);
    page.reseau.sourd = true;
    let issue = null;
    page.appeler("fetchT('/api/history?x=1').then((r) => r.json())").then(() => { issue = 'reçu'; }, (e) => { issue = `abandonné : ${e.message}`; });
    await stabiliser();
    await page.avancer(3000);
    m.morceau(0);
    await stabiliser();
    await page.avancer(5999);
    assert.equal(issue, null, 'encore dans le délai (compté depuis le dernier morceau)');
    await page.avancer(1);
    assert.equal(issue, 'abandonné : délai dépassé');
  });

  test('réponse ordinaire : ok, status et json() comme avant ; un corps qui n\'est pas du JSON fait échouer json()', T, async () => {
    const page = ouvrirNu((req) => (req.params.x === '1' ? reponse(404, { error: 'event not found' }) : reponse(200, null, { brut: '<html>portail</html>' })));
    const r = await page.appeler("fetchT('/api/history?x=1').then(async (r) => [r.ok, r.status, await r.json()])");
    assert.deepEqual(net(r), [false, 404, { error: 'event not found' }]);
    const html = await page.appeler("fetchT('/api/history?x=2').then((r) => r.json()).then(() => 'lu', (e) => e.name)");
    assert.equal(html, 'SyntaxError');
  });
});
