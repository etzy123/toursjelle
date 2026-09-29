// Berlin divided service worker.
// App shell and tour data: network first, cache as fallback, so updates arrive when online.
// Audio: cache first (the page pre-caches every file after first load), with Range support,
// because iPhone Safari only plays audio served as byte ranges.
// OpenStreetMap tiles are left to the browser: the tile usage policy forbids bulk offline caching.
const SHELL = 'bd-shell-v1', AUDIO = 'bd-audio', FONTS = 'bd-fonts';
const SHELL_FILES = [
  './', 'manifest.webmanifest', 'data/berlin-divided.json',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('bd-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('./'));
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
async function ranged(req, res) {
  const buf = await res.arrayBuffer(), size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': size, 'Accept-Ranges': 'bytes' } });
  let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size || start < 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' } });
}
async function audio(req) {
  const hit = await (await caches.open(AUDIO)).match(req.url);
  if (hit) return ranged(req, hit);
  return fetch(req); // not downloaded yet: straight from the network, Range and all
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes('/audio/')) e.respondWith(audio(req));
    else if (req.mode === 'navigate' || url.pathname.endsWith('.json') || url.pathname.endsWith('/')) e.respondWith(networkFirst(req));
    else e.respondWith(cacheFirst(req, SHELL));
  } else if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(cacheFirst(req, FONTS));
  }
});
