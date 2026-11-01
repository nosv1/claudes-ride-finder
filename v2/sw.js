// Offline support. The app and road data are served from cache and refreshed in the background;
// map imagery, terrain and fonts are kept as you browse (up to a limit), so areas you've looked
// at keep working without signal. Routing and place search always need the network.
const VERSION = 'v1';
const APP = `rf-app-${VERSION}`, MAP = `rf-map-${VERSION}`;
const MAP_LIMIT = 4000;   // map tiles to keep (~150 MB at most)
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/main.js', './js/config.js', './js/geo.js', './js/roads.js', './js/trip.js', './js/plan.js',
  './js/search.js', './js/routing.js', './js/elevation.js', './js/store.js', './js/mapview.js', './js/ui.js',
  '../tiles/index.js', '../tiles/fuel.js', '../tiles/search.js', '../favicon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.js',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.css',
];
const MAP_HOSTS = ['server.arcgisonline.com', 's3.amazonaws.com', 'tiles.openfreemap.org', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('rf-') && k !== APP && k !== MAP).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) return e.respondWith(staleWhileRevalidate(e.request, APP));
  if (MAP_HOSTS.includes(url.hostname)) return e.respondWith(cacheFirst(e.request, MAP));
  // Everything else (routing, search) goes straight to the network.
});

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name), hit = await cache.match(req);
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

let puts = 0;
async function cacheFirst(req, name) {
  const cache = await caches.open(name), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    await cache.put(req, res.clone());
    if (++puts % 200 === 0) trim(cache);
  }
  return res;
}

// Drop the oldest map tiles once over the limit (cache keys come back in insertion order).
async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAP_LIMIT)).map(k => cache.delete(k)));
}
