/* Service worker.
 *
 * v1 was cache-first for the whole shell under a fixed cache name, which meant
 * a returning browser served its cached copy forever and no deploy could ever
 * reach it. The app was effectively un-updatable. Hence:
 *
 *   shell (HTML/CSS/JS)  network-first, cache as fallback
 *   icons and manifest   cache-first (they change only when regenerated)
 *   API and config.js    never cached
 *
 * Network-first costs one round trip on load and buys correctness: the page
 * you see is the page that is deployed. The cache is still there underneath,
 * so the app opens offline - just from the last version actually fetched.
 */

var VERSION = 'v2';
var SHELL_CACHE = 'mana-shell-' + VERSION;
var ASSET_CACHE = 'mana-assets-' + VERSION;

var SHELL = ['/', '/index.html', '/app.css', '/app.js'];
var ASSETS = ['/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }),
      caches.open(ASSET_CACHE).then(function (c) { return c.addAll(ASSETS); }),
    ]).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var stale = keys.filter(function (key) {
        return key !== SHELL_CACHE && key !== ASSET_CACHE;
      });
      return Promise.all(stale.map(function (key) { return caches.delete(key); }))
        .then(function () { return self.clients.claim(); });
      // Claiming fires `controllerchange` in every open page; app.js listens
      // for it and reloads. Doing the reload from the page rather than with
      // WindowClient.navigate() here is both more reliable and easier to
      // reason about - the page decides when it is safe to reload itself.
    })
  );
});

function networkFirst(request, cacheName) {
  return fetch(request)
    .then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        // Offline and this exact URL was never cached: fall back to the shell
        // so the app still opens rather than showing a browser error page.
        return hit || caches.match('/index.html');
      });
    });
}

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // config.js carries the API endpoint and is generated at deploy time.
  // A stale copy would point the app at the wrong backend.
  if (url.pathname === '/config.js') return;
  // The API is cross-origin in production and already skipped above, but the
  // dev server is same-origin. Entries and photos must never be served from a
  // cache: a stale entry would misreport what your partner wrote.
  if (url.pathname.indexOf('/api/') === 0) return;

  if (url.pathname.indexOf('/icons/') === 0 || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});
