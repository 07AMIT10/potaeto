/* Potaeto Release 1 service worker (hand-written; no build dependency).
 *
 * Strategy:
 *  - Precache the app shell so the PWA opens offline.
 *  - Navigations are network-first, falling back to the cached /offline.html
 *    page (the static export emits `offline.html`, not an extensionless route).
 *  - Hashed _next/static assets and icons are cache-first (immutable).
 *  - /v1/* API calls and cross-origin requests are never cached; they pass
 *    straight to the core (same-origin via Caddy in production, or
 *    NEXT_PUBLIC_CORE_URL cross-origin in development).
 */

const CACHE = 'potaeto-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  '/',
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Cache each shell entry independently: `addAll` is all-or-nothing, so a
      // single missing URL would abort the whole install.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // dev: core on another origin
  if (url.pathname.startsWith('/v1/')) return; // API: network only

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() =>
          caches
            .match(OFFLINE_URL)
            .then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // Immutable, hashed assets: cache-first, then populate.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (
            response.ok &&
            (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/'))
          ) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
