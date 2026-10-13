'use strict';

// Écran OPÉRATEUR (public/index.html) — la logique qui compte vraiment sur le terrain et
// que rien ne testait : la file d'attente hors ligne (« ne jamais perdre un comptage »),
// la reconnexion du WebSocket, la restauration de l'affichage, l'alerte de capacité.
// Le script de la page est exécuté tel quel dans un faux navigateur
// (tests/shared/browser-harness.js) : réseau, stockage et horloge sont pilotés par le test.
//
// `{ todo }` = défaut CONNU, pas encore corrigé (ici : V12, l'alerte en double) : le test
// est joué, son échec ne casse pas la suite. Corriger le défaut → retirer l'option.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { charger, reponse, corpsQuiCale, differe, stabiliser, HORS_LIGNE, PEND } = require('./shared/browser-harness');

const E = 'abc123', G = 'def456';
const T = { timeout: 10_000 };

// Serveur simulé : tient un total et répond comme l'API (/api/state, /api/count).
function serveur({ total = 10, capacity = 100, groupCount = 4 } = {}) {
  const s = { total, capacity, groupCount, vus: new Set(), comptes: [], enLigne: true, forcer: null };
  s.repondre = (req) => {
    if (!s.enLigne) throw new TypeError('Failed to fetch');
    if (req.chemin === '/api/state') {
      return reponse(200, { total: s.total, groupCount: s.groupCount, capacity: s.capacity, eventName: 'Soirée', groupName: 'Principal' });
    }
    if (req.chemin === '/api/count') {
      if (s.forcer) { const r = s.forcer(req); if (r) return r; }
      return s.compter(req);
    }
    return reponse(404, { error: 'not found' });
  };
  // Le comptage seul : pour simuler « le serveur a compté, mais sa réponse se perd en route ».
  s.compter = (req) => {
    if (s.vus.has(req.corps.uuid)) return reponse(200, { total: s.total, dup: true });
    s.vus.add(req.corps.uuid);
    s.total = Math.max(0, s.total + req.corps.delta);
    s.comptes.push(req.corps);
    return reponse(200, { total: s.total, alert: s.total >= s.capacity });
  };
  return s;
}

// Page ouverte sur un événement, état initial chargé, WebSocket connecté.
async function ouvrir({ srv = serveur(), ws = true, ...opts } = {}) {
  const page = charger('index.html', 'function flush', {
    url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice' }, repondre: (req) => srv.repondre(req), ...opts,
  });
  await stabiliser(); // /api/state, puis connect()
  if (ws && page.socket) { page.socket.ouvrir(); await stabiliser(); }
  page.reseau.oublier();
  return { page, srv };
}

const BOUTONS = { 1: 'btn-p', '-1': 'btn-m', 5: 'btn-p5', '-5': 'btn-m5' };
const taper = (page, delta = 1) => page.el(BOUTONS[delta]).emettre('pointerdown');
const envois = (page) => page.reseau.vers('/api/count');
const badge = (page) => (page.el('queue-badge').style.display === 'none' ? null : page.el('queue-badge').textContent);

// ── File d'attente ───────────────────────────────────────────────────────────

describe('Opérateur — file d\'attente', () => {
  test('un appui en ligne : affichage immédiat, une requête, file vidée à l\'accusé de réception', T, async () => {
    const { page, srv } = await ouvrir();
    taper(page);
    assert.equal(page.el('count').textContent, 11, 'le total monte AVANT la réponse du serveur');
    assert.equal(page.el('group-sub').textContent, 'dont 5 en Principal');
    assert.equal(badge(page), '1 en attente');

    await stabiliser();
    assert.equal(envois(page).length, 1);
    assert.equal(envois(page)[0].method, 'POST');
    assert.deepEqual(envois(page)[0].corps, { delta: 1, uuid: 'uuid-1', e: E, g: G, name: 'Alice' });
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(page.local.getItem('op_queue'), '[]');
    assert.equal(badge(page), null);
    assert.equal(srv.total, 11);
  });

  test('les quatre boutons envoient +1, −1, +5, −5', T, async () => {
    const { page, srv } = await ouvrir();
    for (const delta of [1, -1, 5, -5]) taper(page, delta);
    await stabiliser();
    assert.deepEqual(srv.comptes.map((c) => c.delta), [1, -1, 5, -5]);
    assert.equal(new Set(srv.comptes.map((c) => c.uuid)).size, 4, 'un uuid par appui');
  });

  test('sans prénom, l\'opération part sans champ name', T, async () => {
    const { page } = await ouvrir({ stockage: {} });
    taper(page);
    await stabiliser();
    assert.deepEqual(Object.keys(envois(page)[0].corps).sort(), ['delta', 'e', 'g', 'uuid']);
  });

  test('hors ligne : les appuis sont gardés (mémoire + localStorage), l\'affichage continue de monter', T, async () => {
    const { page, srv } = await ouvrir();
    srv.enLigne = false;
    taper(page); taper(page); taper(page, 5);
    await stabiliser();

    assert.equal(page.el('count').textContent, 17, 'affichage optimiste');
    assert.equal(page.lire('queue.length'), 3);
    assert.deepEqual(page.local.json('op_queue').map((o) => [o.delta, o.uuid, o.e, o.g]),
      [[1, 'uuid-1', E, G], [1, 'uuid-2', E, G], [5, 'uuid-3', E, G]]);
    assert.equal(badge(page), '3 en attente');
    assert.equal(srv.total, 10, 'rien n\'est parvenu au serveur');
  });

  for (const [nom, declencher] of [
    ['événement « online » du navigateur', (page) => page.fenetre('online')],
    ['minuterie de 2 s', (page) => page.avancer(2000)],
    ['réouverture du WebSocket', (page) => { page.socket.couper(); return page.avancer(1000).then(() => page.socket.ouvrir()); }],
    ['retour de la page au premier plan', (page) => page.visible(true)],
  ]) {
    test(`retour du réseau (${nom}) : tout part, dans l'ordre, avec les mêmes uuid`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.enLigne = false;
      taper(page); taper(page, -1); taper(page, 5);
      await stabiliser();

      srv.enLigne = true;
      await declencher(page);
      await stabiliser();
      assert.deepEqual(srv.comptes.map((c) => [c.uuid, c.delta]), [['uuid-1', 1], ['uuid-2', -1], ['uuid-3', 5]]);
      assert.equal(page.lire('queue.length'), 0);
      assert.equal(page.local.getItem('op_queue'), '[]');
      assert.equal(badge(page), null);
      assert.equal(page.el('count').textContent, 15);
    });
  }

  // navigator.onLine n'est que l'avis du navigateur. S'il reste à « hors ligne » après le
  // retour du réseau (et que l'événement `online` ne vient pas), la minuterie ne doit pas
  // s'y fier : avant, plus rien ne relançait la file sans un appui ou la réouverture du
  // WebSocket (jusqu'à 30 s plus tard).
  test('minuterie de 2 s : elle réessaie même si le navigateur se dit (encore) hors ligne', T, async () => {
    const { page, srv } = await ouvrir();
    srv.enLigne = false;
    page.navigator.onLine = false;
    taper(page); taper(page);
    await stabiliser();
    assert.equal(page.lire('queue.length'), 2);

    srv.enLigne = true; // le réseau est revenu ; le navigateur, lui, n'a rien signalé
    await page.avancer(2000);
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1', 'uuid-2']);
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(badge(page), null);
  });

  // La tête de file bloque les suivantes : jamais de réordonnancement, jamais d'op qui
  // « double » une autre. C'est ce qui rend le renvoi idempotent côté serveur.
  test('une op en échec garde sa place : les suivantes attendent derrière elle', T, async () => {
    const { page, srv } = await ouvrir();
    srv.enLigne = false;
    taper(page); taper(page); taper(page);
    await stabiliser();
    for (let i = 0; i < 5; i++) await page.avancer(2000);
    assert.deepEqual([...new Set(envois(page).map((a) => a.corps.uuid))], ['uuid-1'],
      'seule la première op est tentée tant qu\'elle n\'est pas passée');
    assert.equal(page.lire('queue.length'), 3);
  });

  test('un appui pendant qu\'une requête est en vol part dans la même passe, sans attendre 2 s', T, async () => {
    const { page, srv } = await ouvrir();
    const enVol = differe();
    srv.forcer = (req) => (req.corps.uuid === 'uuid-1' ? enVol.promise : null);
    taper(page);
    await stabiliser();
    taper(page); // la première requête n'est pas revenue
    await stabiliser();
    assert.equal(envois(page).length, 1, 'une seule requête à la fois');

    srv.forcer = null;
    enVol.resolve(reponse(200, { total: 11, alert: false }));
    await stabiliser();
    assert.deepEqual(envois(page).map((a) => a.corps.uuid), ['uuid-1', 'uuid-2']);
    assert.equal(page.lire('queue.length'), 0);
  });

  // Le bail se renouvelle à chaque op : une passe lente mais VIVANTE (réseau saturé, 4 s par
  // réponse) ne doit jamais être prise pour une passe bloquée, même au-delà de 15 s.
  test('verrou : une passe longue mais vivante garde la main — chaque op part une seule fois', T, async () => {
    const { page, srv } = await ouvrir();
    const enVol = [];
    srv.forcer = (req) => { const d = differe(); enVol.push(d); return d.promise.then(() => srv.compter(req)); };
    for (let i = 0; i < 5; i++) taper(page);
    await stabiliser();
    for (let i = 0; i < 5; i++) {
      await page.avancer(4000); // deux minuteries de 2 s relancent flush() pendant chaque attente
      assert.equal(enVol.length, i + 1, `${(i + 1) * 4} s : une seule requête en vol`);
      enVol[i].resolve();
      await stabiliser();
    }
    assert.deepEqual(envois(page).map((a) => a.corps.uuid), ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4', 'uuid-5']);
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(srv.total, 15);
  });

  test('verrou : dix déclenchements simultanés → une seule requête en vol', T, async () => {
    const { page, srv } = await ouvrir();
    const enVol = differe();
    srv.forcer = () => enVol.promise;
    taper(page);
    for (let i = 0; i < 10; i++) { page.fenetre('online'); page.appeler('flush()'); }
    await page.avancer(4000); // deux minuteries de 2 s passent aussi
    assert.equal(envois(page).length, 1);
    enVol.resolve(reponse(200, { total: 11, alert: false }));
    await stabiliser();
    assert.equal(page.lire('queue.length'), 0);
  });

  // Un pic de rate-limit ne doit JAMAIS coûter un comptage : sur 429 l'op reste en tête
  // de file et la passe s'arrête là.
  test('429 : l\'op reste en file, la passe s\'arrête, et elle est comptée une seule fois quand ça passe', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = () => reponse(429, null, { brut: 'Too Many Requests' });
    taper(page); taper(page); taper(page);
    await stabiliser();
    assert.equal(envois(page).length, 1, 'pas de requête pour les ops suivantes dans la même passe');
    for (let i = 0; i < 10; i++) await page.avancer(2000);
    assert.equal(page.lire('queue.length'), 3, 'dix refus plus tard, rien n\'a été jeté');
    assert.equal(badge(page), '3 en attente');

    srv.forcer = null;
    await page.avancer(2000);
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1', 'uuid-2', 'uuid-3']);
    assert.equal(page.lire('queue.length'), 0);
  });

  for (const statut of [500, 502, 503, 504]) {
    test(`erreur serveur ${statut} : l'op est gardée et renvoyée`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.forcer = () => reponse(statut, null, { brut: '<html>erreur</html>' });
      taper(page);
      await stabiliser();
      assert.equal(page.lire('queue.length'), 1);
      srv.forcer = null;
      await page.avancer(2000);
      assert.equal(srv.comptes.length, 1);
    });
  }

  test('requête qui ne revient jamais : abandonnée au bout de 5 s, l\'op est gardée', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = PEND;
    taper(page);
    await page.avancer(4999);
    assert.equal(page.lire('flushBusy()'), true, 'la requête est encore attendue');
    await page.avancer(1);
    assert.equal(page.lire('flushBusy()'), false, 'abandonnée à 5 s : la file est de nouveau libre');
    assert.equal(page.lire('queue.length'), 1);

    srv.forcer = null;
    await page.avancer(2000);
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1'], 'renvoyée avec le même uuid');
  });

  // ── Le blocage du 2026-10-13 ───────────────────────────────────────────────
  // Constaté par Elie (DuckDuckGo, production) : après une coupure, les appuis restaient
  // « en attente » pour de bon, les nouveaux s'y ajoutaient, alors que les comptages des
  // autres continuaient d'arriver — il fallait recharger la page. Reproduit dans WebKit :
  // UNE réponse de /api/count dont les en-têtes arrivent mais pas le corps, et l'attente
  // de ce corps, sans limite, gardait le verrou de flush() pour toujours.
  test('réponse dont le corps n\'arrive jamais : la passe est abandonnée, l\'op gardée, et tout repart sans recharger', T, async () => {
    const { page, srv } = await ouvrir();
    // Le serveur a compté l'op ; sa réponse se perd après les en-têtes.
    srv.forcer = (req) => { srv.compter(req); return corpsQuiCale(); };
    taper(page);
    await stabiliser();
    assert.equal(srv.total, 11, 'le serveur, lui, a compté');
    assert.equal(page.lire('flushBusy()'), true);

    srv.forcer = null; // le réseau refonctionne dès maintenant
    taper(page); taper(page); // …mais les appuis suivants butent sur la passe en cours
    await page.avancer(4999);
    assert.equal(envois(page).length, 1, 'rien ne part tant que le corps est attendu');
    assert.equal(badge(page), '3 en attente');

    // Pendant ce temps le WebSocket vit sa vie : c'est ce qui rendait la panne si déroutante.
    page.socket.recevoir({ type: 'update', total: 40, capacity: 100, groups: [{ id: G, name: 'Principal', count: 9 }] });
    assert.equal(page.el('count').textContent, 40);

    await page.avancer(1); // 5 s après les en-têtes : le corps n'est plus attendu
    assert.equal(page.lire('flushBusy()'), false, 'le verrou est rendu');
    assert.equal(page.lire('queue.length'), 3, 'l\'op sans accusé de réception est gardée');

    await page.avancer(2000);
    assert.equal(page.lire('queue.length'), 0, 'la file se vide toute seule');
    assert.equal(badge(page), null);
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1', 'uuid-2', 'uuid-3'], 'chaque appui compté UNE fois');
    assert.equal(srv.total, 13);
    assert.equal(envois(page).filter((a) => a.corps.uuid === 'uuid-1').length, 2, 'renvoyée avec le même uuid → doublon reconnu');
  });

  test('en-têtes à la dernière seconde : le corps a droit à son propre délai', T, async () => {
    const { page, srv } = await ouvrir();
    const enTetes = differe();
    srv.forcer = () => enTetes.promise;
    taper(page);
    await page.avancer(4900);
    enTetes.resolve(corpsQuiCale());
    await stabiliser();
    await page.avancer(4900); // 9,8 s après l'envoi, 4,9 s après les en-têtes
    assert.equal(page.lire('flushBusy()'), true);
    await page.avancer(100);
    assert.equal(page.lire('flushBusy()'), false);
    assert.equal(page.lire('queue.length'), 1);
  });

  // Certains navigateurs n'interrompent pas vraiment une requête sur abort() : le délai doit
  // tenir à une minuterie de la page, pas à la bonne volonté du moteur.
  for (const [nom, cale] of [['requête qui ne revient jamais', PEND], ['corps qui n\'arrive jamais', () => corpsQuiCale()]]) {
    test(`navigateur sourd à abort() — ${nom} : abandonnée quand même, puis comptée une fois`, T, async () => {
      const { page, srv } = await ouvrir();
      page.reseau.sourd = true;
      srv.forcer = cale;
      taper(page);
      await stabiliser(); // les en-têtes (s'il y en a) arrivent tout de suite
      await page.avancer(5000);
      assert.equal(page.lire('flushBusy()'), false);
      assert.equal(page.lire('queue.length'), 1);

      srv.forcer = null;
      await page.avancer(2000);
      assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1']);
      assert.equal(page.lire('queue.length'), 0);
    });
  }

  // Seconde ceinture : le verrou est un bail. Page figée par le téléphone (arrière-plan)
  // avec une requête en vol → au réveil, ses minuteries n'ont pas tourné, mais l'heure a
  // passé : une nouvelle passe part sans attendre. L'ancienne peut encore recevoir sa
  // réponse — elle ne doit ni retirer une AUTRE op, ni réécrire l'affichage.
  test('page figée avec une requête en vol : nouvelle passe au réveil, et l\'accusé tardif de l\'ancienne ne jette pas l\'op suivante', T, async () => {
    const { page, srv } = await ouvrir();
    const ancienne = differe(), suivante = differe();
    let n = 0;
    srv.forcer = (req) => {
      n += 1;
      if (n === 1) return ancienne.promise;                       // uuid-1, passe d'avant le gel
      if (n === 3 && req.corps.uuid === 'uuid-2') return suivante.promise; // uuid-2, en vol
      return null;
    };
    taper(page); taper(page);
    await stabiliser();
    assert.equal(envois(page).length, 1);

    page.horloge.maintenant += 60_000; // une minute passe SANS qu'aucune minuterie ne tourne
    assert.equal(page.lire('flushBusy()'), false, 'le bail a expiré');
    page.fenetre('online');
    await stabiliser();
    assert.deepEqual(envois(page).map((a) => a.corps.uuid), ['uuid-1', 'uuid-1', 'uuid-2']);
    assert.equal(page.lire('queue.length'), 1, 'uuid-1 acquittée par la nouvelle passe');
    assert.equal(page.el('count').textContent, 11);

    ancienne.resolve(reponse(200, { total: 999 })); // la vieille réponse finit par arriver
    await stabiliser();
    assert.deepEqual(page.valeur('queue.map((o) => o.uuid)'), ['uuid-2'], 'uuid-2, encore en vol, reste en file');
    assert.equal(page.el('count').textContent, 11, 'un total périmé ne réécrit pas l\'affichage');
    page.fenetre('online');
    await stabiliser();
    assert.equal(envois(page).length, 3, 'l\'ancienne passe, en s\'arrêtant, ne libère pas le bail de la nouvelle');

    suivante.reject(new TypeError('Failed to fetch')); // …et sa requête échoue
    await stabiliser();
    assert.equal(page.lire('queue.length'), 1, 'toujours là : elle n\'a jamais été acquittée');

    await page.avancer(2000);
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1', 'uuid-2']);
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(srv.total, 12);
  });

  // Le bail se mesure à l'heure du téléphone, qui peut reculer (remise à l'heure automatique,
  // changement de fuseau) : un âge négatif ne doit pas le faire durer une heure de plus.
  test('horloge du téléphone reculée pendant une requête en vol : le bail est caduc, la file repart', T, async () => {
    const { page, srv } = await ouvrir();
    let n = 0;
    srv.forcer = () => { n += 1; return n === 1 ? PEND() : null; };
    taper(page);
    await stabiliser();
    page.horloge.maintenant -= 3_600_000;
    page.fenetre('online');
    await stabiliser();
    assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-1']);
    assert.equal(page.lire('queue.length'), 0);
  });

  // Portail captif d'un Wi-Fi public : la requête est redirigée vers une page de connexion
  // et revient en 200… avec du HTML.
  test('réponse 200 qui n\'est pas du JSON (portail captif) : l\'op est gardée', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = () => reponse(200, null, { brut: '<html>Connectez-vous au Wi-Fi</html>' });
    taper(page);
    await stabiliser();
    assert.equal(page.lire('queue.length'), 1);
    assert.equal(page.el('count').textContent, 11, 'l\'affichage optimiste n\'est pas abîmé');
  });

  // 400 / 404 répondus par NOTRE API : l'op ne passera jamais (événement archivé, groupe
  // supprimé). La garder bloquerait toutes les suivantes.
  for (const [statut, erreur] of [[404, 'event not found'], [404, 'group not found'], [400, 'invalid']]) {
    test(`refus définitif de l'API (${statut} ${erreur}) : l'op est retirée, les suivantes passent`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.forcer = (req) => (req.corps.uuid === 'uuid-1' ? reponse(statut, { error: erreur }) : null);
      taper(page); taper(page);
      await stabiliser();
      assert.deepEqual(srv.comptes.map((c) => c.uuid), ['uuid-2']);
      assert.equal(page.lire('queue.length'), 0);
      assert.equal(page.local.getItem('op_queue'), '[]');
    });
  }

  test('doublon (dup) : l\'op est retirée et le total de la réponse n\'écrase pas l\'affichage', T, async () => {
    const { page, srv } = await ouvrir();
    srv.forcer = () => reponse(200, { total: 3, dup: true });
    taper(page);
    await stabiliser();
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(page.el('count').textContent, 11);
  });

  test('rechargement de la page : la file persistée repart, chaque op avec SON événement et SON groupe', T, async () => {
    const file = [
      { delta: 1, uuid: 'vieux-1', e: E, g: G, name: 'Alice' },
      { delta: 5, uuid: 'vieux-2', e: E, g: 'aaaaaa', name: 'Alice' }, // saisie à une autre porte
      { delta: -1, uuid: 'vieux-3', e: E, g: G },
    ];
    const srv = serveur();
    const page = charger('index.html', 'function flush', {
      url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice', op_queue: file }, repondre: (req) => srv.repondre(req),
    });
    assert.equal(badge(page), '3 en attente', 'visible dès le chargement');
    await stabiliser();
    page.socket.ouvrir();
    await stabiliser();
    assert.deepEqual(srv.comptes, file);
    assert.equal(page.local.getItem('op_queue'), '[]');
  });

  test('ancienne file (ops sans champ e) : vidée au démarrage, rien n\'est envoyé', T, async () => {
    const { page } = await ouvrir({ stockage: { op_name: 'Alice', op_queue: [{ delta: 1, uuid: 'ancien' }, { delta: 1, uuid: 'ancien-2' }] } });
    assert.equal(page.lire('queue.length'), 0);
    assert.equal(page.local.getItem('op_queue'), null);
    assert.equal(envois(page).length, 0);
  });

  test('file illisible dans localStorage (JSON cassé, null) : la page démarre avec une file vide', T, async () => {
    for (const contenu of ['{pas du json', 'null', '']) {
      const { page, srv } = await ouvrir({ stockage: { op_name: 'Alice', op_queue: contenu } });
      taper(page);
      await stabiliser();
      assert.equal(srv.comptes.length, 1, `contenu ${JSON.stringify(contenu)}`);
    }
  });

  // localStorage peut être INUTILISABLE : WebView Android d'une appli de scan de QR (DOM
  // storage désactivé par défaut → `localStorage` vaut null), Safari avec « Bloquer tous
  // les cookies », quota plein. Écrite sans garde, la file levait à chaque appui, et dans
  // flush() l'exception était prise pour une panne réseau : 1 op toutes les 2 s.
  for (const [nom, mode] of [['setItem lève (quota, cookies bloqués)', 'ecriture'], ['localStorage vaut null (WebView)', 'absent']]) {
    test(`stockage inutilisable — ${nom} : les appuis partent quand même, tous, sans délai`, T, async () => {
      const { page, srv } = await ouvrir({ stockageCasse: mode });
      const erreurs = [];
      for (let i = 0; i < 5; i++) { try { taper(page); } catch (err) { erreurs.push(err.message); } }
      await stabiliser();
      assert.deepEqual(erreurs, [], 'un appui ne doit pas lever d\'exception');
      assert.equal(srv.comptes.length, 5, 'les 5 appuis doivent être arrivés sans attendre la minuterie');
      assert.equal(page.lire('queue.length'), 0);
      assert.equal(page.el('count').textContent, 15);

      // Hors ligne aussi : la file tient en mémoire, et repart au retour du réseau.
      srv.enLigne = false;
      taper(page); taper(page);
      await stabiliser();
      assert.equal(badge(page), '2 en attente');
      srv.enLigne = true;
      await page.avancer(2000);
      assert.equal(srv.comptes.length, 7);
    });
  }

  // Seul un 400 / 404 répondu en JSON par NOTRE API est un refus définitif. 401/403/407/408…
  // ne viennent jamais d'elle sur /api/count : ils viennent de ce qu'il y a DEVANT (pare-feu
  // ou défi anti-bot Cloudflare, proxy d'entreprise, portail captif). L'op se garde.
  for (const statut of [401, 403, 407, 408, 409, 413, 418, 451]) {
    test(`réponse ${statut} d'un intermédiaire (pare-feu, proxy, portail) : l'op est gardée`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.forcer = () => reponse(statut, null, { brut: '<html>Accès refusé</html>' });
      taper(page);
      await stabiliser();
      assert.equal(page.lire('queue.length'), 1, 'comptage jeté en silence');

      srv.forcer = null;
      await page.avancer(2000);
      assert.equal(srv.comptes.length, 1);
    });
  }

  // 400 / 404 qui ne viennent PAS de notre API (page d'erreur d'un proxy, 404 HTML d'un
  // hébergeur) : sans le champ `error` en JSON, ce n'est pas un refus de l'op.
  for (const [nom, rep404] of [
    ['404 en HTML', () => reponse(404, null, { brut: '<html>Not Found</html>' })],
    ['400 en HTML', () => reponse(400, null, { brut: '<html>Bad Request</html>' })],
    ['404 en JSON sans champ error', () => reponse(404, { message: 'no such route' })],
    ['404 en JSON avec error non textuel', () => reponse(404, { error: { code: 42 } })],
  ]) {
    test(`${nom} : ce n'est pas un refus de notre API, l'op est gardée`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.forcer = rep404;
      taper(page);
      await stabiliser();
      assert.equal(page.lire('queue.length'), 1);
      srv.forcer = null;
      await page.avancer(2000);
      assert.equal(srv.comptes.length, 1);
    });
  }

  for (const [nom, corps] of [['sans total', { status: 'ok' }], ['total non numérique', { total: '12' }], ['null', null], ['tableau', []]]) {
    test(`réponse 200 en JSON ${nom} (ce n'est pas notre API) : l'op est gardée, l'affichage intact`, T, async () => {
      const { page, srv } = await ouvrir();
      srv.forcer = () => reponse(200, corps);
      taper(page);
      await stabiliser();
      assert.equal(page.el('count').textContent, 11, 'affichage');
      assert.equal(page.lire('queue.length'), 1);
      srv.forcer = null;
      await page.avancer(2000);
      assert.equal(srv.comptes.length, 1, 'elle part dès que la vraie API répond');
    });
  }

  // File contenant une op saisie sur un AUTRE événement (l'opérateur a scanné un nouveau
  // QR alors qu'il lui restait des ops en attente) : la réponse porte le total de l'autre.
  test('accusé de réception d\'une op d\'un autre événement : n\'écrase pas le total affiché', T, async () => {
    const srv = serveur({ total: 10 });
    const base = srv.repondre;
    srv.repondre = (req) => (req.chemin === '/api/count' && req.corps.e === 'autre1' ? reponse(200, { total: 950, alert: true }) : base(req));
    const page = charger('index.html', 'function flush', {
      url: `/?e=${E}&g=${G}`, repondre: (req) => srv.repondre(req),
      stockage: { op_name: 'Alice', op_queue: [{ delta: 1, uuid: 'ailleurs', e: 'autre1', g: 'autre2' }] },
    });
    await stabiliser();
    page.socket.ouvrir();
    await stabiliser();
    assert.equal(page.lire('queue.length'), 0, 'l\'op de l\'autre événement est bien partie');
    assert.equal(page.el('count').textContent, 10, 'le total affiché est celui de CET événement');
    assert.equal(page.journal.vibrations.length, 0, 'et son alerte ne sonne pas ici');
  });
});

// ── Affichage ────────────────────────────────────────────────────────────────

describe('Opérateur — affichage', () => {
  test('bornage optimiste : comme le serveur, seul le total s\'arrête à 0', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 3, groupCount: 1 }) });
    taper(page, -5);
    assert.equal(page.el('count').textContent, 0);
    assert.equal(page.el('group-sub').textContent, 'dont -2 en Principal', 'le groupe peut passer en négatif');
    taper(page, -1);
    assert.equal(page.el('count').textContent, 0);
    assert.equal(page.el('group-sub').textContent, 'dont -2 en Principal', 'à 0, un −1 ne change rien à l\'écran');
    assert.deepEqual(page.valeur('queue.map(o => o.delta)'), [-5, -1], 'mais l\'op part quand même : le serveur tranche');
  });

  test('seuils : orange à 80 %, rouge à 100 %, barre plafonnée à 100 %', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 0, capacity: 10 }) });
    const voir = (total) => { page.socket.recevoir({ type: 'update', total, capacity: 10, groups: [] }); return [page.document.body.className, page.el('bar').style.width]; };
    assert.deepEqual(voir(7), ['', '70%']);
    assert.deepEqual(voir(8), ['state-warn', '80%']);
    assert.deepEqual(voir(9), ['state-warn', '90%']);
    assert.deepEqual(voir(10), ['state-danger', '100%']);
    assert.deepEqual(voir(25), ['state-danger', '100%']);
    assert.deepEqual(voir(2), ['', '20%'], 'les classes sont retirées quand la salle se vide');
  });

  // B7 : PWA relancée sans réseau → réafficher le dernier total connu plutôt que « – ».
  describe('dernier état affiché (op_last_state)', () => {
    const MEMO = { e: E, g: G, count: 42, groupCount: 7, groupName: 'Entrée', capacity: 50 };

    test('restauré au démarrage, avant toute réponse réseau', T, async () => {
      const page = charger('index.html', 'function flush', { url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice', op_last_state: MEMO }, repondre: PEND });
      assert.equal(page.el('count').textContent, 42);
      assert.equal(page.el('group-sub').textContent, 'dont 7 en Entrée');
      assert.equal(page.document.body.className, 'state-warn', '42 / 50 : la capacité est restaurée aussi');
    });

    test('gardé si le serveur est injoignable ou répond 404', T, async () => {
      for (const repondre of [HORS_LIGNE, () => reponse(404, { error: 'event not found' }), () => reponse(500, null, { brut: 'oups' }), () => reponse(200, { error: 'forme inattendue' })]) {
        const page = charger('index.html', 'function flush', { url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice', op_last_state: MEMO }, repondre });
        await stabiliser();
        assert.equal(page.el('count').textContent, 42, 'jamais « undefined » ni « NaN »');
        assert.equal(page.sockets.length, 1, 'le WebSocket est tenté dans tous les cas');
      }
    });

    // Même trou que dans la file : le corps de /api/state attendu sans limite, et connect()
    // — donc le WebSocket, le point vert, le direct — n'était jamais appelé.
    for (const [nom, repondre, sourd] of [
      ['corps qui n\'arrive jamais', () => corpsQuiCale(), false],
      ['requête qui ne revient jamais, navigateur sourd à abort()', PEND, true],
    ]) {
      test(`/api/state — ${nom} : l'état restauré reste affiché, et le WebSocket s'ouvre quand même`, T, async () => {
        const page = charger('index.html', 'function flush', { url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice', op_last_state: MEMO }, repondre });
        page.reseau.sourd = sourd;
        await stabiliser(); // les en-têtes (s'il y en a) arrivent tout de suite
        await page.avancer(4999);
        assert.equal(page.sockets.length, 0, 'encore dans le délai');
        await page.avancer(1);
        assert.equal(page.sockets.length, 1);
        assert.equal(page.el('count').textContent, 42);
      });
    }

    test('remplacé par la réponse de /api/state quand elle arrive', T, async () => {
      const { page } = await ouvrir({ stockage: { op_name: 'Alice', op_last_state: MEMO } });
      assert.equal(page.el('count').textContent, 10);
      assert.equal(page.el('group-sub').textContent, 'dont 4 en Principal');
      assert.deepEqual(page.local.json('op_last_state'), { e: E, g: G, count: 10, groupCount: 4, groupName: 'Principal', capacity: 100 });
    });

    test('ignoré s\'il vient d\'un autre événement ou d\'un autre groupe', T, async () => {
      for (const autre of [{ ...MEMO, e: 'autre1' }, { ...MEMO, g: 'autre2' }]) {
        const page = charger('index.html', 'function flush', { url: `/?e=${E}&g=${G}`, stockage: { op_name: 'Alice', op_last_state: autre }, repondre: PEND });
        assert.equal(page.el('count').textContent, '', 'le total d\'un autre événement ne doit pas s\'afficher');
      }
    });

    test('mis à jour à chaque changement (appui, message WebSocket)', T, async () => {
      const { page } = await ouvrir();
      taper(page, 5);
      assert.equal(page.local.json('op_last_state').count, 15);
      page.socket.recevoir({ type: 'update', total: 30, capacity: 80, groups: [{ id: G, name: 'Porte A', count: 12 }] });
      assert.deepEqual(page.local.json('op_last_state'), { e: E, g: G, count: 30, groupCount: 12, groupName: 'Porte A', capacity: 80 });
    });
  });
});

// ── Alerte de capacité ───────────────────────────────────────────────────────

describe('Opérateur — alerte de capacité', () => {
  const plein = (page, total, capacity = 10) => page.socket.recevoir({ type: 'update', total, capacity, groups: [] });

  test('déclenchée chez TOUS les opérateurs par le message du serveur, une seule fois au franchissement', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 0, capacity: 10 }) });
    plein(page, 9);
    assert.equal(page.journal.vibrations.length, 0);
    plein(page, 10);
    // (le motif est un tableau né dans le contexte de la page : comparé après passage par JSON)
    assert.equal(JSON.stringify(page.journal.vibrations), '[[300,100,300,100,300]]');
    plein(page, 11); plein(page, 12); plein(page, 10);
    assert.equal(page.journal.vibrations.length, 1, 'pas de nouvelle vibration tant qu\'on reste au-dessus');
    plein(page, 9);
    plein(page, 10);
    assert.equal(page.journal.vibrations.length, 2, 'ré-armée dès qu\'on repasse sous la capacité');
  });

  test('une baisse de la capacité par l\'admin la déclenche aussi', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 0, capacity: 100 }) });
    plein(page, 50, 100);
    assert.equal(page.journal.vibrations.length, 0);
    plein(page, 50, 50);
    assert.equal(page.journal.vibrations.length, 1);
    assert.equal(page.document.body.className, 'state-danger');
  });

  // navigator.vibrate n'existe sur AUCUN Safari iOS : le bip Web Audio est le seul signal
  // sonore d'un iPhone. iOS n'autorise le contexte audio qu'après un geste utilisateur.
  test('iPhone (pas de vibration) : bip de 3 notes, seulement après un premier appui', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 0, capacity: 10 }), vibration: false, audio: true });
    plein(page, 10);
    assert.equal(page.journal.bips, 0, 'aucun contexte audio avant le premier geste');
    assert.equal(page.document.body.className, 'state-danger', 'le signal visuel, lui, ne dépend de rien');

    plein(page, 5);
    taper(page);           // geste → contexte audio créé
    plein(page, 10);
    assert.equal(page.journal.bips, 3);
    plein(page, 11);
    assert.equal(page.journal.bips, 3, 'pas de bip à chaque message');
  });

  test('téléphone sans vibration ni audio : aucune exception, l\'écran passe quand même au rouge', T, async () => {
    const { page } = await ouvrir({ srv: serveur({ total: 0, capacity: 10 }), vibration: false });
    assert.doesNotThrow(() => { taper(page); plein(page, 10); });
    assert.equal(page.document.body.className, 'state-danger');
  });

  // « Sur une réponse dup, data.alert est undefined : l'ancien code éteignait l'alerte
  // alors que la salle était pleine. »
  test('un doublon n\'éteint pas l\'alerte', T, async () => {
    const { page, srv } = await ouvrir({ srv: serveur({ total: 10, capacity: 10 }) });
    assert.equal(page.lire('alertActive'), true);
    const avant = page.journal.vibrations.length;
    srv.forcer = () => reponse(200, { total: 10, dup: true });
    taper(page);
    await stabiliser();
    assert.equal(page.lire('alertActive'), true);
    assert.equal(page.document.body.className, 'state-danger');
    plein(page, 11);
    assert.equal(page.journal.vibrations.length, avant, 'toujours armée → pas de seconde alerte');
  });

  // Deux appuis rapprochés autour du seuil : l'affichage optimiste franchit la capacité,
  // puis l'accusé de réception du PREMIER appui (total encore sous le seuil) le fait
  // redescendre, et celui du second le refait franchir → deux salves au lieu d'une.
  test('franchissement avec deux appuis en vol : une seule alerte', { ...T, todo: 'défaut connu — chaque accusé de réception réécrit le total affiché sans tenir compte des ops encore en file : l\'alerte se désarme puis se redéclenche' }, async () => {
    const { page, srv } = await ouvrir({ srv: serveur({ total: 8, capacity: 10 }) });
    const premier = differe();
    srv.forcer = (req) => (req.corps.uuid === 'uuid-1' ? premier.promise : null);
    taper(page); taper(page); // 9 puis 10 à l'écran : l'alerte part
    await stabiliser();        // la 1re requête est partie, la 2e attend derrière elle
    assert.equal(page.journal.vibrations.length, 1);

    srv.forcer = null;
    srv.total = 9; srv.vus.add('uuid-1');
    premier.resolve(reponse(200, { total: 9, alert: false }));
    await stabiliser(); // accusé du 1er (9), puis envoi et accusé du 2e (10)
    assert.equal(page.el('count').textContent, 10);
    assert.equal(page.journal.vibrations.length, 1, 'l\'alerte a sonné deux fois pour un seul franchissement');
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────────

describe('Opérateur — WebSocket', () => {
  test('adresse : wss en https, ws en http, e et g encodés', T, async () => {
    const https = await ouvrir();
    assert.equal(https.page.socket.url, `wss://compteur.test?e=${E}&g=${G}`);
    const http = await ouvrir({ protocole: 'http:', hote: '192.168.1.20:3000' });
    assert.equal(http.page.socket.url, `ws://192.168.1.20:3000?e=${E}&g=${G}`);
    const bizarre = await ouvrir({ url: `/?e=${encodeURIComponent('a b&c')}&g=${encodeURIComponent('d#e')}` });
    assert.equal(bizarre.page.socket.url, 'wss://compteur.test?e=a%20b%26c&g=d%23e');
  });

  test('le point vert suit le WebSocket, pas les requêtes HTTP', T, async () => {
    const { page, srv } = await ouvrir({ ws: false });
    assert.equal(page.el('dot').className, '', 'ni vert ni rouge tant que la connexion n\'a pas abouti');
    taper(page);
    await stabiliser();
    assert.equal(srv.comptes.length, 1);
    assert.notEqual(page.el('dot').className, 'online', 'un comptage acquitté ne suffit pas à passer au vert');

    page.socket.ouvrir();
    assert.equal(page.el('dot').className, 'online');
    assert.equal(page.el('status-text').textContent, 'En ligne');
    srv.enLigne = false;
    taper(page);
    await stabiliser();
    assert.equal(page.el('dot').className, 'online', 'une requête en échec ne passe pas le point au rouge');

    page.socket.couper();
    assert.equal(page.el('dot').className, 'offline');
    assert.equal(page.el('status-text').textContent, 'Hors ligne');
  });

  test('hello : envoyé à chaque ouverture si l\'opérateur a un prénom, jamais sinon', T, async () => {
    const avec = await ouvrir();
    assert.deepEqual(avec.page.socket.envoyes, [{ type: 'hello', name: 'Alice' }]);
    avec.page.socket.couper();
    await avec.page.avancer(1000);
    avec.page.socket.ouvrir();
    assert.deepEqual(avec.page.socket.envoyes, [{ type: 'hello', name: 'Alice' }], 'renvoyé après une reconnexion');

    const sans = await ouvrir({ stockage: {} });
    assert.deepEqual(sans.page.socket.envoyes, []);
  });

  test('init et update : total, capacité et compteur de MON groupe ; le titre porte le nom de l\'événement', T, async () => {
    const { page } = await ouvrir();
    page.socket.recevoir({ type: 'init', total: 25, capacity: 200, eventName: 'Gala', groups: [{ id: 'zzzzzz', name: 'B', count: 16 }, { id: G, name: 'Porte A', count: 9 }] });
    assert.equal(page.el('count').textContent, 25);
    assert.equal(page.lire('capacity'), 200);
    assert.equal(page.el('group-sub').textContent, 'dont 9 en Porte A');
    assert.equal(page.document.title, 'Gala – Compteur');

    page.socket.recevoir({ type: 'update', total: 26, delta: 1, alert: false, capacity: 200, groups: [{ id: 'zzzzzz', name: 'B', count: 17 }, { id: G, name: 'Porte A', count: 9 }] });
    assert.equal(page.el('count').textContent, 26);
    assert.equal(page.el('group-sub').textContent, 'dont 9 en Porte A');

    page.socket.recevoir({ type: 'pong' });
    page.socket.recevoir({ type: 'clients', clients: [{ name: 'Bob', groupName: 'B' }] });
    page.socket.recevoir({ type: 'inconnu', total: 999 });
    assert.equal(page.el('count').textContent, 26, 'les autres messages ne touchent pas au total');
  });

  // Lien mort : événement archivé ou supprimé, groupe supprimé.
  test('fermeture 4004 : message clair, bouton de saisie du lien, et PAS de reconnexion', T, async () => {
    const { page } = await ouvrir();
    page.socket.couper(4004);
    assert.equal(page.el('status-text').textContent, 'Événement ou groupe introuvable');
    assert.equal(page.el('manual-link-btn').style.display, 'inline-block');
    assert.equal(page.el('dot').className, 'offline');
    await page.avancer(120_000);
    assert.equal(page.sockets.length, 1, 'aucune tentative de reconnexion');
  });

  test('coupure : reconnexion après 1 s, 2 s, 4 s… plafonnée à 30 s, remise à 1 s après un succès', T, async () => {
    const { page } = await ouvrir();
    let attendu = 1;
    for (const ms of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      page.socket.couper();
      await page.avancer(ms - 1);
      assert.equal(page.sockets.length, attendu, `pas de reconnexion avant ${ms} ms`);
      await page.avancer(1);
      attendu += 1;
      assert.equal(page.sockets.length, attendu, `reconnexion à ${ms} ms`);
    }
    page.socket.ouvrir(); // succès → le délai repart de 1 s
    page.socket.couper();
    await page.avancer(1000);
    assert.equal(page.sockets.length, attendu + 1);
  });

  test('erreur de connexion (onerror) : traitée comme une coupure', T, async () => {
    const { page } = await ouvrir({ ws: false });
    const s = page.socket;
    s.onerror({});
    assert.equal(s.fermePar, 'page');
    await page.avancer(1000);
    assert.equal(page.sockets.length, 2);
  });

  test('page cachée : aucune minuterie de reconnexion ; retour au premier plan : reconnexion immédiate', T, async () => {
    const { page } = await ouvrir();
    page.document.hidden = true;
    page.socket.couper();
    await page.avancer(300_000);
    assert.equal(page.sockets.length, 1, 'téléphone verrouillé : on ne tourne pas à vide');

    await page.visible(true);
    assert.equal(page.sockets.length, 2);
    page.socket.ouvrir();
    assert.equal(page.el('dot').className, 'online');
  });

  // Au déverrouillage, l'ancien socket peut sembler ouvert alors que la connexion est
  // morte : on le tue sans attendre son heartbeat, et on annule la minuterie en cours.
  test('retour au premier plan : tue le socket zombie, annule la reconnexion en attente, une seule connexion', T, async () => {
    const { page } = await ouvrir();
    const zombie = page.socket;
    await page.visible(true);
    assert.equal(zombie.fermePar, 'page');
    assert.equal(zombie.onmessage, null, 'ses messages tardifs ne sont plus écoutés');
    assert.equal(page.sockets.length, 2);

    page.socket.couper();   // minuterie de 1 s armée…
    await page.visible(true); // …puis retour au premier plan avant qu'elle sonne
    assert.equal(page.sockets.length, 3);
    await page.avancer(5000);
    assert.equal(page.sockets.length, 3, 'la minuterie annulée ne doit pas ouvrir un second socket');
  });

  test('connect() appelé alors qu\'une connexion existe déjà : sans effet', T, async () => {
    const { page } = await ouvrir({ ws: false });
    page.appeler('connect()'); // socket en cours de connexion
    page.socket.ouvrir();
    page.appeler('connect()'); // socket ouvert
    assert.equal(page.sockets.length, 1);
  });

  test('heartbeat : ping toutes les 20 s ; sans aucun message depuis plus de 60 s, la page coupe et se reconnecte', T, async () => {
    const { page } = await ouvrir();
    const s = page.socket;
    await page.avancer(60_000);
    assert.deepEqual(s.types, ['hello', 'ping', 'ping', 'ping']);
    assert.equal(s.readyState, 1);
    await page.avancer(20_000);
    assert.equal(s.fermePar, 'page', 'serveur muet : connexion considérée comme morte');
    await page.avancer(1000);
    assert.equal(page.sockets.length, 2);
  });

  test('heartbeat : tant que le serveur répond, la connexion reste ouverte', T, async () => {
    const { page } = await ouvrir();
    const s = page.socket;
    for (let i = 0; i < 30; i++) { await page.avancer(20_000); s.recevoir({ type: 'pong' }); }
    assert.equal(s.readyState, 1, 'toujours ouverte après 10 minutes');
    assert.equal(page.sockets.length, 1);
  });
});

// ── Lien, prénom, démarrage ──────────────────────────────────────────────────

describe('Opérateur — lien et démarrage', () => {
  // U19 : la PWA se lance sur « / », sans e ni g.
  test('lien dans l\'URL : mémorisé pour le prochain lancement', T, async () => {
    const { page } = await ouvrir({ stockage: { op_name: 'Alice', op_last_link: { e: 'vieux1', g: 'vieux2' } } });
    assert.deepEqual(page.local.json('op_last_link'), { e: E, g: G });
  });

  test('lancement sans lien (PWA) : le dernier lien est restauré, URL comprise', T, async () => {
    const srv = serveur();
    const page = charger('index.html', 'function flush', {
      url: '/', stockage: { op_name: 'Alice', op_last_link: { e: E, g: G } }, repondre: (req) => srv.repondre(req),
    });
    await stabiliser();
    assert.deepEqual(page.journal.historique, [`/?e=${E}&g=${G}`], 'un rechargement manuel doit retomber sur le bon lien');
    assert.equal(page.reseau.vers('/api/state')[0].url, `/api/state?e=${E}&g=${G}`);
    assert.equal(page.socket.url, `wss://compteur.test?e=${E}&g=${G}`);
    page.socket.ouvrir();
    taper(page);
    await stabiliser();
    assert.deepEqual([srv.comptes[0].e, srv.comptes[0].g], [E, G]);
  });

  test('aucun lien, rien en mémoire : message, bouton de saisie, ni requête ni WebSocket', T, async () => {
    for (const stockage of [{}, { op_last_link: '{cassé' }, { op_last_link: { e: E } }, { op_last_link: 'null' }]) {
      const page = charger('index.html', 'function flush', { url: '/', stockage });
      await stabiliser();
      assert.equal(page.el('status-text').textContent, 'URL invalide — utilisez le QR code');
      assert.equal(page.el('manual-link-btn').style.display, 'inline-block');
      assert.equal(page.el('dot').className, 'offline');
      assert.equal(page.sockets.length, 0);
      assert.equal(page.reseau.appels.length, 0);
    }
  });

  test('lien incomplet dans l\'URL (e sans g) : traité comme une absence de lien', T, async () => {
    const page = charger('index.html', 'function flush', { url: `/?e=${E}`, stockage: { op_last_link: { e: 'mem001', g: 'mem002' } } });
    await stabiliser();
    assert.equal(page.socket.url, 'wss://compteur.test?e=mem001&g=mem002', 'le lien mémorisé prend le relais');
  });

  test('saisie manuelle : accepte une URL complète, relative, ou la seule query', T, async () => {
    const { page } = await ouvrir();
    const lire = (brut) => page.valeur(`parseEventURL(${JSON.stringify(brut)})`);
    const OK = { e: 'aaa111', g: 'bbb222' };
    for (const brut of [
      'https://compteur.example/?e=aaa111&g=bbb222',
      'http://192.168.1.20:3000/?e=aaa111&g=bbb222',
      '  https://compteur.example/?g=bbb222&e=aaa111&utm=x  ',
      '/?e=aaa111&g=bbb222',
      '?e=aaa111&g=bbb222',
      'e=aaa111&g=bbb222',
      '#e=aaa111&g=bbb222',
    ]) assert.deepEqual(lire(brut), OK, brut);
    for (const brut of ['', '   ', 'bonjour', 'https://compteur.example/', '?e=aaa111', '?g=bbb222', 'e=&g=', null]) {
      assert.equal(lire(brut), null, JSON.stringify(brut));
    }
  });

  test('saisie manuelle : lien invalide → message ; lien valide → navigation vers /?e=…&g=… encodé', T, async () => {
    const { page } = await ouvrir();
    page.el('link-input').value = 'pas un lien';
    page.appeler('submitLink()');
    assert.equal(page.el('link-err').textContent, 'Lien invalide — vérifiez le copié-collé');
    assert.deepEqual(page.journal.navigations, []);

    page.el('link-input').value = 'https://ailleurs.example/?e=aaa111&g=b%26b';
    page.appeler('submitLink()');
    assert.deepEqual(page.journal.navigations, ['/?e=aaa111&g=b%26b'], 'toujours sur NOTRE origine, jamais vers le site du lien collé');

    page.appeler('handleScannedURL("https://exemple.org/page-sans-rapport")');
    assert.equal(page.journal.navigations.length, 1, 'un QR code sans rapport est ignoré');
  });

  // N6 : crypto.randomUUID n'existe qu'en contexte sécurisé — absent en LAN http.
  test('uuid sans crypto.randomUUID (LAN en http) : repli unique, et les appuis partent', T, async () => {
    const { page, srv } = await ouvrir({ uuidNatif: false, protocole: 'http:', hote: '192.168.1.20:3000', serviceWorker: false });
    for (let i = 0; i < 50; i++) taper(page);
    await stabiliser();
    const uuids = srv.comptes.map((c) => c.uuid);
    assert.equal(uuids.length, 50);
    assert.equal(new Set(uuids).size, 50, 'tous différents, même dans la même milliseconde');
    assert.ok(uuids.every((u) => typeof u === 'string' && u.length >= 16 && u.length <= 64));
  });

  test('service worker : enregistré quand il existe, ignoré sans erreur sinon (http)', T, async () => {
    assert.deepEqual((await ouvrir()).page.journal.swEnregistres, ['/sw.js']);
    assert.deepEqual((await ouvrir({ serviceWorker: false })).page.journal.swEnregistres, []);
  });

  test('prénom : demandé au premier lancement, nettoyé, mémorisé, annoncé au serveur', T, async () => {
    const { page } = await ouvrir({ stockage: {} });
    assert.equal(page.el('name-overlay').style.display, 'flex');

    page.el('name-input').value = '    ';
    page.appeler('saveName()');
    assert.equal(page.el('name-overlay').style.display, 'flex', 'un prénom vide est refusé');

    page.el('name-input').value = `  ${'Z'.repeat(50)}  `;
    page.appeler('saveName()');
    assert.equal(page.local.getItem('op_name'), 'Z'.repeat(32));
    assert.equal(page.el('name-overlay').style.display, 'none');
    assert.equal(page.el('op-name-btn').textContent, 'Z'.repeat(32));
    assert.deepEqual(page.socket.envoyes, [{ type: 'hello', name: 'Z'.repeat(32) }]);

    const connu = await ouvrir();
    assert.equal(connu.page.el('name-overlay').style.display, 'none', 'pas redemandé ensuite');
  });

  test('Wake Lock : demandé au chargement, redemandé au retour au premier plan s\'il a été relâché', T, async () => {
    const demandes = [];
    let relacher;
    const wakeLock = { request: async (type) => { demandes.push(type); return { addEventListener: (_t, fn) => { relacher = fn; } }; } };
    const { page } = await ouvrir({ navigateur: { wakeLock } });
    assert.deepEqual(demandes, ['screen']);
    await page.visible(true);
    assert.equal(demandes.length, 1, 'toujours tenu : pas de nouvelle demande');
    relacher(); // le système l'a relâché (écran verrouillé)
    await page.visible(true);
    assert.equal(demandes.length, 2);
  });
});

// ── Mon QR ───────────────────────────────────────────────────────────────────

describe('Opérateur — « Mon QR »', () => {
  // Faux `qrcode-generator` : enregistre ce qu'on lui demande d'encoder.
  function fauxQr() {
    const encodes = [];
    const qrcode = () => ({ addData: (d) => encodes.push(d), make() {}, createSvgTag: () => '<svg>qr</svg>' });
    return { qrcode, encodes };
  }

  test('encode le lien du groupe, généré une fois par groupe', T, async () => {
    const { qrcode, encodes } = fauxQr();
    const { page } = await ouvrir({ globaux: { qrcode } });
    page.appeler('renderMyQR()');
    page.appeler('renderMyQR()');
    assert.deepEqual(encodes, [`https://compteur.test/?e=${E}&g=${G}`]);
    assert.equal(page.el('my-qr-svg').innerHTML, '<svg>qr</svg>');
    assert.equal(page.el('my-qr-name').textContent, 'Principal');
  });

  // Les libs QR sont en `defer` : sur un réseau lent ou hors ligne, elles peuvent manquer.
  test('lib QR pas (encore) chargée : message de repli, et nouvel essai à la prochaine ouverture', T, async () => {
    const { page } = await ouvrir();
    assert.doesNotThrow(() => page.appeler('renderMyQR()'));
    assert.match(page.el('my-qr-svg').textContent, /QR indisponible/);
    assert.equal(page.el('my-qr-svg').dataset.key, undefined, 'rien n\'est mis en cache : on réessaiera');

    const { qrcode, encodes } = fauxQr();
    page.ctx.qrcode = qrcode; // la lib finit par arriver
    page.appeler('renderMyQR()');
    assert.equal(encodes.length, 1);
  });

  test('partage : feuille de partage du téléphone si elle existe, sinon copie du lien', T, async () => {
    const natif = await ouvrir({ partage: true });
    await natif.page.appeler('shareMyQR()');
    assert.equal(natif.page.journal.partages[0].url, `https://compteur.test/?e=${E}&g=${G}`);
    assert.deepEqual(natif.page.journal.copies, []);

    const { page } = await ouvrir();
    page.el('my-qr-share-btn').textContent = 'Partager le lien';
    await page.appeler('shareMyQR()');
    assert.deepEqual(page.journal.copies, [`https://compteur.test/?e=${E}&g=${G}`]);
    assert.equal(page.el('my-qr-share-btn').textContent, 'Lien copié');
    await page.avancer(1500);
    assert.equal(page.el('my-qr-share-btn').textContent, 'Partager le lien');
  });

  test('bouton scanner : visible avec une caméra OU un groupe actif, masqué sans les deux', T, async () => {
    const camera = { mediaDevices: { getUserMedia: async () => { throw new Error('refusé'); } } };
    const affiche = (page) => page.el('scan-btn').style.display === 'block';
    assert.equal(affiche((await ouvrir()).page), true, 'groupe actif, pas de caméra → pour montrer son QR');
    assert.equal(affiche(charger('index.html', 'function flush', { url: '/' })), false, 'ni caméra ni groupe');
    assert.equal(affiche(charger('index.html', 'function flush', { url: '/', navigateur: camera })), true, 'caméra seule → pour scanner');
  });
});
