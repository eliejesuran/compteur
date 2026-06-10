# Compteur Événement

## Stack
Node.js 18+ · Express · ws (WebSocket) · qrcode · Chart.js (CDN) · Vanilla JS — no build step.

## Files
| Fichier | Rôle |
|---|---|
| `server.js` | Serveur HTTP + WebSocket, état, API |
| `public/index.html` | Page compteur (opérateurs) : +1/−1/+5/−5 |
| `public/admin.html` | Panel admin : QR code, capacité, reset, code |
| `public/stats.html` | Graphiques temps réel (Chart.js) + stats par opérateur |
| `public/manifest.json` | Manifest PWA — installable sur mobile |
| `public/icon.svg` | Icône de l'app (PWA) |
| `state.json` | État persisté automatiquement (ne pas éditer à la main) |

## API
```
POST /api/count              {delta: ±1|±5, uuid: string, name?: string} → {count, dup?, alert?}
GET  /api/state              → {count, capacity}
GET  /api/history?code=X     → {history:[{t,c}], count, capacity, totalIn, totalOut, opStats}
GET  /api/clients?code=X     → {clients:[{name, connectedAt}]}
POST /api/admin/config       {code, capacity?, newCode?, reset?} → {ok, capacity}
GET  /api/qr?code=X          → {qr: dataURL, url}
GET  /api/ips?code=X         → {ips: string[], port}
```

## WebSocket (server → clients)
| type | champs | déclencheur |
|---|---|---|
| `init` | count, capacity, opStats | connexion d'un client |
| `update` | count, delta, alert, capacity, opStats | opération reçue |
| `config` | capacity | changement de config admin |
| `clients` | names: string[] | connexion ou déconnexion d'un opérateur nommé |

## WebSocket (client → server)
| type | champs | moment |
|---|---|---|
| `hello` | name: string | juste après `ws.onopen`, si le prénom est connu |

## Décisions clés (non évidentes)
- **UUID dedup** : chaque tap génère un UUID unique. Le serveur ignore les doublons → pas de double-comptage en cas de retry réseau.
- **Opérations delta** (±1/±5) jamais état absolu → concurrent-safe sans verrou.
- **Queue localStorage** plutôt que Service Worker → meilleure compat Safari iOS, pas de build.
- **UI optimiste** : compte mis à jour immédiatement, corrigé si le serveur diverge.
- **Persistance disk** toutes les 30s → résiste à un redémarrage serveur en cours d'événement.
- **seenOps** trimmé à 10k entrées quand >20k → mémoire bornée pour les longues soirées.
- `Math.max(0, count + delta)` côté serveur ET client → jamais négatif.
- **Thème** : suit automatiquement le thème OS via `prefers-color-scheme`. Variables CSS redéfinies dans `@media (prefers-color-scheme: light)` sur les 3 pages. Les couleurs du graphique Chart.js sont recalculées via `chartPalette()` et mises à jour dynamiquement si le thème change pendant la session.
- **Bouton +1 plus large sur mobile** : sur écrans tactiles (`pointer: coarse`), la grille des boutons principaux passe à `grid-template-columns: 1.18fr 1fr` → le bouton +1 est ~18 % plus large que −1. Choix intentionnel : l'entrée est l'action principale.
- **Identité opérateur** : à la première connexion, un overlay plein écran demande le prénom. Stocké dans `localStorage('op_name')`. Envoyé au serveur via `{type:'hello', name}` à chaque reconnexion WS. Le serveur tient un `Map<ws, {name, connectedAt}>` et broadcast `{type:'clients', names:[]}` dès qu'un opérateur se connecte ou déconnecte. L'admin voit la liste en temps réel. Les noms sont dédupliqués (plusieurs onglets = 1 seul badge).
- **Stats par opérateur** : `POST /api/count` accepte un champ `name` optionnel. Le serveur agrège dans `state.opStats = {[name]: {in, out}}` et le broadcast dans chaque message `update` et `init`. `stats.html` affiche un tableau par opérateur trié par entrées décroissantes, mis à jour en temps réel. Le nom vient du `localStorage('op_name')` déjà connu.
- **`pointerdown` pour les boutons** : les 4 boutons (+1/−1/+5/−5) utilisent `pointerdown` au lieu de `click`. Sur mobile, les taps rapides peuvent être fusionnés ou abandonnés par le navigateur au niveau `click` ; `pointerdown` capture chaque toucher immédiatement. `e.preventDefault()` bloque le `click` fantôme qui suivrait. Classe `.tapping` gérée manuellement pour le retour visuel (`:active` peut ne pas déclencher avec `preventDefault()` sur iOS).
- **PWA** : `manifest.json` + `icon.svg` déclarent l'app installable sur Android/iOS. `theme-color` adapté au mode clair/sombre sur chaque page. L'app s'ouvre en `display: standalone` (sans barre d'URL) une fois installée.

## Améliorations prévues

### Garder l'écran allumé (Wake Lock)
- Utiliser l'API `navigator.wakeLock.request('screen')` dès que la page `index.html` est au premier plan.
- Réacquérir le lock après `visibilitychange` (l'OS le libère automatiquement quand l'onglet passe en arrière-plan).
- Fallback silencieux si l'API n'est pas supportée (pas d'erreur affichée à l'opérateur).

### Bouton +1 plus haut sur mobile
- Sur écrans tactiles (`pointer: coarse`), augmenter la hauteur minimale du bouton +1 (ex. `min-height: 30vh` ou valeur en `dvh`) pour qu'il soit plus facile à atteindre et à maintenir à un rythme soutenu.

### Bouton admin (lien vers admin.html)
- Ajouter un bouton/icône discret sur `index.html` pointant vers `/admin.html` (ex. coin en bas à droite, icône engrenage).
- Le bouton reste visible mais non intrusif — l'admin peut naviguer sans mémoriser l'URL.

### Persistance des opérateurs connectés (30 s)
- Problème actuel : si un opérateur perd brièvement le réseau (tunnel instable, WiFi coupé 2 s), il disparaît de la liste WS et son badge s'efface côté admin.
- Solution : garder un opérateur dans la liste pendant 30 s après sa déconnexion WS. Le serveur maintient un `Map<name, disconnectedAt>` ; il ne retire le nom du broadcast `clients` que si `Date.now() - disconnectedAt > 30_000`. À la reconnexion, la grâce est annulée immédiatement.

### Scanner le QR code depuis mobile (opérateur)
- Sur `index.html`, ajouter un bouton "Scanner un QR code" (icône caméra) qui ouvre `navigator.mediaDevices` pour lire un QR code via la caméra arrière.
- Utile quand un opérateur rejoint en cours d'événement sans avoir l'URL : il scanne l'écran de l'admin au lieu de taper l'URL à la main.
- Bibliothèque légère : `jsQR` (CDN, ~35 KB) ou `ZXing-js`. Pas de build nécessaire.
- Fallback : si la caméra n'est pas disponible (desktop), masquer le bouton.

### Sessions de comptage multiples (admin)
- Permettre de gérer plusieurs sessions indépendantes (ex. "Entrée principale", "Entrée secondaire") depuis un seul serveur.
- Chaque session a son propre `count`, `capacity`, `history`, `opStats`, `adminCode`.
- API : ajouter un segment `sessionId` aux routes (`/api/:session/count`, etc.) ou un header.
- Admin : page de gestion des sessions — créer, renommer, archiver, changer de session active. Les opérateurs rejoignent une session via son QR code dédié.
- Complexité notable : le state devient `{sessions: {[id]: SessionState}}`, la persistance et les broadcasts sont scopés par session.

## Démarrage
```bash
npm install
npm start
# Affiche les IPs réseau locales et le code admin au démarrage
```

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
- **Local (recommandé)** : PC sur le même WiFi que les opérateurs. L'URL est `http://<IP>:3000`.
- **Render** : ajouter variable d'env `PORT` (auto-injectée). WebSocket supporté en paid tier.
- **Cloudflare Workers** : nécessite une réécriture avec Durable Objects pour le state WS — hors scope actuel.
