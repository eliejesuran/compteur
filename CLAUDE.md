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
GET  /api/history?code=X&e=X → {history:[{t,c,g}], historyCoarse:[{t,c}], total, capacity, totalIn, totalOut, groups:[{id,name,count,totalIn,totalOut,opStats}]}  // g={groupId:count} ; historyCoarse=total seul 30min/60j
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
- **Plafonds (R4)** : `MAX_EVENTS=50` (archivés inclus) · `MAX_GROUPS=20`/event · `MAX_OPS=100`/groupe (opStats) · `MAX_HISTORY=2880` (fin, 24h@30s) · `MAX_HISTORY_COARSE=2880` (grossier, 60j@30min) · seenOps trimmé 20k→10k. Dépassement création → **409**. opStats au plafond : nom ignoré mais **comptage jamais bloqué**. Constantes dupliquées cloud (registry/event.js) + local (server.js) — garder alignées.
- **Rate-limit (S3/L3)** : token bucket par IP `RL_CAPACITY=300` burst · `RL_RATE=20`/s, en tête de `/api/count` cloud (`_rl_check`, `cf-connecting-ip`) ET local (`rlCheck`, `req.ip`). Dépassement → **429 + Retry-After**. **Le client ne jette JAMAIS un 429** : `flush()` fait `break` et relance (sinon perte). Buckets alignés.
- **Rôle PERM** : `permCode` distinct — UI masque capacité/reset-event/archive/codes/groupes-edit (mais reset-counts autorisé).
- **Historique par groupe** : point `{t, c, g:{[gid]:count}}` toutes les 30s. **Local** : `evt.history` (state.json) via `recordHistory()`. **Cloud** : clé DO **séparée `history`** (≠ `state`), écrite seulement par l'`alarm()` → `_save()` léger ; `_load()` migre l'ancien inline (waitUntil). `stats.html` trace `history[].g[gid]` (`spanGaps:true` ; `g` absent → `null`), affiché si >1 groupe.
- **Historique grossier (rétention 60j)** : série **total seul** `{t,c}` toutes les 30 min, plafond `MAX_HISTORY_COARSE=2880` = 60 j. **Local** : `evt.historyCoarse` via `recordHistoryCoarse()` (setInterval 30min). **Cloud** : clé DO **séparée `historyCoarse`**, alimentée par l'`alarm()` (30s) seulement si ≥30min écoulées depuis le dernier point. reset/reset-counts ajoute/vide aussi le grossier. Migration : clé absente → `[]`.
- **Chart stats : fenêtre + live (pas de push/clic)** : 2 séries — `fullHistory` (fine 30s, ≤24h, avec groupes) et `fullHistoryCoarse` (grossière 30min, total seul). `selectedSeries()` : fenêtre `chartWindowH` ≤24h → fine ; 7j(168)/30j(720)/0=début → grossière (pas de lignes par groupe). `fmt()` : date pour les vues longues, heure pour ≤24h. Le WS `update` ne pousse PLUS un point/clic : `updateLivePoint()` déplace le DERNIER point (« maintenant »). `setInterval` 60s re-fetch `/api/history` (fine+grossière) → la fenêtre glisse.
- **Persistance DO seenOps** : `_load()` lit `seen`, `_save()` persiste `[..._seen].slice(-2500)`. Local : `buildSnapshot`/`applySnapshot` sérialisent seenOps (max 5000/event) ; `scheduleSave()` debounce 500ms + `setInterval(flushSave,30000)`.
- **`run_worker_first: true` OBLIGATOIRE** (wrangler.jsonc) : sinon Workers Assets sert `index.html` (200) avant le Worker → l'upgrade WS reçoit du HTML au lieu du 101 → opérateurs hors ligne en prod. Vérif : `curl -i -H "Upgrade: websocket" …/?e=x&g=x` → 404 DO ou 101, jamais du HTML.
- **Dot online op = état WS uniquement** : `flush()` ne touche pas `setOnline`.
- **Dernier état affiché (B7)** : localStorage `op_last_state={e,g,count,groupCount,groupName,capacity}`, écrit par `persistDisplay()` (dans setCount/setGroupCount). Restauré au boot AVANT le fetch → pas de « – » hors ligne. Boot `/api/state` : n'écrase que si `r.ok && typeof total==='number'` (sinon 404→undefined→NaN écrasait l'état restauré).
- **Heartbeat serveur (N9)** : server.js ping WS-frame toutes les 30s (`ws.isAlive`/`on('pong')`), `terminate()` les sockets sans pong → purge des TCP morts. Interval dans le bloc `require.main` (pas en test). Distinct du ping applicatif JSON client→serveur.
- **Hello borné (N8)** : 1 hello/s/WS (`_lastHello`/`a.lastHello`) + rediffusion clients seulement si le nom change. server.js ET event.js.
- **Handlers hibernation DO** (`webSocketMessage/Close/Error`) : toujours `await this._load()` avant `this._s` (null après hibernation).
- **Suppression event (N4)** : `/terminate` AVANT le garde archived→404 ; ferme WS 4004 + `deleteAll()` + `deleteAlarm()` + reset mémoire ; `index.js` n'efface le registre que si purge OK (502 sinon, terminate idempotent).
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

**Fonctionnels** — tous corrigés (voir git) : **B7** (op_last_state, cf. invariants), **N5** (archive ferme WS 4004), **N6** (`genUUID()` : fallback si `crypto.randomUUID` absent en LAN http), **N7** (esc + renameGroup sans interpolation du nom), **N8** (hello 1/s/WS + broadcast si nom change), **N9** (ping serveur→client), **N10** (timeout fan-out).

**Sécurité**
- **S1** Code admin en query param GET (logs, historique, Referer). → `Authorization: Bearer`, query en fallback.
- **S2** ✅ SRI + `crossorigin="anonymous"` sur les 3 CDN : jsQR@1.4.0 (index), SheetJS@0.20.3 (admin), Chart.js **épinglé 4.4.1** (stats, avant `@4` flottant). Hash sha384 recalculé si bump de version.
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
Code admin par défaut : `admin123`. Tests Worker : RegistryDO singleton, cache mémoire persiste entre tests (isolatedStorage = storage seul) → scoper les assertions par id.
