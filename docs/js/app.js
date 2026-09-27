// ── Navigation ──
function switchTab(name) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('page-' + name).classList.add('active');
  var tabs = document.querySelectorAll('.tab');
  var map = { home: 0, explore: 1, calendar: 2, community: 3, profile: 4 };
  if (map[name] !== undefined) tabs[map[name]].classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'home') renderContinueWatching();
  if (name === 'calendar') switchCalendarView(calendarView);
  if (name === 'community') loadCommunity();
  if (name === 'profile') refreshLevel();
}

// ── Offline UX ──
var offlineBanner = document.createElement('div');
offlineBanner.id = 'offline-banner';
offlineBanner.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;padding:8px;background:#ef4444;color:#fff;text-align:center;font-size:13px;font-weight:600;z-index:999';
offlineBanner.textContent = 'Sem conexão — modo offline';
document.body.appendChild(offlineBanner);
function updateOnlineStatus() {
  offlineBanner.style.display = navigator.onLine ? 'none' : 'block';
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ── Startup ──
renderProfileStats();
renderProfileName();
applyCaptionStyle();
doSearch();
setTimeout(loadRecommendations, 2500);
fetch(getApiBase() + '/api/status').catch(function() {});
initCookieBanner();
updateNotifBadge();
readNotifyState().then(function() {
  if (Object.keys(notifyState.items).length) setTimeout(checkNewEpisodes, 3000);
});
setInterval(checkNewEpisodes, 30 * 60 * 1000);
readNotifyState().then(importFromHash);
if (/Android/i.test(navigator.userAgent) && !window.Capacitor) document.getElementById('android-app-item').style.display = '';
(function handleLaunchParams() {
  var params = new URLSearchParams(location.search);
  var anime = params.get('anime'), code = params.get('party'), user = params.get('u');
  if (anime || code || user) history.replaceState(null, '', location.pathname + location.hash);
  if (code) joinParty(code);
  else if (user) openPublicProfile(String(user).replace(/[^A-Za-z0-9]/g, '').toUpperCase());
  else if (anime) openDetail(anime);
})();

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (hadController && !window._swReloaded) { window._swReloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js').catch(function() {});
}
