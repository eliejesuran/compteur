import { env, runInDurableObject, listDurableObjectIds, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker, { wrlCheck, badId } from '../../src/index.js';

// Robustesse du WORKER — ce qui est propre à Cloudflare et que le contrat partagé
// (contract.test.js) ne voit pas : hibernation des Durable Objects, alarme, stockage,
// garde d'entrée, registre. Tout passe par l'export du Worker (cf. contract.test.js :
// SELF.fetch ralentit avec le nombre d'appels).
//
// Un défaut connu et pas encore corrigé se note `it.fails` : le test doit échouer tant que
// le défaut est là, et vitest le signale le jour où il passe.

const ADMIN = 'admin123';
const BASE  = 'http://do';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let n = 0;
let ip = '198.51.100.1';
const ouverts = new Set();
beforeEach(() => { n += 1; ip = `198.51.${100 + (n >> 8)}.${n & 255}`; });
afterEach(() => { for (const s of ouverts) { try { s.close(); } catch {} } ouverts.clear(); });

async function appeler(chemin, { method = 'GET', corps, headers = {} } = {}) {
  const init = { method, headers: { 'cf-connecting-ip': ip, ...headers } };
  if (corps !== undefined) { init.body = JSON.stringify(corps); init.headers['Content-Type'] = 'application/json'; }
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(BASE + chemin, init), env, ctx);
  if (r.status === 101) return { status: 101, ws: r.webSocket };
  const text = await r.text();
  await waitOnExecutionContext(ctx);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, header: (nom) => r.headers.get(nom) };
}
const get  = (chemin, headers) => appeler(chemin, { headers });
const post = (chemin, corps) => appeler(chemin, { method: 'POST', corps });

const stub = (e) => env.EVENT.get(env.EVENT.idFromName(e));
const registre = () => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
const compter = (e, g, delta, uuid, name) => post('/api/count', { e, g, delta, uuid, name });
const histo = async (e) => (await get(`/api/history?code=${ADMIN}&e=${e}`)).json;

// Crée un événement, joue `fn`, le supprime quoi qu'il arrive (registre plafonné à 50).
async function avecEvenement(nom, fn) {
  const r = await post('/api/events', { code: ADMIN, name: nom });
  expect(r.status).toBe(200);
  const e = r.json.id, g = r.json.groups[0].id;
  try { return await fn({ e, g }); }
  finally { await post('/api/admin/config', { code: ADMIN, e, deleteEvent: true }); }
}

// Un WebSocket côté test : messages rangés par type, fermeture observable.
async function ouvrir(e, g) {
  const r = await appeler(`/?${new URLSearchParams(g ? { e, g } : { e })}`, { headers: { Upgrade: 'websocket' } });
  if (r.status !== 101) return { refus: r.status };
  const sock = r.ws;
  ouverts.add(sock);
  const recus = [];
  const reveils = new Set();
  sock.addEventListener('message', (ev) => { recus.push(JSON.parse(ev.data)); for (const f of [...reveils]) f(); });
  const ferme = new Promise((resolve) => sock.addEventListener('close', (ev) => resolve(ev.code)));
  sock.accept();
  let lu = 0;
  const attendre = (type, ms = 5000) => new Promise((resolve, reject) => {
    const essai = () => {
      for (let i = lu; i < recus.length; i++) if (recus[i].type === type) { lu = i + 1; fin(); resolve(recus[i]); return; }
    };
    const timer = setTimeout(() => { fin(); reject(new Error(`aucun « ${type} » (reçus : ${recus.map((m) => m.type).join(', ') || 'rien'})`)); }, ms);
    const fin = () => { clearTimeout(timer); reveils.delete(essai); };
    reveils.add(essai);
    essai();
  });
  return { sock, attendre, ferme, envoyer: (o) => sock.send(JSON.stringify(o)) };
}

const borne = (promesse, ms = 5000) => Promise.race([promesse, pause(ms).then(() => { throw new Error(`rien en ${ms} ms`); })]);

// Joue `fn` avec une horloge FIGÉE. Un token bucket se recharge avec le temps (40 jetons/s
// pour celui du Worker, 20 pour celui de l'événement) : entre « je vide le bucket » et « je
// vérifie le 429 », quelques dizaines de millisecondes suffisent à rendre un jeton. Sans
// figer l'horloge, ces tests dépendent de la vitesse de la machine.
async function horlogeFigee(fn) {
  const maintenant = Date.now(), vraieHorloge = Date.now;
  Date.now = () => maintenant;
  try { return await fn(); } finally { Date.now = vraieHorloge; }
}

// Hibernation : Cloudflare décharge le DO de la mémoire entre deux messages et ne garde
// que le stockage + les WebSockets. On la reproduit en vidant ce que le constructeur vide.
const hiberner = (e) => runInDurableObject(stub(e), (inst) => {
  inst._s = null; inst._hist = null; inst._histCoarse = null;
  inst._seen = new Set(); inst._rl = new Map(); inst._recentlyDisc = new Map(); inst._qrCache = null;
});

// ── Hibernation ──────────────────────────────────────────────────────────────

describe('Durable Object — hibernation', () => {
  it('après un déchargement mémoire, rien n\'est perdu : total, opérateurs, historique, doublons', async () => {
    await avecEvenement('Sommeil', async ({ e, g }) => {
      await compter(e, g, 5, 'avant-sommeil', 'Alice');
      await runInDurableObject(stub(e), (inst) => inst.alarm());
      await hiberner(e);

      expect((await get(`/api/state?e=${e}&g=${g}`)).json.total).toBe(5);
      expect((await compter(e, g, 5, 'avant-sommeil', 'Alice')).json).toEqual({ total: 5, dup: true });
      expect((await compter(e, g, 1, 'apres-sommeil', 'Alice')).json).toEqual({ total: 6, alert: false });
      const h = await histo(e);
      expect(h.groups[0].opStats).toEqual({ Alice: { in: 6, out: 0 } });
      expect(h.history.at(-1).c).toBe(5);
      expect(h.historyCoarse.length).toBeGreaterThan(0);
    });
  });

  // Les handlers webSocketMessage/Close/Error sont appelés sur un DO tout juste réveillé :
  // `this._s` vaut null tant que _load() n'a pas tourné.
  it('un message WebSocket reçu au réveil est traité (ping, hello), sans exception', async () => {
    await avecEvenement('Réveil', async ({ e, g }) => {
      const op = await ouvrir(e, g), temoin = await ouvrir(e);
      await op.attendre('init'); await temoin.attendre('init');

      await hiberner(e);
      op.envoyer({ type: 'ping' });
      expect(await op.attendre('pong')).toEqual({ type: 'pong' });

      await hiberner(e);
      op.envoyer({ type: 'hello', name: 'Alice' });
      expect((await temoin.attendre('clients')).clients).toEqual([{ name: 'Alice', groupName: 'Principal' }]);

      await hiberner(e);
      await compter(e, g, 1, 'u-reveil');
      expect((await temoin.attendre('update')).total).toBe(1);
    });
  });

  it('une déconnexion au réveil est diffusée aux autres, sans exception', async () => {
    await avecEvenement('Départ', async ({ e, g }) => {
      const op = await ouvrir(e, g), temoin = await ouvrir(e);
      await op.attendre('init'); await temoin.attendre('init');
      op.envoyer({ type: 'hello', name: 'Partant' });
      await temoin.attendre('clients');

      await hiberner(e);
      op.sock.close();
      expect((await temoin.attendre('clients')).clients.map((c) => c.name)).toEqual(['Partant']);
      expect((await get(`/api/clients?code=${ADMIN}&e=${e}`)).json.clients.map((c) => c.name)).toEqual(['Partant']);
    });
  });

  // N4 : un socket resté ouvert sur un événement dont le stockage a disparu ne doit plus
  // recevoir de pong — sinon son heartbeat est satisfait et il ne se déconnecte jamais.
  it('socket survivant d\'un événement sans stockage : fermé en 4004 au premier message', async () => {
    const r = await post('/api/events', { code: ADMIN, name: 'Fantôme' });
    const e = r.json.id, g = r.json.groups[0].id;
    try {
      const op = await ouvrir(e, g);
      await op.attendre('init');
      await runInDurableObject(stub(e), async (inst, etat) => { await etat.storage.deleteAll(); inst._s = null; });
      op.envoyer({ type: 'ping' });
      expect(await borne(op.ferme)).toBe(4004);
    } finally { await post('/api/admin/config', { code: ADMIN, e, deleteEvent: true }); }
  });
});

// ── Mémoire des uuid ─────────────────────────────────────────────────────────

describe('Durable Object — mémoire des uuid déjà vus', () => {
  it('2 500 uuid au plus sont persistés, les plus récents', async () => {
    await avecEvenement('Uuid', async ({ e, g }) => {
      const persistes = await runInDurableObject(stub(e), async (inst, etat) => {
        for (let i = 0; i < 3000; i++) inst._seen.add(`u-${i}`);
        await inst._save();
        return etat.storage.get('seen');
      });
      expect(persistes).toHaveLength(2500);
      expect(persistes[0]).toBe('u-500');
      expect(persistes.at(-1)).toBe('u-2999');

      await hiberner(e);
      expect((await compter(e, g, 1, 'u-2999')).json.dup).toBe(true);   // récent : reconnu
      expect((await compter(e, g, 1, 'u-10')).json.dup).toBeUndefined(); // trop ancien : oublié (limite assumée)
    });
  });

  it('en mémoire : au-delà de 20 000, on ne garde que les 10 000 derniers', async () => {
    await avecEvenement('Uuid', async ({ e, g }) => {
      await runInDurableObject(stub(e), (inst) => { for (let i = 0; i < 20_000; i++) inst._seen.add(`m-${i}`); });
      expect((await compter(e, g, 1, 'le-20001e')).status).toBe(200);
      const etat = await runInDurableObject(stub(e), (inst) => ({
        taille: inst._seen.size, ancien: inst._seen.has('m-0'), recent: inst._seen.has('m-19999'), dernier: inst._seen.has('le-20001e'),
      }));
      expect(etat).toEqual({ taille: 10_000, ancien: false, recent: true, dernier: true });
    });
  });
});

// ── Alarme (échantillonnage de l'historique) ─────────────────────────────────

describe('Durable Object — alarme', () => {
  it('événement archivé : aucun point, alarme non replanifiée ; désarchivé : elle repart dans 30 s', async () => {
    await avecEvenement('Horloge', async ({ e }) => {
      const s = stub(e);
      await post('/api/admin/config', { code: ADMIN, e, archived: true });
      const fige = await runInDurableObject(s, async (inst, etat) => {
        await etat.storage.deleteAlarm(); // celle posée à la création a « sonné »
        await inst.alarm();
        return { points: inst._hist.length, alarme: await etat.storage.getAlarm() };
      });
      expect(fige).toEqual({ points: 0, alarme: null });

      await post('/api/admin/config', { code: ADMIN, e, archived: false });
      const ecart = await runInDurableObject(s, async (_inst, etat) => (await etat.storage.getAlarm()) - Date.now());
      expect(ecart).toBeGreaterThan(20_000);
      expect(ecart).toBeLessThanOrEqual(30_000);
    });
  });

  it('désarchiver un événement qui n\'était pas archivé ne touche pas à l\'alarme en cours', async () => {
    await avecEvenement('Horloge', async ({ e }) => {
      const s = stub(e);
      const avant = await runInDurableObject(s, (_i, etat) => etat.storage.getAlarm());
      await pause(30);
      await post('/api/admin/config', { code: ADMIN, e, archived: false });
      expect(await runInDurableObject(s, (_i, etat) => etat.storage.getAlarm())).toBe(avant);
    });
  });

  it('alarme d\'un événement supprimé : sans effet, sans exception, pas replanifiée', async () => {
    const r = await post('/api/events', { code: ADMIN, name: 'Supprimé' });
    const e = r.json.id;
    await post('/api/admin/config', { code: ADMIN, e, deleteEvent: true });
    const apres = await runInDurableObject(stub(e), async (inst, etat) => {
      await inst.alarm();
      return { alarme: await etat.storage.getAlarm(), cles: (await etat.storage.list()).size };
    });
    expect(apres).toEqual({ alarme: null, cles: 0 });
  });

  // La série longue ne prend qu'un point toutes les 5 min, alors que l'alarme sonne toutes
  // les 30 s : c'est l'écart au dernier point long terme qui décide.
  it('série long terme : un point seulement quand ~5 min ont passé depuis le dernier', async () => {
    await avecEvenement('Cadence', async ({ e }) => {
      const tailles = await runInDurableObject(stub(e), async (inst) => {
        const t = [];
        const depuis = (ms) => { inst._histCoarse = [{ t: Date.now() - ms, c: 0, i: 0, o: 0 }]; };
        depuis(30_000);  await inst.alarm(); t.push(inst._histCoarse.length); // 30 s : trop tôt
        depuis(240_000); await inst.alarm(); t.push(inst._histCoarse.length); // 4 min : trop tôt
        depuis(296_000); await inst.alarm(); t.push(inst._histCoarse.length); // 4 min 56 : le tir tombe « pile »
        depuis(600_000); await inst.alarm(); t.push(inst._histCoarse.length); // 10 min
        inst._histCoarse = []; await inst.alarm(); t.push(inst._histCoarse.length); // série vide : premier point
        return t;
      });
      expect(tailles).toEqual([1, 1, 2, 2, 1]);
    });
  });

  it('les deux séries glissent à leur plafond (4 320 et 17 280), le point le plus récent en dernier', async () => {
    await avecEvenement('Plafonds', async ({ e, g }) => {
      await compter(e, g, 5, 'plafond');
      const m = await runInDurableObject(stub(e), async (inst) => {
        inst._hist = Array.from({ length: 4320 }, (_, k) => ({ t: k, c: 0, i: 0, o: 0, g: {} }));
        inst._histCoarse = Array.from({ length: 17_280 }, (_, k) => ({ t: k, c: 0, i: 0, o: 0 }));
        await inst.alarm();
        return {
          fin: inst._hist.length, gros: inst._histCoarse.length,
          premierFin: inst._hist[0].t, dernierFin: inst._hist.at(-1).c,
          premierGros: inst._histCoarse[0].t, dernierGros: inst._histCoarse.at(-1).c,
        };
      });
      expect(m).toEqual({ fin: 4320, gros: 17_280, premierFin: 1, dernierFin: 5, premierGros: 1, dernierGros: 5 });
    });
  }, 30_000);
});

// ── Total négatif hérité ─────────────────────────────────────────────────────

// Un événement enregistré AVANT le correctif peut porter un total négatif (groupe d'entrée
// supprimé alors qu'un groupe de sortie était négatif). La formule de bornage suppose un
// total ≥ 0 : sans précaution, le premier clic « −1 » ajoutait |total| personnes, en entrées.
describe('Durable Object — total négatif hérité d\'un ancien état', () => {
  it('le premier comptage ramène le total à 0, sans inventer d\'entrées', async () => {
    await avecEvenement('Hérité', async ({ e, g }) => {
      await runInDurableObject(stub(e), (inst) => { inst._s.groups[g].count = -3; inst._s.groups[g].totalOut = 3; });

      expect((await compter(e, g, -1, 'moins', 'Zoé')).json).toEqual({ total: 0, alert: false });
      let grp = (await histo(e)).groups[0];
      expect([grp.count, grp.totalIn, grp.totalOut, grp.opStats]).toEqual([0, 0, 3, {}]);

      expect((await compter(e, g, 1, 'plus', 'Zoé')).json).toEqual({ total: 1, alert: false });
      grp = (await histo(e)).groups[0];
      expect([grp.count, grp.totalIn]).toEqual([1, 1]);
    });
  });
});

// « __proto__ » ne peut pas être une clé ordinaire : `opStats['__proto__'] = {…}` ne crée
// pas une entrée, il REMPLACE LE PROTOTYPE de la table. Rien ne fuit vers Object.prototype,
// mais la table des opérateurs n'est plus un objet ordinaire.
describe('Durable Object — prénom « __proto__ »', () => {
  it('compté, pas suivi, et le prototype de la table des opérateurs n\'est pas remplacé', async () => {
    await avecEvenement('Proto', async ({ e, g }) => {
      expect((await compter(e, g, 1, 'proto-1', '__proto__')).json).toEqual({ total: 1, alert: false });
      const vu = await runInDurableObject(stub(e), (inst) => {
        const { opStats, totalIn } = inst._s.groups[g];
        return { prototypeIntact: Object.getPrototypeOf(opStats) === Object.prototype, cles: Object.keys(opStats), totalIn };
      });
      expect(vu).toEqual({ prototypeIntact: true, cles: [], totalIn: 1 });
    });
  });
});

// ── Suppression ──────────────────────────────────────────────────────────────

describe('Suppression d\'un événement', () => {
  it('ne laisse rien derrière elle : stockage vide, alarme annulée, mémoire remise à zéro', async () => {
    const r = await post('/api/events', { code: ADMIN, name: 'À purger' });
    const e = r.json.id, g = r.json.groups[0].id;
    await compter(e, g, 5, 'u1', 'Alice');
    await runInDurableObject(stub(e), (inst) => inst.alarm());
    await post('/api/admin/config', { code: ADMIN, e, archived: true }); // le flux normal supprime un archivé

    expect((await post('/api/admin/config', { code: ADMIN, e, deleteEvent: true })).json).toEqual({ ok: true });
    const reste = await runInDurableObject(stub(e), async (inst, etat) => ({
      cles: (await etat.storage.list()).size, alarme: await etat.storage.getAlarm(),
      etat: inst._s, vus: inst._seen.size, fin: inst._hist.length, gros: inst._histCoarse.length,
    }));
    expect(reste).toEqual({ cles: 0, alarme: null, etat: null, vus: 0, fin: 0, gros: 0 });

    const reg = await runInDurableObject(registre(), (inst) => Object.keys(inst._events));
    expect(reg).not.toContain(e);
    expect((await compter(e, g, 1, 'u1')).status).toBe(404); // et pas « dup » : plus aucune mémoire
  });
});

// ── Garde d'entrée du Worker ─────────────────────────────────────────────────

describe('Garde d\'entrée du Worker', () => {
  it('badId : seuls 4 à 32 caractères hexadécimaux minuscules passent', () => {
    for (const ok of ['abcd', 'abc123', '0123456789abcdef', 'f'.repeat(32)]) expect(badId(ok)).toBe(false);
    for (const ko of ['', 'abc', 'f'.repeat(33), 'ABC123', 'abc12g', 'abc 123', '../etc', '__proto__', 'abc123\n', null, undefined, 123, ['abc123'], {}]) {
      expect(badId(ko)).toBe(true);
    }
    expect(badId('abc123', 'def456')).toBe(false);
    expect(badId('abc123', 'DEF456')).toBe(true); // un seul mauvais suffit
  });

  // Un DO réveillé est facturé, même pour répondre 404. Le statut ne dit pas QUI a répondu
  // (le Worker et le DO renvoient tous deux 404) : on regarde donc quels DO existent.
  it('identifiant mal formé : refusé par le Worker, AUCUN Durable Object n\'est réveillé (WS, state, count)', async () => {
    const reveilles = async () => (await listDurableObjectIds(env.EVENT)).map((id) => id.toString());
    const idDe = (nom) => env.EVENT.idFromName(nom).toString();
    const MALFORMES = ['__proto__', 'ZZZZZZ', 'abc', '../etc', 'a'.repeat(64)];

    for (const e of MALFORMES) {
      expect((await ouvrir(e, 'abc123')).refus).toBe(404);
      expect((await get(`/api/state?e=${encodeURIComponent(e)}&g=abc123`)).status).toBe(404);
      expect((await post('/api/count', { e, g: 'abc123', delta: 1, uuid: 'x' })).status).toBe(404);
    }
    const apres = await reveilles();
    for (const e of MALFORMES) expect(apres, `un DO a été réveillé pour « ${e} »`).not.toContain(idDe(e));

    // Contre-épreuve : un identifiant bien formé mais inconnu, lui, atteint son DO.
    expect((await get('/api/state?e=ab12cd&g=abc123')).status).toBe(404);
    expect(await reveilles()).toContain(idDe('ab12cd'));

    const sansE = await appeler('/', { headers: { Upgrade: 'websocket' } });
    expect(sansE.status).toBe(400);
  });

  it('bucket du Worker vide → 429 + Retry-After sur /api/state et sur l\'ouverture d\'un WebSocket', async () => {
    await avecEvenement('Bridé', async ({ e, g }) => {
      await horlogeFigee(async () => {
        for (let i = 0; i < 800; i++) wrlCheck(ip); // bucket vidé pour l'IP de ce test
        const etat = await get(`/api/state?e=${e}&g=${g}`);
        expect(etat.status).toBe(429);
        expect(etat.header('Retry-After')).toBe('1');
        const ws = await appeler(`/?e=${e}&g=${g}`, { headers: { Upgrade: 'websocket' } });
        expect(ws.status).toBe(429);
        expect(ws.header('Retry-After')).toBe('1');
      });
      n += 1; ip = `198.51.99.${n & 255}`; // IP neuve pour la suppression de l'événement
    });
  });

  it('bucket de l\'événement vide → 429 sans rien compter, puis l\'op rejouée compte une seule fois', async () => {
    await avecEvenement('Bridé', async ({ e, g }) => {
      await compter(e, g, 1, 'amorce');
      await horlogeFigee(async () => {
        await runInDurableObject(stub(e), (inst) => { for (const b of inst._rl.values()) b.tokens = 0; });
        const refus = await compter(e, g, 1, 'limite');
        expect(refus.status).toBe(429);
        expect(refus.header('Retry-After')).toBe('1');
        expect((await get(`/api/state?e=${e}&g=${g}`)).json.total).toBe(1);

        await runInDurableObject(stub(e), (inst) => { for (const b of inst._rl.values()) b.tokens = 5; });
        expect((await compter(e, g, 1, 'limite')).json).toEqual({ total: 2, alert: false });
        expect((await compter(e, g, 1, 'limite')).json).toEqual({ total: 2, dup: true });
      });
    });
  });

  // Le garde du Worker ne valide que `e` à l'ouverture d'un WebSocket ; c'est le DO qui
  // refuse le groupe. `groups['__proto__']` y trouvait Object.prototype : la connexion
  // était acceptée sur un groupe qui n'existe pas.
  it('WebSocket avec g=__proto__, constructor… → fermé en 4004 comme n\'importe quel groupe inconnu', async () => {
    await avecEvenement('Groupe piégé', async ({ e }) => {
      for (const g of ['__proto__', 'constructor', 'toString', 'aaaaaa']) {
        const s = await ouvrir(e, g);
        expect(s.refus, `g=${g}`).toBeUndefined();
        expect(await Promise.race([s.ferme, pause(2000).then(() => 'resté ouvert')]), `g=${g}`).toBe(4004);
      }
    });
  });

  // Lien mort : le DO ACCEPTE la connexion pour la fermer en 4004 (cf. _refuseWS). Ce socket
  // de courtoisie ne doit ni compter parmi les opérateurs ni recevoir les diffusions.
  it('lien mort : le socket fermé en 4004 n\'est pas compté parmi les connexions de l\'événement', async () => {
    await avecEvenement('Lien mort', async ({ e, g }) => {
      const temoin = await ouvrir(e, g);
      await temoin.attendre('init');
      for (let i = 0; i < 5; i++) expect(await borne((await ouvrir(e, 'aaaaaa')).ferme)).toBe(4004);
      expect(await runInDurableObject(stub(e), (inst) => inst.ctx.getWebSockets().length)).toBe(1);
      await compter(e, g, 1, 'apres-refus');
      expect((await temoin.attendre('update')).total).toBe(1);
    });
  });
});

// ── Registre ─────────────────────────────────────────────────────────────────

describe('Registre', () => {
  it('le code admin et le code PERM survivent à un déchargement mémoire du registre', async () => {
    try {
      await post('/api/admin/config', { code: ADMIN, newCode: 'code-durable', newPermCode: 'perm-durable' });
      await runInDurableObject(registre(), (inst) => { inst._loaded = false; inst._code = null; inst._permCode = null; inst._events = null; });
      expect((await get(`/api/events?code=${ADMIN}`)).status).toBe(403);
      expect((await get('/api/events?code=code-durable')).json.role).toBe('admin');
      expect((await get('/api/events?code=perm-durable')).json.role).toBe('perm');
    } finally {
      await post('/api/admin/config', { code: 'code-durable', newCode: ADMIN, newPermCode: null });
    }
  });

  it('mise à jour ou suppression d\'un identifiant inconnu : sans effet, sans erreur', async () => {
    const appel = (chemin, corps) => runInDurableObject(registre(), async (inst) => {
      const r = await inst.fetch(new Request(`http://do${chemin}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }));
      return { status: r.status, events: Object.keys(inst._events).length };
    });
    const avant = (await appel('/events/update', { id: 'aucun0', name: 'x' })).events;
    expect((await appel('/events/update', { id: 'aucun0', name: 'Fantôme', archived: true })).events).toBe(avant);
    expect((await appel('/events/delete', { id: 'aucun0' })).events).toBe(avant);
    expect((await appel('/events/delete', {})).events).toBe(avant);
    expect((await appel('/route/inconnue', {})).status).toBe(404);
  });

  // Entrée de registre dont le DO n'a pas d'état (registre et DO désynchronisés). /summary
  // répond 404 en JSON : sans `if (!r.ok) throw`, le `catch` prévu pour ce cas n'était pas
  // atteint et l'événement partait sans `groups` — la page admin plantait dessus
  // (`groups.map`), et s'il était seul dans la liste elle ne s'affichait plus.
  it('un événement du registre dont le DO ne répond pas est listé avec total 0 et groups []', async () => {
    const id = 'dead00';
    try {
      await runInDurableObject(registre(), (inst) => inst.fetch(new Request('http://do/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: 'À moitié créé' }),
      })));
      const evt = (await get(`/api/events?code=${ADMIN}`)).json.events.find((x) => x.id === id);
      expect(evt.name).toBe('À moitié créé');
      expect(evt.total).toBe(0);
      expect(evt.groups).toEqual([]);
    } finally {
      await post('/api/admin/config', { code: ADMIN, e: id, deleteEvent: true });
    }
  });

  // La cause : le registre enregistre l'événement, PUIS le DO est initialisé. Si ce second
  // appel échoue (DO redémarré par un déploiement, coupure entre objets), l'entrée restait.
  it('création : si le Durable Object ne s\'initialise pas, l\'entrée du registre est retirée (502)', async () => {
    const enPanne = { idFromName: (nom) => nom, get: () => ({ fetch: async () => { throw new Error('DO indisponible'); } }) };
    const avant = await runInDurableObject(registre(), (inst) => Object.keys(inst._events).length);

    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`${BASE}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ADMIN, name: 'Jamais né' }),
    }), { ...env, EVENT: enPanne }, ctx);
    await waitOnExecutionContext(ctx);

    expect(r.status).toBe(502);
    expect(typeof (await r.json()).error).toBe('string');
    const apres = await runInDurableObject(registre(), (inst) => Object.values(inst._events));
    expect(apres.length).toBe(avant);
    expect(apres.some((x) => x.name === 'Jamais né')).toBe(false);
  });

  it('un événement à moitié créé reste supprimable par l\'API', async () => {
    const id = 'dead01';
    await runInDurableObject(registre(), (inst) => inst.fetch(new Request('http://do/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: 'À moitié créé' }),
    })));
    expect((await post('/api/admin/config', { code: ADMIN, e: id, deleteEvent: true })).json).toEqual({ ok: true });
    expect((await get(`/api/events?code=${ADMIN}`)).json.events.some((x) => x.id === id)).toBe(false);
  });
});

// ── QR ───────────────────────────────────────────────────────────────────────

describe('QR code (cache T1)', () => {
  it('SVG en data URL, lien bâti sur l\'hôte de la requête, cache réutilisé puis invalidé si l\'hôte change', async () => {
    await avecEvenement('QR', async ({ e, g }) => {
      const demander = (host) => get(`/api/qr?code=${ADMIN}&e=${e}&g=${g}`, { host });
      const a = await demander('compteur.example');
      expect(a.status).toBe(200);
      expect(a.json.url).toBe(`https://compteur.example/?e=${e}&g=${g}`);
      expect(a.json.qr.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(atob(a.json.qr.split(',')[1])).toContain('<svg');

      const cache1 = await runInDurableObject(stub(e), (inst) => inst._qrCache);
      expect(cache1.url).toBe(a.json.url);
      const b = await demander('compteur.example');
      expect(b.json.qr).toBe(a.json.qr);
      expect(await runInDurableObject(stub(e), (inst) => inst._qrCache === cache1 || inst._qrCache.qr === cache1.qr)).toBe(true);

      const c = await demander('autre.example');
      expect(c.json.url).toBe(`https://autre.example/?e=${e}&g=${g}`);
      expect(c.json.qr).not.toBe(a.json.qr);
      expect((await runInDurableObject(stub(e), (inst) => inst._qrCache.url))).toBe(c.json.url);
    });
  });
});

// ── Divers ───────────────────────────────────────────────────────────────────

describe('Divers', () => {
  it('/api/ips (compatibilité avec le serveur local) : liste vide, port 443', async () => {
    expect((await get(`/api/ips?code=${ADMIN}`)).json).toEqual({ ips: [], port: 443 });
  });

  it('route d\'API inconnue → 404 en JSON, méthode inattendue → pas d\'exception', async () => {
    expect((await get(`/api/nexiste/pas?code=${ADMIN}`)).status).toBe(404);
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const r = await appeler('/api/count', { method, corps: { e: 'abc123', g: 'def456', delta: 1, uuid: 'x' } });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });

  it('deux événements ne partagent rien : compteurs, doublons, opérateurs', async () => {
    await avecEvenement('A', async ({ e: a, g: ga }) => {
      await avecEvenement('B', async ({ e: b, g: gb }) => {
        await compter(a, ga, 5, 'commun', 'Alice');
        await compter(b, gb, 1, 'commun', 'Bob');
        const ha = await histo(a), hb = await histo(b);
        expect([ha.total, hb.total]).toEqual([5, 1]);
        expect(ha.groups[0].opStats).toEqual({ Alice: { in: 5, out: 0 } });
        expect(hb.groups[0].opStats).toEqual({ Bob: { in: 1, out: 0 } });
        // un groupe de A n'existe pas dans B
        expect((await compter(b, ga, 1, 'croise')).status).toBe(404);
      });
    });
  });
});
