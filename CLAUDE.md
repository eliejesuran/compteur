# Compteur Événement

## Stack
**Local**: Node.js 18 · Express · ws · qrcode · Chart.js (CDN) · Vanilla JS — no build.  
**Cloud**: CF Workers · Durable Objects (RegistryDO + EventDO) · Workers Assets · nodejs_compat

## Règles Claude
Français · tokens courts · vérifier le code 2× · mettre à jour ce fichier après chaque feature · poser des questions plutôt que supposer

## Fichiers
| Fichier | Rôle |
|---|---|
| `server.js` | Local HTTP+WS, état, API |
| `src/index.js` | Worker CF — routeur, sécurité admin, QR |
| `src/registry.js` | RegistryDO — index events, codes admin/perm |
| `src/event.js` | EventDO — état event, WS hibernation, alarme historique |
| `wrangler.jsonc` | Assets, DO bindings, migrations |
| `public/index.html` | Opérateur : +1/−1/+5/−5, scan QR, fond ASCII Bruxelles |
| `public/admin.html` | Admin : QR, groupes, archive, export XLSX, rôle PERM |
| `public/stats.html` | Chart.js total + lignes groupes + stats opérateurs |
| `public/manifest.json` | PWA opérateur — bleu, `start_url=/` |
| `public/manifest-admin.json` | PWA admin — rouge, `start_url=/admin.html` |
| `state.json` | Persistance locale (cloud → DO storage) |

## API
```
POST /api/count              {delta:±1|±5, uuid, e, g, name?} → {total, dup?, alert?}
GET  /api/state?e=X&g=Y      → {total, groupCount, capacity, eventName, groupName}
GET  /api/events?code=X      → {events:[{id,name,total,capacity,groups:[{id,name,count}],createdAt}]}
POST /api/events             {code, name?} → {id, name, total, capacity, groups}
POST /api/groups             {code, e, name?} → {id, name}
GET  /api/history?code=X&e=X → {history:[{t,c,g}], total, capacity, totalIn, totalOut, groups:[{id,name,count,totalIn,totalOut,opStats}]}  // g={groupId:count} : détail par groupe à chaque point
GET  /api/clients?code=X&e=X → {clients:[{name,groupName,connectedAt}]}
POST /api/admin/config       {code, e, g?, capacity?, name?, newCode?, newPermCode?, reset?, archived?, deleteGroup?, deleteEvent?} → {ok}
POST /api/reset-counts       {code, e} → {ok}  // admin OU perm : count groupes→0, garde historique (+1 pt) + totalIn/out/opStats
GET  /api/qr?code=X&e=X&g=Y  → {qr:dataURL, url}
GET  /api/ips?code=X         → {ips:string[], port}
```

## WebSocket
URL : `ws://host/?e=<id>&g=<gid>` (op) · `ws://host/?e=<id>` (admin/stats). Code 4004 si introuvable.  
Backoff reconnexion : 1s→2s→4s→…→30s, reset sur succès ou switch event. `wsReconnectNow()` sur `visibilitychange` : annule le timer en attente, tue le WS zombie, reconnecte immédiatement. Heartbeat anti-zombie : ping 20s, close si silence serveur >60s. Page cachée → pas de timer de reconnexion.

| sens | type | champs |
|---|---|---|
| s→c | `init` | total, capacity, eventName, groups:[{id,name,count}] |
| s→c | `update` | total, delta, alert, capacity, groups:[{id,name,count}] |
| s→c | `clients` | clients:[{name,groupName}] |
| c→s | `hello` | name — envoyé après chaque onopen |
| c→s | `ping` | — toutes les 20s (keepalive + heartbeat) |
| s→c | `pong` | — réponse immédiate (server.js ET event.js) |

## Invariants critiques
- **State** : `{adminCode, permCode, events:{[id]:{capacity,history,groups:{[id]:GroupState}}}}`. Groupe "Principal" auto-créé. Dernier groupe non supprimable. Event archivé → 404.
- **UUID dedup** scopé par event — protège les retries réseau, pas la multi-porte.
- **Delta** jamais état absolu → concurrent-safe. **Bornage au TOTAL, pas au groupe** : `eff = (total+delta<0) ? -total : delta` puis `grp.count += eff` (serveur `server.js`+`event.js` ET client `index.html`). Un groupe peut donc être **négatif** (entrée par un groupe, sortie par un autre) tant que le total event reste ≥ 0. `totalIn/out`/opStats comptés sur `eff`.
- **Queue localStorage** (pas SW) → compat Safari iOS. Ancienne queue sans champ `e` vidée au démarrage.
- **UI optimiste** : total + groupe mis à jour avant ack serveur.
- **Broadcast** : un JSON par event, tous les clients extraient leur groupe côté JS → O(1) sérialisation.
- **seenOps** trimmé 20k→10k. History plafonnée à 2 880 pts (24h @ 30s).
- **Plafonds anti-DoS (R4)** : `MAX_EVENTS=50` (archivés inclus) · `MAX_GROUPS=20`/event · `MAX_OPS=100`/groupe. Dépassement création → **409**. opStats au plafond : nom nouveau ignoré mais **comptage jamais bloqué**. Constantes dupliquées cloud (registry/event.js) + local (server.js) — garder alignées.
- **Rate-limit token bucket (S3/L3)** : `RL_CAPACITY=300` (burst) · `RL_RATE=20`/s, par IP, en tête de `/api/count` cloud (`_rl_check`, ip = `cf-connecting-ip`) ET local (`rlCheck`, ip = `req.ip`). Dépassement → **429 + `Retry-After`**. **Le client ne jette JAMAIS un 429** : `flush()` fait `break` et relance (sinon perte de comptage). Garder les deux buckets alignés.
- **Rôle PERM** : `permCode` distinct — UI masque capacité/reset/archive/codes/groupes-edit.
- **Fond ASCII `index.html`** : fond sur `html` uniquement, `body` sans background → `#bxl-bg {z-index:-1}` visible.
- **Charts groupes `stats.html`** : lignes par groupe (tirets, 6 couleurs) tracent l'évolution **enregistrée** via `history[].g[groupId]` (puis live en WS). Points antérieurs à l'enregistrement par groupe (anciens events) → `g` absent → `null` (`spanGaps:true`) : la ligne démarre quand les données existent. Affiché seulement si >1 groupe.
- **Historique par groupe (stockage)** : chaque point = `{t, c, g:{[groupId]:count}}`, échantillonné toutes les 30 s. **Local** : dans `evt.history` (state.json), via `recordHistory()`. **Cloud** : clé DO **séparée `history`** (≠ `state`), écrite uniquement par l'`alarm()` → `_save()` par comptage reste léger ; `_load()` migre l'ancien `state.history` inline (waitUntil). Plafond `MAX_HISTORY=2880` aligné local/cloud. SQLite-backed DO : 2 Mo/clé, pire cas 20 groupes ≈ 835 Ko.
- **Grâce déco U4** : `recentlyDisconnected` (server.js) / `_recentlyDisc` (event.js) — op visible 30s après déco ; `setTimeout` déclenche re-broadcast de retrait ; clé `${eventId}:${name}` évite les collisions multi-reconnexions.
- **Cache QR T1** : `_qrCache={url,qr}` en mémoire DO — invalidé si l'URL change. `generateQR` défini dans `event.js` ; `index.js` délègue via `/qr?g=X&url=X`.
- **`run_worker_first: true` OBLIGATOIRE** (wrangler.jsonc) : par défaut Workers Assets sert les fichiers statiques AVANT le Worker → l'upgrade WS sur `/?e=X&g=Y` recevait `index.html` (200, même CF-cache HIT) au lieu du 101 → opérateurs toujours hors ligne en prod. Corrigé 2026-06-12. Vérifiable : `curl -i -H "Upgrade: websocket" …/?e=x&g=x` doit renvoyer 404 DO (event bidon) ou 101, jamais du HTML.
- **Dot online opérateur = état WS uniquement** : `flush()` ne touche plus `setOnline` (avant : queue vide → online même sans WS, d'où "en ligne au clic puis hors ligne").
- **Handlers hibernation DO** (`webSocketMessage/Close/Error` event.js) : toujours `await this._load()` avant d'accéder à `this._s` — après hibernation `_s` est null.
- **Persistance lien op (U19)** : clé localStorage `op_last_link` = `{e,g}`. Écrite au boot si l'URL porte `e&g` ; relue si absents (PWA `start_url=/`) → `EVENT_ID/GROUP_ID` (passés en `let`) restaurés + `history.replaceState`. Chaque op de la queue garde ses propres `e/g` → restauration sans effet de bord sur le flush. Lien mort restauré → 4004 → bouton saisie manuelle (graceful, cf. U16).
- **Hauteur viewport (U18)** : `--app-height` = `window.innerHeight` piloté en JS (`setAppHeight`), CSS `height: var(--app-height, 100dvh)`. Recalcul sur resize/orientationchange/pageshow/visualViewport + rAF + 300 ms + visibilitychange. Sans JS → fallback `100dvh`. `setAppHeight` lit toujours `innerHeight` (pas `visualViewport.height`) → clavier Android ne réduit pas la mise en page.

## Backlog
| ID | Titre | Approche |
|---|---|---|
| U1 | ✅ **FAIT** Wake Lock | `navigator.wakeLock.request('screen')` + réacquisition sur `visibilitychange`, fallback silencieux |
| U2 | Bouton +1 plus grand en hauteur | `min-height:30dvh` sur `pointer:coarse` |
| U3 | ✅ **FAIT** Lien admin discret | `<a #admin-link>` fixe bas-droite `opacity:0.28`, engrenage SVG → `/admin.html` |
| U4 | ✅ **FAIT** Grâce déco op 30s | `recentlyDisconnected Map` server.js + `_recentlyDisc` event.js · retrait broadcast après 30s via setTimeout |
| U14 | Spinner file d'attente | Spinner CSS sur badge queue `index.html` pendant flush |
| U15 | Remonter les Boutons + et -  pour mieux voir |  |
| U16 | ✅ **FAIT** Saisie manuelle du lien hors ligne | Bouton « Saisir le lien manuellement » + overlay `#link-overlay` (copié-collé) affichés quand URL invalide / event introuvable (4004) ; `parseEventURL` accepte URL complète, relative ou query seule → reste dans l'app |
| U17 | ✅ **FAIT** Lien QR admin cliquable | `#qr-url` rendu en `<a target="_blank" rel="noopener">` au lieu de texte brut |
| U18 | ✅ **FAIT** Boutons trop bas au lancement | Cause : en PWA (Android) le viewport n'est pas stabilisé au 1er rendu → `100dvh` trop grand → boutons du bas poussés hors écran (un resize via extinction/rallumage corrigeait). Fix : hauteur pilotée par `--app-height` = `window.innerHeight`, recalculée sur `resize`/`orientationchange`/`pageshow`/`visualViewport` + différé (rAF + 300 ms) + retour 1er plan (`visibilitychange`). CSS : `height: var(--app-height, 100dvh)` |
| U19 | ✅ **FAIT** Persistance du lien | `e`/`g` présents dans l'URL → sauvegardés en localStorage (`op_last_link`). Absents (lancement PWA `start_url=/`) → restaurés + `history.replaceState`. Au relancement : reconnexion directe au dernier événement (online, ou file d'attente si hors ligne) au lieu de « URL invalide ». Atténue B7. |
| U20 | ✅ **FAIT** Évolution par groupe (stats) | Historique enregistre le détail par groupe `{t,c,g}` (server.js `recordHistory` + event.js clé DO `history` séparée écrite par l'alarme, migration de l'ancien inline). `stats.html` trace `history[].g[gid]` au lieu de `fill(count)` → vraie courbe par groupe (plus de fausse ligne plate). Tests : 3 local + 1 worker (alarme via `runInDurableObject`). |
| T1 | ✅ **FAIT** Cache QR EventDO | `this._qrCache={url,qr}` dans EventDO · invalidé si URL change · QR généré dans event.js (import QRCode) · route index.js délègue au DO |

## Bugs & Lacunes de robustesse
> Revue complète 2026-06-11. Classés par gravité.

### ⛔ Critiques — sécurité des personnes (peut provoquer un sous-comptage ou sur-comptage)

| ID | Fichier | Description | Risque concret |
|---|---|---|---|
| C1 | `server.js` | ✅ **CORRIGÉ** — `buildSnapshot()`/`applySnapshot()` sérialisent `seenOps` dans `state.json` (max 5 000 UUIDs/event). `applySnapshot` restaure les Sets au démarrage. 6 tests round-trip ajoutés. | — |
| C2 | `src/event.js` | ✅ **CORRIGÉ** — `_load()` charge `seen` depuis DO storage, `_save()` persiste `[..._seen].slice(-2500)` en parallèle du state. | — |
| C3 | `server.js` | ✅ **CORRIGÉ** — `scheduleSave()` (debounce 500 ms) appelé après chaque count ; `flushSave()` immédiat sur reset ; `setInterval(flushSave, 30000)` en filet de sécurité. | — |
| C4 | `src/event.js` | ✅ **CORRIGÉ** — dans `/config`, `archived === false` détecte `wasArchived` et appelle `setAlarm(+30s)` seulement si l'event était réellement archivé. Pas de double-arme si l'alarme tournait déjà. | — |

---

### 🐛 Bugs fonctionnels

| ID | Fichier | Description |
|---|---|---|
| B1 | `public/admin.html` | ✅ **CORRIGÉ** — spread inversé : `{ ...(existing\|\|{}), ...g }` ; WS gagne sur le cache local. Boucle redondante de mise à jour du count supprimée. |
| B2 | `public/stats.html` | ✅ **CORRIGÉ** — message `init` WS traité : `updateCount(msg.total)` appelé au reconnect. |
| B3 | `public/stats.html` | ✅ **CORRIGÉ** — sur `init`, re-fetch `/api/history` pour mettre à jour `totalIn` avec les ops manquées pendant la coupure. |
| B4 | `src/event.js` | ✅ **CORRIGÉ** — `_rl_check` purge les IPs inactives depuis >1h quand `_rl.size > 500`. |
| B5 | `src/event.js` + `src/index.js` + `server.js` | ✅ **CORRIGÉ** — endpoint `/terminate` dans EventDO ferme tous les WS avec code 4004 ; appelé par `index.js` avant la suppression registre. `server.js` ferme directement les WS locaux. 2 tests ajoutés. |
| B6 | `server.js` | ✅ **CORRIGÉ** — `scheduleSave()` ajouté en fin du handler `/api/admin/config` (couvre capacity, name, code, perm, archive, group rename/delete) et dans le branch `deleteEvent`. |
| B7 | 'public/index.html' |  si déconnecté d'internet, et application quittée, le rebranchement n'est pas spécialement cohérent. |


---

### 🔒 Sécurité

| ID | Fichier | Description |
|---|---|---|
| S1 | `public/admin.html`, `public/stats.html` | **Code admin en query param GET** (`/api/events?code=X`, `/api/history?code=X`…) — exposé dans les logs d'accès serveur, l'historique navigateur, et les headers Referer vers des tiers. |
| S2 | `public/index.html` L13, `public/admin.html` L794 | **Pas de SRI sur les scripts CDN** (jsQR, SheetJS) — compromission du CDN = exécution de code arbitraire. Ajouter `integrity="sha384-…" crossorigin="anonymous"`. |
| S3 | `server.js` | ✅ **CORRIGÉ** — token bucket par IP `rlCheck()` (miroir local de `_rl_check`), `RL_CAPACITY=300 · RL_RATE=20`, appelé en tête de `/api/count` → 429 + `Retry-After`. Clé = `req.ip`/`socket.remoteAddress` (per-device en LAN ; **pas de `trust proxy`** → non spoofable, mais derrière un tunnel toutes les requêtes partagent un bucket — le Worker CF reste le chemin prod via `cf-connecting-ip`). 1 test. |
| S4 | `src/index.js`, `server.js` | **Event ID = 3 octets / 6 hex** (~16M possibilités) — brute-forceable depuis le réseau local pour découvrir des events. `/api/state` et `/api/history` sont non-authentifiés pour les IDs connus. |

---

### ⚠️ Limites / DoS doux

| ID | Description |
|---|---|
| L1 | ✅ **CORRIGÉ** (R4) — plafonds 50 events (registry.js + server.js) et 20 groupes/event (event.js + server.js), 409 si dépassé. Archivés comptés dans les 50 (storage). |
| L2 | ✅ **CORRIGÉ** (R4) — opStats plafonné à 100 noms/groupe (event.js + server.js). Un nouveau nom au-delà n'est plus tracké **mais le comptage total/groupe reste exact** (jamais de perte). |
| L3 | ✅ **CORRIGÉ** — burst du token bucket CF réduit **2 000 → 300** (`RL_CAPACITY` hoistée en constante module, `event.js`). Salve max divisée par ~6,6 ; débit soutenu inchangé (20/s). 300 absorbe un flush multi-opérateurs derrière un même IP de lieu. 1 test (`runInDurableObject`). |

## Revue 2026-06-12 — bugs

### ⛔ Critiques

| ID | Fichier | Description |
|---|---|---|
| N1 | `server.js` | ✅ **CORRIGÉ** — le serveur local ne répondait pas aux `ping` WS → le heartbeat client (close si silence >60s) faisait boucler déco/reco toutes les 60s sur un event calme. Régression du heartbeat 12/06. Handler `ping`→`pong` ajouté + test. |
| N2 | `src/index.js` | ✅ **CORRIGÉ** — `iReq()` ne transmettait pas `cf-connecting-ip` au EventDO → `_rl_check` voyait `'unknown'` pour TOUTES les requêtes : rate-limit par IP inopérant, bucket unique partagé. Un attaquant connaissant l'event ID pouvait l'épuiser en continu → 429 pour tous les opérateurs → comptage paralysé. `iReq` accepte un 4ᵉ param `headers` ; `/api/count` transmet l'IP. |
| N3 | `public/admin.html` | ✅ **CORRIGÉ** — régression 12/06 : le garde anti-double-connexion de `startWS` (`if (ws && readyState<=1) return`) bloquait le **switch d'événement** (ancien WS encore ouvert → return → admin abonné au mauvais event, plus aucun live). Tag `ws._eventId` : même event → noop, autre event → fermeture propre (handlers neutralisés) puis reconnexion. |
| N4 | `src/event.js` + `src/index.js` | ✅ **CORRIGÉ** — event supprimé = fantôme côté CF : le storage du DO n'était jamais purgé → `/api/count`, `/api/state`, WS et résurrection (`archived:false`) fonctionnaient toujours sur un event « supprimé ». Pire : `/terminate` était placé APRÈS le garde `archived → 404`, donc inopérant pour le flux normal (archive → delete). Fix : `/terminate` déplacé AVANT le garde ; `storage.deleteAll()` + `deleteAlarm()` + reset mémoire complet ; `index.js` n'efface l'entrée registre que si la purge a réussi (502 sinon → retry, terminate idempotent) ; garde `webSocketMessage` : message reçu sur un event supprimé → close 4004 au lieu de pong (un zombie ne survit pas au heartbeat). Vérifié sous `wrangler dev` : state/count/WS/résurrection → 404 après delete (flux live ET archivé). Artefact connu : en dev local la trame close 4004 part (client passe en CLOSING) mais le teardown TCP ne se propage pas — OK en prod. |

### 🐛 Bugs fonctionnels

| ID | Fichier | Description |
|---|---|---|
| N5 | `server.js` + `src/event.js` | **Archivage ne ferme pas les WS ouverts** — l'opérateur garde son dot vert et continue de taper ; `/api/count` → 404 → la queue jette les ops (4xx) **silencieusement**. Perte de comptage sans aucun signal. Fix : fermer les WS en 4004 quand `archived === true`. |
| N6 | `public/index.html` | **`crypto.randomUUID()` exige un contexte sécurisé** — en LAN local (`http://192.168.x.x:3000`, mode fallback sans internet), `tap()` lève TypeError → **aucun comptage possible**. Jamais vu car tunnel/CF = https. Fix : fallback `Date.now()+Math.random()` si `randomUUID` absent. |
| N7 | `public/admin.html` | **`esc()` n'échappe ni `'` ni `"`** — un nom de groupe/événement contenant une apostrophe (ex. « L'entrée ») casse les `onclick` générés (`renameGroup('id','L'entrée')` = SyntaxError) → boutons ✎/×/Supprimer inopérants. Injection JS possible (admin-only). Fix : échapper `'`→`&#39;` `"`→`&quot;` dans `esc()`. |

### ⚠️ Limites

| ID | Description |
|---|---|
| N8 | `webSocketMessage` (event.js) sans rate-limit : spam `hello` = amplification `_broadcastClients` vers tous les clients. Borner (ex. 1 hello/s/WS). |
| N9 | `server.js` n'envoie jamais de ping serveur→client : les sockets TCP morts restent dans `wsClients` jusqu'au timeout OS (fuite lente + faux « connectés » au-delà de la grâce 30s). |
| N10 | Fan-out `/api/events` (index.js) sans timeout par DO : un seul DO lent bloque toute la liste admin (le client coupe à 6s). `AbortSignal.timeout(3000)` par stub. |

## Renforcement sécurité (proposé)

| ID | Description | Approche |
|---|---|---|
| S1 | Code admin en query param GET (logs, historique, Referer) | Header `Authorization: Bearer <code>` partout ; garder le query param en fallback compat |
| S2 | Pas de SRI sur les CDN — jsQR (index), SheetJS (admin), **Chart.js (stats)** | `integrity="sha384-…" crossorigin="anonymous"` sur les 3 |
| S5 | Pas de vérification `Origin` sur les upgrades WS (CSWSH) — un site tiers ouvert par l'admin peut lire totaux + prénoms si event ID connu | Refuser l'upgrade si `Origin` présent ≠ host attendu (server.js + index.js) |
| S6 | `/api/qr` local construit l'URL depuis le header `Host` non validé | Liste blanche : IPs locales + localhost (faible — admin auth requis) |
| S7 | Event ID 6 hex brute-forçable (S4) + `/api/state` non authentifié | Passer à 8-10 hex à la création ; optionnel : rate-limit `/api/state` |

## Robustesse (proposé)

| ID | Description | Approche |
|---|---|---|
| R1 | ✅ **CORRIGÉ (cœur)** — `flush()` traitait un **429 comme un 4xx définitif → `queue.shift()` jetait le compte** (perte silencieuse, aggravée par S3/L3). Désormais 429/5xx → `break` (op conservée, relance via `setInterval` 2s/online/visibility). Reste optionnel : parser `Retry-After` pour un backoff > 2s. | Backoff explicite : suspendre flush `Retry-After` s |
| R2 | Queue localStorage non plafonnée (opérateur hors ligne des heures) | Plafond 5 000 ops + bandeau UI « synchronisation requise » |
| R3 | `/api/qr` Express : async sans try/catch → rejet non géré si QRCode échoue | try/catch → 500 JSON propre |
| R4 | ✅ **FAIT** Caps L1/L2 | Constantes `MAX_EVENTS=50 · MAX_GROUPS=20 · MAX_OPS=100` dupliquées cloud (registry/event.js) + local (server.js). Création refusée → 409 `{error}` ; admin.html `alert()` (plus d'échec silencieux). opStats : cap sans perte de comptage. Tests : 3 Worker + 3 local |
| R5 | ✅ **FAIT** Tests Worker CF | `@cloudflare/vitest-pool-workers` (v4 API : plugin `cloudflareTest` dans `vitest.config.mjs`) — `tests/worker/worker.test.js` exerce index.js+EventDO+RegistryDO via `SELF.fetch` (création/auth/count/dedup/groupes/archive/delete). Singleton RegistryDO : cache mémoire persiste entre tests (isolatedStorage = storage only) → assertions scopées par id. `npm run test:worker` |

## Dev
```bash
npm start          # local (affiche IPs + code admin)
npm run cf:dev     # wrangler dev (DO simulés)
npm run deploy     # CF — nécessite wrangler login + plan Paid (DO)
npm test           # tous : local (node:test) + worker (vitest-pool-workers)
npm run test:local # serveur Express (tests/server.test.js)
npm run test:worker# Worker CF (tests/worker/*.test.js, runtime workerd)
```
Code admin par défaut : `admin123`
