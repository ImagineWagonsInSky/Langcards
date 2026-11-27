// Service worker: caches the whole app (code + data) so it works offline.
// VERSION is rewritten by scripts/stamp_version.py whenever any cached file changes.
const VERSION = 'lc-8862f92e47';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/main.js',
  './assets/js/util.js',
  './assets/js/text.js',
  './assets/js/srs.js',
  './assets/js/store.js',
  './assets/js/data.js',
  './assets/js/speech.js',
  './assets/js/sound.js',
  './assets/js/content.js',
  './assets/js/session.js',
  './assets/js/views.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon.png',
  './data/meta.json',
  './data/words.json',
  './data/sentences.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' bypasses the HTTP cache so a new version never stores stale files
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // First install: activate straight away. Updates wait until the user taps "Update".
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
