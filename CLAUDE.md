# Compteur Événement

## Stack
Node.js 18+ · Express · ws (WebSocket) · qrcode · Chart.js (CDN) · Vanilla JS — no build step.

## Files
| Fichier | Rôle |
|---|---|
| `server.js` | Serveur HTTP + WebSocket, état, API |
| `public/index.html` | Page compteur (opérateurs) : +1/−1/+5/−5 |
| `public/admin.html` | Panel admin : QR code, capacité, reset, code |
| `public/stats.html` | Graphiques temps réel (Chart.js) |
| `state.json` | État persisté automatiquement (ne pas éditer à la main) |

## API
```
POST /api/count              {delta: ±1|±5, uuid: string} → {count, dup?, alert?}
GET  /api/state              → {count, capacity}
GET  /api/history?code=X     → {history:[{t,c}], count, capacity, totalIn, totalOut}
POST /api/admin/config       {code, capacity?, newCode?, reset?} → {ok, capacity}
GET  /api/qr?code=X          → {qr: dataURL, url}
GET  /api/ips?code=X         → {ips: string[], port}
```

## WebSocket (server → clients)
| type | champs | déclencheur |
|---|---|---|
| `init` | count, capacity | connexion d'un client |
| `update` | count, delta, alert, capacity | opération reçue |
| `config` | capacity | changement de config admin |

## Décisions clés (non évidentes)
- **UUID dedup** : chaque tap génère un UUID unique. Le serveur ignore les doublons → pas de double-comptage en cas de retry réseau.
- **Opérations delta** (±1/±5) jamais état absolu → concurrent-safe sans verrou.
- **Queue localStorage** plutôt que Service Worker → meilleure compat Safari iOS, pas de build.
- **UI optimiste** : compte mis à jour immédiatement, corrigé si le serveur diverge.
- **Persistance disk** toutes les 30s → résiste à un redémarrage serveur en cours d'événement.
- **seenOps** trimmé à 10k entrées quand >20k → mémoire bornée pour les longues soirées.
- `Math.max(0, count + delta)` côté serveur ET client → jamais négatif.

## Démarrage
```bash
npm install
npm start
# Affiche les IPs réseau locales et le code admin au démarrage
```

## Code admin par défaut
`admin123` — à changer via `/admin.html` avant l'événement.

## Déploiement
- **Local (recommandé)** : PC sur le même WiFi que les opérateurs. L'URL est `http://<IP>:3000`.
- **Render** : ajouter variable d'env `PORT` (auto-injectée). WebSocket supporté en paid tier.
- **Cloudflare Workers** : nécessite une réécriture avec Durable Objects pour le state WS — hors scope actuel.
