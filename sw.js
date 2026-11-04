/* sw.js — offline shell for Hive.
 *
 * BUMP `CACHE` (hive-v1 -> hive-v2 ...) on every deploy that changes a precached file:
 * the new worker installs beside the old one, the page offers a RELOAD toast, and the
 * old cache is deleted once the new worker takes over. Online play needs the network;
 * the WebSocket never passes through here. */
const CACHE = 'hive-v1';
const FONT_CACHE = 'hive-fonts';

const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.json',
  '/js/app.js',
  '/js/audio.js',
  '/js/board.js',
  '/js/game.js',
  '/js/hex.js',
  '/js/hints.js',
  '/js/local-save.js',
  '/js/menu.js',
  '/js/net.js',
  '/js/notation.js',
  '/js/replay.js',
  '/js/sprites.js',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/icons/apple-touch-icon-180.png',
  '/assets/icons/favicon-32.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  // No skipWaiting here: the page decides (RELOAD toast) so a game is never swapped mid-move.
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== FONT_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Serve the cache at once and refresh it in the background (fonts). */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const fresh  = fetch(request).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached ?? (await fresh) ?? Response.error();
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE, ignoreSearch: true });
  return cached ?? fetch(request);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname === '/ws') return;

  // Invite links (/?room=CODE) and any navigation get the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('/index.html', { cacheName: CACHE }).then(r => r ?? fetch(request)));
    return;
  }
  event.respondWith(cacheFirst(request));
});
