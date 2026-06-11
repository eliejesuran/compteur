# Compteur Événement

## Stack
**Local** : Node.js 18+ · Express · ws (WebSocket) · qrcode · Chart.js (CDN) · Vanilla JS — no build step.
**Cloud** : Cloudflare Workers · Durable Objects (RegistryDO + EventDO) · Workers Assets (public/) · qrcode (SVG path, nodejs_compat)

## Instructions Claude
Parler en optimisant les tokens · Mettre régulièrement ce fichier CLAUDE.md pour optimiser l'utilisation de token · Vérifie toujours 2 fois ton code · Pose autant de questions que nécessaire toujours dans le but d'optimiser ton utilisation de token

## Files
| Fichier | Rôle |
|---|---|
| `server.js` | Serveur local HTTP + WebSocket, état, API (dev local) |
| `src/index.js` | Worker CF — routeur HTTP, sécurité admin, QR code |
| `src/registry.js` | RegistryDO — index des événements, code admin |
| `src/event.js` | EventDO — état par événement, WS hibernation, alarme historique |
| `wrangler.jsonc` | Config Workers : assets, DO bindings, migrations |
| `public/index.html` | Page compteur (opérateurs) : +1/−1/+5/−5 |
| `public/admin.html` | Panel admin : QR code, capacité, reset, code |
| `public/stats.html` | Graphiques temps réel (Chart.js) + stats par opérateur |
| `public/manifest.json` | Manifest PWA — installable sur mobile |
| `public/icon.svg` | Icône de l'app (PWA) |
| `state.json` | État persisté (local uniquement — en cloud : DO storage) |

## API
```
POST /api/count              {delta:±1|±5, uuid, e, g, name?} → {total, dup?, alert?}
GET  /api/state?e=X&g=Y      → {total, groupCount, capacity, eventName, groupName}
GET  /api/events?code=X      → {events:[{id, name, total, capacity, groups:[{id,name,count}], createdAt}]}
POST /api/events             {code, name?} → {id, name, total, capacity, groups}
POST /api/groups             {code, e, name?} → {id, name}
GET  /api/history?code=X&e=X → {history:[{t,c}], total, capacity, totalIn, totalOut, groups:[{id,name,count,totalIn,totalOut,opStats}]}
GET  /api/clients?code=X&e=X → {clients:[{name, groupName, connectedAt}]}
POST /api/admin/config       {code, e, g?, capacity?, name?, newCode?, reset?, archived?, deleteGroup?} → {ok}
GET  /api/qr?code=X&e=X&g=Y  → {qr:dataURL, url}  — url = /?e=<id>&g=<id>
GET  /api/ips?code=X         → {ips:string[], port}
```

## WebSocket (server → clients)
WS URL : `ws://host/?e=<eventId>&g=<groupId>` (opérateur) · `ws://host/?e=<eventId>` (admin)
Code 4004 si événement ou groupe introuvable.
| type | champs | déclencheur |
|---|---|---|
| `init` | total, capacity, eventName, groups:[{id,name,count}] | connexion |
| `update` | total, delta, alert, capacity, groups:[{id,name,count}] | opération ou config |
| `clients` | clients:[{name,groupName}] | connexion/déconnexion opérateur |

Le client opérateur extrait son propre groupe via `groups.find(g => g.id === GROUP_ID)`.

## WebSocket (client → server)
| type | champs | moment |
|---|---|---|
| `hello` | name: string | juste après `ws.onopen`, si le prénom est connu |

## Décisions clés (non évidentes)
- **UUID dedup** : scopé par événement — même UUID dans deux groupes du même événement = ignoré (dedup protège contre les retries réseau, pas la multi-porte).
- **Opérations delta** (±1/±5) jamais état absolu → concurrent-safe sans verrou.
- **Queue localStorage** plutôt que Service Worker → meilleure compat Safari iOS, pas de build. Ancienne queue (format sans `e`) vidée automatiquement au démarrage.
- **UI optimiste** : total ET compteur groupe mis à jour immédiatement côté opérateur.
- **Persistance disk** toutes les 30s → résiste à un redémarrage serveur.
- **seenOps** trimmé à 10k entrées quand >20k → mémoire bornée.
- **Hiérarchie événement/groupe** : `state = {adminCode, events: {[id]: {capacity, history, groups: {[id]: GroupState}}}}`. Un groupe "Principal" auto-créé à la création d'un événement. Groupes supprimables sauf le dernier. Événement archivé → invisible, rejette les ops (404). History enregistre le total événement toutes les 30s.
- **Broadcast one-to-many** : un seul JSON par événement envoyé à tous les clients (opérateurs + admin). Chaque client extrait sa donnée groupe côté JS. Pas de personnalisation serveur → O(1) sérialisation.
- `Math.max(0, count + delta)` côté serveur ET client → jamais négatif.
- **Thème** : `prefers-color-scheme` sur les 3 pages. Graphique Chart.js mis à jour dynamiquement.
- **Bouton +1 plus large sur mobile** : `grid-template-columns: 1.18fr 1fr` sur `pointer: coarse`.
- **Identité opérateur** : overlay prénom à la première connexion, stocké `localStorage('op_name')`. `{type:'hello'}` envoyé à chaque reconnexion WS. Admin voit `{name, groupName}` en temps réel.
- **`pointerdown`** pour les boutons : capture chaque toucher avant la fusion navigateur sur mobile.
- **PWA** : `manifest.json` + `icon.svg`, `display: standalone`, `theme-color` adaptatif.

## Améliorations prévues

### U1 Garder l'écran allumé (Wake Lock)
- Utiliser l'API `navigator.wakeLock.request('screen')` dès que la page `index.html` est au premier plan.
- Réacquérir le lock après `visibilitychange` (l'OS le libère automatiquement quand l'onglet passe en arrière-plan).
- Fallback silencieux si l'API n'est pas supportée (pas d'erreur affichée à l'opérateur).

### U2 Bouton +1 plus grand en hauteur sur mobile
- Sur écrans tactiles (`pointer: coarse`), augmenter la hauteur minimale du bouton +1 (ex. `min-height: 30vh` ou valeur en `dvh`) pour qu'il soit plus facile à atteindre et à maintenir à un rythme soutenu.

### U3 Bouton admin (lien vers admin.html)
- Ajouter un bouton/icône discret sur `index.html` pointant vers `/admin.html` (ex. coin en bas à droite, icône engrenage).
- Le bouton reste visible mais non intrusif — l'admin peut naviguer sans mémoriser l'URL.

### U4 Persistance des opérateurs connectés (30 s)
- Problème actuel : si un opérateur perd brièvement le réseau (tunnel instable, WiFi coupé 2 s), il disparaît de la liste WS et son badge s'efface côté admin.
- Solution : garder un opérateur dans la liste pendant 30 s après sa déconnexion WS. Le serveur maintient un `Map<name, disconnectedAt>` ; il ne retire le nom du broadcast `clients` que si `Date.now() - disconnectedAt > 30_000`. À la reconnexion, la grâce est annulée immédiatement.

### ~~U5 Scanner le QR code depuis mobile (opérateur)~~ ✅ FAIT
- Sur `index.html`, ajouter un bouton "Scanner un QR code" (icône caméra) qui ouvre `navigator.mediaDevices` pour lire un QR code via la caméra arrière.
- Utile quand un opérateur rejoint en cours d'événement sans avoir l'URL : il scanne l'écran de l'admin au lieu de taper l'URL à la main.
- il peut passer d'un event à l'autre
- Bibliothèque légère : `jsQR` (CDN, ~35 KB) ou `ZXing-js`. Pas de build nécessaire.
- Fallback : si la caméra n'est pas disponible (desktop), masquer le bouton.

### ~~U6 Sessions de comptage multiples (admin)~~ ✅ FAIT
- Permettre de gérer plusieurs groupes (ex. "Entrée principale", "Entrée secondaire") depuis un seul serveur.
- Chaque session a son propre `count`, `capacity`, `history`, `opStats`, `adminCode`.
- Possibilité d'avoir un nombre aggrégé.
- API : ajouter un segment `sessionId` aux routes (`/api/:session/count`, etc.) ou un header.
- Admin : page de gestion des groupes — créer, renommer, archiver, changer de session active. Les opérateurs rejoignent une session via son QR code dédié.
- Complexité notable : le state devient `{sessions: {[id]: SessionState}}`, la persistance et les broadcasts sont scopés par session.

### ~~U7 Sessions de comptage différentes (admin)~~ ✅ FAIT (fusionné avec U6)
- Permettre de gérer plusieurs sessions indépendantes (ex. "Event 1", "Event 2") depuis un seul serveur.
- Chaque session a son propre `count`, `capacity`, `history`, `opStats`, `adminCode`.
- API : ajouter un segment `sessionId` aux routes (`/api/:session/count`, etc.) ou un header.
- Admin : page de gestion des sessions — créer, renommer, archiver, changer de session active. Les opérateurs rejoignent une session via son QR code dédié.
- Complexité notable : le state devient `{sessions: {[id]: SessionState}}`, la persistance et les broadcasts sont scopés par session.

### ~~U8 Export xlsx de la session (admin)~~ ✅ FAIT
- SheetJS CDN dans `admin.html` · bouton "⬇ Exporter XLSX" · 3 feuilles : Résumé, Historique, Groupes.

### ~~U9 Redéfinition du bouton remettre à zéro~~ PLUS D'ACTUALITE
- Remet le compteur à 0, efface l'historique, efface le seuil.

### U10 Graphiques par groupe

### U11 adapter le manifest.json
- Pour avoir une app "admin" logo +1 en rouge et une app "cliqueur" logo +1 en bleu

### ~~U12 Export CSV de l'historique (stats.html)~~ ✅ FAIT dans U8
- Ajouter un bouton "Exporter CSV" sur `stats.html` qui télécharge les données de `GET /api/history` (colonnes : horodatage, total).
- Inclure une colonne par groupe si des groupes existent.
- Pas de dépendance externe — `Blob` + `URL.createObjectURL` suffit.

### ~~U13 Confirmation avant changement de code admin~~ ✅ FAIT
- `<dialog>` natif dans `admin.html` · affiche le nouveau code avant confirmation.

### U14 Indicateur de synchronisation de la file d'attente
- Sur `index.html`, afficher une icône animée (spinner CSS) sur le badge de file d'attente pendant le flush vers le serveur.
- Disparaît une fois la file vide et la connexion rétablie.
- Renforce la confiance de l'opérateur sur les réseaux instables.

### ~~U15 Gestion des événements archivés (admin)~~ ✅ FAIT
- Section repliable dans `admin.html` · désarchiver + supprimer (avec `<dialog>`) · `POST /api/admin/config {deleteEvent:true}` · registre nettoyé.

### ~~U16 Nouveau rôle "PERM"~~ ✅ FAIT
- `permCode` dans RegistryDO + server.js · login détecte `role:perm` · UI masque capacité/reset/archive/code/perm/groupes-edit pour PERM · configurable via admin.

### T1 Cache QR code côté EventDO
- `GET /api/qr` régénère le SVG à chaque requête — coûteux.
- Stocker le résultat dans une propriété en mémoire de l'EventDO (`this._qrCache = {url, svg}`), invalidée uniquement si l'URL change (événement/groupe renommé).
- Réduction de latence sur admin avec QR affiché en permanence.

### ~~T2 Backoff exponentiel WS (toutes les pages)~~ ✅ FAIT
- `index.html`, `admin.html`, `stats.html` : 1s→2s→4s→…→30s max · reset à 1s sur succès ou changement d'événement.

### ~~T3 Rate limiting sur `/api/count` (Workers)~~ ✅ FAIT
- Token bucket dans `EventDO._rl` : capacity=2000, refill=20/s par IP (`cf-connecting-ip`) · HTTP 429 + `Retry-After: 1`.

### ~~B1 "Adresses Réseau" toujours indiquée~~ ✅ FAIT

### ~~B2: fond des boutons secondaires restent en foncé alors que le thème est clair~~ ✅ FAIT

### ~~I1 passer à un serveur en ligne (cloudflare)~~ ✅ FAIT
- `src/index.js` + `src/registry.js` + `src/event.js` — réécriture complète pour Cloudflare Workers.
- **RegistryDO** (singleton `registry`) : code admin, index léger des événements.
- **EventDO** (une instance par eventId, nommée par `idFromName(eventId)`) : état complet, WebSocket hibernation, alarme 30s pour l'historique.
- Le Worker vérifie le code admin contre RegistryDO avant toute route admin, puis délègue à EventDO sans re-vérification (sécurité au niveau du Worker).
- `GET /api/events` fan-out vers chaque EventDO en parallèle pour les totaux en temps réel.
- `/api/ips` retourne `{ips:[], port:443}` (sans utilité en cloud).
- QR code : `QRCode.toString(url, {type:'svg'})` → `data:image/svg+xml;base64,...` (sans Canvas).
- `seenOps` non persisté (comme local) — réinitialisé sur cold start DO (rare, acceptable).

## Démarrage
```bash
npm install
npm start          # serveur local — affiche les IPs réseau et le code admin
npm run cf:dev     # dev local avec wrangler (Workers + DOs simulés)
npm run deploy     # déploiement Cloudflare (wrangler login requis)
```

### Premier déploiement
```bash
npx wrangler login          # authentification Cloudflare (une seule fois)
npm run deploy              # build + upload + migration DO automatique
# URL affichée : https://compteur.<account>.workers.dev
```
Plan Workers Paid requis ($5/mois) pour les Durable Objects.

## Code admin par défaut
`admin123` — à changer via `/admin.html` avant l'événement.

## Limitations estimées

### Appareils connectés (WebSocket)
| Clients WS | Comportement |
|---|---|
| < 200 | Fluide, broadcast <1 ms |
| 200 – 500 | Acceptable, latence broadcast ~2-5 ms par op |
| > 500 | Broadcast O(n) devient sensible ; envisager throttle |
| > 2 000 | Risque OOM (~100 KB/client) sur machine 512 MB |

Le vrai goulot : chaque appui déclenche `broadcast()` qui itère **tous** les clients en boucle synchrone. Avec 100 opérateurs tapant à 2 taps/s + 100 clients WS → ~20 000 envois/s, gérable. À 500 opérateurs × 2 taps/s → 500 000 envois/s → saturation du event loop Node.js.

### Opérations (+1/−1)
| Volume | Comportement |
|---|---|
| < 100 ops/s | Imperceptible (typique pour un événement humain) |
| 100 – 500 ops/s | Toujours OK, Set.has/add O(1) |
| 500 – 5 000 ops/s | `trimSeenOps` à 20k → 10k déclenché souvent ; légère pause |
| > 10 000 ops/s | Saturation event loop, timeouts clients |

### Historique & mémoire
- `seenOps` Set : plafonné à ~20k UUID (~2 MB), trimmé automatiquement.
- `state.history` : plafonné à 2 880 points (24h à 30s). Environ 86 KB.
- `writeFileSync` toutes les 30s : bloque l'event loop ~1 ms (JSON de quelques KB) — non problématique.

### En pratique pour un événement type
Un PC modeste (2 cœurs, 1 GB RAM) tient sans problème **50 opérateurs simultanés** avec **100-200 spectateurs** connectés. Limite réelle : le WiFi et le débit upload du PC hôte, pas Node.js.

## Déploiement
- **Local** : PC sur le même WiFi que les opérateurs. `npm start` → URL `http://<IP>:3000`.
- **Cloudflare Workers** : `npm run deploy` → URL `https://compteur.<account>.workers.dev`. Plan Paid requis (Durable Objects).
