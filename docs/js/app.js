// ── Navigation ──
// Logo: close whatever is open on top and go back to the home screen.
function goHome() {
  if (document.getElementById('detail-page').classList.contains('show')) closeDetail();
  document.querySelectorAll('.sheet.show').forEach(function(s) { s.classList.remove('show'); });
  if (partySheetOpen()) closePartySheet();
  switchTab('home');
}

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
renderAccount();
if (account) { pullAccount(); startInboxPolling(); }
applyCaptionStyle();
doSearch();
setTimeout(loadTodayReleases, 800);
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
// Mobile browsers sometimes reload a tab left in the background; bring back the tab
// and the anime that were open instead of starting over on the home screen.
function saveView(patch) {
  try { var v = JSON.parse(sessionStorage.getItem('ah_view')) || {}; Object.assign(v, patch); sessionStorage.setItem('ah_view', JSON.stringify(v)); } catch (e) {}
}
function restoreView() {
  var v;
  try { v = JSON.parse(sessionStorage.getItem('ah_view')); } catch (e) {}
  if (!v) return;
  if (v.tab && v.tab !== 'home' && document.getElementById('page-' + v.tab)) switchTab(v.tab);
  if (v.anime) openDetail(v.anime);
}
(function trackView() {
  var sw = switchTab, od = openDetail, cd = closeDetail;
  window.switchTab = function(name) { sw.apply(null, arguments); saveView({ tab: name }); };
  window.openDetail = function(id) { od.apply(null, arguments); saveView({ anime: safeId(id) }); };
  window.closeDetail = function() { cd.apply(null, arguments); saveView({ anime: null }); };
})();
(function handleLaunchParams() {
  var params = new URLSearchParams(location.search);
  var anime = params.get('anime'), code = params.get('party'), user = params.get('u'), list = params.get('list');
  if (anime || code || user || list) history.replaceState(null, '', location.pathname + location.hash);
  if (code) joinParty(code);
  else if (list) openPublicList(safeId(list).toUpperCase());
  else if (user) openPublicProfile(String(user).replace(/[^A-Za-z0-9]/g, '').toUpperCase());
  else if (anime) openDetail(anime);
  else restoreView();
})();

// ── Service Worker ──
// No reload when a new version is installed: that threw people back to the home
// screen mid-use. Code is fetched network-first, so the next open is already new.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function() {});
