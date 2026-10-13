// Injecté par le harnais au tout début de chaque page : journalise fetch / WebSocket, et
// permet de simuler l'avis du navigateur sur le réseau (window.__lab.onLine = true | false ;
// null = la vraie valeur). Ne change rien au comportement de la page.
(function () {
  if (window.__lab) return;
  const post = (m) => { try { window.webkit.messageHandlers.lab.postMessage(String(m)); } catch (e) {} };
  const lab = window.__lab = { t0: Date.now(), fetches: [], ws: [], onLine: null, post };
  try { if (!localStorage.getItem('op_name')) localStorage.setItem('op_name', 'Banc'); } catch (e) {}

  const real = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
  Object.defineProperty(Navigator.prototype, 'onLine', {
    configurable: true,
    get() { return lab.onLine === null ? real.get.call(this) : lab.onLine; },
  });

  const realFetch = window.fetch;
  let n = 0;
  window.fetch = function (input, init) {
    const rec = {
      id: ++n, url: typeof input === 'string' ? input : input.url,
      method: (init && init.method) || 'GET', started: Date.now(), state: 'en cours',
    };
    lab.fetches.push(rec);
    if (init && init.signal) init.signal.addEventListener('abort', () => { rec.abortedAt = Date.now(); });
    const p = realFetch.apply(this, arguments);
    p.then((res) => { rec.state = 'en-têtes ' + res.status; rec.headersAt = Date.now(); },
           (e) => { rec.state = 'rejeté ' + e.name + ' « ' + e.message + ' »'; rec.endedAt = Date.now(); });
    return p;
  };

  const RealWS = window.WebSocket;
  const SuiviWS = function (url, protocols) {
    const ws = protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
    const rec = { created: Date.now(), state: 'connexion' };
    lab.ws.push(rec);
    ws.addEventListener('open', () => { rec.state = 'ouvert'; });
    ws.addEventListener('close', (e) => { rec.state = 'fermé ' + e.code; });
    return ws;
  };
  SuiviWS.prototype = RealWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) SuiviWS[k] = RealWS[k];
  window.WebSocket = SuiviWS;

  window.addEventListener('error', (e) => post('ERREUR dans la page : ' + e.message + ' (ligne ' + e.lineno + ')'));
  window.addEventListener('unhandledrejection', (e) => post('REJET non géré : ' + ((e.reason && e.reason.message) || e.reason)));

  // État de l'écran opérateur (les `let` globaux du script de la page sont visibles d'ici).
  lab.snap = function () {
    const s = (t) => ((t - lab.t0) / 1000).toFixed(1);
    const lire = (expr) => { try { return (0, eval)(expr); } catch (e) { return null; } };
    const badge = document.getElementById('queue-badge');
    return {
      file: lire('queue.length'), occupe: lire('flushBusy()'),
      hidden: document.hidden, onLine: navigator.onLine,
      point: (document.getElementById('dot') || {}).className,
      badge: badge && badge.style.display !== 'none' ? badge.textContent : '',
      total: (document.getElementById('count') || {}).textContent,
      sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      wsOuvert: lab.ws.length > 0 && lab.ws[lab.ws.length - 1].state === 'ouvert',
      wsEssais: lab.ws.length, wsDernier: lab.ws.length ? lab.ws[lab.ws.length - 1].state : '',
      fetch: lab.fetches.slice(-6).map((f) =>
        `${f.method} ${f.url.replace(/\?.*/, '')} à ${s(f.started)} s → ${f.state}` +
        (f.abortedAt ? ` [abandonnée par la page à ${((f.abortedAt - f.started) / 1000).toFixed(1)} s]` : '')),
    };
  };
})();
