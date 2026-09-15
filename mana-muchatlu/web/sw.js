/* Service worker - app shell only.
 *
 * Deliberately cache-first for the shell and network-only for the API. A
 * stale shell is invisible; a stale entry would be a lie about what your
 * partner wrote. Offline *entry* caching arrives with the IndexedDB work -
 * that needs a write queue and conflict handling, not just a cache. */

var CACHE = 'mana-shell-v1';
var SHELL = [
  '/', '/index.html', '/app.css', '/app.js',
  '/manifest.webmanifest', '/icons/icon.svg',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  // Never cache the API or the generated config - both must always be live.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/config.js') return;

  event.respondWith(
    caches.match(request).then(function (hit) {
      return hit || fetch(request).then(function (response) {
        if (response.ok && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        // Offline and uncached: fall back to the shell so the app still opens.
        return caches.match('/index.html');
      });
    })
  );
});
