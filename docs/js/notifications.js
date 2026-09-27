// ── New-episode notifications ──
// Followed shows live in Cache Storage so the service worker can check them in the background too.
var STATE_CACHE = 'animehub-state';
var NOTIFY_STATE_URL = new URL('__notify_state', document.baseURI).toString();
var notifyState = { items: {} };

function readNotifyState() {
  if (!('caches' in window)) return Promise.resolve(notifyState);
  return caches.open(STATE_CACHE).then(function(c) { return c.match(NOTIFY_STATE_URL); })
    .then(function(r) { return r ? r.json() : null; })
    .then(function(s) { notifyState = (s && s.items) ? s : { items: {} }; return notifyState; })
    .catch(function() { return notifyState; });
}

function writeNotifyState() {
  notifyState.apiBase = getApiBase() || location.origin;
  if (!('caches' in window)) return Promise.resolve();
  return caches.open(STATE_CACHE).then(function(c) {
    return c.put(NOTIFY_STATE_URL, new Response(JSON.stringify(notifyState), { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function() {});
}

function isFollowing(id) { return !!notifyState.items[String(id)]; }

function setFollow(on) {
  if (!currentAnime) return;
  var id = String(currentAnime.id);
  if (on) {
    notifyState.items[id] = { title: getTitle(currentAnime), cover: getCover(currentAnime), count: currentAnimeEpisodes.length };
    if (!getSettings().notifications) {
      requestNotificationPermission().then(function(granted) {
        if (granted) { setSetting('notifications', true); registerPeriodicCheck(); }
      });
    }
  } else {
    delete notifyState.items[id];
  }
  writeNotifyState();
}

function toggleFollow() {
  var on = !(currentAnime && isFollowing(currentAnime.id));
  setFollow(on);
  showToast(on ? 'Você será avisado de novos episódios' : 'Notificações desativadas para este anime');
  refreshDetail();
}

function requestNotificationPermission() {
  if (!('Notification' in window)) { showToast('Seu navegador não suporta notificações'); return Promise.resolve(false); }
  if (Notification.permission === 'granted') return Promise.resolve(true);
  if (Notification.permission === 'denied') { showToast('Notificações bloqueadas nas permissões do site'); return Promise.resolve(false); }
  return Notification.requestPermission().then(function(p) { return p === 'granted'; });
}

function registerPeriodicCheck() {
  if (!('serviceWorker' in navigator) || !navigator.permissions) return;
  navigator.serviceWorker.ready.then(function(reg) {
    if (!reg.periodicSync) return;
    return navigator.permissions.query({ name: 'periodic-background-sync' }).then(function(p) {
      if (p.state === 'granted') return reg.periodicSync.register('ah-new-episodes', { minInterval: 6 * 60 * 60 * 1000 });
    });
  }).catch(function() {});
}

function getNotifications() { try { return JSON.parse(localStorage.getItem('ah_notifications')) || []; } catch (e) { return []; } }
function setNotifications(list) { try { localStorage.setItem('ah_notifications', JSON.stringify(list.slice(0, 50))); } catch (e) {} updateNotifBadge(); }

function updateNotifBadge() {
  var dot = document.getElementById('notif-dot');
  if (dot) dot.classList.toggle('show', getNotifications().some(function(n) { return !n.read; }));
}

function checkNewEpisodes() {
  return readNotifyState().then(function() {
    var ids = Object.keys(notifyState.items);
    return Promise.all(ids.map(function(id) {
      return atvFetch('cat_id=' + id).then(function(eps) {
        var item = notifyState.items[id];
        var count = Array.isArray(eps) ? eps.length : 0;
        if (!item || !count) return;
        if (item.count && count > item.count) {
          var list = getNotifications();
          list.unshift({ id: id, title: item.title, cover: item.cover, from: item.count + 1, to: count, at: Date.now(), read: false });
          setNotifications(list);
          showSystemNotification(id, item, count);
        }
        item.count = Math.max(item.count || 0, count);
      }).catch(function() {});
    })).then(writeNotifyState);
  });
}

function showSystemNotification(id, item, count) {
  if (!getSettings().notifications || !('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then(function(reg) {
    reg.showNotification(item.title, {
      body: 'Episódio ' + count + ' disponível',
      icon: item.cover || 'icon-192.png',
      tag: 'ep-' + id,
      data: { url: new URL('?anime=' + id, document.baseURI).toString() }
    });
  }).catch(function() {});
}

function openNotifications() {
  var list = getNotifications();
  var followed = Object.keys(notifyState.items);
  var html = '';
  if (!list.length) html += '<div style="padding:32px 16px;text-align:center;color:var(--muted)">Nenhuma notificação ainda.<br>Toque em <b>Notificar</b> na página de um anime (ou marque como Favorito) para ser avisado de episódios novos.</div>';
  list.forEach(function(n) {
    if (n.id === 'invite') {
      html += '<div class="notif-item' + (n.read ? '' : ' unread') + '"><div><div class="notif-title">' + escapeHtml(n.title) + '</div>' +
        '<div class="notif-sub">' + escapeHtml(n.body || '') + ' · ' + new Date(n.at).toLocaleDateString('pt-BR') + '</div></div></div>';
      return;
    }
    var eps = n.from === n.to ? 'Episódio ' + (+n.to || '') : 'Episódios ' + (+n.from || '') + '–' + (+n.to || '');
    html += '<div class="notif-item' + (n.read ? '' : ' unread') + '" onclick="closeSheet(\'notifications-sheet\');openDetail(\'' + safeId(n.id) + '\')">' +
      '<img src="' + escapeHtml(n.cover) + '" alt="" loading="lazy"><div><div class="notif-title">' + escapeHtml(n.title) + '</div>' +
      '<div class="notif-sub">' + eps + ' disponível · ' + new Date(n.at).toLocaleDateString('pt-BR') + '</div></div></div>';
  });
  if (followed.length) {
    html += '<div class="setting-group">Animes que você segue</div>';
    followed.forEach(function(id) {
      var it = notifyState.items[id];
      html += '<div class="notif-item" onclick="closeSheet(\'notifications-sheet\');openDetail(\'' + safeId(id) + '\')"><img src="' + escapeHtml(it.cover) + '" alt="" loading="lazy">' +
        '<div><div class="notif-title">' + escapeHtml(it.title) + '</div><div class="notif-sub">' + (it.count || 0) + ' episódios</div></div></div>';
    });
  }
  html += '<div class="setting-desc" style="padding:16px">Os avisos chegam quando você abre o app. No Android, com o app instalado na tela inicial, o navegador também verifica de tempos em tempos em segundo plano.</div>';
  document.getElementById('notifications-body').innerHTML = html;
  setNotifications(list.map(function(n) { n.read = true; return n; }));
  openSheet('notifications-sheet');
}
