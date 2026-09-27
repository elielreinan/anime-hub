var CACHE = 'animehub-v11';
var STATE_CACHE = 'animehub-state';

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
      return Promise.all(keys.filter(function(k) { return k !== CACHE && k !== STATE_CACHE; }).map(function(k) { return caches.delete(k); }));
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

  // Pages: network first so a new deploy shows up on the next load
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function(r) {
        var clone = r.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        return r;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match(self.registration.scope + 'index.html');
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

// New-episode checks while the app is closed (installed PWA on Chrome/Android).
// The page keeps the followed shows in STATE_CACHE; counts are updated here too so
// a notification is only shown once per new episode.
function checkFollowedShows() {
  var stateUrl = self.registration.scope + '__notify_state';
  return caches.open(STATE_CACHE).then(function(cache) {
    return cache.match(stateUrl).then(function(r) { return r ? r.json() : null; }).then(function(state) {
      if (!state || !state.items || !state.apiBase) return;
      return Promise.all(Object.keys(state.items).map(function(id) {
        var item = state.items[id];
        return fetch(state.apiBase + '/api/atv/cat_id=' + id).then(function(r) { return r.json(); }).then(function(eps) {
          var count = Array.isArray(eps) ? eps.length : 0;
          if (item.count && count > item.count) {
            item.count = count;
            return self.registration.showNotification(item.title, {
              body: 'Episódio ' + count + ' disponível',
              icon: item.cover || 'icon-192.png',
              tag: 'ep-' + id,
              data: { url: self.registration.scope + '?anime=' + id }
            });
          }
          if (count > (item.count || 0)) item.count = count;
        }).catch(function() {});
      })).then(function() {
        return cache.put(stateUrl, new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
      });
    });
  });
}

self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'ah-new-episodes') e.waitUntil(checkFollowedShows());
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
        return list[i].navigate(url).then(function(c) { return c && c.focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
