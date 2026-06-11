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
Backoff reconnexion : 1s→2s→4s→…→30s, reset sur succès ou switch event.

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

## Backlog
| ID | Titre | Approche |
|---|---|---|
| U1 | Wake Lock | `navigator.wakeLock.request('screen')` + réacquisition sur `visibilitychange`, fallback silencieux |
| U2 | Bouton +1 plus haut | `min-height:30dvh` sur `pointer:coarse` |
| U3 | Lien admin discret | Icône engrenage coin bas-droite `index.html` → `/admin.html` |
| U4 | Grâce déco op 30s | `Map<name,disconnectedAt>` · retrait broadcast si >30s |
| U14 | Spinner file d'attente | Spinner CSS sur badge queue `index.html` pendant flush |
| T1 | Cache QR EventDO | `this._qrCache={url,svg}`, invalidé si URL change |

## Dev
```bash
npm start          # local (affiche IPs + code admin)
npm run cf:dev     # wrangler dev (DO simulés)
npm run deploy     # CF — nécessite wrangler login + plan Paid (DO)
```
Code admin par défaut : `admin123`
