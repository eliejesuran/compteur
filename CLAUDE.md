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
GET  /api/history?code=X&e=X → {history:[{t,c}], total, capacity, totalIn, totalOut, groups:[{id,name,count,totalIn,totalOut,opStats}]}
GET  /api/clients?code=X&e=X → {clients:[{name,groupName,connectedAt}]}
POST /api/admin/config       {code, e, g?, capacity?, name?, newCode?, newPermCode?, reset?, archived?, deleteGroup?, deleteEvent?} → {ok}
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

## Invariants critiques
- **State** : `{adminCode, permCode, events:{[id]:{capacity,history,groups:{[id]:GroupState}}}}`. Groupe "Principal" auto-créé. Dernier groupe non supprimable. Event archivé → 404.
- **UUID dedup** scopé par event — protège les retries réseau, pas la multi-porte.
- **Delta** jamais état absolu → concurrent-safe. `Math.max(0, count+delta)` serveur ET client.
- **Queue localStorage** (pas SW) → compat Safari iOS. Ancienne queue sans champ `e` vidée au démarrage.
- **UI optimiste** : total + groupe mis à jour avant ack serveur.
- **Broadcast** : un JSON par event, tous les clients extraient leur groupe côté JS → O(1) sérialisation.
- **seenOps** trimmé 20k→10k. History plafonnée à 2 880 pts (24h @ 30s).
- **Rôle PERM** : `permCode` distinct — UI masque capacité/reset/archive/codes/groupes-edit.
- **Fond ASCII `index.html`** : fond sur `html` uniquement, `body` sans background → `#bxl-bg {z-index:-1}` visible.
- **Charts groupes `stats.html`** : lignes par groupe (tirets, 6 couleurs) démarrent à la connexion WS — historique API ne contient que le total.
- **Grâce déco U4** : `recentlyDisconnected` (server.js) / `_recentlyDisc` (event.js) — op visible 30s après déco ; `setTimeout` déclenche re-broadcast de retrait ; clé `${eventId}:${name}` évite les collisions multi-reconnexions.
- **Cache QR T1** : `_qrCache={url,qr}` en mémoire DO — invalidé si l'URL change. `generateQR` défini dans `event.js` ; `index.js` délègue via `/qr?g=X&url=X`.
- **`run_worker_first: true` OBLIGATOIRE** (wrangler.jsonc) : par défaut Workers Assets sert les fichiers statiques AVANT le Worker → l'upgrade WS sur `/?e=X&g=Y` recevait `index.html` (200, même CF-cache HIT) au lieu du 101 → opérateurs toujours hors ligne en prod. Corrigé 2026-06-12. Vérifiable : `curl -i -H "Upgrade: websocket" …/?e=x&g=x` doit renvoyer 404 DO (event bidon) ou 101, jamais du HTML.
- **Dot online opérateur = état WS uniquement** : `flush()` ne touche plus `setOnline` (avant : queue vide → online même sans WS, d'où "en ligne au clic puis hors ligne").
- **Handlers hibernation DO** (`webSocketMessage/Close/Error` event.js) : toujours `await this._load()` avant d'accéder à `this._s` — après hibernation `_s` est null.

## Backlog
| ID | Titre | Approche |
|---|---|---|
| U1 | ✅ **FAIT** Wake Lock | `navigator.wakeLock.request('screen')` + réacquisition sur `visibilitychange`, fallback silencieux |
| U2 | Bouton +1 plus grand en hauteur | `min-height:30dvh` sur `pointer:coarse` |
| U3 | ✅ **FAIT** Lien admin discret | `<a #admin-link>` fixe bas-droite `opacity:0.28`, engrenage SVG → `/admin.html` |
| U4 | ✅ **FAIT** Grâce déco op 30s | `recentlyDisconnected Map` server.js + `_recentlyDisc` event.js · retrait broadcast après 30s via setTimeout |
| U14 | Spinner file d'attente | Spinner CSS sur badge queue `index.html` pendant flush |
| U15 | Remonter les Boutons + et -  pour mieux voir |  |
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

---

### 🔒 Sécurité

| ID | Fichier | Description |
|---|---|---|
| S1 | `public/admin.html`, `public/stats.html` | **Code admin en query param GET** (`/api/events?code=X`, `/api/history?code=X`…) — exposé dans les logs d'accès serveur, l'historique navigateur, et les headers Referer vers des tiers. |
| S2 | `public/index.html` L13, `public/admin.html` L794 | **Pas de SRI sur les scripts CDN** (jsQR, SheetJS) — compromission du CDN = exécution de code arbitraire. Ajouter `integrity="sha384-…" crossorigin="anonymous"`. |
| S3 | `server.js` | **Pas de rate-limiting sur le serveur local** — `/api/count` peut être martelé. Le serveur CF a un token bucket (event.js) mais pas le local. |
| S4 | `src/index.js`, `server.js` | **Event ID = 3 octets / 6 hex** (~16M possibilités) — brute-forceable depuis le réseau local pour découvrir des events. `/api/state` et `/api/history` sont non-authentifiés pour les IDs connus. |

---

### ⚠️ Limites / DoS doux

| ID | Description |
|---|---|
| L1 | Aucune limite sur le nombre de groupes par event ni d'events au total — un admin peut saturer la mémoire/storage. |
| L2 | `opStats` non borné en nombre d'entrées — noms d'opérateurs illimités par groupe. |
| L3 | Token bucket CF : burst initial de 2 000 requêtes par IP — un attaquant connaissant un event ID peut injecter 2 000 faux comptes en une salve. |

## Dev
```bash
npm start          # local (affiche IPs + code admin)
npm run cf:dev     # wrangler dev (DO simulés)
npm run deploy     # CF — nécessite wrangler login + plan Paid (DO)
```
Code admin par défaut : `admin123`
