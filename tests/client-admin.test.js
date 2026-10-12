'use strict';

// Page ADMIN (public/admin.html) — le script de la page exécuté dans un faux navigateur
// (tests/shared/browser-harness.js) face à un serveur simulé.
// Couvre les défauts déjà rencontrés côté admin (code tronqué dans la query, bouton
// Supprimer inerte sur un nom à apostrophe, /api/history rapatrié à chaque déverrouillage,
// loadIPs sur un élément masqué, export limité à la fenêtre fine) et quelques cas neufs.
//
// Un défaut connu et pas encore corrigé se note `{ todo: 'défaut connu — …' }` : le test
// est joué, son échec ne casse pas la suite.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { charger, reponse, stabiliser, HORS_LIGNE } = require('./shared/browser-harness');

const T  = { timeout: 10_000 };
const E  = 'abc123', E2 = 'bbb222';
const G1 = 'aaa111', G2 = 'ccc333';
const T0 = Date.UTC(2026, 9, 12, 20, 0, 0);

// ── Faux SheetJS : garde ce que la page lui demande d'écrire ─────────────────

function fauxXlsx() {
  const fichiers = [];
  const XLSX = {
    utils: {
      book_new: () => ({ feuilles: {} }),
      aoa_to_sheet: (lignes) => ({ lignes }),
      book_append_sheet: (wb, feuille, nom) => { wb.feuilles[nom] = JSON.parse(JSON.stringify(feuille.lignes)); },
    },
    writeFile: (wb, nom) => { fichiers.push({ nom, ...wb.feuilles }); },
  };
  return { XLSX, fichiers };
}

// ── Serveur simulé ───────────────────────────────────────────────────────────

function evenement(id, name, groups) {
  return { id, name, total: groups.reduce((s, g) => s + g.count, 0), capacity: 100, createdAt: T0, groups };
}

function serveur({ code = 'admin123', perm = null } = {}) {
  const s = {
    code, perm,
    events: [evenement(E, 'Soirée', [{ id: G1, name: 'Entrée Nord', count: 30 }, { id: G2, name: 'Entrée Sud', count: 10 }])],
    archives: [],
    clients: [],
    histo: { history: [], historyCoarse: [], total: 40, capacity: 100, peak: 40, totalIn: 50, totalOut: 10, groups: [] },
    forcer: null,   // (req) => réponse, pour court-circuiter une route
    recus: [],      // toutes les requêtes, dans l'ordre
  };
  const role = (c) => (c === s.code ? 'admin' : (s.perm && c === s.perm ? 'perm' : null));
  s.posts = (chemin) => s.recus.filter((r) => r.method === 'POST' && (!chemin || r.chemin === chemin)).map((r) => r.corps);
  s.vers = (chemin) => s.recus.filter((r) => r.chemin === chemin);
  s.repondre = (req) => {
    s.recus.push(req);
    const r = role(req.method === 'GET' ? req.params.code : req.corps?.code);
    if (!r) return reponse(403, { error: 'forbidden' });
    if (s.forcer) { const f = s.forcer(req, r); if (f) return f; }
    const adminSeul = () => (r === 'admin' ? null : reponse(403, { error: 'forbidden' }));
    switch (`${req.method} ${req.chemin}`) {
      case 'GET /api/events':          return reponse(200, { events: JSON.parse(JSON.stringify(s.events)), role: r });
      case 'GET /api/events/archived': return adminSeul() ?? reponse(200, { events: JSON.parse(JSON.stringify(s.archives)) });
      case 'GET /api/qr':              return reponse(200, { qr: 'data:image/png;base64,AAAA', url: `https://compteur.test/?e=${req.params.e}&g=${req.params.g}` });
      case 'GET /api/clients':         return reponse(200, { clients: s.clients });
      case 'GET /api/ips':             return reponse(200, { ips: ['192.168.1.20'], port: 3000 });
      case 'GET /api/history':         return reponse(200, JSON.parse(JSON.stringify(s.histo)));
      case 'POST /api/events': {
        const evt = evenement(E2, req.corps.name, [{ id: 'ddd444', name: 'Principal', count: 0 }]);
        s.events.push(evt);
        return adminSeul() ?? reponse(200, evt);
      }
      case 'POST /api/groups':         return adminSeul() ?? reponse(200, { id: 'eee555', name: req.corps.name });
      case 'POST /api/admin/config': {
        const refus = adminSeul(); if (refus) return refus;
        const { e, archived, deleteEvent, newCode } = req.corps;
        if (typeof newCode === 'string' && newCode.length >= 4) s.code = newCode;
        if (archived === true) { const i = s.events.findIndex((x) => x.id === e); if (i >= 0) s.archives.push(...s.events.splice(i, 1)); }
        if (archived === false) { const i = s.archives.findIndex((x) => x.id === e); if (i >= 0) s.events.push(...s.archives.splice(i, 1)); }
        if (deleteEvent === true) s.archives = s.archives.filter((x) => x.id !== e);
        return reponse(200, { ok: true });
      }
      case 'POST /api/reset-counts':   return reponse(200, { ok: true });
      default: return reponse(404, { error: 'not found' });
    }
  };
  return s;
}

// Le <div id="ip-list"> est commenté dans admin.html : getElementById ne le trouve pas.
const ABSENTS = ['ip-list'];

async function ouvrir({ srv = serveur(), connecter = true, code, ...opts } = {}) {
  const { XLSX, fichiers } = fauxXlsx();
  const page = charger('admin.html', 'function login', {
    url: '/admin.html', absents: ABSENTS, globaux: { XLSX }, repondre: (req) => srv.repondre(req), depart: T0, ...opts,
  });
  if (connecter) {
    page.el('code-input').value = code ?? srv.code;
    await page.appeler('login()');
    await stabiliser();
    if (page.socket) {
      page.socket.ouvrir();
      const evt = srv.events.find((x) => x.id === page.lire('currentEvent'));
      page.socket.recevoir({ type: 'init', total: evt.total, capacity: evt.capacity, eventName: evt.name, groups: evt.groups });
      await stabiliser();
    }
  }
  return { page, srv, fichiers };
}

const codeDe = (req) => (req.method === 'GET' ? req.params.code : req.corps?.code);
const visible = (page, id) => page.el(id).style.display !== 'none';
// Clic sur un bouton de la liste des archivés (délégation posée sur le conteneur).
const cliquerArchive = (page, act, id) => page.el('archived-list').emettre('click', { target: { closest: (sel) => (sel === 'button[data-act]' ? { dataset: { act, id } } : null) } });

// ── Connexion ────────────────────────────────────────────────────────────────

describe('Admin — connexion', () => {
  test('code correct : la page charge événements, archivés, QR, opérateurs, et ouvre le WebSocket sans groupe', T, async () => {
    const { page, srv } = await ouvrir();
    assert.equal(page.el('login-view').style.display, 'none');
    assert.equal(page.el('main-view').style.display, 'block');
    assert.deepEqual([...new Set(srv.recus.map((r) => r.chemin))].sort(), ['/api/clients', '/api/events', '/api/events/archived', '/api/qr']);
    assert.equal(page.socket.url, `wss://compteur.test?e=${E}`);
    assert.equal(page.el('live-count').textContent, 40);
    assert.equal(page.el('live-sub').textContent, '40 / 100 personnes');
    assert.equal(page.el('qr-img').src, 'data:image/png;base64,AAAA');
    assert.equal(page.el('stats-link').href, `/stats.html?e=${E}`);
  });

  test('code incorrect : message, la page reste sur la connexion', T, async () => {
    const { page, srv } = await ouvrir({ code: 'mauvais' });
    assert.equal(page.el('login-err').textContent, 'Code incorrect');
    assert.notEqual(page.el('main-view').style.display, 'block');
    assert.equal(srv.recus.length, 1);
    assert.equal(page.sockets.length, 0);
  });

  // Le code est libre (4 caractères mini). Interpolé brut dans la query, un `&`, `+`, `#`
  // ou une espace le tronquait : 403 partout sauf à la connexion, seule à encoder.
  test('code à caractères spéciaux : TOUTES les requêtes le transmettent intact, export compris', T, async () => {
    const code = 'a&b=c #1+é%20?';
    const { page, srv } = await ouvrir({ srv: serveur({ code }) });
    assert.equal(page.el('main-view').style.display, 'block');
    await page.appeler(`loadQR(${JSON.stringify(G2)})`);
    await page.appeler('loadArchived()');
    await page.appeler('exportXLSX()');
    await page.visible(true); // reconnexion → /api/clients
    page.socket.ouvrir();
    await stabiliser();
    assert.ok(srv.recus.length >= 8);
    for (const req of srv.recus) assert.equal(codeDe(req), code, `${req.method} ${req.url}`);
  });

  test('rôle PERM : réglages, création, archivage et édition des groupes masqués ; compteurs à zéro et export restent', T, async () => {
    const { page, srv } = await ouvrir({ srv: serveur({ perm: 'perm-1234' }), code: 'perm-1234' });
    assert.equal(page.lire('userRole'), 'perm');
    for (const id of ['card-capacity', 'card-rename', 'card-code', 'card-perm', 'card-reset', 'card-archive', 'new-event-btn', 'new-group-btn']) {
      assert.equal(visible(page, id), false, `${id} doit être masqué`);
    }
    assert.equal(page.el('card-reset-counts').style.display, undefined, 'la remise à zéro des compteurs n\'est pas masquée');
    assert.equal(visible(page, 'export-btn'), true);
    assert.ok(!/renameGroup|deleteGroup/.test(page.el('grp-body').innerHTML), 'pas de bouton d\'édition des groupes');
    assert.equal(srv.vers('/api/events/archived').length, 0, 'la liste des archivés n\'est pas demandée');
  });

  // Connexion directe aux graphiques : le code passe par sessionStorage, jamais par l'URL.
  test('bloc « Graphiques » : code vérifié sur place, transmis par sessionStorage, navigation vers /stats.html nu', T, async () => {
    const { page, srv } = await ouvrir({ connecter: false });
    page.el('stats-code-input').value = '  admin123  ';
    await page.appeler('loginStats()');
    assert.equal(page.session.getItem('stats_code'), 'admin123');
    assert.deepEqual(page.journal.navigations, ['/stats.html']);
    assert.deepEqual(srv.recus.map((r) => r.chemin), ['/api/events']);
  });

  test('bloc « Graphiques » : code refusé ou serveur injoignable → message, ni navigation ni code mémorisé', T, async () => {
    const refus = await ouvrir({ connecter: false });
    refus.page.el('stats-code-input').value = 'mauvais';
    await refus.page.appeler('loginStats()');
    assert.equal(refus.page.el('stats-login-err').textContent, 'Code incorrect');

    const coupe = await ouvrir({ connecter: false, repondre: HORS_LIGNE });
    coupe.page.el('stats-code-input').value = 'admin123';
    await coupe.page.appeler('loginStats()');
    assert.equal(coupe.page.el('stats-login-err').textContent, 'Serveur injoignable');

    for (const { page } of [refus, coupe]) {
      assert.deepEqual(page.journal.navigations, []);
      assert.equal(page.session.getItem('stats_code'), null);
    }
  });

  // En PWA iOS (standalone) il n'y a aucun bouton retour : la flèche ne doit apparaître que
  // si on vient de l'écran opérateur, et survivre à un aller-retour admin ↔ stats.
  test('flèche retour vers le comptage : seulement en venant de l\'écran opérateur (mémorisé par onglet)', T, async () => {
    const venu = await ouvrir({ connecter: false, url: '/admin.html?from=op' });
    assert.equal(venu.page.el('back-op').classList.contains('show'), true);
    assert.equal(venu.page.session.getItem('from_op'), '1');

    const retour = await ouvrir({ connecter: false, session: { from_op: '1' } }); // revenu de stats.html
    assert.equal(retour.page.el('back-op').classList.contains('show'), true);

    const direct = await ouvrir({ connecter: false }); // PWA admin lancée directement
    assert.equal(direct.page.existe('back-op'), false, 'la flèche n\'est même pas touchée');
  });

  test('champs « code » : repassés en type=password si le navigateur ne sait pas masquer en CSS', T, async () => {
    const champs = [{ type: 'text' }, { type: 'text' }];
    await ouvrir({ connecter: false, selecteurs: { 'input.secret': champs } });
    assert.deepEqual(champs.map((c) => c.type), ['password', 'password']);

    const masques = [{ type: 'text' }];
    await ouvrir({ connecter: false, selecteurs: { 'input.secret': masques }, globaux: { CSS: { supports: () => true } } });
    assert.equal(masques[0].type, 'text');
  });
});

// ── Ce que la page ne doit PAS demander ──────────────────────────────────────

describe('Admin — requêtes inutiles', () => {
  // L'historique complet pèse jusqu'à ~2 Mo. Il était rapatrié à chaque ouverture du
  // WebSocket, donc à chaque déverrouillage du téléphone, pour deux valeurs que le message
  // `init` porte déjà.
  test('/api/history n\'est demandé qu\'à l\'export — ni à la connexion, ni à chaque retour au premier plan', T, async () => {
    const { page, srv } = await ouvrir();
    for (let i = 0; i < 3; i++) {
      await page.visible(true);
      page.socket.ouvrir();
      page.socket.recevoir({ type: 'init', total: 40, capacity: 100, eventName: 'Soirée', groups: srv.events[0].groups });
      await stabiliser();
    }
    assert.equal(srv.vers('/api/history').length, 0);

    await page.appeler('exportXLSX()');
    const demandes = srv.vers('/api/history');
    assert.equal(demandes.length, 1);
    assert.deepEqual(Object.keys(demandes[0].params).sort(), ['code', 'e'], 'export = historique COMPLET : ni since ni series');
  });

  // Le <div id="ip-list"> est commenté dans le HTML : sans garde, loadIPs() plantait à
  // chaque connexion sans événement et à chaque ouverture du WebSocket.
  test('adresses réseau masquées : loadIPs() ne demande rien et ne lève pas', T, async () => {
    const { page, srv } = await ouvrir();
    await assert.doesNotReject(page.appeler('loadIPs()'));
    assert.equal(srv.vers('/api/ips').length, 0);

    const vide = serveur();
    vide.events = [];
    const sans = await ouvrir({ srv: vide }); // connexion sans événement → loadIPs()
    assert.equal(vide.vers('/api/ips').length, 0);
    assert.equal(sans.page.el('empty-state').style.display, 'block');
  });

  test('adresses réseau : il suffit de décommenter le <div> pour les réafficher (une seule requête)', T, async () => {
    const { page, srv } = await ouvrir({ absents: [] });
    assert.equal(srv.vers('/api/ips').length, 1);
    assert.match(page.el('ip-list').innerHTML, /http:\/\/192\.168\.1\.20:3000/);
    await page.appeler('loadIPs()');
    assert.equal(srv.vers('/api/ips').length, 1, 'déjà chargé : pas de nouvelle requête');
  });
});

// ── WebSocket et affichage ───────────────────────────────────────────────────

describe('Admin — tableau en direct', () => {
  const cellules = (html) => html.split('<tr>').slice(1).map((r) => [...r.matchAll(/<td class="g-(?:name|count|pct)">([\s\S]*?)<\/td>/g)].map((m) => m[1].trim()));

  test('init / update : total, sous-titre, une ligne par groupe avec sa part', T, async () => {
    const { page } = await ouvrir();
    assert.deepEqual(cellules(page.el('grp-body').innerHTML), [['Entrée Nord', '30', '75%'], ['Entrée Sud', '10', '25%']]);

    page.socket.recevoir({ type: 'update', total: 0, delta: 0, alert: false, capacity: 250, groups: [{ id: G1, name: 'Entrée Nord', count: 5 }, { id: G2, name: 'Sortie', count: -5 }] });
    assert.equal(page.el('live-sub').textContent, '0 / 250 personnes');
    assert.deepEqual(cellules(page.el('grp-body').innerHTML), [['Entrée Nord', '5', '0%'], ['Sortie', '-5', '0%']], 'total à 0 : pas de division par zéro');
  });

  test('noms de groupe, d\'événement et prénoms d\'opérateur hostiles : échappés partout', T, async () => {
    const srv = serveur();
    const mechant = '<img src=x onerror="alert(1)">\'';
    srv.events[0].name = mechant;
    srv.events[0].groups[0].name = mechant;
    srv.clients = [{ name: mechant, groupName: mechant }];
    const { page } = await ouvrir({ srv });
    page.socket.recevoir({ type: 'clients', clients: srv.clients });
    for (const id of ['grp-body', 'event-sel', 'qr-group-sel', 'op-list']) {
      const html = page.el(id).innerHTML;
      assert.ok(html.includes('&lt;img'), `${id} : le nom doit apparaître échappé`);
      assert.ok(!html.includes('<img'), `${id} : balise injectée`);
    }
    assert.equal(page.el('op-count').textContent, 1);
  });

  // N7 : esc() transforme ' en &#39;, que le parseur HTML redécode AVANT l'analyse du JS
  // d'un attribut onclick. Un nom ne doit donc jamais y figurer — seulement l'identifiant.
  test('boutons d\'édition des groupes : l\'onclick ne transporte que l\'identifiant, jamais le nom', T, async () => {
    const srv = serveur();
    srv.events[0].groups[0].name = 'Soirée d\'ouverture "VIP"';
    const { page } = await ouvrir({ srv });
    const handlers = [...page.el('grp-body').innerHTML.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(handlers, [`renameGroup('${G1}')`, `deleteGroup('${G1}')`, `renameGroup('${G2}')`, `deleteGroup('${G2}')`]);
  });

  test('renommer un groupe : le nom actuel est relu dans l\'état (apostrophes comprises), pas dans le HTML', T, async () => {
    const srv = serveur();
    const nom = 'Soirée d\'ouverture "VIP"';
    srv.events[0].groups[0].name = nom;
    let propose;
    const { page } = await ouvrir({ srv, saisir: (_m, defaut) => { propose = defaut; return '  Entrée principale  '; } });
    await page.appeler(`renameGroup('${G1}')`);
    assert.equal(propose, nom, 'valeur proposée dans la boîte de saisie');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: E, g: G1, name: 'Entrée principale' }]);
  });

  test('renommer un groupe : annulation, nom vide ou inchangé → aucune requête', T, async () => {
    for (const saisie of [null, '', '   ', 'Entrée Nord']) {
      const { page, srv } = await ouvrir({ saisir: () => saisie });
      await page.appeler(`renameGroup('${G1}')`);
      assert.deepEqual(srv.posts(), [], `saisie ${JSON.stringify(saisie)}`);
    }
  });

  test('liste des opérateurs : mise à jour par le WebSocket, groupe entre parenthèses, texte de repli quand elle est vide', T, async () => {
    const { page } = await ouvrir();
    page.socket.recevoir({ type: 'clients', clients: [{ name: 'Alice', groupName: 'Entrée Nord' }, { name: 'Chef', groupName: null }] });
    assert.equal(page.el('op-count').textContent, 2);
    assert.match(page.el('op-list').innerHTML, /Alice <span[^>]*>\(Entrée Nord\)<\/span>/);
    assert.match(page.el('op-list').innerHTML, /<span class="op-badge">Chef<\/span>/);
    page.socket.recevoir({ type: 'clients', clients: [] });
    assert.match(page.el('op-list').innerHTML, /Aucun opérateur connecté/);
  });

  test('WebSocket : reconnexion après coupure, immédiate au retour au premier plan, une seule connexion par événement', T, async () => {
    const { page } = await ouvrir();
    page.appeler(`startWS('${E}')`);
    assert.equal(page.sockets.length, 1, 'déjà connecté à cet événement');

    page.socket.couper();
    await page.avancer(1000);
    assert.equal(page.sockets.length, 2);

    const zombie = page.socket;
    zombie.ouvrir();
    await page.visible(true);
    assert.equal(zombie.fermePar, 'page');
    assert.equal(page.sockets.length, 3);
    await page.avancer(60_000);
    assert.equal(page.sockets.length, 3, 'pas de connexion en double');
  });

  test('changement d\'événement : l\'ancien socket est fermé, ses messages tardifs sont ignorés', T, async () => {
    const srv = serveur();
    srv.events.push(evenement(E2, 'Gala', [{ id: 'ddd444', name: 'Principal', count: 7 }]));
    const { page } = await ouvrir({ srv });
    const ancien = page.socket;
    const tardif = ancien.onmessage;
    await page.appeler(`switchEvent('${E2}')`);
    assert.equal(ancien.fermePar, 'page');
    assert.equal(page.socket.url, `wss://compteur.test?e=${E2}`);
    assert.equal(page.el('live-count').textContent, 7);
    assert.equal(page.el('stats-link').href, `/stats.html?e=${E2}`);

    tardif({ data: JSON.stringify({ type: 'update', total: 999, capacity: 100, groups: [] }) });
    assert.equal(page.el('live-count').textContent, 7);
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

describe('Admin — actions', () => {
  test('capacité : valeur invalide refusée sur place, valeur valide envoyée comme un nombre', T, async () => {
    const { page, srv } = await ouvrir();
    for (const saisie of ['', 'abc', '0', '-5']) {
      page.el('cap-input').value = saisie;
      await page.appeler('saveCapacity()');
      assert.equal(page.el('cap-toast').textContent, 'Valeur invalide', `saisie ${JSON.stringify(saisie)}`);
    }
    assert.deepEqual(srv.posts(), []);

    page.el('cap-input').value = '250';
    await page.appeler('saveCapacity()');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: E, capacity: 250 }]);
    assert.equal(page.el('cap-toast').textContent, 'Seuil réglé à 250 personnes');
  });

  test('renommer l\'événement : nom vide refusé ; sinon envoyé SANS identifiant de groupe', T, async () => {
    const { page, srv } = await ouvrir();
    page.el('event-name-input').value = '   ';
    await page.appeler('renameEvent()');
    assert.equal(page.el('name-toast').textContent, 'Nom vide');

    page.el('event-name-input').value = '  Gala d\'hiver  ';
    await page.appeler('renameEvent()');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: E, name: 'Gala d\'hiver' }]);
    assert.match(page.el('event-sel').innerHTML, /Gala d&#39;hiver/);
  });

  test('changer le code admin : confirmation avant envoi, puis toutes les requêtes utilisent le nouveau', T, async () => {
    const { page, srv } = await ouvrir();
    page.el('new-code').value = 'abc';
    page.appeler('changeCode()');
    assert.equal(page.el('code-toast').textContent, 'Code trop court (min. 4 caractères)');
    assert.equal(page.el('code-confirm-dialog').ouvert, false);

    page.el('new-code').value = '  nouveau & code  ';
    page.appeler('changeCode()');
    assert.equal(page.el('code-confirm-dialog').ouvert, true);
    assert.equal(page.el('code-confirm-preview').textContent, 'nouveau & code', 'aperçu en texte, pas en HTML');
    assert.deepEqual(srv.posts(), [], 'rien n\'est envoyé avant la confirmation');

    await page.appeler('confirmCodeChange()');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', newCode: 'nouveau & code' }]);
    assert.equal(page.el('new-code').value, '');

    await page.appeler(`loadQR('${G1}')`);
    assert.equal(srv.recus.at(-1).params.code, 'nouveau & code');
  });

  test('code PERM : trop court refusé, champ vide = désactivation (null)', T, async () => {
    const { page, srv } = await ouvrir();
    page.el('perm-code-input').value = 'abc';
    await page.appeler('savePermCode()');
    assert.deepEqual(srv.posts(), []);

    page.el('perm-code-input').value = 'perm-1234';
    await page.appeler('savePermCode()');
    page.el('perm-code-input').value = '';
    await page.appeler('savePermCode()');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', newPermCode: 'perm-1234' }, { code: 'admin123', newPermCode: null }]);
    assert.equal(page.el('perm-toast').textContent, 'Code PERM désactivé');
  });

  test('actions destructrices : rien n\'est envoyé si l\'admin annule la confirmation', T, async () => {
    const { page, srv } = await ouvrir({ confirmer: false });
    for (const action of ['resetCounts()', 'resetEvent()', 'archiveEvent()', `deleteGroup('${G1}')`]) await page.appeler(action);
    assert.equal(page.journal.confirmations.length, 4);
    assert.deepEqual(srv.posts(), []);
  });

  test('compteurs à zéro, réinitialisation, suppression de groupe : la bonne route, le bon corps', T, async () => {
    const { page, srv } = await ouvrir();
    await page.appeler('resetCounts()');
    await page.appeler('resetEvent()');
    await page.appeler(`deleteGroup('${G2}')`);
    assert.deepEqual(srv.posts('/api/reset-counts'), [{ code: 'admin123', e: E }]);
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: E, reset: true }, { code: 'admin123', e: E, g: G2, deleteGroup: true }]);
    assert.equal(page.el('reset-counts-toast').textContent, 'Compteurs remis à zéro');
  });

  test('suppression du dernier groupe refusée par le serveur : message explicite', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = (req) => (req.corps?.deleteGroup ? reponse(200, { ok: false, error: 'cannot delete last group' }) : null);
    await page.appeler(`deleteGroup('${G1}')`);
    assert.deepEqual(page.journal.alertes, ['Impossible de supprimer le dernier groupe.']);
  });

  test('plafond atteint (409) à la création d\'un événement ou d\'un groupe : le message du serveur est affiché', T, async () => {
    const { page, srv } = await ouvrir({ saisir: () => 'Nouveau' });
    srv.forcer = (req) => (req.method === 'POST' ? reponse(409, { error: 'Limite atteinte : 50 événements maximum.' }) : null);
    await page.appeler('newEvent()');
    await page.appeler('createGroup()');
    assert.deepEqual(page.journal.alertes, ['Limite atteinte : 50 événements maximum.', 'Limite atteinte : 50 événements maximum.']);
    assert.equal(page.sockets.length, 1, 'pas de bascule vers un événement qui n\'existe pas');
  });

  test('nouvel événement : sélectionné, affiché, WebSocket rebranché dessus', T, async () => {
    const { page } = await ouvrir({ saisir: () => '  Gala  ' });
    await page.appeler('newEvent()');
    assert.equal(page.lire('currentEvent'), E2);
    assert.equal(page.socket.url, `wss://compteur.test?e=${E2}`);
    assert.match(page.el('event-sel').innerHTML, />Gala</);
    assert.equal(page.el('live-count').textContent, 0);
  });

  test('archiver : l\'événement quitte le sélecteur, le suivant est chargé ; le dernier archivé → écran vide', T, async () => {
    const srv = serveur();
    srv.events.push(evenement(E2, 'Gala', [{ id: 'ddd444', name: 'Principal', count: 7 }]));
    const { page } = await ouvrir({ srv });
    await page.appeler('archiveEvent()');
    assert.equal(page.lire('currentEvent'), E2);
    assert.equal(page.socket.url, `wss://compteur.test?e=${E2}`);
    assert.equal(page.el('archived-count').textContent, 1);

    await page.appeler('archiveEvent()');
    assert.equal(page.lire('currentEvent'), '');
    assert.equal(page.el('empty-state').style.display, 'block');
    assert.equal(page.el('event-content').style.display, 'none');
  });
});

// ── Événements archivés ──────────────────────────────────────────────────────

describe('Admin — événements archivés', () => {
  const NOM = 'Soirée d\'ouverture <b>"VIP"</b>';
  const avecArchive = () => { const srv = serveur(); srv.archives = [{ id: 'fff666', name: NOM, capacity: 100, createdAt: T0 }]; return srv; };

  // N7bis : « Soirée d'ouverture » suffisait à rendre le bouton Supprimer inerte.
  test('liste : nom échappé, boutons en data-*, AUCUN gestionnaire en ligne', T, async () => {
    const { page } = await ouvrir({ srv: avecArchive() });
    const html = page.el('archived-list').innerHTML;
    assert.ok(!/\son\w+=/.test(html), 'aucun onclick / on* dans la liste');
    assert.match(html, /data-act="unarchive" data-id="fff666"/);
    assert.match(html, /data-act="delete"\s+data-id="fff666"/);
    assert.match(html, /Soirée d&#39;ouverture &lt;b&gt;&quot;VIP&quot;&lt;\/b&gt;/);
    assert.equal(page.el('archived-count').textContent, 1);
    assert.equal(page.el('card-archived').style.display, '');
  });

  test('supprimer : confirmation avec le nom exact (en texte), puis suppression et retrait de la liste', T, async () => {
    const { page, srv } = await ouvrir({ srv: avecArchive() });
    cliquerArchive(page, 'delete', 'fff666');
    assert.equal(page.el('delete-confirm-dialog').ouvert, true);
    assert.equal(page.el('delete-confirm-name').textContent, NOM);
    assert.deepEqual(srv.posts(), [], 'rien avant la confirmation');

    await page.appeler('deleteArchivedEvent()');
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: 'fff666', deleteEvent: true }]);
    assert.equal(page.el('delete-confirm-dialog').ouvert, false);
    assert.equal(page.el('archived-count').textContent, 0);
    assert.equal(page.el('card-archived').style.display, 'none');
  });

  test('suppression en échec (502, réseau) : alerte, l\'événement reste dans la liste pour réessayer', T, async () => {
    for (const panne of [() => reponse(502, { error: 'delete failed' }), () => { throw new TypeError('Failed to fetch'); }]) {
      const { page, srv } = await ouvrir({ srv: avecArchive() });
      srv.forcer = (req) => (req.corps?.deleteEvent ? panne() : null);
      cliquerArchive(page, 'delete', 'fff666');
      await page.appeler('deleteArchivedEvent()');
      assert.deepEqual(page.journal.alertes, ['Échec de la suppression — réessayez.']);
      assert.equal(page.lire('archivedEvents.length'), 1);
    }
  });

  test('désarchiver : l\'événement revient dans le sélecteur', T, async () => {
    const { page, srv } = await ouvrir({ srv: avecArchive() });
    cliquerArchive(page, 'unarchive', 'fff666');
    await stabiliser();
    assert.deepEqual(srv.posts('/api/admin/config'), [{ code: 'admin123', e: 'fff666', archived: false }]);
    assert.match(page.el('event-sel').innerHTML, /value="fff666"/);
    assert.equal(page.el('card-archived').style.display, 'none');
  });

  test('un clic ailleurs que sur un bouton de la liste ne fait rien', T, async () => {
    const { page, srv } = await ouvrir({ srv: avecArchive() });
    page.el('archived-list').emettre('click', { target: { closest: () => null } });
    assert.deepEqual(srv.posts(), []);
    assert.equal(page.el('delete-confirm-dialog').ouvert, false);
  });
});

// ── Export XLSX ──────────────────────────────────────────────────────────────

describe('Admin — export XLSX', () => {
  const MIN = 60_000;
  // Série longue : 1 point / 5 min sur 2 h ; série fine : les 20 dernières minutes, toutes
  // les 30 s. Les 20 dernières minutes existent donc dans LES DEUX séries.
  function historique() {
    const historyCoarse = Array.from({ length: 24 }, (_, k) => ({ t: T0 - (24 - k) * 5 * MIN, c: 100 + k, i: 200 + k, o: 100 }));
    const history = Array.from({ length: 40 }, (_, k) => ({ t: T0 - (40 - k) * 30_000, c: 500 + k, i: 700 + k, o: 200, g: { [G1]: 500 + k } }));
    return {
      history, historyCoarse, total: 539, capacity: 600, peak: 539, totalIn: 739, totalOut: 200,
      groups: [{ id: G1, name: 'Entrée Nord', count: 539, totalIn: 739, totalOut: 200, opStats: {} }, { id: G2, name: 'Sortie', count: 0, totalIn: 0, totalOut: 0, opStats: {} }],
    };
  }

  // L'onglet « Historique » fusionne les deux séries : sans ça l'export s'arrêtait à la
  // fenêtre fine alors que la série longue couvre 60 jours.
  test('fusionne long terme puis détaillé, sans doublon sur la période commune, dans l\'ordre du temps', T, async () => {
    const srv = serveur();
    srv.histo = historique();
    const { page, fichiers } = await ouvrir({ srv });
    await page.appeler('exportXLSX()');
    assert.equal(fichiers.length, 1);
    const [entete, ...lignes] = fichiers[0].Historique;
    assert.deepEqual(entete, ['Horodatage', 'Présents', 'Entrées cumulées', 'Sorties cumulées', 'Série']);

    const series = lignes.map((l) => l[4]);
    assert.equal(series.filter((x) => x === 'détaillé').length, 40, 'tous les points fins');
    assert.equal(series.filter((x) => x === 'long terme').length, 20, '2 h de série longue moins les 20 min déjà couvertes en détail');
    assert.equal(series.lastIndexOf('long terme') < series.indexOf('détaillé'), true, 'le long terme d\'abord, le détaillé ensuite');
    assert.deepEqual(lignes[0].slice(1), [100, 200, 100, 'long terme']);
    assert.deepEqual(lignes.at(-1).slice(1), [539, 739, 200, 'détaillé']);
    assert.equal(new Set(lignes.map((l) => l[0])).size, 60, 'aucun horodatage en double');
  });

  test('cumuls absents (points d\'avant la fonctionnalité) : cellule vide, jamais 0', T, async () => {
    const srv = serveur();
    srv.histo = { ...historique(), historyCoarse: [{ t: T0 - 7200_000, c: 12 }], history: [{ t: T0 - 60_000, c: 5, g: {} }, { t: T0 - 30_000, c: 6, i: 0, o: 0, g: {} }] };
    const { page, fichiers } = await ouvrir({ srv });
    await page.appeler('exportXLSX()');
    const lignes = fichiers[0].Historique.slice(1).map((l) => l.slice(1));
    assert.deepEqual(lignes, [[12, '', '', 'long terme'], [5, '', '', 'détaillé'], [6, 0, 0, 'détaillé']], 'un vrai 0 reste un 0');
  });

  test('séries vides : une seule des deux, ou aucune, l\'export sort quand même', T, async () => {
    const cas = [
      [{ history: [] }, 24, 'long terme'],
      [{ historyCoarse: [] }, 40, 'détaillé'],
      [{ history: [], historyCoarse: [] }, 0, null],
    ];
    for (const [manque, attendu, serie] of cas) {
      const srv = serveur();
      srv.histo = { ...historique(), ...manque };
      const { page, fichiers } = await ouvrir({ srv });
      await page.appeler('exportXLSX()');
      const lignes = fichiers[0].Historique.slice(1);
      assert.equal(lignes.length, attendu);
      if (serie) assert.ok(lignes.every((l) => l[4] === serie));
      const periode = fichiers[0].Résumé.find((l) => l[0] === 'Période couverte')[1];
      assert.equal(periode === '—', attendu === 0);
    }
  });

  test('onglets Résumé et Groupes, nom de fichier nettoyé et daté', T, async () => {
    const srv = serveur();
    srv.histo = historique();
    srv.events[0].name = 'Soirée d\'été / 2026 : "VIP"';
    const { page, fichiers } = await ouvrir({ srv });
    await page.appeler('exportXLSX()');
    const f = fichiers[0];
    const resume = Object.fromEntries(f.Résumé.filter((l) => l.length === 2));
    assert.equal(resume['Événement'], 'Soirée d\'été / 2026 : "VIP"');
    assert.deepEqual([resume['Total actuel'], resume['Capacité'], resume['Total entrées'], resume['Total sorties']], [539, 600, 739, 200]);
    assert.match(resume['Série détaillée'], /30 secondes.*36 h/);
    assert.match(resume['Série long terme'], /5 minutes.*60 jours/);
    assert.deepEqual(f.Groupes, [['Groupe', 'Compteur', 'Entrées', 'Sorties'], ['Entrée Nord', 539, 739, 200], ['Sortie', 0, 0, 0]]);
    assert.match(f.nom, /^[\w]+_2026-10-12\.xlsx$/, `nom de fichier : ${f.nom}`);
    assert.ok(!/[/\\:"' ]/.test(f.nom));
  });

  test('export en échec (réseau, code refusé, événement disparu) : alerte, aucun fichier à moitié écrit', T, async () => {
    for (const panne of [() => { throw new TypeError('Failed to fetch'); }, () => reponse(403, { error: 'forbidden' }), () => reponse(404, { error: 'event not found' })]) {
      const { page, srv, fichiers } = await ouvrir();
      srv.forcer = (req) => (req.chemin === '/api/history' ? panne() : null);
      await page.appeler('exportXLSX()');
      assert.deepEqual(page.journal.alertes, ['Erreur lors de l\'export']);
      assert.equal(fichiers.length, 0);
    }
  });

  // SheetJS vient d'un CDN. En LAN sans internet, ou si le CDN est bloqué, `XLSX` n'existe
  // pas : le bouton « Exporter » ne faisait alors RIEN, sans un mot.
  test('SheetJS non chargé (pas d\'internet) : l\'admin est prévenu, et rien n\'est téléchargé pour rien', T, async () => {
    const { page, srv } = await ouvrir({ globaux: { XLSX: undefined } });
    await page.appeler('exportXLSX()');
    assert.equal(page.journal.alertes.length, 1, 'aucun message : l\'admin croit que l\'export est parti');
    assert.match(page.journal.alertes[0], /Export impossible/);
    assert.equal(srv.vers('/api/history').length, 0, 'inutile de rapatrier l\'historique si on ne peut pas l\'écrire');
  });
});
