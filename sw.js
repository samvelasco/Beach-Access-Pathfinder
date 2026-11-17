// Offline shell + runtime tile cache. Live data (OpenStreetMap, NOAA, USGS, FWC) always goes to the network.
const VERSION = 'bap-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'js/config.js', 'js/i18n.js', 'js/geo.js', 'js/closures.js', 'js/osm.js', 'js/router.js', 'js/tides.js', 'js/tidecheck.js', 'js/official.js', 'js/photos.js', 'js/reports.js', 'js/demo-data.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const TILE_HOSTS = ['basemap.nationalmap.gov', 'tile.openstreetmap.org'];
const MAX_TILES = 400;

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'bap-tiles').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trim(cache) { const ks = await cache.keys(); for (let i = 0; i < ks.length - MAX_TILES; i++) await cache.delete(ks[i]); }

self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('bap-tiles').then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trim(c); } return r; } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return; // APIs and photos: network only
  if (url.pathname.includes('/data/')) { // reviewed reports and closures: fresh when online
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(VERSION).then((k) => k.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then((k) => k.put(req, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
