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
| `public/index.html` | Opérateur : +1/−1/+5/−5, scan QR, bandeau (logo + dot + admin), fond ASCII Bruxelles |
| `public/admin.html` | Admin : QR, groupes, archive, export XLSX, rôle PERM |
| `public/stats.html` | Chart.js total + lignes groupes + stats opérateurs |
| `public/manifest.json` / `manifest-admin.json` | PWA op (bleu, `start_url=/`) / admin (rouge, `/admin.html`) |
| `public/logo.png` / `logo_white.png` | Logo bandeau, mode clair / sombre |
| `state.json` | Persistance locale (cloud → DO storage) |

## API
```
POST /api/count              {delta:±1|±5, uuid, e, g, name?} → {total, dup?, alert?}
GET  /api/state?e=X&g=Y      → {total, groupCount, capacity, eventName, groupName}
GET  /api/events?code=X      → {events:[{id,name,total,capacity,groups:[{id,name,count}],createdAt}]}
POST /api/events             {code, name?} → {id, name, total, capacity, groups}
POST /api/groups             {code, e, name?} → {id, name}
GET  /api/history?code=X&e=X[&since=<ms>][&series=fine|coarse] → {history:[{t,c,i,o,g}], historyCoarse:[{t,c,i,o}], total, capacity, peak, totalIn, totalOut, groups:[{id,name,count,totalIn,totalOut,opStats}]}  // c=présents(net) ; i/o=cumuls ; g={groupId:count} ; history=fin 60s/48h ; historyCoarse=5min/60j ; since/series = fenêtrage ; peak = max sur les 2 séries (jamais fenêtré)
GET  /api/clients?code=X&e=X → {clients:[{name,groupName,connectedAt}]}
POST /api/admin/config       {code, e, g?, capacity?, name?, newCode?, newPermCode?, reset?, archived?, deleteGroup?, deleteEvent?} → {ok}  // admin only
POST /api/reset-counts       {code, e} → {ok}  // admin OU perm : count groupes→0, garde historique (+1 pt) + totalIn/out/opStats
GET  /api/qr?code=X&e=X&g=Y  → {qr:dataURL, url}
GET  /api/ips?code=X         → {ips:string[], port}
```

## WebSocket
URL : `ws://host/?e=<id>&g=<gid>` (op) · `?e=<id>` (admin/stats). Code 4004 si introuvable.
Backoff reco 1s→…→30s, reset sur succès/switch. `wsReconnectNow()` sur `visibilitychange` (annule timer, tue zombie, reco). Heartbeat : ping 20s, close si silence >60s. Page cachée → pas de timer.

| sens | type | champs |
|---|---|---|
| s→c | `init` | total, capacity, eventName, groups:[{id,name,count}] |
| s→c | `update` | total, delta, alert, capacity, groups |
| s→c | `clients` | clients:[{name,groupName}] |
| c→s | `hello` | name (après chaque onopen) |
| c→s `ping` / s→c `pong` | — | keepalive 20s ; pong immédiat (server.js ET event.js) |

## Invariants critiques
- **State** : `{adminCode, permCode, events:{[id]:{capacity,history,groups:{[id]:GroupState}}}}`. Groupe "Principal" auto-créé. Dernier groupe non supprimable. Event archivé → 404.
- **UUID dedup** scopé par event — protège les retries réseau, pas la multi-porte.
- **Delta** jamais état absolu → concurrent-safe. **Bornage au TOTAL, pas au groupe** : `eff = (total+delta<0) ? -total : delta` puis `grp.count += eff` (server.js + event.js + index.html). Un groupe peut être **négatif** (entrée par un groupe, sortie par un autre) tant que le total event reste ≥ 0. `totalIn/out`/opStats comptés sur `eff`.
- **Queue localStorage** (pas SW → compat Safari iOS). Ancienne queue sans `e` vidée au boot. **UI optimiste** : total + groupe màj avant ack.
- **Broadcast** : un JSON par event, chaque client extrait son groupe en JS → O(1).
- **Plafonds (R4)** : `MAX_EVENTS=50` (archivés inclus) · `MAX_GROUPS=20`/event · `MAX_OPS=100`/groupe (opStats) · `MAX_HISTORY=2880` (fin, 48h@60s) · `MAX_HISTORY_COARSE=17280` (grossier, 60j@5min) · seenOps trimmé 20k→10k. Dépassement création → **409**. opStats au plafond : nom ignoré mais **comptage jamais bloqué**. Constantes dupliquées cloud (registry/event.js) + local (server.js) — garder alignées.
- **Rate-limit (S3/L3)** : token bucket par IP `RL_CAPACITY=300` burst · `RL_RATE=20`/s, en tête de `/api/count` cloud (`_rl_check`, `cf-connecting-ip`) ET local (`rlCheck`, `req.ip`). Dépassement → **429 + Retry-After**. **Le client ne jette JAMAIS un 429** : `flush()` fait `break` et relance (sinon perte). Buckets alignés.
- **Rôle PERM** : `permCode` distinct — UI masque capacité/reset-event/archive/codes/groupes-edit (mais reset-counts autorisé).
- **Net vs cumuls (i/o)** : `c` = **présents** (somme des counts) → un −1 le fait redescendre. Les entrées cumulées ne sont donc PAS déductibles de la courbe : chaque point (fin ET grossier) porte `i`/`o` = `Σ totalIn`/`Σ totalOut` de l'event à cet instant (`cumulIO()` local / `_cumulIO()` cloud). Invariant : `i − o === c`, **sauf après un reset-counts** (c repart à 0, i/o continuent). Points d'avant la feature : `i`/`o` **absents** — jamais remplacés par 0 (export → cellule vide, chart → `null` + `spanGaps`), et non reconstituables rétroactivement.
- **Historique par groupe** : point `{t, c, i, o, g:{[gid]:count}}` toutes les **60s** (`FINE_INTERVAL_MS`, était 30s → 2880 pts couvrent 48h au lieu de 24h, et moitié moins d'écritures DO). **Local** : `evt.history` (state.json) via `recordHistory()`. **Cloud** : clé DO **séparée `history`** (≠ `state`), écrite seulement par l'`alarm()` → `_save()` léger ; `_load()` migre l'ancien inline (waitUntil). `stats.html` trace `history[].g[gid]` (`spanGaps:true` ; `g` absent → `null`), affiché si >1 groupe.
- **Historique grossier (rétention 60j)** : série **total seul** `{t,c}` toutes les 5 min, plafond `MAX_HISTORY_COARSE=17280` = 60 j. **Local** : `evt.historyCoarse` via `recordHistoryCoarse()` (setInterval 5min). **Cloud** : clé DO **séparée `historyCoarse`**, alimentée par l'`alarm()` (60s) seulement si ≥5min écoulées depuis le dernier point. reset/reset-counts ajoute/vide aussi le grossier. **Backfill** : event antérieur à la feature (clé absente) → série grossière reconstruite depuis l'historique fin via `downsampleCoarse()` (1 pt/bucket 5min, jusqu'à 48h dispo) au `_load()` cloud / `backfillCoarse()` local (au boot + lazy dans `/api/history`). Données au-delà de la fenêtre fine jamais stockées → non récupérables.
- **Export XLSX = les 2 séries fusionnées** : l'onglet « Historique » concatène le grossier (`t < history[0].t`, colonne Série = « long terme ») puis le fin (« détaillé ») → l'export couvre jusqu'à **60 j**, pas seulement la fenêtre fine. Le filtre `< cutoff` évite les doublons sur la zone commune. Colonnes : Horodatage · **Présents** · Entrées cumulées · Sorties cumulées · Série. L'onglet « Résumé » porte la période couverte, la résolution de chaque série et la note de lecture net/cumuls.
- **Budget stockage DO (2 Mo par clé, SQLite-backed)** : pire cas actuel ≈ 1 Mo pour `historyCoarse` (17280 pts × ~55 o avec i/o) et ≈ 1,2 Mo pour `history` (2880 pts × ~400 o à 20 groupes). Marge ~2× : **tout nouveau champ par point se paie ×17280** — recalculer avant d'en ajouter un.
- **Chart stats : fenêtre + live (pas de push/clic)** : 2 séries — `fullHistory` (fine 60s, ≤48h, avec groupes) et `fullHistoryCoarse` (grossière 5min, total seul). `selectedSeries()` : fenêtre `chartWindowH` ≤48h (2/6/24/48) → fine ; 7j(168)/30j(720)/0=début → grossière (pas de lignes par groupe). Le WS `update` ne pousse PLUS un point/clic : `updateLivePoint()` déplace le DERNIER point (« maintenant »). `setInterval` 60s re-fetch `/api/history` (fine+grossière) → la fenêtre glisse.
- **Courbe « Entrées cumulées » (stats)** : dataset sur un **2e axe Y à droite** (`y1`, `display:'auto'` → l'axe n'apparaît que si la courbe est affichée), **masqué par défaut**, révélé par un clic sur la légende. `showCumul` mémorise le choix car `renderChart()` détruit/reconstruit le graphe (fenêtre + refresh 60s) ; `legend.onClick` appelle le handler Chart.js par défaut puis relit `isDatasetVisible()`. `totalIn` suit le live via `+delta` sur `update` WS et se **resynchronise** au fetch 60s (le `+delta` dérive si le total est borné à 0).
- **Axe X temps réel (linéaire)** : `scales.x.type='linear'` sur des points `{x:ts, y}` (PAS d'axe catégoriel) → un pas de 30 min se voit comme 30 min, les trous comme des trous. Pas d'adaptateur de date (timestamps bruts). `ticks.callback=fmt(v)` : `fmt()` = date si vue longue (`chartWindowH===0 || >48`), date+heure en 48h (à cheval sur 2 jours), heure sinon. Tooltip `title` = date+heure complète. Ligne capacité = 2 points `[premierX, maintenant]`. `updateLivePoint` remplace le dernier `{x,y}` de chaque dataset.
- **Persistance DO seenOps** : `_load()` lit `seen`, `_save()` persiste `[..._seen].slice(-2500)`. Local : `buildSnapshot`/`applySnapshot` sérialisent seenOps (max 5000/event) ; `scheduleSave()` debounce 500ms + `setInterval(flushSave,30000)`.
- **Écriture atomique de `state.json`** : `flushSave()` fait `openSync(.tmp)` → `writeSync` → **`fsyncSync`** → `closeSync` → **`renameSync`**. Un `writeFileSync` direct laissait un JSON tronqué si le process mourait pendant l'écriture (elle a lieu toutes les 30 s **et** 500 ms après chaque comptage → fenêtre large) : au boot `JSON.parse` throw, l'état repartait à vide **et était écrasé 30 s plus tard** = soirée perdue. En cas d'échec : `.tmp` supprimé, `state.json` précédent laissé intact. Au boot, un `state.json` illisible est **renommé `.corrupt-<ts>`** au lieu d'être écrasé.
- **`STATE_FILE` surchargeable par `process.env.STATE_FILE`** : la suite locale importe `server.js` et `/api/count` déclenche `scheduleSave()` → sans ça `npm test` **écrasait le `state.json` d'exploitation** avec ses fixtures. `tests/server.test.js` pose `process.env.STATE_FILE` vers un `mkdtemp` **avant** le `require('../server')` — ordre critique, la constante est lue à l'import.
- **`run_worker_first: true` OBLIGATOIRE** (wrangler.jsonc) : sinon Workers Assets sert `index.html` (200) avant le Worker → l'upgrade WS reçoit du HTML au lieu du 101 → opérateurs hors ligne en prod. Vérif : `curl -i -H "Upgrade: websocket" …/?e=x&g=x` → 404 DO ou 101, jamais du HTML.
- **Dot online op = état WS uniquement** : `flush()` ne touche pas `setOnline`.
- **Dernier état affiché (B7)** : localStorage `op_last_state={e,g,count,groupCount,groupName,capacity}`, écrit par `persistDisplay()` (dans setCount/setGroupCount). Restauré au boot AVANT le fetch → pas de « – » hors ligne. Boot `/api/state` : n'écrase que si `r.ok && typeof total==='number'` (sinon 404→undefined→NaN écrasait l'état restauré).
- **Heartbeat serveur (N9)** : server.js ping WS-frame toutes les 30s (`ws.isAlive`/`on('pong')`), `terminate()` les sockets sans pong → purge des TCP morts. Interval dans le bloc `require.main` (pas en test). Distinct du ping applicatif JSON client→serveur.
- **Hello borné (N8)** : 1 hello/s/WS (`_lastHello`/`a.lastHello`) + rediffusion clients seulement si le nom change. server.js ET event.js.
- **Handlers hibernation DO** (`webSocketMessage/Close/Error`) : toujours `await this._load()` avant `this._s` (null après hibernation).
- **Suppression event (N4)** : `/terminate` AVANT le garde archived→404 ; ferme WS 4004 + `deleteAll()` + `deleteAlarm()` + reset mémoire ; `index.js` n'efface le registre que si purge OK (502 sinon, terminate idempotent).
- **`/config` AUSSI avant le garde archived→404** (`event.js`, avec son propre `if (!this._s) → 404`) : placé après, `archived:false` n'atteignait jamais le handler → le désarchivage renvoyait 404 pendant que `index.js` mettait quand même le registre à jour → **event zombie** (listé actif, mais 404 sur state/count/history + WS 4004, et plus supprimable depuis l'UI qui ne propose Supprimer que dans la liste des archivés). Le local n'a jamais eu ce garde sur `/api/admin/config` : cloud aligné dessus. **Règle générale : tout ce qui doit pouvoir *sortir* un event de l'état archivé se place avant le garde.**
- **Registre synchronisé seulement si le DO accepte** : `index.js` ne poste `/events/update` que si `configResp.ok`. Sinon registre et DO divergent — c'est ce qui rendait le zombie ci-dessus irréversible.
- **Suppression de groupe = fermeture des WS du groupe (N5bis)** : `deleteGroup` ferme en 4004 les sockets dont `groupId === g` (server.js **et** event.js), comme l'archivage le fait pour l'event. Sans ça l'opérateur gardait le point vert, l'UI optimiste continuait de monter, et chaque `/api/count` répondait 404 → **la file jetait les ops en silence** (`4xx → shift()`) : comptage perdu sans aucun signal. Ne coupe que le groupe visé — les autres opérateurs de l'event continuent (testé).
- **Jamais de donnée interpolée dans un `onclick` (N7/N7bis)** : `esc()` produit `&#39;` pour une apostrophe, que le parseur HTML **redécode en `'` avant** l'analyse JS → la chaîne se referme trop tôt, `SyntaxError` silencieuse, bouton inerte. « Soirée d'ouverture » suffisait à casser le bouton Supprimer de la liste des archivés. Règle : `data-*` + délégation (un listener posé une fois sur le conteneur, car `innerHTML` est réécrit), et le libellé relu depuis l'état + `textContent`. `esc()` reste correct pour le **contenu** ; le piège n'existe que dans un attribut d'événement.
- **`/api/history` est fenêtré (`since`/`series`), le pic ne l'est pas** : l'historique complet atteint ~1,6 Mo (fin 0,83 Mo à 20 groupes + grossier 0,77 Mo) et `stats.html` le retéléchargeait **intégralement toutes les 60 s**. `since` (ms epoch) borne les deux séries, `series=fine|coarse` supprime celle que la fenêtre n'utilise pas ; **sans paramètre → tout**, ce dont dépend l'export XLSX. Le champ **`peak`** est calculé serveur sur les DEUX séries + le total courant : il reste juste même quand la réponse ne transporte aucun point. Côté client, `historyParams()`/`applyHistory()` (stats.html) ; `usesFineSeries()` décide série ET requête — les garder alignés. Changer de fenêtre **refait un fetch** (`setRange` est async) : le client ne détient plus tout l'historique.
  Le pic échantillonné reste borné par la rétention : un pic très bref, hors fenêtre fine, tombe entre deux points grossiers (5 min) et n'est pas capté.
- **`admin.html` n'appelle plus `/api/history` qu'à l'export** : le fetch à l'ouverture du WS rapatriait jusqu'à 1,6 Mo pour `total` + `groups`, que le message `init` porte déjà — et il repartait à **chaque `visibilitychange`**, donc à chaque déverrouillage de téléphone.
- **Query string : `qs()` obligatoire** (admin.html + stats.html) : le code admin est libre (min. 4 car.), un `&`/`+`/`#`/espace interpolé brut coupait l'URL → code tronqué → **403 sur tout sauf la connexion** (seule à encoder). Ne jamais réintroduire `?code=${adminCode}`.
- **Garde d'entrée du Worker (S4bis/L3bis)** : `badId()` rejette tout id non hexadécimal **avant** `idFromName()` (sinon n'importe quelle chaîne réveille un EventDO facturé), et `wrlCheck()` est un token bucket **par IP, tous events confondus** (600 burst / 40 par s) consulté avant de joindre le DO sur `/api/count`, `/api/state` et l'upgrade WS. Celui du DO est **par event** : faire varier `e` donnait un bucket neuf de 300 jetons à chaque id. **Limite assumée** : l'état est local à l'isolate (Cloudflare en fait tourner plusieurs) → mitigation, pas garantie ; la version dure passerait par le binding Rate Limiting de Cloudflare. `wrlCheck`/`badId` sont exportés pour les tests.
- **Grâce déco (U4)** : `recentlyDisconnected`/`_recentlyDisc` — op visible 30s après déco, retrait via setTimeout, clé `${eventId}:${name}`.
- **Cache QR (T1)** : `_qrCache={url,qr}` mémoire DO, invalidé si URL change. `generateQR` dans event.js ; index.js délègue via `/qr?g=X&url=X`.
- **Persistance lien op (U19)** : localStorage `op_last_link={e,g}`. Écrit au boot si URL porte `e&g` ; relu si absents (PWA `start_url=/`) → `EVENT_ID/GROUP_ID` (`let`) restaurés + `history.replaceState`. Chaque op de la queue garde ses `e/g`. Lien mort → 4004 → saisie manuelle (U16).
- **Hauteur viewport (U18)** : `--app-height = window.innerHeight` piloté JS (`setAppHeight`), CSS `height: var(--app-height, 100dvh)`. Recalc resize/orientationchange/pageshow/visualViewport + rAF + 300ms + visibilitychange. Lit `innerHeight` (pas `visualViewport.height`) → clavier Android ne réduit pas la mise en page.
- **Bandeau op (U3/U21)** : `#statusbar` flex, hauteur 52px bornée par `#scan-btn` (32px). Logo `.app-logo` (height 22px) haut-gauche, switch clair/sombre via `@media prefers-color-scheme`. Lien admin `#admin-link` (engrenage, opacity 0.28) haut-droite, dans le bandeau (pas en fixed).
- **Logos pages** : `.logo-bar` en tête de `admin.html` + `stats.html` (`#logo-dark`/`#logo-light`, switch `@media prefers-color-scheme`, height 28px). Export XLSX : pas de logo (SheetJS gratuit ne supporte pas les images).
- **Fond ASCII index.html** : background sur `html` seul, `body` sans background → `#bxl-bg {z-index:-1}` visible.

## Backlog (ouvert)
| ID | Titre | Approche |
|---|---|---|
| U2 | Bouton +1 plus grand en hauteur | `min-height:30dvh` sur `pointer:coarse` |
| U14 | **NON NECESSAIRE** Spinner file d'attente | Spinner CSS sur badge queue pendant flush |
| U15 | **NON NECESSAIRE** Remonter +/− pour mieux voir | — |

Faits : U1 (Wake Lock), U3 (lien admin → bandeau), U4 (grâce déco), U16 (saisie lien manuelle), U17 (QR admin cliquable), U18 (hauteur viewport), U19 (persistance lien), U20 (évolution par groupe stats), U21 (logo bandeau), T1 (cache QR).

## Bugs ouverts & robustesse
> Revue 2026-06-11 / 06-12. Items corrigés → voir l'historique git ; ci-dessous = **ouvert**.

**Fonctionnels** — tous corrigés (voir git) : **B7** (op_last_state, cf. invariants), **N5** (archive ferme WS 4004), **N5bis** (suppression de groupe ferme les WS de CE groupe), **N6** (`genUUID()` : fallback si `crypto.randomUUID` absent en LAN http), **N7** (esc + renameGroup sans interpolation du nom), **N7bis** (liste archivés : data-* + délégation, plus de nom dans un onclick), **N8** (hello 1/s/WS + broadcast si nom change), **N9** (ping serveur→client), **N10** (timeout fan-out).

**Sécurité**
- **S1** Code admin en query param GET (logs, historique, Referer). → `Authorization: Bearer`, query en fallback.
- **S2** ✅ SRI + `crossorigin="anonymous"` sur les 3 CDN : jsQR@1.4.0 (index), SheetJS@0.20.3 (admin), Chart.js **épinglé 4.4.1** (stats, avant `@4` flottant). Hash sha384 recalculé si bump de version — **toujours vérifier dans le navigateur après coup** : un hash faux ne casse rien visiblement, le script est juste bloqué en silence (scan QR mort, `window.jsQR` undefined, aucune erreur visible hors console). Contrôle :
  ```bash
  curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A   # doit égaler l'attribut integrity
  ```
  ⚠️ **Le hash jsQR a été cassé deux fois** : le commit 9680013 « Fix SRI » a remplacé le hash **correct** par un faux (recalcul fait sur autre chose que le fichier servi). Vérité terrain au 2026-08-25 : jsQR@1.4.0 = `sha384-hStSInNIZ8ljtOVrmrgf7zdHMapaLBWoSnPTtF0nzsybp4+LuhDz6sHuEVpWIX8o`. Ne jamais modifier un `integrity` sans (1) le curl ci-dessus **et** (2) un contrôle navigateur que le symbole global existe.
- **S4/S7** Event ID 6 hex (~16M) brute-forçable ; `/api/state`+`/api/history` non auth pour IDs connus. → 8-10 hex à la création ; option rate-limit `/api/state`.
- **S5** Pas de check `Origin` sur upgrade WS (CSWSH) : site tiers peut lire totaux+prénoms si event ID connu. → refuser si `Origin` présent ≠ host (server.js + index.js).
- **S6** `/api/qr` local construit l'URL depuis `Host` non validé. → whitelist IPs locales + localhost (faible, admin auth).

**Limites / robustesse**
- **R1** (cœur corrigé) Optionnel : parser `Retry-After` pour backoff > 2s.
- **R2** Queue localStorage non plafonnée (op hors ligne des heures). → plafond 5000 ops + bandeau « synchronisation requise ».
- **R3** `/api/qr` Express async sans try/catch → rejet non géré si QRCode échoue. → try/catch → 500 JSON.

## Dev
```bash
npm start           # local (affiche IPs + code admin)
npm run cf:dev      # wrangler dev (DO simulés)
npm run deploy      # CF — nécessite wrangler login + plan Paid (DO)
npm test            # tous (local node:test + worker vitest-pool-workers)
npm run test:local  # serveur Express (tests/server.test.js)
npm run test:worker # Worker CF (tests/worker/*.test.js, runtime workerd)
```
Tests WS (node:test) : **borner le `timeout` ET fermer le socket dans `t.after()`** — un test qui attend un `close` qui n'arrive jamais laisse une connexion ouverte, et le `server.close()` du hook `after()` ne résout alors jamais : la suite pend (7 min observées) au lieu d'échouer.
Code admin par défaut : `admin123`. Tests Worker : RegistryDO singleton, cache mémoire persiste entre tests (isolatedStorage = storage seul) → scoper les assertions par id.
Le bloc « Plafond événements » **doit rester le dernier** (il remplit le registre à 50) ; tout test qui crée un event ailleurs doit le supprimer ensuite, sinon les suivants prennent des 409.
Le bucket `wrlCheck` est un état de **module** partagé par tout le fichier : le solliciter sous une **IP dédiée** (`cf-connecting-ip`), sinon les tests suivants prennent des 429.
