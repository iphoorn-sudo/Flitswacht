// Flitswacht service worker — cachet uitsluitend de app-shell, zodat de app offline start.
// GEEN kaarttegels cachen of vooraf ophalen (A1.5): tegels en Overpass (andere origin) worden niet onderschept;
// de browser-HTTP-cache regelt die (OSM-tegelbeleid).
//
// Versiebeheer zonder build-stap (U9) en atomair (N7):
// - De shell staat in een cache met versienaam `flitswacht-shell-<stempel>`. Welke cache actief is, staat in één
//   wijzer-item in de cache 'flitswacht-meta'. Alle verzoeken worden uit de ACTIEVE cache bediend (cache-first).
// - Een update (inhoud gewijzigd) of een nieuwe sw.js schrijft eerst ALLES in een NIEUWE cache. Pas als die compleet
//   is én de pagina opnieuw navigeert (herladen / "Bijwerken", R4), wordt de wijzer in één put() omgezet. Breekt iOS de worker halverwege af, dan
//   blijft de wijzer op de oude, complete cache staan; de halve nieuwe wordt later opgeruimd. Nooit gemengd.
// - De "versie" is de inhoud zelf: vergeten op te hogen kan niet. SCHEMA alleen ophogen als de opbouw verandert.

const SCHEMA = 'fw-shell-3';
const PREFIX = 'flitswacht-shell-';
const META = 'flitswacht-meta';
const POINTER = 'https://flitswacht.invalid/__active-shell';
const PENDING = 'https://flitswacht.invalid/__pending-shell';   // nieuwe sw.js: actief bij activate
const READY = 'https://flitswacht.invalid/__ready-shell';       // nieuwe inhoud: actief bij volgende navigatie

// Moet volledig lukken, anders faalt de installatie (U10) en blijft de vorige werkende versie actief.
const CORE = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'js/app.js',
  'js/ui/settings.js',
  'js/ui/sound.js',
  'js/ui/hud.js',
  'js/ui/map.js',
  'js/ui/icons.js',
  'js/ui/wake.js',
  'js/ui/sim.js',
  'js/ui/reports-ui.js',
  'js/core/geo.js',
  'js/core/gpsfilter.js',
  'js/core/matcher.js',
  'js/core/alerts.js',
  'js/core/section.js',
  'js/core/region.js',
  'js/data/overpass.js',
  'js/data/store.js',
  'js/data/provider.js',
  'js/data/geoutil.js',
  'js/data/link.js',
  'js/data/reports.js',
];
// Mag ontbreken zonder dat de app kapot gaat.
const OPTIONAL = [
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
];

const abs = (p) => new URL(p, self.registration.scope).href;
const newName = () => `${PREFIX}${SCHEMA}-${Date.now().toString(36)}`;

async function readPtr(key) {
  const meta = await caches.open(META);
  const r = await meta.match(key);
  return r ? r.text() : null;
}
async function writePtr(key, name) {
  const meta = await caches.open(META);
  if (name == null) await meta.delete(key);
  else await meta.put(key, new Response(name, { headers: { 'Content-Type': 'text/plain' } }));
}
let activeName = null;
async function activeCache() {
  if (!activeName) activeName = await readPtr(POINTER);
  return activeName ? caches.open(activeName) : null;
}
/** Alle shell-caches behalve `keep` verwijderen (ook halve, afgebroken updates). */
async function prune(keep) {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith('flitswacht-') && k !== META && !keep.includes(k)).map((k) => caches.delete(k)));
}

/**
 * Vult een NIEUWE cache met de volledige shell. Gooit als een CORE-bestand niet lukt (U10) — dan wordt de
 * halve cache weggegooid en blijft alles bij het oude.
 */
async function buildCache(name, fetchMode) {
  const cache = await caches.open(name);
  try {
    await cache.addAll(CORE.map((p) => new Request(abs(p), { cache: fetchMode })));
    await Promise.all(OPTIONAL.map(async (p) => {
      try { const res = await fetch(abs(p), { cache: fetchMode }); if (res.ok) await cache.put(abs(p), res); } catch { /* optioneel */ }
    }));
  } catch (e) {
    await caches.delete(name);
    throw e;
  }
  return cache;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const name = newName();
    await buildCache(name, 'reload');
    // Nog NIET omschakelen: dat gebeurt in activate (de oude worker kan nog pagina's bedienen).
    await writePtr(PENDING, name);
    // Eerste installatie: meteen actief. Bij een update wachten tot de gebruiker kiest (nooit midden in een rit).
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const pending = await readPtr(PENDING);
    if (pending && (await caches.has(pending))) {
      await writePtr(POINTER, pending);       // één put: atomaire omschakeling
      activeName = pending;
    }
    await writePtr(PENDING, null);
    const active = await readPtr(POINTER);
    await prune(active ? [active] : []);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// --- achtergrond-update ----------------------------------------------------------------------------
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

let lastCheck = 0;
let checking = null;
/**
 * Vergelijkt de shell met het netwerk. Bij een verschil: volledige nieuwe cache bouwen en als READY klaarzetten.
 * R4: NIET omschakelen terwijl een pagina draait; dat gebeurt pas bij de volgende navigatie (herladen / "Bijwerken").
 * Hooguit eens per 30 s, en pas 10 s na een navigatie.
 */
function checkForUpdate() {
  if (checking) return checking;
  if (Date.now() - lastCheck < 30000) return Promise.resolve();
  lastCheck = Date.now();
  checking = (async () => {
    await new Promise((r) => setTimeout(r, 10000));
    const cache = await activeCache();
    if (!cache) return;
    let changed = false;
    for (const p of CORE) {
      const url = abs(p);
      const old = await cache.match(url);
      let res;
      try { res = await fetch(url, { cache: 'no-cache' }); } catch { return; }   // offline: niets doen
      if (!res.ok) return;
      if (!old || !sameBytes(await old.arrayBuffer(), await res.arrayBuffer())) { changed = true; break; }
    }
    if (!changed) return;
    const prevReady = await readPtr(READY);
    const name = newName();
    await buildCache(name, 'no-cache');      // gooit bij een fout -> alles blijft bij het oude
    await writePtr(READY, name);             // klaar voor de VOLGENDE navigatie
    if (prevReady && prevReady !== name) await caches.delete(prevReady);
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'SHELL_UPDATED' }));
  })().catch(() => {}).finally(() => { checking = null; });
  return checking;
}

/** Bij een navigatie: een klaargezette, complete update in één put() actief maken. */
async function promoteReady() {
  const ready = await readPtr(READY);
  if (!ready) return;
  await writePtr(READY, null);
  if (!(await caches.has(ready))) return;
  const prev = await readPtr(POINTER);
  await writePtr(POINTER, ready);
  activeName = ready;
  // De vorige cache blijft bestaan zolang er nog pagina's op draaien (andere tabbladen); oudere gaan weg.
  await prune(prev ? [ready, prev] : [ready]);
}

// R4: elke pagina blijft de cache gebruiken waarmee ze geladen is (ook voor late import()s).
const clientCache = new Map();   // clientId -> cachenaam

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // tegels, Overpass: niet aanraken
  if (!url.href.startsWith(self.registration.scope)) return;

  if (req.mode === 'navigate') {
    const scopePath = new URL(self.registration.scope).pathname;
    const isShell = url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
    if (!isShell) return;
    event.respondWith((async () => {
      try { await promoteReady(); } catch { /* oude versie blijft */ }
      const cache = await activeCache();
      const shell = cache && await cache.match(abs('index.html'));
      if (shell) {
        if (event.resultingClientId) clientCache.set(event.resultingClientId, activeName);
        event.waitUntil(checkForUpdate());
        return shell;
      }
      try { return await fetch(req); } catch {
        return new Response('Offline en nog niet gecachet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // App-shell-bestanden: uit de cache van déze pagina (anders de actieve), anders netwerk.
  event.respondWith((async () => {
    const own = event.clientId && clientCache.get(event.clientId);
    let cache = own && (await caches.has(own)) ? await caches.open(own) : null;
    if (!cache) cache = await activeCache();
    const hit = cache && await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
