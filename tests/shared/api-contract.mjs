// ── Contrat de l'API : les MÊMES scénarios sur le serveur local et sur le Worker ──
// Le compteur existe en deux implémentations (server.js ↔ src/*.js). Chaque divergence
// passée a coûté un bug de prod (garde `archived`, fermeture des WS, constantes…). Ici un
// scénario n'est écrit qu'une fois et joué des deux côtés :
//   tests/contract.test.js          → Express, node:test
//   tests/worker/contract.test.js   → Worker + Durable Objects, vitest (workerd)
//
// Chaque cas reçoit un `api` fourni par la plateforme :
//   api.plateforme           'local' | 'cloud'
//   api.ADMIN                code admin de départ
//   api.get(chemin)          → { status, json, text, header(nom) }
//   api.post(chemin, corps, { brut, type })   `brut` = corps envoyé tel quel
//   api.echantillonner(e)    un tir d'horloge d'historique pour CET événement
//   api.ws(e, g?)            → { attendre(type, ms), silence(type, ms), envoyer(x), fermer(), ferme }
//                            `ferme` = code de fermeture, ou 'refus:<statut>' si le
//                            handshake n'aboutit pas
//
// `defaut: { local|cloud: 'raison' }` = défaut CONNU et pas encore corrigé sur cette
// plateforme. Le cas est joué quand même, mais son échec ne casse pas la suite (todo côté
// node:test, it.fails côté vitest). Corriger le défaut → retirer la mention.

// ── Assertions neutres (ni node:assert ni expect : le fichier tourne dans les deux) ──

const trier = (v) => {
  if (Array.isArray(v)) return v.map(trier);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, trier(v[k])]));
  }
  return v;
};
const voir = (v) => JSON.stringify(trier(v));

export function egal(recu, attendu, msg) {
  if (voir(recu) !== voir(attendu)) {
    throw new Error(`${msg ?? 'valeur inattendue'}\n    reçu    : ${voir(recu)}\n    attendu : ${voir(attendu)}`);
  }
}

export function vrai(condition, msg) {
  if (!condition) throw new Error(msg ?? 'condition fausse');
}

const cles = (o) => Object.keys(o ?? {}).sort();
// L'ordre des groupes N'EST PAS l'ordre de création : `Object.values(groups)` range d'abord
// les identifiants entièrement numériques (« 482913 »), par valeur. Ne jamais comparer une
// liste de groupes ou d'opérateurs dans l'ordre reçu.
const ids = (liste_) => liste_.map((x) => x.id).sort();
const parNom = (clients) => [...clients].sort((a, b) => a.name.localeCompare(b.name));

// Borne toute attente : une régression doit ÉCHOUER, pas faire pendre la suite.
export function delai(promesse, ms = 5000, quoi = 'réponse') {
  let timer;
  const borne = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${quoi} : rien en ${ms} ms`)), ms);
  });
  return Promise.race([promesse, borne]).finally(() => clearTimeout(timer));
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Boîte de réception d'un WebSocket (partagée par les deux plateformes) ──
// Les messages s'entrelacent (init, clients, update) : on les consomme PAR TYPE.
export function creerBoite() {
  const recus = [];
  const lus = new Map();      // type → index du prochain message non consommé
  const reveils = new Set();

  function prendre(type) {
    for (let i = lus.get(type) ?? 0; i < recus.length; i++) {
      if (recus[i]?.type === type) { lus.set(type, i + 1); return recus[i]; }
    }
    lus.set(type, recus.length);
    return null;
  }

  return {
    recus,
    recevoir(donnee) {
      let msg;
      try { msg = JSON.parse(typeof donnee === 'string' ? donnee : String(donnee)); }
      catch { msg = { type: '(illisible)' }; }
      recus.push(msg);
      for (const f of [...reveils]) f();
    },
    attendre(type, ms = 5000) {
      return new Promise((resolve, reject) => {
        const fin = () => { clearTimeout(timer); reveils.delete(essai); };
        const essai = () => { const m = prendre(type); if (m) { fin(); resolve(m); } };
        const timer = setTimeout(() => {
          fin();
          reject(new Error(`aucun message « ${type} » en ${ms} ms (reçus : ${recus.map((m) => m?.type).join(', ') || 'rien'})`));
        }, ms);
        reveils.add(essai);
        essai();
      });
    },
    // true si AUCUN message de ce type n'arrive pendant `ms`.
    async silence(type, ms = 300) {
      await pause(ms);
      return prendre(type) === null;
    },
  };
}

// ── Outils des scénarios ──

const q = (o) => new URLSearchParams(o).toString();

let _n = 0;
const uid = (p = 'u') => `${p}-${Date.now().toString(36)}-${(_n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const HEX6 = /^[0-9a-f]{6}$/;
const INCONNU = 'ffffff'; // forme valide, n'existe pas

const compter = (api, e, g, delta, extra = {}) => api.post('/api/count', { e, g, delta, uuid: uid(), ...extra });
const etat    = async (api, e, g) => (await api.get(`/api/state?${q({ e, g })}`)).json;
const histo   = async (api, e, extra = {}, code = api.ADMIN) => (await api.get(`/api/history?${q({ code, e, ...extra })}`)).json;
const config  = (api, corps, code = api.ADMIN) => api.post('/api/admin/config', { code, ...corps });
const liste   = async (api, code = api.ADMIN) => (await api.get(`/api/events?${q({ code })}`)).json;
const groupe  = (h, id) => h.groups.find((x) => x.id === id);

async function creerGroupe(api, e, name) {
  const r = await api.post('/api/groups', { code: api.ADMIN, e, name });
  egal(r.status, 200, `création du groupe « ${name} »`);
  return r.json.id;
}

// Crée un événement, joue `fn`, puis le SUPPRIME quoi qu'il arrive : le registre cloud
// est plafonné à 50 événements et sa mémoire survit d'un test à l'autre.
async function avecEvenement(api, nom, fn) {
  const r = await api.post('/api/events', { code: api.ADMIN, name: nom });
  egal(r.status, 200, `création de l'événement « ${nom} »`);
  const evt = r.json;
  try {
    return await fn({ e: evt.id, g: evt.groups[0].id, evt });
  } finally {
    await api.post('/api/admin/config', { code: api.ADMIN, e: evt.id, deleteEvent: true });
  }
}

// Rien d'énumérable ne doit jamais apparaître sur Object.prototype (pollution). Local et
// cloud tournent dans le même processus/isolate que le test : on peut le constater ici.
// Nettoie TOUJOURS derrière soi, sinon la pollution ferait échouer les tests suivants.
const RESERVES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

function pollution() {
  const traces = Object.keys(Object.prototype);
  for (const k of traces) delete Object.prototype[k];
  // « constructor », « toString »… désignent des FONCTIONS natives : un `opStats[nom].in += 1`
  // mal gardé y laisse une propriété.
  for (const f of new Set([Object, ...RESERVES.map((n) => Object.prototype[n])])) {
    if (typeof f !== 'function') continue;
    for (const k of ['in', 'out', 'count', 'totalIn', 'totalOut']) {
      if (Object.hasOwn(f, k)) { traces.push(`${f.name}.${k}`); delete f[k]; }
    }
  }
  return traces;
}

// Générateur pseudo-aléatoire à graine : mêmes tirages à chaque exécution.
function alea(graine) {
  let a = graine | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Les cas ──

export function casDuContrat() {
  const C = [];
  const cas = (groupe_, nom, run, defaut = {}) => C.push({ groupe: groupe_, nom, run, defaut });

  // ════ Comptage ════════════════════════════════════════════════════════════

  cas('Comptage', 'les quatre deltas s\'appliquent au total et au groupe', async (api) => {
    await avecEvenement(api, 'Deltas', async ({ e, g }) => {
      for (const [delta, attendu] of [[1, 1], [5, 6], [-1, 5], [-5, 0]]) {
        const r = await compter(api, e, g, delta);
        egal(r.status, 200, `delta ${delta}`);
        egal(r.json, { total: attendu, alert: false }, `réponse au delta ${delta}`);
      }
      egal(await etat(api, e, g),
        { total: 0, groupCount: 0, capacity: 100, eventName: 'Deltas', groupName: 'Principal' });
      const h = await histo(api, e);
      egal([h.total, h.totalIn, h.totalOut], [0, 6, 6], 'cumuls');
    });
  });

  cas('Comptage', 'tout delta autre que ±1 / ±5 est refusé (400) et ne change rien', async (api) => {
    await avecEvenement(api, 'Deltas invalides', async ({ e, g }) => {
      const MAUVAIS = [0, 2, -2, 3, 10, -10, 1.5, 1e9, '1', '+1', '', null, true, false, [1], { v: 1 }];
      for (const delta of MAUVAIS) {
        const r = await api.post('/api/count', { e, g, delta, uuid: uid() });
        egal(r.status, 400, `delta ${JSON.stringify(delta)}`);
      }
      egal((await api.post('/api/count', { e, g, uuid: uid() })).status, 400, 'delta absent');
      egal((await etat(api, e, g)).total, 0, 'aucun de ces envois ne doit compter');
    });
  });

  cas('Comptage', 'uuid absent ou vide → 400', async (api) => {
    await avecEvenement(api, 'Uuid', async ({ e, g }) => {
      egal((await api.post('/api/count', { e, g, delta: 1 })).status, 400, 'absent');
      egal((await api.post('/api/count', { e, g, delta: 1, uuid: '' })).status, 400, 'vide');
      egal((await api.post('/api/count', { e, g, delta: 1, uuid: null })).status, 400, 'null');
      egal((await etat(api, e, g)).total, 0);
    });
  });

  // Un uuid qui n'est pas du texte ne se compare pas par valeur : deux envois « identiques »
  // d'un objet sont deux objets différents → la déduplication ne les reconnaît jamais.
  cas('Comptage', 'uuid qui n\'est pas du texte (nombre, objet, tableau) → 400', async (api) => {
    await avecEvenement(api, 'Uuid typé', async ({ e, g }) => {
      for (const uuid of [12345, true, ['a'], { a: 1 }]) {
        const r = await api.post('/api/count', { e, g, delta: 1, uuid });
        egal(r.status, 400, `uuid ${JSON.stringify(uuid)}`);
      }
      egal((await etat(api, e, g)).total, 0);
    });
  });

  // Les uuid sont gardés en mémoire (20 000) et persistés (2 500 à 5 000) : sans borne de
  // taille, quelques milliers d'envois suffisent à gonfler le stockage.
  cas('Comptage', 'uuid démesuré (10 000 caractères) → 400', async (api) => {
    await avecEvenement(api, 'Uuid géant', async ({ e, g }) => {
      const r = await api.post('/api/count', { e, g, delta: 1, uuid: 'x'.repeat(10_000) });
      egal(r.status, 400);
      egal((await api.post('/api/count', { e, g, delta: 1, uuid: 'x'.repeat(65) })).status, 400, '65 caractères');
      egal((await etat(api, e, g)).total, 0);
      egal((await api.post('/api/count', { e, g, delta: 1, uuid: 'x'.repeat(64) })).status, 200, '64 caractères : accepté');
    });
  });

  cas('Comptage', 'e ou g manquant → 400', async (api) => {
    await avecEvenement(api, 'Sans cible', async ({ e, g }) => {
      egal((await api.post('/api/count', { g, delta: 1, uuid: uid() })).status, 400, 'sans e');
      egal((await api.post('/api/count', { e, delta: 1, uuid: uid() })).status, 400, 'sans g');
      egal((await api.post('/api/count', { e: '', g: '', delta: 1, uuid: uid() })).status, 400, 'vides');
    });
  });

  // Une op refusée ne doit pas « brûler » son uuid : sinon le renvoi correct serait pris
  // pour un doublon et le comptage perdu.
  cas('Comptage', 'événement ou groupe inconnu → 404, et l\'uuid n\'est pas consommé', async (api) => {
    await avecEvenement(api, 'Inconnus', async ({ e, g }) => {
      const uuid = uid();
      egal((await api.post('/api/count', { e: INCONNU, g, delta: 1, uuid })).status, 404, 'événement inconnu');
      egal((await api.post('/api/count', { e, g: 'aaaaaa', delta: 1, uuid })).status, 404, 'groupe inconnu');
      const r = await api.post('/api/count', { e, g, delta: 1, uuid });
      egal(r.json, { total: 1, alert: false }, 'le même uuid, bien adressé, doit compter');
    });
  });

  cas('Comptage', 'même uuid rejoué (à la suite puis en rafale) → compté une seule fois', async (api) => {
    await avecEvenement(api, 'Doublons', async ({ e, g }) => {
      const uuid = uid();
      const envoyer = (u) => api.post('/api/count', { e, g, delta: 1, uuid: u });
      egal((await envoyer(uuid)).json, { total: 1, alert: false });
      for (let i = 0; i < 2; i++) {
        const r = await envoyer(uuid);
        egal(r.status, 200);
        egal(r.json, { total: 1, dup: true }, 'un doublon répond dup:true, sans champ alert');
      }
      const rafale = uid();
      const reps = await Promise.all(Array.from({ length: 10 }, () => envoyer(rafale)));
      egal(reps.filter((r) => !r.json.dup).length, 1, 'une seule des 10 requêtes simultanées compte');
      egal((await etat(api, e, g)).total, 2);
    });
  });

  cas('Comptage', 'la déduplication est scopée par événement, pas par groupe', async (api) => {
    await avecEvenement(api, 'Dédup A', async ({ e: a, g: ga }) => {
      await avecEvenement(api, 'Dédup B', async ({ e: b, g: gb }) => {
        const uuid = uid();
        egal((await api.post('/api/count', { e: a, g: ga, delta: 1, uuid })).json.total, 1);
        egal((await api.post('/api/count', { e: b, g: gb, delta: 1, uuid })).json, { total: 1, alert: false },
          'le même uuid sur un AUTRE événement compte');
        const ga2 = await creerGroupe(api, a, 'Autre porte');
        egal((await api.post('/api/count', { e: a, g: ga2, delta: 1, uuid })).json, { total: 1, dup: true },
          'le même uuid sur un autre GROUPE du même événement est un doublon');
      });
    });
  });

  cas('Comptage', 'bornage au total : −5 à 3 n\'enlève que 3, −1 à 0 n\'enlève rien', async (api) => {
    await avecEvenement(api, 'Bornage', async ({ e, g }) => {
      for (let i = 0; i < 3; i++) await compter(api, e, g, 1, { name: 'Alice' });
      egal((await compter(api, e, g, -5, { name: 'Bob' })).json, { total: 0, alert: false });
      egal((await compter(api, e, g, -1, { name: 'Chloé' })).json, { total: 0, alert: false });
      const grp = groupe(await histo(api, e), g);
      egal([grp.count, grp.totalIn, grp.totalOut], [0, 3, 3], 'les sorties comptées sont les sorties EFFECTIVES');
      egal(grp.opStats, { Alice: { in: 3, out: 0 }, Bob: { in: 0, out: 3 } },
        'un clic sans effet (Chloé) ne crée pas de ligne opérateur');
    });
  });

  cas('Comptage', 'un groupe peut être négatif tant que le total reste ≥ 0', async (api) => {
    await avecEvenement(api, 'Portes', async ({ e, g: entree }) => {
      const sortie = await creerGroupe(api, e, 'Sortie');
      await compter(api, e, entree, 5);
      await compter(api, e, sortie, -1);
      egal((await compter(api, e, sortie, -1)).json.total, 3);
      egal((await etat(api, e, sortie)).groupCount, -2, 'sorties par une porte où personne n\'est entré');
      egal((await compter(api, e, sortie, -5)).json.total, 0, 'le total, lui, s\'arrête à 0');
      const h = await histo(api, e);
      egal([groupe(h, entree).count, groupe(h, sortie).count, groupe(h, sortie).totalOut], [5, -5, 5]);
    });
  });

  cas('Comptage', 'alerte : fausse sous la capacité, vraie à partir de la capacité', async (api) => {
    await avecEvenement(api, 'Seuil', async ({ e, g }) => {
      await config(api, { e, capacity: 3 });
      const suite = [[1, 1, false], [1, 2, false], [1, 3, true], [5, 8, true], [-5, 3, true], [-1, 2, false]];
      for (const [delta, total, alert] of suite) {
        egal((await compter(api, e, g, delta)).json, { total, alert }, `delta ${delta}`);
      }
    });
  });

  cas('Comptage', 'prénom : espaces retirés, 32 caractères max, ignoré s\'il n\'est pas du texte', async (api) => {
    await avecEvenement(api, 'Prénoms', async ({ e, g }) => {
      for (const name of ['  Alice  ', 'X'.repeat(50), 123, '', '   ', null, ['Zoé'], { n: 1 }]) {
        egal((await compter(api, e, g, 1, { name })).status, 200, `prénom ${JSON.stringify(name)}`);
      }
      const grp = groupe(await histo(api, e), g);
      egal(grp.totalIn, 8, 'le comptage ne dépend jamais du prénom');
      egal(grp.opStats, { Alice: { in: 1, out: 0 }, ['X'.repeat(32)]: { in: 1, out: 0 } });
    });
  });

  cas('Comptage', 'un même opérateur sur deux groupes : chiffres séparés par groupe', async (api) => {
    await avecEvenement(api, 'Mobile', async ({ e, g: g1 }) => {
      const g2 = await creerGroupe(api, e, 'Porte B');
      await compter(api, e, g1, 5, { name: 'Alice' });
      await compter(api, e, g2, 1, { name: 'Alice' });
      await compter(api, e, g2, -1, { name: 'Alice' });
      const h = await histo(api, e);
      egal(groupe(h, g1).opStats, { Alice: { in: 5, out: 0 } });
      egal(groupe(h, g2).opStats, { Alice: { in: 1, out: 1 } });
    });
  });

  // `opStats[prénom]` et `groups[id]` sont des objets ordinaires : un nom comme
  // « constructor » ou « __proto__ » y trouve une propriété HÉRITÉE au lieu de rien.
  cas('Comptage', 'prénoms à risque (__proto__, constructor, toString…) : comptés, suivis, rien de pollué', async (api) => {
    try {
      await avecEvenement(api, 'Prénoms piégés', async ({ e, g }) => {
        for (const name of RESERVES) {
          egal((await compter(api, e, g, 1, { name })).status, 200, `prénom ${name}`);
        }
        const grp = groupe(await histo(api, e), g);
        egal(grp.totalIn, RESERVES.length, 'les 5 clics sont comptés');
        egal(pollution(), [], 'Object.prototype / fonctions natives modifiés par un simple prénom');
        for (const name of RESERVES.filter((n) => n !== '__proto__')) {
          egal(grp.opStats[name], { in: 1, out: 0 }, `l'opérateur « ${name} » doit apparaître dans les stats`);
        }
        // « __proto__ » ne peut pas être une clé ordinaire d'un objet : compté, pas suivi.
        egal(Object.keys(grp.opStats).sort(), RESERVES.filter((n) => n !== '__proto__').sort());
        // …et ces prénoms continuent d'accumuler comme les autres.
        await compter(api, e, g, -1, { name: 'constructor' });
        egal(groupe(await histo(api, e), g).opStats.constructor, { in: 1, out: 1 });
      });
    } finally { pollution(); }
  });

  cas('Comptage', 'identifiants à risque en e / g (__proto__, constructor…) → 404, jamais 500 ni 200', async (api) => {
    try {
      await avecEvenement(api, 'Ids piégés', async ({ e, g }) => {
        for (const id of RESERVES) {
          egal((await api.post('/api/count', { e: id, g, delta: 1, uuid: uid() })).status, 404, `count e=${id}`);
          egal((await api.post('/api/count', { e, g: id, delta: 1, uuid: uid() })).status, 404, `count g=${id}`);
          egal((await api.get(`/api/state?${q({ e: id, g })}`)).status, 404, `state e=${id}`);
          egal((await api.get(`/api/state?${q({ e, g: id })}`)).status, 404, `state g=${id}`);
        }
        egal(pollution(), [], 'Object.prototype modifié par un identifiant');
        egal((await etat(api, e, g)).total, 0);
      });
    } finally { pollution(); }
  });

  cas('Comptage', 'e / g d\'un mauvais type (tableau, nombre, objet) → refusé, rien n\'est compté', async (api) => {
    await avecEvenement(api, 'Types', async ({ e, g }) => {
      const uuid = uid();
      for (const corps of [{ e: [e], g }, { e, g: [g] }, { e: 123, g }, { e, g: 456 }, { e: { id: e }, g }]) {
        const r = await api.post('/api/count', { ...corps, delta: 1, uuid });
        vrai(r.status === 400 || r.status === 404, `${JSON.stringify(corps)} → ${r.status}`);
      }
      egal((await etat(api, e, g)).total, 0, 'un identifiant en tableau ne doit pas être « converti » puis compté');
    });
  });

  cas('Comptage', 'corps illisible (JSON cassé, vide, texte brut, null, tableau) → 4xx, jamais 5xx', async (api) => {
    const CORPS = [
      ['JSON tronqué', '{"delta":1,'],
      ['vide', ''],
      ['texte brut', 'bonjour'],
      ['null', 'null'],
      ['tableau', '[1,2,3]'],
      ['chaîne JSON', '"x"'],
      ['nombre', '42'],
    ];
    for (const [nom, brut] of CORPS) {
      for (const chemin of ['/api/count', '/api/admin/config', '/api/events', '/api/groups', '/api/reset-counts']) {
        const r = await api.post(chemin, null, { brut });
        vrai(r.status >= 400 && r.status < 500, `${chemin} avec un corps ${nom} → ${r.status}`);
      }
    }
    const sansType = await api.post('/api/count', null, { brut: '{"delta":1}', type: 'text/plain' });
    vrai(sansType.status >= 400 && sansType.status < 500, `Content-Type text/plain → ${sansType.status}`);
  });

  // Séquences tirées au hasard (graine fixe) comparées, opération par opération, à un
  // modèle de référence de quelques lignes : la règle documentée, sans rien d'autre.
  for (const [nom, graine, sorties] of [['plutôt des entrées', 20261012, 0.3], ['plutôt des sorties (bornage)', 7, 0.6]]) {
    cas('Comptage', `200 opérations aléatoires (${nom}) : identique au modèle de référence`, async (api) => {
      await avecEvenement(api, 'Aléatoire', async ({ e, g: g0 }) => {
        const tirer = alea(graine);
        const gids = [g0, await creerGroupe(api, e, 'B'), await creerGroupe(api, e, 'C')];
        const noms = ['Alice', 'Bob', 'Chloé', null];
        const M = { vus: new Set(), groupes: Object.fromEntries(gids.map((id) => [id, { count: 0, totalIn: 0, totalOut: 0, opStats: {} }])) };
        const total = () => Object.values(M.groupes).reduce((s, x) => s + x.count, 0);
        const envoyes = [];

        for (let i = 0; i < 200; i++) {
          let op;
          if (envoyes.length && tirer() < 0.12) {
            op = envoyes[Math.floor(tirer() * envoyes.length)]; // renvoi d'une op déjà partie
          } else {
            const negatif = tirer() < sorties;
            const grand = tirer() < 0.25;
            op = { e, g: gids[Math.floor(tirer() * 3)], delta: (negatif ? -1 : 1) * (grand ? 5 : 1), uuid: uid() };
            const name = noms[Math.floor(tirer() * noms.length)];
            if (name) op.name = name;
            envoyes.push(op);
          }

          let attendu;
          if (M.vus.has(op.uuid)) attendu = { total: total(), dup: true };
          else {
            M.vus.add(op.uuid);
            const cur = total();
            const eff = (cur + op.delta < 0) ? -cur : op.delta;
            const grp = M.groupes[op.g];
            grp.count += eff;
            if (eff > 0) grp.totalIn += eff; else if (eff < 0) grp.totalOut -= eff;
            if (op.name && eff !== 0) {
              const s = (grp.opStats[op.name] ??= { in: 0, out: 0 });
              if (eff > 0) s.in += eff; else s.out -= eff;
            }
            attendu = { total: total(), alert: total() >= 100 };
          }
          const r = await api.post('/api/count', op);
          egal(r.status, 200, `opération n°${i}`);
          egal(r.json, attendu, `opération n°${i} : ${JSON.stringify(op)}`);
        }

        const h = await histo(api, e);
        for (const id of gids) {
          const { count, totalIn, totalOut, opStats } = groupe(h, id);
          egal({ count, totalIn, totalOut, opStats }, M.groupes[id], `groupe ${id}`);
        }
        egal(h.total, total());
        vrai(h.total >= 0, 'total négatif');
        egal(h.totalIn - h.totalOut, h.total, 'entrées − sorties = présents (hors remise à zéro)');
        await api.echantillonner(e);
        const pt = (await histo(api, e)).history.at(-1);
        egal(pt.i - pt.o, pt.c, 'invariant i − o = c sur le point d\'historique');
      });
    });
  }

  // ════ Lecture d'état ══════════════════════════════════════════════════════

  cas('État', '/api/state : paramètres manquants → 400, inconnus → 404', async (api) => {
    await avecEvenement(api, 'État', async ({ e, g }) => {
      egal((await api.get('/api/state')).status, 400);
      egal((await api.get(`/api/state?${q({ e })}`)).status, 400, 'sans g');
      egal((await api.get(`/api/state?${q({ g })}`)).status, 400, 'sans e');
      egal((await api.get(`/api/state?${q({ e: INCONNU, g })}`)).status, 404, 'événement inconnu');
      egal((await api.get(`/api/state?${q({ e, g: 'aaaaaa' })}`)).status, 404, 'groupe inconnu');
      egal((await api.get(`/api/state?${q({ e, g })}`)).status, 200);
    });
  });

  // ════ Authentification et rôles ═══════════════════════════════════════════

  cas('Accès', 'sans code ou avec un mauvais code → 403 partout, et rien ne change', async (api) => {
    await avecEvenement(api, 'Fermé', async ({ e, g }) => {
      for (const code of [undefined, 'mauvais', '', 'ADMIN123', 'admin123 ']) {
        const p = code === undefined ? {} : { code };
        for (const chemin of ['/api/events', '/api/events/archived', `/api/history?${q({ e })}`, `/api/clients?${q({ e })}`, `/api/qr?${q({ e, g })}`, '/api/ips']) {
          const sep = chemin.includes('?') ? '&' : '?';
          const r = await api.get(chemin + (code === undefined ? '' : sep + q({ code })));
          egal(r.status, 403, `GET ${chemin} avec le code ${JSON.stringify(code)}`);
        }
        const POSTS = [
          ['/api/events', { name: 'Intrus' }],
          ['/api/groups', { e, name: 'Intrus' }],
          ['/api/admin/config', { e, capacity: 7 }],
          ['/api/admin/config', { e, name: 'Piraté' }],
          ['/api/admin/config', { e, archived: true }],
          ['/api/admin/config', { e, deleteEvent: true }],
          ['/api/admin/config', { newCode: 'piratage' }],
          ['/api/admin/config', { newPermCode: 'piratage' }],
          ['/api/reset-counts', { e }],
        ];
        for (const [chemin, corps] of POSTS) {
          const r = await api.post(chemin, { ...p, ...corps });
          egal(r.status, 403, `POST ${chemin} ${JSON.stringify(corps)} avec le code ${JSON.stringify(code)}`);
        }
      }
      egal(await etat(api, e, g),
        { total: 0, groupCount: 0, capacity: 100, eventName: 'Fermé', groupName: 'Principal' }, 'rien n\'a changé');
      const l = await liste(api);
      vrai(l.events.some((x) => x.id === e), 'l\'événement existe toujours');
      vrai(!l.events.some((x) => x.name === 'Intrus'), 'aucun événement créé');
      egal((await api.get(`/api/events?${q({ code: 'piratage' })}`)).status, 403, 'le code n\'a pas été changé');
    });
  });

  cas('Accès', 'code d\'un mauvais type dans le corps (tableau, objet, nombre, booléen) → 403', async (api) => {
    for (const code of [[api.ADMIN], { code: api.ADMIN }, 123, true]) {
      egal((await api.post('/api/events', { code, name: 'Type' })).status, 403, JSON.stringify(code));
    }
  });

  cas('Accès', 'rôle PERM : lecture et remise à zéro des compteurs, rien d\'autre', async (api) => {
    const PERM = 'perm-1234';
    try {
      await avecEvenement(api, 'Lecture seule', async ({ e, g }) => {
        egal((await config(api, { newPermCode: PERM })).status, 200);
        await compter(api, e, g, 5, { name: 'Alice' });

        const l = await liste(api, PERM);
        egal(l.role, 'perm');
        vrai(l.events.some((x) => x.id === e), 'PERM voit les événements');
        egal((await api.get(`/api/history?${q({ code: PERM, e })}`)).status, 200, 'history');
        egal((await api.get(`/api/clients?${q({ code: PERM, e })}`)).status, 200, 'clients');
        egal((await api.get(`/api/qr?${q({ code: PERM, e, g })}`)).status, 200, 'qr');

        const INTERDITS = [
          ['/api/events', { name: 'Interdit' }],
          ['/api/groups', { e, name: 'Interdit' }],
          ['/api/admin/config', { e, capacity: 7 }],
          ['/api/admin/config', { e, name: 'Interdit' }],
          ['/api/admin/config', { e, reset: true }],
          ['/api/admin/config', { e, archived: true }],
          ['/api/admin/config', { e, g, deleteGroup: true }],
          ['/api/admin/config', { e, deleteEvent: true }],
          ['/api/admin/config', { newCode: 'interdit' }],
          ['/api/admin/config', { newPermCode: 'interdit' }],
        ];
        for (const [chemin, corps] of INTERDITS) {
          egal((await api.post(chemin, { code: PERM, ...corps })).status, 403, `PERM → ${chemin} ${JSON.stringify(corps)}`);
        }
        egal((await api.get(`/api/events/archived?${q({ code: PERM })}`)).status, 403, 'liste des archivés');
        egal(await etat(api, e, g),
          { total: 5, groupCount: 5, capacity: 100, eventName: 'Lecture seule', groupName: 'Principal' });
        egal((await liste(api)).role, 'admin', 'le code admin n\'a pas bougé');

        egal((await api.post('/api/reset-counts', { code: PERM, e })).status, 200, 'remise à zéro des compteurs');
        egal((await etat(api, e, g)).total, 0);
      });
    } finally { await config(api, { newPermCode: null }); }
  });

  cas('Accès', 'code PERM : désactivé par null, par une chaîne vide ou par un code trop court', async (api) => {
    const PERM = 'perm-5678';
    try {
      for (const couper of [null, '', 'abc']) {
        await config(api, { newPermCode: PERM });
        egal((await api.get(`/api/events?${q({ code: PERM })}`)).status, 200, 'PERM actif');
        await config(api, { newPermCode: couper });
        egal((await api.get(`/api/events?${q({ code: PERM })}`)).status, 403, `désactivé par ${JSON.stringify(couper)}`);
        if (couper) egal((await api.get(`/api/events?${q({ code: couper })}`)).status, 403, 'un code trop court n\'ouvre rien');
      }
    } finally { await config(api, { newPermCode: null }); }
  });

  cas('Accès', 'changement du code admin : l\'ancien est refusé, un code trop court ou non textuel est ignoré', async (api) => {
    const NOUVEAU = 'nouveau-code-42';
    try {
      for (const ignore of ['abc', '', 12345, null, ['abcd']]) {
        await config(api, { newCode: ignore });
        egal((await api.get(`/api/events?${q({ code: api.ADMIN })}`)).status, 200, `newCode ${JSON.stringify(ignore)} ignoré`);
      }
      egal((await config(api, { newCode: NOUVEAU })).status, 200);
      egal((await api.get(`/api/events?${q({ code: api.ADMIN })}`)).status, 403, 'ancien code refusé');
      egal((await liste(api, NOUVEAU)).role, 'admin');
    } finally { await config(api, { newCode: api.ADMIN }, NOUVEAU); }
    egal((await api.get(`/api/events?${q({ code: api.ADMIN })}`)).status, 200, 'code d\'origine rétabli');
  });

  // Le code est libre (4 caractères mini). Les pages passent par URLSearchParams (`qs()`) :
  // tant que la query est encodée, n'importe quel caractère doit authentifier.
  cas('Accès', 'code à caractères spéciaux (& + # espace accent emoji apostrophe) : accepté en query encodée et en corps', async (api) => {
    let courant = api.ADMIN;
    try {
      for (const code of ['a&b=c', 'code+plus', 'has space', 'hash#tag', 'café ☕ 100%', 'l\'apostrophe', '"guillemets"', '../..//?e=']) {
        egal((await config(api, { newCode: code }, courant)).status, 200, `passage au code ${code}`);
        courant = code;
        const get = await api.get(`/api/events?${q({ code })}`);
        egal(get.status, 200, `GET avec ${code}`);
        egal(get.json.role, 'admin');
        const post = await api.post('/api/events', { code, name: 'Spécial' });
        egal(post.status, 200, `POST avec ${code}`);
        await api.post('/api/admin/config', { code, e: post.json.id, deleteEvent: true });
      }
    } finally { await config(api, { newCode: api.ADMIN }, courant); }
  });

  // ════ Événements et groupes ═══════════════════════════════════════════════

  cas('Événements', 'création : identifiant, nom nettoyé, groupe « Principal », présence dans la liste', async (api) => {
    const crees = [];
    try {
      const NOMS = [
        ['  Soirée d\'ouverture  ', 'Soirée d\'ouverture'],
        ['N'.repeat(60), 'N'.repeat(40)],
        ['', 'Nouvel événement'],
        ['    ', 'Nouvel événement'],
        [undefined, 'Nouvel événement'],
        [42, 'Nouvel événement'],
        ['<b>gras</b> & "co"', '<b>gras</b> & "co"'],
      ];
      for (const [envoye, attendu] of NOMS) {
        const r = await api.post('/api/events', { code: api.ADMIN, name: envoye });
        egal(r.status, 200, `nom ${JSON.stringify(envoye)}`);
        crees.push(r.json.id);
        await pause(3); // la liste est triée par date de création, à la milliseconde
        vrai(HEX6.test(r.json.id), `identifiant ${r.json.id}`);
        egal(r.json.name, attendu);
        egal([r.json.total, r.json.capacity], [0, 100]);
        egal(r.json.groups.length, 1);
        egal([r.json.groups[0].name, r.json.groups[0].count], ['Principal', 0]);
        vrai(HEX6.test(r.json.groups[0].id), 'identifiant de groupe');
      }
      egal(new Set(crees).size, crees.length, 'identifiants tous différents');

      const l = await liste(api);
      egal(l.role, 'admin');
      const miens = l.events.filter((x) => crees.includes(x.id));
      egal(miens.map((x) => x.id), crees, 'liste dans l\'ordre de création');
      for (const x of miens) {
        for (const k of ['id', 'name', 'total', 'capacity', 'createdAt', 'groups']) {
          vrai(k in x, `champ ${k} absent de la liste`);
        }
      }
    } finally {
      for (const id of crees) await config(api, { e: id, deleteEvent: true });
    }
  });

  cas('Groupes', 'création : nom nettoyé, visible partout, plafond de 20 → 409', async (api) => {
    await avecEvenement(api, 'Groupes', async ({ e }) => {
      egal((await api.post('/api/groups', { code: api.ADMIN, e, name: '  Entrée VIP  ' })).json.name, 'Entrée VIP');
      egal((await api.post('/api/groups', { code: api.ADMIN, e, name: 'G'.repeat(60) })).json.name, 'G'.repeat(40));
      egal((await api.post('/api/groups', { code: api.ADMIN, e })).json.name, 'Nouveau groupe');
      egal((await api.post('/api/groups', { code: api.ADMIN, e, name: '   ' })).json.name, 'Nouveau groupe');
      let groupes = (await liste(api)).events.find((x) => x.id === e).groups;
      egal(groupes.length, 5);
      for (let i = 5; i < 20; i++) await creerGroupe(api, e, `G${i}`);
      const trop = await api.post('/api/groups', { code: api.ADMIN, e, name: 'de trop' });
      egal(trop.status, 409);
      vrai(/Limite atteinte/.test(trop.json.error), 'message d\'erreur lisible');

      groupes = (await liste(api)).events.find((x) => x.id === e).groups;
      egal(groupes.length, 20);
      egal((await config(api, { e, g: groupes[19].id, deleteGroup: true })).json, { ok: true });
      egal((await api.post('/api/groups', { code: api.ADMIN, e, name: 'place libérée' })).status, 200);
    });
    egal((await api.post('/api/groups', { code: api.ADMIN, e: INCONNU, name: 'x' })).status, 404, 'événement inconnu');
  });

  cas('Groupes', 'renommer un groupe ne renomme pas l\'événement, et inversement', async (api) => {
    await avecEvenement(api, 'Soirée VHS', async ({ e, g }) => {
      await config(api, { e, g, name: '  Entrée Nord  ' });
      let s = await etat(api, e, g);
      egal([s.eventName, s.groupName], ['Soirée VHS', 'Entrée Nord']);
      // Archivé AVANT toute relecture de la liste active : côté cloud, celle-ci recale le
      // registre sur le nom du DO et masquerait la confusion ; la liste des archivés, non.
      await config(api, { e, archived: true });
      const archives = (await api.get(`/api/events/archived?${q({ code: api.ADMIN })}`)).json.events;
      egal(archives.find((x) => x.id === e).name, 'Soirée VHS', 'renommer un groupe a renommé l\'événement (liste des archivés)');
      await config(api, { e, archived: false });
      egal((await liste(api)).events.find((x) => x.id === e).name, 'Soirée VHS', 'nom dans la liste admin');

      await config(api, { e, name: 'Soirée Bêta' });
      s = await etat(api, e, g);
      egal([s.eventName, s.groupName], ['Soirée Bêta', 'Entrée Nord']);
      egal((await liste(api)).events.find((x) => x.id === e).name, 'Soirée Bêta');

      for (const vide of ['', '    ', 42, null]) {
        await config(api, { e, name: vide });
        await config(api, { e, g, name: vide });
      }
      s = await etat(api, e, g);
      egal([s.eventName, s.groupName], ['Soirée Bêta', 'Entrée Nord'], 'un nom vide ou non textuel est ignoré');

      await config(api, { e, name: 'E'.repeat(60) });
      await config(api, { e, g, name: 'G'.repeat(60) });
      s = await etat(api, e, g);
      egal([s.eventName.length, s.groupName.length], [40, 40], '40 caractères max');
    });
  });

  cas('Groupes', 'suppression : le dernier groupe est protégé, un groupe supprimé répond 404', async (api) => {
    await avecEvenement(api, 'Suppression', async ({ e, g }) => {
      const r = await config(api, { e, g, deleteGroup: true });
      egal(r.status, 200);
      egal(r.json.ok, false, 'dernier groupe non supprimable');
      egal((await etat(api, e, g)).groupName, 'Principal');

      const g2 = await creerGroupe(api, e, 'Temporaire');
      await compter(api, e, g, 5);
      await compter(api, e, g2, 1);
      egal((await config(api, { e, g: g2, deleteGroup: true })).json, { ok: true });
      egal((await api.get(`/api/state?${q({ e, g: g2 })}`)).status, 404, 'state du groupe supprimé');
      egal((await compter(api, e, g2, 1)).status, 404, 'count sur le groupe supprimé');
      egal(await etat(api, e, g),
        { total: 5, groupCount: 5, capacity: 100, eventName: 'Suppression', groupName: 'Principal' },
        'le total est celui des groupes restants');
      egal((await config(api, { e, g: 'aaaaaa', deleteGroup: true })).status, 200, 'groupe inconnu : sans effet');
    });
  });

  // Un GROUPE peut être négatif (porte de sortie) ; le TOTAL, jamais. Retirer la part d'un
  // groupe d'entrée (suppression, remise à zéro) pouvait laisser un total négatif : les
  // groupes négatifs sont alors remontés, le plus négatif d'abord, jusqu'à un total de 0.
  cas('Groupes', 'supprimer le groupe d\'entrée alors que la sortie est négative : le total est ramené à 0', async (api) => {
    await avecEvenement(api, 'Deux portes', async ({ e, g: entree }) => {
      const sortie = await creerGroupe(api, e, 'Sortie');
      await compter(api, e, entree, 5);
      await compter(api, e, sortie, -1);
      await compter(api, e, sortie, -1);
      egal((await config(api, { e, g: entree, deleteGroup: true })).json, { ok: true });
      const h = await histo(api, e);
      egal(h.total, 0, 'total après la suppression du groupe d\'entrée');
      egal([groupe(h, sortie).count, groupe(h, sortie).totalOut], [0, 2], 'compteur remonté à 0, sorties cumulées intactes');
      egal((await compter(api, e, sortie, 1)).json, { total: 1, alert: false }, 'le comptage repart de 0, sans décalage');
    });
  });

  cas('Groupes', 'remettre à zéro le groupe d\'entrée alors que la sortie est négative : le total est ramené à 0', async (api) => {
    await avecEvenement(api, 'Deux portes', async ({ e, g: entree }) => {
      const sortie = await creerGroupe(api, e, 'Sortie');
      await compter(api, e, entree, 5);
      await compter(api, e, sortie, -1);
      egal((await config(api, { e, g: entree, reset: true })).json, { ok: true });
      const h = await histo(api, e);
      egal([h.total, groupe(h, entree).count, groupe(h, sortie).count], [0, 0, 0]);
    });
  });

  cas('Groupes', 'total ramené à 0 : seuls les groupes négatifs bougent, le plus négatif d\'abord, et juste ce qu\'il faut', async (api) => {
    await avecEvenement(api, 'Quatre portes', async ({ e, g: entree }) => {
      const sortieA = await creerGroupe(api, e, 'Sortie A');
      const sortieB = await creerGroupe(api, e, 'Sortie B');
      const autre   = await creerGroupe(api, e, 'Entrée 2');
      for (let i = 0; i < 2; i++) await compter(api, e, entree, 5);   // +10
      await compter(api, e, autre, 1); await compter(api, e, autre, 1); // +2
      await compter(api, e, sortieA, -5);                               // −5
      await compter(api, e, sortieB, -1);                               // −1   → total 6
      egal((await etat(api, e, entree)).total, 6);

      await config(api, { e, g: entree, deleteGroup: true });           // reste 2 − 5 − 1 = −4
      const h = await histo(api, e);
      egal(h.total, 0);
      egal([groupe(h, sortieA).count, groupe(h, sortieB).count, groupe(h, autre).count], [-1, -1, 2],
        'Sortie A (la plus négative) remonte de 4 ; Sortie B et Entrée 2 ne bougent pas');
      egal([h.totalIn, h.totalOut], [2, 6], 'les cumuls ne sont pas retouchés');
    });
  });

  cas('Groupes', 'supprimer un groupe sans rendre le total négatif : les autres compteurs ne bougent pas', async (api) => {
    await avecEvenement(api, 'Sans effet de bord', async ({ e, g: entree }) => {
      const sortie = await creerGroupe(api, e, 'Sortie');
      const temp   = await creerGroupe(api, e, 'Temporaire');
      await compter(api, e, entree, 5);
      await compter(api, e, sortie, -1);
      await compter(api, e, temp, 1);
      await config(api, { e, g: temp, deleteGroup: true });
      const h = await histo(api, e);
      egal([h.total, groupe(h, entree).count, groupe(h, sortie).count], [4, 5, -1], 'un groupe négatif reste négatif tant que le total est ≥ 0');
    });
  });

  // La formule de bornage `eff = (cur + delta < 0) ? -cur : delta` suppose cur ≥ 0. Avec un
  // total négatif, un clic « −1 » appliquait +|cur| et l'inscrivait en ENTRÉES.
  cas('Groupes', 'un clic « −1 » ne fait jamais monter le total ni les entrées, quel que soit l\'état', async (api) => {
    await avecEvenement(api, 'Deux portes', async ({ e, g: entree }) => {
      const sortie = await creerGroupe(api, e, 'Sortie');
      await compter(api, e, entree, 5);
      await compter(api, e, sortie, -1);
      await compter(api, e, sortie, -1);
      await config(api, { e, g: entree, deleteGroup: true });
      const avant = await histo(api, e);
      const r = await compter(api, e, sortie, -1, { name: 'Zoé' });
      const apres = await histo(api, e);
      egal(r.json, { total: 0, alert: false });
      egal(apres.totalIn, avant.totalIn, 'un −1 a été compté comme des entrées');
      egal(groupe(apres, sortie).opStats, {}, 'un clic sans effet ne crée pas de ligne opérateur');
    });
  });

  // Même racine que les identifiants à risque du comptage, côté réglages (code admin requis).
  cas('Groupes', 'réglage admin visant un groupe « __proto__ » : sans effet, rien de pollué', async (api) => {
    try {
      await avecEvenement(api, 'Réglage piégé', async ({ e, g }) => {
        await compter(api, e, g, 5);
        const r = await config(api, { e, g: '__proto__', reset: true });
        const traces = pollution(); // constat ET nettoyage, avant toute autre requête
        vrai(r.status === 200 || r.status === 404, `statut ${r.status}`);
        egal(traces, [], 'Object.prototype modifié par un réglage admin');
        egal((await etat(api, e, g)).total, 5, 'le vrai groupe n\'est pas touché');
      });
    } finally { pollution(); }
  });

  cas('Groupes', 'remise à zéro d\'UN groupe : lui seul repart à 0 (compteur, cumuls, opérateurs)', async (api) => {
    await avecEvenement(api, 'RAZ groupe', async ({ e, g: g1 }) => {
      const g2 = await creerGroupe(api, e, 'B');
      await compter(api, e, g1, 5, { name: 'Alice' });
      await compter(api, e, g2, 5, { name: 'Bob' });
      await compter(api, e, g2, -1, { name: 'Bob' });
      egal((await config(api, { e, g: g2, reset: true })).json, { ok: true });
      const h = await histo(api, e);
      const a = groupe(h, g1), b = groupe(h, g2);
      egal([a.count, a.totalIn, a.totalOut, a.opStats], [5, 5, 0, { Alice: { in: 5, out: 0 } }]);
      egal([b.count, b.totalIn, b.totalOut, b.opStats], [0, 0, 0, {}]);
      egal(h.total, 5);
    });
  });

  cas('Événements', 'réinitialisation : compteurs, cumuls, opérateurs, historique ET mémoire des doublons repartent de zéro', async (api) => {
    await avecEvenement(api, 'RAZ complète', async ({ e, g }) => {
      const uuid = uid();
      await api.post('/api/count', { e, g, delta: 5, uuid, name: 'Alice' });
      await api.echantillonner(e);
      vrai((await histo(api, e)).history.length >= 1, 'un point d\'historique existe avant la réinitialisation');

      egal((await config(api, { e, reset: true })).json, { ok: true });
      const h = await histo(api, e);
      egal([h.total, h.totalIn, h.totalOut, h.peak], [0, 0, 0, 0]);
      egal([h.history, h.historyCoarse], [[], []], 'historique effacé (les deux séries)');
      egal(groupe(h, g).opStats, {});
      egal((await api.post('/api/count', { e, g, delta: 5, uuid })).json, { total: 5, alert: false },
        'un uuid d\'avant la réinitialisation n\'est plus un doublon');
    });
  });

  cas('Événements', 'compteurs à zéro : les cumuls, les opérateurs et l\'historique sont conservés', async (api) => {
    await avecEvenement(api, 'Multi-jours', async ({ e, g: g1 }) => {
      const g2 = await creerGroupe(api, e, 'B');
      await compter(api, e, g1, 5, { name: 'Alice' });
      await compter(api, e, g2, 1, { name: 'Bob' });
      await compter(api, e, g2, -1, { name: 'Bob' });
      await api.echantillonner(e);
      const avant = await histo(api, e);

      egal((await api.post('/api/reset-counts', { code: api.ADMIN, e })).json, { ok: true });
      const h = await histo(api, e);
      egal([h.total, h.totalIn, h.totalOut], [0, 6, 1]);
      egal(h.groups.map((x) => x.count), [0, 0]);
      egal(groupe(h, g1).opStats, { Alice: { in: 5, out: 0 } });
      egal(h.history.length, avant.history.length + 1, 'un point fin ajouté, aucun retiré');
      egal(h.historyCoarse.length, avant.historyCoarse.length + 1, 'un point long terme ajouté');
      const fin = h.history.at(-1), gros = h.historyCoarse.at(-1);
      egal([fin.c, fin.i, fin.o], [0, 6, 1], 'point fin : présents à 0, cumuls intacts');
      egal([gros.c, gros.i, gros.o], [0, 6, 1], 'point long terme : idem');
      egal(fin.g, { [g1]: 0, [g2]: 0 });
      egal(h.peak, 5, 'le pic survit à la remise à zéro');
    });
    egal((await api.post('/api/reset-counts', { code: api.ADMIN, e: INCONNU })).status, 404, 'événement inconnu');
  });

  cas('Événements', 'capacité : arrondie à l\'entier, les valeurs absurdes sont ignorées', async (api) => {
    await avecEvenement(api, 'Capacité', async ({ e, g }) => {
      await config(api, { e, capacity: 250 });
      egal((await etat(api, e, g)).capacity, 250);
      await config(api, { e, capacity: 150.7 });
      egal((await etat(api, e, g)).capacity, 151);
      for (const absurde of [0, -10, '200', null, true, [300], { v: 300 }]) {
        await config(api, { e, capacity: absurde });
        egal((await etat(api, e, g)).capacity, 151, `capacité ${JSON.stringify(absurde)} ignorée`);
      }
      egal((await liste(api)).events.find((x) => x.id === e).capacity, 151, 'liste admin');
    });
  });

  cas('Événements', 'capacité entre 0 et 0,5 : ne devient jamais 0', async (api) => {
    await avecEvenement(api, 'Capacité', async ({ e, g }) => {
      await config(api, { e, capacity: 0.4 });
      egal((await etat(api, e, g)).capacity, 1, 'capacité tombée à 0 → `alert` vraie en permanence');
      egal((await liste(api)).events.find((x) => x.id === e).capacity, 1, 'liste admin');
      egal((await compter(api, e, g, 1)).json, { total: 1, alert: true });
    });
  });

  cas('Événements', 'archivage : sort de la liste, 404 pour les opérateurs ; désarchivage : tout revient intact', async (api) => {
    await avecEvenement(api, 'Archive', async ({ e, g }) => {
      await compter(api, e, g, 5, { name: 'Alice' });
      egal((await config(api, { e, archived: true })).status, 200);

      vrai(!(await liste(api)).events.some((x) => x.id === e), 'absent de la liste active');
      const arch = (await api.get(`/api/events/archived?${q({ code: api.ADMIN })}`)).json;
      vrai(arch.events.some((x) => x.id === e && x.name === 'Archive'), 'présent dans les archivés');
      egal((await api.get(`/api/state?${q({ e, g })}`)).status, 404, 'state');
      egal((await compter(api, e, g, 1)).status, 404, 'count');
      egal((await api.post('/api/reset-counts', { code: api.ADMIN, e })).status, 404, 'reset-counts');
      egal((await config(api, { e, archived: true })).status, 200, 'archiver deux fois : sans effet');

      egal((await config(api, { e, archived: false })).status, 200);
      vrai((await liste(api)).events.some((x) => x.id === e), 'de retour dans la liste active');
      egal(await etat(api, e, g),
        { total: 5, groupCount: 5, capacity: 100, eventName: 'Archive', groupName: 'Principal' });
      egal(groupe(await histo(api, e), g).opStats, { Alice: { in: 5, out: 0 } });
      egal((await compter(api, e, g, 1)).json.total, 6, 'le comptage reprend');
    });
  });

  cas('Événements', 'suppression : actif ou archivé, 404 partout ensuite, et rejouable sans erreur', async (api) => {
    for (const archiver of [false, true]) {
      const r = await api.post('/api/events', { code: api.ADMIN, name: 'À supprimer' });
      const e = r.json.id, g = r.json.groups[0].id;
      await compter(api, e, g, 5);
      if (archiver) await config(api, { e, archived: true });

      egal((await config(api, { e, deleteEvent: true })).json, { ok: true }, archiver ? 'archivé' : 'actif');
      vrai(!(await liste(api)).events.some((x) => x.id === e), 'absent de la liste');
      const arch = (await api.get(`/api/events/archived?${q({ code: api.ADMIN })}`)).json;
      vrai(!arch.events.some((x) => x.id === e), 'absent des archivés');
      egal((await api.get(`/api/state?${q({ e, g })}`)).status, 404);
      egal((await compter(api, e, g, 1)).status, 404);
      egal((await api.get(`/api/history?${q({ code: api.ADMIN, e })}`)).status, 404);
      egal((await config(api, { e, deleteEvent: true })).status, 200, 'supprimer deux fois');
    }
  });

  // ════ Historique ══════════════════════════════════════════════════════════

  cas('Historique', 'un tir d\'horloge enregistre présents, cumuls et détail par groupe', async (api) => {
    await avecEvenement(api, 'Horloge', async ({ e, g: g1 }) => {
      const g2 = await creerGroupe(api, e, 'B');
      await compter(api, e, g1, 5);
      await compter(api, e, g1, 1);
      await compter(api, e, g2, 5);
      await compter(api, e, g2, -1);
      const t0 = Date.now();
      await api.echantillonner(e);

      const h = await histo(api, e);
      for (const k of ['history', 'historyCoarse', 'total', 'capacity', 'peak', 'totalIn', 'totalOut', 'groups']) {
        vrai(k in h, `champ ${k} absent de /api/history`);
      }
      const fin = h.history.at(-1), gros = h.historyCoarse.at(-1);
      egal(cles(fin), ['c', 'g', 'i', 'o', 't']);
      egal([fin.c, fin.i, fin.o, fin.g], [10, 11, 1, { [g1]: 6, [g2]: 4 }]);
      vrai(Math.abs(fin.t - t0) < 5000, 'horodatage = maintenant');
      egal(cles(gros), ['c', 'i', 'o', 't'], 'la série long terme ne porte PAS le détail par groupe');
      egal([gros.c, gros.i, gros.o], [10, 11, 1]);
      egal(cles(h.groups[0]), ['count', 'id', 'name', 'opStats', 'totalIn', 'totalOut']);
      egal([h.total, h.capacity, h.peak, h.totalIn, h.totalOut], [10, 100, 10, 11, 1]);
    });
  });

  cas('Historique', 'since / series : fenêtrage, valeurs farfelues tolérées, pic jamais fenêtré', async (api) => {
    await avecEvenement(api, 'Fenêtre', async ({ e, g }) => {
      await compter(api, e, g, 5);
      await api.echantillonner(e);
      await compter(api, e, g, -5);
      await api.echantillonner(e);

      const tout = await histo(api, e);
      vrai(tout.history.length >= 2 && tout.historyCoarse.length >= 1, 'les deux séries sont alimentées');
      egal(tout.peak, 5, 'le pic survit à la redescente');

      const fine = await histo(api, e, { series: 'fine' });
      egal([fine.history.length, fine.historyCoarse.length], [tout.history.length, 0]);
      const coarse = await histo(api, e, { series: 'coarse' });
      egal([coarse.history.length, coarse.historyCoarse.length], [0, tout.historyCoarse.length]);
      egal(coarse.peak, 5);

      const futur = await histo(api, e, { since: String(Date.now() + 60_000) });
      egal([futur.history, futur.historyCoarse, futur.peak, futur.total], [[], [], 5, 0], 'aucun point, mais le reste est complet');
      const dernier = tout.history.at(-1).t;
      const borne = await histo(api, e, { since: String(dernier) });
      vrai(borne.history.length >= 1 && borne.history.every((h) => h.t >= dernier), 'since est inclusif');
      egal((await histo(api, e, { since: String(dernier + 1) })).history, [], 'un point plus ancien que since est écarté');

      for (const farfelu of ['abc', '-5', '0', '', 'NaN', 'Infinity', '1e999', ' ']) {
        const r = await api.get(`/api/history?${q({ code: api.ADMIN, e, since: farfelu })}`);
        egal(r.status, 200, `since=${JSON.stringify(farfelu)}`);
        egal(r.json.history.length, tout.history.length, `since=${JSON.stringify(farfelu)} → tout l'historique`);
      }
      const serieInconnue = await histo(api, e, { series: 'nimporte' });
      egal([serieInconnue.history.length, serieInconnue.historyCoarse.length], [tout.history.length, tout.historyCoarse.length]);
    });
    egal((await api.get(`/api/history?${q({ code: api.ADMIN, e: INCONNU })}`)).status, 404, 'événement inconnu');
  });

  // Archiver en fin d'événement FIGE la série fine : sans ça le tampon de 36 h continue de
  // glisser et mange le début de la soirée tant que l'export n'est pas fait.
  cas('Historique', 'un événement archivé n\'est plus échantillonné ; désarchivé, il l\'est de nouveau', async (api) => {
    await avecEvenement(api, 'Figé', async ({ e, g }) => {
      await compter(api, e, g, 5);
      await api.echantillonner(e);
      const avant = (await histo(api, e)).history.length;

      await config(api, { e, archived: true });
      await api.echantillonner(e);
      await api.echantillonner(e);
      await config(api, { e, archived: false });
      egal((await histo(api, e)).history.length, avant, 'aucun point ajouté pendant l\'archivage');

      await api.echantillonner(e);
      egal((await histo(api, e)).history.length, avant + 1, 'l\'échantillonnage a repris');
    });
  });

  // ════ QR et opérateurs connectés ══════════════════════════════════════════

  cas('QR', '/api/qr : une image et le lien du groupe', async (api) => {
    await avecEvenement(api, 'QR', async ({ e, g }) => {
      const r = await api.get(`/api/qr?${q({ code: api.ADMIN, e, g })}`);
      egal(r.status, 200);
      vrai(/^data:image\/(png|svg\+xml);base64,/.test(r.json.qr), 'image en data URL');
      vrai(/^https?:\/\/[^/]+\/\?/.test(r.json.url), `lien absolu : ${r.json.url}`);
      const lien = new URL(r.json.url).searchParams;
      egal([lien.get('e'), lien.get('g')], [e, g]);
      egal((await api.get(`/api/qr?${q({ code: api.ADMIN, e })}`)).status, 400, 'sans g');
      egal((await api.get(`/api/qr?${q({ code: api.ADMIN, g })}`)).status, 400, 'sans e');
    });
  });

  cas('QR', '/api/qr pour un événement ou un groupe qui n\'existe pas → 404', async (api) => {
    await avecEvenement(api, 'QR', async ({ e, g }) => {
      egal((await api.get(`/api/qr?${q({ code: api.ADMIN, e, g: 'aaaaaa' })}`)).status, 404, 'groupe inconnu');
      egal((await api.get(`/api/qr?${q({ code: api.ADMIN, e: INCONNU, g })}`)).status, 404, 'événement inconnu');
    });
  });

  cas('Opérateurs', '/api/clients : liste vide sans opérateur nommé, 404 pour un événement inconnu', async (api) => {
    await avecEvenement(api, 'Clients', async ({ e }) => {
      const r = await api.get(`/api/clients?${q({ code: api.ADMIN, e })}`);
      egal(r.status, 200);
      egal(r.json, { clients: [] });
    });
    egal((await api.get(`/api/clients?${q({ code: api.ADMIN, e: INCONNU })}`)).status, 404);
  });

  // ════ WebSocket ═══════════════════════════════════════════════════════════

  cas('WebSocket', 'init : total, capacité, nom de l\'événement et groupes — pour l\'opérateur comme pour l\'admin', async (api) => {
    await avecEvenement(api, 'Init', async ({ e, g }) => {
      await compter(api, e, g, 5);
      for (const cible of [g, undefined]) {
        const s = await api.ws(e, cible);
        egal(await s.attendre('init'),
          { type: 'init', total: 5, capacity: 100, eventName: 'Init', groups: [{ id: g, name: 'Principal', count: 5 }] },
          cible ? 'opérateur' : 'admin (sans groupe)');
        egal(await s.silence('clients', 150), true, 'pas de liste d\'opérateurs tant que personne ne s\'est nommé');
      }
    });
  });

  // Le WS n'est PAS authentifié (S5) : `update` ne doit rien transporter de plus que le
  // total et le compteur des groupes. Les chiffres par opérateur restent derrière le code.
  cas('WebSocket', 'update : reçu par tout l\'événement et lui seul, clés figées, rien sur les opérateurs', async (api) => {
    await avecEvenement(api, 'Diffusion', async ({ e, g }) => {
      await avecEvenement(api, 'Voisin', async ({ e: autre, g: gAutre }) => {
        const op = await api.ws(e, g), admin = await api.ws(e), voisin = await api.ws(autre, gAutre);
        for (const s of [op, admin, voisin]) await s.attendre('init');

        const uuid = uid();
        await api.post('/api/count', { e, g, delta: 5, uuid, name: 'Alice' });
        for (const s of [op, admin]) {
          const m = await s.attendre('update');
          egal(m, { type: 'update', total: 5, delta: 5, alert: false, capacity: 100, groups: [{ id: g, name: 'Principal', count: 5 }] });
          vrai(!JSON.stringify(m).includes('Alice'), 'le prénom de l\'opératrice ne doit pas circuler sur ce canal');
        }
        egal(await voisin.silence('update'), true, 'un autre événement ne reçoit rien');

        await api.post('/api/count', { e, g, delta: 5, uuid }); // doublon
        egal(await op.silence('update'), true, 'un doublon ne rediffuse rien');

        await compter(api, e, g, -5);
        await compter(api, e, g, -5); // sans effet (total déjà à 0) : diffusé quand même, delta demandé
        egal((await op.attendre('update')).total, 0);
        egal([(await op.attendre('update')).total], [0]);
      });
    });
  });

  cas('WebSocket', 'les réglages admin sont diffusés : capacité, nouveau groupe, renommage, remise à zéro', async (api) => {
    await avecEvenement(api, 'Réglages', async ({ e, g }) => {
      const s = await api.ws(e, g);
      await s.attendre('init');

      await config(api, { e, capacity: 2 });
      let m = await s.attendre('update');
      egal([m.capacity, m.delta, m.total], [2, 0, 0]);

      await compter(api, e, g, 5);
      egal((await s.attendre('update')).alert, true, 'alerte diffusée à tous les opérateurs');

      const g2 = await creerGroupe(api, e, 'Nouvelle porte');
      m = await s.attendre('update');
      egal(ids(m.groups), [g, g2].sort(), 'le nouveau groupe arrive sans recharger');

      await config(api, { e, g: g2, name: 'Porte B' });
      egal((await s.attendre('update')).groups.find((x) => x.id === g2).name, 'Porte B');

      await api.post('/api/reset-counts', { code: api.ADMIN, e });
      m = await s.attendre('update');
      egal([m.total, m.alert], [0, false], 'remise à zéro des compteurs');
    });
  });

  cas('WebSocket', 'ping → pong', async (api) => {
    await avecEvenement(api, 'Ping', async ({ e, g }) => {
      const s = await api.ws(e, g);
      await s.attendre('init');
      s.envoyer({ type: 'ping' });
      egal(await s.attendre('pong'), { type: 'pong' });
    });
  });

  cas('WebSocket', 'messages illisibles ou inattendus : ignorés, la connexion reste utilisable', async (api) => {
    await avecEvenement(api, 'Bruit', async ({ e, g }) => {
      const s = await api.ws(e, g);
      await s.attendre('init');
      for (const bruit of ['pas du json', 'null', '[]', '42', '""', '{"type":"hello"}', '{"type":"hello","name":123}',
        '{"type":"hello","name":{"a":1}}', '{"type":"inconnu"}', '{"type":"update","total":999}', new Uint8Array([0, 1, 2, 255])]) {
        s.envoyer(bruit);
      }
      s.envoyer({ type: 'ping' });
      egal(await s.attendre('pong'), { type: 'pong' }, 'le serveur répond encore');
      egal(await s.silence('clients', 150), true, 'aucun de ces messages ne doit nommer un opérateur');
      egal(await s.silence('update', 50), true, 'un client ne peut pas injecter de mise à jour');
      egal((await etat(api, e, g)).total, 0);
    });
  });

  cas('WebSocket', 'hello : prénom diffusé avec le groupe, nettoyé, tronqué à 32 caractères', async (api) => {
    await avecEvenement(api, 'Hello', async ({ e, g }) => {
      const op = await api.ws(e, g), admin = await api.ws(e);
      for (const s of [op, admin]) await s.attendre('init');

      op.envoyer({ type: 'hello', name: '   ' });
      egal(await admin.silence('clients', 200), true, 'un prénom vide ne crée pas d\'opérateur');

      op.envoyer({ type: 'hello', name: '  Alice  ' });
      for (const s of [op, admin]) {
        egal(await s.attendre('clients'), { type: 'clients', clients: [{ name: 'Alice', groupName: 'Principal' }] });
      }
      admin.envoyer({ type: 'hello', name: 'N'.repeat(100) });
      const m = await op.attendre('clients');
      egal(parNom(m.clients), [{ name: 'Alice', groupName: 'Principal' }, { name: 'N'.repeat(32), groupName: null }],
        'une connexion sans groupe (admin) a groupName null');

      const r = await api.get(`/api/clients?${q({ code: api.ADMIN, e })}`);
      egal(parNom(r.json.clients).map((c) => c.name), ['Alice', 'N'.repeat(32)]);
      vrai(r.json.clients.every((c) => c.connectedAt > 0), 'connectedAt renseigné pour un opérateur connecté');

      // Un nouvel arrivant reçoit la liste des opérateurs déjà présents.
      const tard = await api.ws(e, g);
      await tard.attendre('init');
      egal(parNom((await tard.attendre('clients')).clients).map((c) => c.name), ['Alice', 'N'.repeat(32)]);
    });
  });

  // N8 : sans borne, un client qui envoie des `hello` en boucle fait rediffuser la liste
  // à tout l'événement à chaque message.
  cas('WebSocket', 'hello borné : un par seconde et par connexion, rediffusé seulement si le prénom change', async (api) => {
    await avecEvenement(api, 'Hello borné', async ({ e, g }) => {
      const op = await api.ws(e, g), temoin = await api.ws(e);
      for (const s of [op, temoin]) await s.attendre('init');

      // Les deux messages partent d'un trait : le serveur les traite à la suite, quelle que
      // soit la charge de la machine (le second arrive forcément dans la même seconde).
      op.envoyer({ type: 'hello', name: 'Alice' });
      op.envoyer({ type: 'hello', name: 'Bob' });
      egal((await temoin.attendre('clients')).clients, [{ name: 'Alice', groupName: 'Principal' }]);
      egal(await temoin.silence('clients', 250), true, 'deuxième hello dans la même seconde : ignoré');
      egal((await api.get(`/api/clients?${q({ code: api.ADMIN, e })}`)).json.clients.map((c) => c.name), ['Alice']);

      await pause(1100);
      op.envoyer({ type: 'hello', name: 'Alice' }); // même prénom : rien à rediffuser
      egal(await temoin.silence('clients', 250), true, 'même prénom');

      await pause(1100);
      op.envoyer({ type: 'hello', name: 'Bob' });
      egal((await temoin.attendre('clients')).clients, [{ name: 'Bob', groupName: 'Principal' }], 'renommage diffusé');
    });
  });

  cas('WebSocket', 'grâce de 30 s : un opérateur qui vient de se déconnecter reste listé', async (api) => {
    await avecEvenement(api, 'Grâce', async ({ e, g }) => {
      const partant = await api.ws(e, g), temoin = await api.ws(e);
      for (const s of [partant, temoin]) await s.attendre('init');
      partant.envoyer({ type: 'hello', name: 'Partant' });
      await temoin.attendre('clients');

      partant.fermer();
      egal((await temoin.attendre('clients')).clients, [{ name: 'Partant', groupName: 'Principal' }],
        'la liste rediffusée à la déconnexion le contient encore');
      const r = await api.get(`/api/clients?${q({ code: api.ADMIN, e })}`);
      egal(r.json.clients.map((c) => [c.name, c.groupName]), [['Partant', 'Principal']],
        '/api/clients le liste encore pendant la période de grâce');
    });
  });

  // Sans le code 4004, le client ne voit qu'une coupure réseau : il affiche « Hors ligne »,
  // se reconnecte en boucle et ne propose jamais « Saisir le lien manuellement ».
  cas('WebSocket', 'lien mort (événement inconnu, groupe inconnu, événement archivé) → fermeture 4004', async (api) => {
    const inconnu = await api.ws(INCONNU, 'aaaaaa');
    egal(await delai(inconnu.ferme, 5000, 'fermeture'), 4004, 'événement inconnu');
    await avecEvenement(api, 'Lien mort', async ({ e, g }) => {
      egal(await delai((await api.ws(e, 'aaaaaa')).ferme, 5000, 'fermeture'), 4004, 'groupe inconnu');
      await config(api, { e, archived: true });
      egal(await delai((await api.ws(e, g)).ferme, 5000, 'fermeture'), 4004, 'événement archivé');
      egal(await delai((await api.ws(e)).ferme, 5000, 'fermeture'), 4004, 'événement archivé, connexion admin');
    });
  });

  cas('WebSocket', 'archivage → 4004 pour tous ; suppression d\'un groupe → 4004 pour ce groupe seulement', async (api) => {
    await avecEvenement(api, 'Coupures', async ({ e, g }) => {
      const g2 = await creerGroupe(api, e, 'À supprimer');
      const reste = await api.ws(e, g), victime = await api.ws(e, g2), admin = await api.ws(e);
      for (const s of [reste, victime, admin]) await s.attendre('init');

      await config(api, { e, g: g2, deleteGroup: true });
      egal(await delai(victime.ferme, 5000, 'fermeture'), 4004, 'opérateur du groupe supprimé');
      egal(ids((await reste.attendre('update')).groups), [g], 'les autres apprennent la suppression');
      await compter(api, e, g, 1);
      egal((await reste.attendre('update')).total, 1, 'l\'opérateur d\'un autre groupe compte toujours');
      egal((await admin.attendre('update')).groups.length, 1);

      await config(api, { e, archived: true });
      egal(await delai(reste.ferme, 5000, 'fermeture'), 4004, 'opérateur, à l\'archivage');
      egal(await delai(admin.ferme, 5000, 'fermeture'), 4004, 'admin, à l\'archivage');
    });
  });

  cas('WebSocket', 'suppression de l\'événement → 4004 pour tous, les autres événements ne sont pas touchés', async (api) => {
    await avecEvenement(api, 'Voisin', async ({ e: autre, g: gAutre }) => {
      const voisin = await api.ws(autre, gAutre);
      await voisin.attendre('init');

      const r = await api.post('/api/events', { code: api.ADMIN, name: 'Éphémère' });
      const s = await api.ws(r.json.id, r.json.groups[0].id);
      await s.attendre('init');
      await config(api, { e: r.json.id, deleteEvent: true });
      egal(await delai(s.ferme, 5000, 'fermeture'), 4004);

      voisin.envoyer({ type: 'ping' });
      egal(await voisin.attendre('pong'), { type: 'pong' }, 'la connexion du voisin est intacte');
    });
  });

  return C;
}
