'use strict';

// Contrats STATIQUES : ce qui se vérifie en lisant les fichiers, sans rien exécuter.
// Le projet tient plusieurs choses alignées « à la main » (constantes dupliquées entre
// le serveur local et le Worker, empreintes SRI, attributs des champs « code »…) et
// plusieurs régressions passées ne cassaient rien de visible : script bloqué en silence,
// invite d'enregistrement du mot de passe, 403 sur un code contenant un `&`.
// Ces tests rendent l'oubli bruyant.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8');

const SERVER   = lire('server.js');
const EVENT    = lire('src', 'event.js');
const REGISTRY = lire('src', 'registry.js');
const PAGES    = Object.fromEntries(['index.html', 'admin.html', 'stats.html', 'guide.html'].map((f) => [f, lire('public', f)]));

// Valeur d'un `const NOM = <expression numérique>;` (ex. `30 * 1000`, `5 * 60 * 1000`).
function constante(source, nom) {
  const m = source.match(new RegExp(`^const ${nom}\\s*=\\s*([0-9_ *+]+);`, 'm'));
  assert.ok(m, `constante ${nom} introuvable`);
  return m[1].replace(/_/g, '').split('*').reduce((p, f) => p * Number(f.trim()), 1);
}

// Le script en ligne principal d'une page (celui qui commence par 'use strict').
const script = (page) => [...PAGES[page].matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('\'use strict\'')) ?? '';
// Le HTML seul : sans scripts, sans feuilles de style (qui stylent `input[type=password]`
// pour le repli Firefox), sans commentaires.
const balisage = (page) => PAGES[page].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');

// ── Constantes dupliquées ────────────────────────────────────────────────────

describe('Constantes alignées entre le serveur local et le Worker', () => {
  for (const nom of ['MAX_GROUPS', 'MAX_OPS', 'MAX_UUID_LEN', 'MAX_HISTORY', 'FINE_INTERVAL_MS', 'MAX_HISTORY_COARSE', 'COARSE_INTERVAL_MS', 'RL_CAPACITY', 'RL_RATE']) {
    test(`${nom} : server.js = src/event.js`, () => {
      assert.equal(constante(SERVER, nom), constante(EVENT, nom));
    });
  }

  test('MAX_EVENTS : server.js = src/registry.js', () => {
    assert.equal(constante(SERVER, 'MAX_EVENTS'), constante(REGISTRY, 'MAX_EVENTS'));
  });

  test('server.js exporte bien les valeurs que son source déclare', () => {
    process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'compteur-statique-')), 'state.json');
    const srv = require('../server');
    for (const nom of ['MAX_HISTORY', 'FINE_INTERVAL_MS', 'MAX_HISTORY_COARSE', 'COARSE_INTERVAL_MS']) {
      assert.equal(srv[nom], constante(SERVER, nom), nom);
    }
  });

  // L'onglet « Résumé » de l'export et le guide annoncent la résolution et la rétention
  // en clair : à réécrire si la cadence change.
  test('l\'export XLSX annonce la vraie résolution et la vraie rétention des deux séries', () => {
    const fin   = constante(SERVER, 'FINE_INTERVAL_MS'), gros = constante(SERVER, 'COARSE_INTERVAL_MS');
    const admin = script('admin.html');
    assert.ok(admin.includes(`1 point / ${fin / 1000} secondes — ${(constante(SERVER, 'MAX_HISTORY') * fin) / 3600_000} h glissantes`), 'série détaillée');
    assert.ok(admin.includes(`1 point / ${gros / 60_000} minutes — ${(constante(SERVER, 'MAX_HISTORY_COARSE') * gros) / 86_400_000} jours glissants`), 'série long terme');
  });

  test('les mêmes plafonds de saisie des deux côtés : 40 caractères pour un nom, 32 pour un prénom, code de 4 caractères mini', () => {
    for (const [nom, source] of [['server.js', SERVER], ['src/event.js', EVENT]]) {
      assert.ok(source.includes('.slice(0, 40)'), `${nom} : nom d'événement / de groupe`);
      assert.ok(source.includes('.slice(0, 32)'), `${nom} : prénom d'opérateur`);
    }
    assert.ok(SERVER.includes('newCode.length >= 4') && lire('src', 'index.js').includes('newCode.length >= 4'), 'code admin');
    assert.ok(SERVER.includes('newPermCode.length >= 4') && REGISTRY.includes('c.length >= 4'), 'code PERM');
    assert.ok(script('index.html').includes('.slice(0, 32)'), 'index.html : prénom');
  });
});

// ── Déploiement Cloudflare ───────────────────────────────────────────────────

describe('wrangler.jsonc', () => {
  const conf = JSON.parse(lire('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));

  // Sans lui, Workers Assets sert index.html (200) avant le Worker : l'upgrade WebSocket
  // reçoit du HTML au lieu du 101 → tous les opérateurs hors ligne en production.
  test('run_worker_first: true', () => {
    assert.equal(conf.assets.run_worker_first, true);
    assert.equal(conf.assets.directory, './public');
    assert.equal(conf.assets.binding, 'ASSETS');
  });

  test('les deux Durable Objects sont liés et migrés en stockage SQLite', () => {
    assert.deepEqual(conf.durable_objects.bindings.map((b) => [b.name, b.class_name]).sort(), [['EVENT', 'EventDO'], ['REGISTRY', 'RegistryDO']]);
    assert.deepEqual([...conf.migrations.flatMap((m) => m.new_sqlite_classes ?? [])].sort(), ['EventDO', 'RegistryDO']);
    assert.equal(conf.main, 'src/index.js');
    assert.ok(conf.compatibility_flags.includes('nodejs_compat'), 'requis par la lib qrcode');
  });
});

// ── Dépendances externes ─────────────────────────────────────────────────────

describe('Scripts externes (CDN)', () => {
  const externes = Object.entries(PAGES).flatMap(([page, html]) =>
    [...html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"[^>]*>/g)].map((m) => ({ page, tag: m[0], src: m[1] })));

  test('exactement les quatre bibliothèques connues, chacune sur sa page', () => {
    assert.deepEqual(externes.map((s) => `${s.page} ${s.src}`).sort(), [
      'admin.html https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
      'index.html https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
      'index.html https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js',
      'stats.html https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    ]);
  });

  // Un `integrity` faux ne casse rien de visible : le script est bloqué en silence. Et une
  // version flottante (`@4`) change de contenu sans prévenir : l'empreinte ne tient plus.
  test('chacune : version épinglée, empreinte sha384, crossorigin="anonymous"', () => {
    for (const { tag, src } of externes) {
      assert.match(src, /(@|-)\d+\.\d+\.\d+\//, `${src} : version exacte attendue`);
      assert.match(tag, /\sintegrity="sha384-[A-Za-z0-9+/]{64}"/, `${src} : SRI manquant ou malformé`);
      assert.match(tag, /\scrossorigin="anonymous"/, `${src} : crossorigin manquant`);
    }
  });

  test('aucune autre ressource externe : feuilles de style, polices, images, iframes', () => {
    for (const [page, html] of Object.entries(PAGES)) {
      const autres = [...html.matchAll(/<(?:link|img|iframe|source|video|audio)\b[^>]*\b(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(autres, [], `${page} dépend d'une ressource externe`);
      assert.ok(!/@import\s+url\(|url\(\s*['"]?https?:/.test(html), `${page} : CSS externe`);
    }
  });

  test('le guide ne dépend d\'aucun script, même en ligne', () => {
    assert.ok(!/<script/i.test(PAGES['guide.html']));
  });
});

// ── Champs « code » ──────────────────────────────────────────────────────────

describe('Champs « code » (admin.html, stats.html)', () => {
  // Un vrai champ password fait proposer « Enregistrer le mot de passe ? » à chaque
  // connexion ; un <form> ou autocomplete="current-password" aussi.
  for (const page of ['admin.html', 'stats.html']) {
    test(`${page} : ni type=password, ni <form>, ni autocomplete de mot de passe dans le HTML`, () => {
      const html = balisage(page);
      assert.ok(!/type\s*=\s*["']?password/i.test(html), 'type=password');
      assert.ok(!/<form\b/i.test(html), '<form>');
      assert.ok(!/autocomplete\s*=\s*["'](current|new)-password/i.test(html), 'autocomplete de mot de passe');
    });

    // Attributs obligatoires, pas cosmétiques : sans autocapitalize="off", iOS met une
    // majuscule au premier caractère et le code, sensible à la casse, est refusé.
    test(`${page} : chaque champ .secret est un texte masqué avec tous ses attributs`, () => {
      const champs = [...balisage(page).matchAll(/<input\b[^>]*\bclass="secret"[^>]*>/g)].map((m) => m[0]);
      assert.equal(champs.length, page === 'admin.html' ? 4 : 1, 'nombre de champs « code »');
      for (const c of champs) {
        for (const attr of ['type="text"', 'autocomplete="off"', 'autocapitalize="off"', 'autocorrect="off"', 'spellcheck="false"', 'data-1p-ignore', 'data-lpignore="true"', 'data-bwignore']) {
          assert.ok(c.includes(attr), `${attr} manquant sur ${c.match(/id="[^"]+"/)?.[0]}`);
        }
      }
      assert.match(PAGES[page], /-webkit-text-security:\s*disc/, 'masquage CSS');
      assert.match(script(page), /function maskSecretFields\(\)/, 'repli Firefox');
    });
  }
});

// ── Query strings ────────────────────────────────────────────────────────────

describe('Requêtes des pages', () => {
  // Le code admin est libre : interpolé brut, un `&`, `+`, `#` ou une espace coupe l'URL.
  for (const page of ['admin.html', 'stats.html']) {
    test(`${page} : le code n'est jamais interpolé brut dans une URL`, () => {
      const js = script(page);
      const bruts = [...js.matchAll(/[?&]code=\$\{(?!encodeURIComponent\()[^}]*\}/g)].map((m) => m[0]);
      assert.deepEqual(bruts, []);
      // Toute URL d'API à paramètres passe par qs() ou encodeURIComponent().
      const urls = [...js.matchAll(/`\/api\/[a-z/-]+\?([^`]*)`/g)].map((m) => m[1]);
      assert.ok(urls.length >= 2);
      for (const u of urls) assert.match(u, /^\$\{qs\(|^code=\$\{encodeURIComponent\(/, `query non encodée : ?${u}`);
    });
  }

  test('index.html : e et g toujours encodés dans les URL', () => {
    const js = script('index.html');
    const bruts = [...js.matchAll(/[?&][eg]=\$\{(?!encodeURIComponent\()[^}]*\}/g)].map((m) => m[0]);
    assert.deepEqual(bruts, []);
  });

  // Le code ne doit pas voyager dans une URL de NAVIGATION (historique, Referer).
  test('aucune navigation ne transporte le code admin', () => {
    for (const page of ['admin.html', 'stats.html']) {
      const navs = [...script(page).matchAll(/(?:location\.href|\.href)\s*=\s*([^;\n]+)/g)].map((m) => m[1]);
      for (const n of navs) assert.ok(!/\b(code|adminCode)\b/.test(n), `${page} : ${n}`);
    }
  });

  test('admin.html : /api/history n\'apparaît que dans exportXLSX()', () => {
    const js = script('admin.html');
    const avant = js.slice(0, js.indexOf('async function exportXLSX'));
    assert.ok(!/fetchT\([^)]*\/api\/history/.test(avant), 'appel à /api/history hors export');
    assert.equal([...js.matchAll(/fetchT\(`\/api\/history/g)].length, 1);
  });
});

// ── Gestionnaires en ligne et injection ──────────────────────────────────────

describe('HTML généré par les pages', () => {
  // esc() produit &#39; pour une apostrophe, que le parseur HTML redécode AVANT l'analyse
  // du JS d'un attribut d'événement : la chaîne se referme trop tôt, le bouton est inerte.
  test('aucun attribut on…= généré par le script n\'interpole autre chose qu\'un identifiant', () => {
    for (const page of ['index.html', 'admin.html', 'stats.html']) {
      const interpoles = [...script(page).matchAll(/\son\w+="[^"`]*\$\{([^}]+)\}/g)].map((m) => m[1].trim());
      for (const expr of interpoles) assert.match(expr, /^esc\(\w+\.id\)$/, `${page} : \${${expr}} dans un gestionnaire en ligne`);
    }
  });

  test('tout nom affiché dans du HTML généré passe par esc()', () => {
    for (const page of ['admin.html', 'stats.html']) {
      const lignes = script(page).split('\n').filter((l) => /<\/?[a-z]+[\s>]/.test(l));
      const nus = lignes.flatMap((l) => [...l.matchAll(/\$\{(?!esc\()([^}]*\b(?:name|groupName|eventName|url)\b[^}]*)\}/g)].map((m) => m[1].trim()));
      assert.deepEqual(nus, [], `${page} : interpolation non échappée`);
    }
  });

  test('index.html n\'écrit jamais un nom reçu du serveur en innerHTML', () => {
    const js = script('index.html');
    const ecritures = [...js.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(ecritures, ['qr.createSvgTag(4, 2)'], 'seul le SVG du QR est injecté');
  });
});

// ── Décisions de conception à ne pas défaire ─────────────────────────────────

describe('Décisions à ne pas défaire', () => {
  // Jugé trop anxiogène : l'alerte = vibration + bip une fois + chiffre et barre rouges.
  test('index.html : pas de fond rouge plein écran ni d\'animation en boucle', () => {
    const html = PAGES['index.html'];
    assert.ok(!/alert-overlay|pulse-red/.test(html));
    assert.deepEqual([...html.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]), ['bump']);
    assert.ok(!/animation:[^;]*infinite/.test(html), 'aucune animation infinie');
  });

  test('index.html : pas de compteur « total / capacité » en texte dans le bandeau', () => {
    assert.ok(!/cap-label/.test(PAGES['index.html']));
  });

  // Masqué par Elie (f6e083c). loadIPs() doit rester un no-op tant que le div est commenté.
  test('admin.html : le bloc des adresses réseau reste commenté, et loadIPs() gardé', () => {
    assert.ok(!/id="ip-list"/.test(balisage('admin.html')), 'le <div id="ip-list"> a été décommenté');
    assert.match(PAGES['admin.html'], /<!--\s*div id="ip-list"><\/div\s*-->/);
    assert.match(script('admin.html'), /async function loadIPs\(\) \{\s*const el = document\.getElementById\('ip-list'\);\s*if \(!el \|\|/);
  });

  // La file d'attente reste en localStorage : Background Sync n'existe pas sur Safari iOS.
  test('la file d\'attente n\'est pas déléguée au service worker', () => {
    const sw = lire('public', 'sw.js');
    assert.ok(!/addEventListener\(\s*['"](sync|periodicsync)['"]/.test(sw));
    assert.ok(!/\/api\//.test(sw.replace(/\/\/.*$/gm, '')), 'sw.js ne doit mentionner aucune route d\'API hors commentaires');
  });

  test('le service worker n\'est enregistré que par l\'écran opérateur', () => {
    assert.match(script('index.html'), /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
    for (const page of ['admin.html', 'stats.html']) assert.ok(!/serviceWorker/.test(PAGES[page]), page);
  });
});

// ── PWA ──────────────────────────────────────────────────────────────────────

describe('Manifestes PWA', () => {
  for (const [fichier, depart] of [['manifest.json', '/'], ['manifest-admin.json', '/admin.html']]) {
    test(`${fichier} : JSON valide, démarre sur ${depart}, icônes présentes`, () => {
      const m = JSON.parse(lire('public', fichier));
      assert.equal(m.start_url, depart);
      assert.equal(m.display, 'standalone');
      assert.ok(m.name && m.icons.length >= 1);
      for (const icone of m.icons) assert.ok(fs.existsSync(path.join(RACINE, 'public', icone.src)), `${icone.src} introuvable`);
    });
  }

  test('chaque page pointe vers un manifeste et des logos qui existent', () => {
    for (const [page, html] of Object.entries(PAGES)) {
      const locaux = [...html.matchAll(/<(?:link|img)\b[^>]*\b(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
      for (const f of locaux) assert.ok(fs.existsSync(path.join(RACINE, 'public', f)), `${page} → ${f} introuvable`);
    }
  });
});

// ── Dépôt ────────────────────────────────────────────────────────────────────

describe('Dépôt', () => {
  test('.gitignore couvre l\'état local et ses variantes', () => {
    const ignores = lire('.gitignore').split('\n').map((l) => l.trim());
    for (const motif of ['state.json', 'state.json.tmp', 'state.json.corrupt-*', 'node_modules/', '.wrangler/']) {
      assert.ok(ignores.includes(motif), `${motif} absent de .gitignore`);
    }
  });

  test('les scripts npm de test ramassent tous les fichiers de test', () => {
    const pkg = JSON.parse(lire('package.json'));
    assert.equal(pkg.scripts['test:local'], 'node --test tests/*.test.js');
    assert.match(lire('vitest.config.mjs'), /include:\s*\['tests\/worker\/\*\*\/\*\.test\.js'\]/);
    const locaux = fs.readdirSync(path.join(RACINE, 'tests')).filter((f) => f.endsWith('.test.js'));
    const worker = fs.readdirSync(path.join(RACINE, 'tests', 'worker')).filter((f) => f.endsWith('.test.js'));
    assert.ok(locaux.length >= 2 && worker.length >= 1);
    // Un fichier de test rangé ailleurs (tests/shared/…) ne serait jamais exécuté.
    const egares = fs.readdirSync(path.join(RACINE, 'tests', 'shared')).filter((f) => /\.test\./.test(f));
    assert.deepEqual(egares, []);
  });
});
