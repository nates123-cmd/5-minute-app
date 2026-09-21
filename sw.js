const CACHE_NAME = '5min-break-v122';
const STATIC_ASSETS = [
  './',
  './index.html',
  './suite-sync.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests — Safari errors if respondWith rejects on non-GET
  if (event.request.method !== 'GET') return;

  // Let localhost pass through natively (no respondWith needed)
  if (event.request.url.includes('localhost') || event.request.url.includes('127.0.0.1')) return;

  // API hosts bypass the worker entirely. Synthesising a 503 here (the old
  // behaviour) made "offline" look like a server error to the app, so the
  // outbox in suite-sync.js could not tell which writes to queue. Letting the
  // browser fetch natively means a dead network rejects with a TypeError,
  // which is the signal the outbox keys on.
  if (event.request.url.includes('api.anthropic.com') || event.request.url.includes('supabase.co')) return;

  // Cache-first for static assets; fall back to cache on network failure
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
