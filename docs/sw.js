var CACHE = 'animehub-v5';

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      var scope = self.registration.scope;
      return cache.addAll([
        scope,
        scope + 'index.html',
        scope + 'manifest.json',
        scope + 'icon-192.png',
        scope + 'icon-512.png'
      ]);
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  // API calls: network first, cache fallback
  if (e.request.url.includes('/api/')) {
    e.respondWith(
      fetch(e.request).then(function(r) {
        var clone = r.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        return r;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || new Response(JSON.stringify({ error: true, message: 'offline' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        });
      })
    );
    return;
  }

  // Images: cache first
  if (e.request.url.match(/\.(png|jpg|jpeg|webp|gif)$/i) || e.request.url.includes('cdn.atv2.net') || e.request.url.includes('kitsu')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(r) {
          var clone = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
          return r;
        }).catch(function() {
          return new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // Everything else: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request);
    }).catch(function() {
      return caches.match(self.registration.scope + 'index.html');
    })
  );
});
