// ── Safe HTML building ──
// Anything that comes from an API or a user goes through escapeHtml before innerHTML;
// ids that end up inside onclick="...('id')" go through safeId (HTML escaping is
// undone by the browser before the handler's JavaScript runs).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function safeId(v) { return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, ''); }

// API server: same origin in local development, Render otherwise.
function getApiBase() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return '';
  return 'https://anime-hub-zz7f.onrender.com';
}

// ── AnimeTV API (atv2.net) via proxy ──
var ATV_IMG = 'https://cdn.atv2.net/img/';

function atvFetch(endpoint) {
  return fetch(getApiBase() + '/api/atv/' + endpoint).then(function(r) { return r.json(); });
}

function getTitle(m) { return m.category_name || m.title || 'Sem título'; }
function getCover(m) { return m.category_image ? ATV_IMG + m.category_image : ''; }
// Plain text from an HTML description (tags dropped, entities decoded), not yet escaped.
function cleanDesc(d) {
  if (!d) return '';
  var doc = new DOMParser().parseFromString(String(d), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

var kitsuCache = {};
function fetchKitsuImages(title) {
  var clean = title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+(Dublado|Legendado|PT-PT|PT-BR)\s*/gi, '').trim();
  if (kitsuCache[clean]) return Promise.resolve(kitsuCache[clean]);
  return fetch('https://kitsu.app/api/edge/anime?filter[text]=' + encodeURIComponent(clean) + '&page[limit]=1', {
    headers: { 'Accept': 'application/vnd.api+json' }
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.data && data.data.length > 0) {
      var attrs = data.data[0].attributes;
      var result = {
        cover: (attrs.coverImage && (attrs.coverImage.large || attrs.coverImage.original)) || '',
        poster: (attrs.posterImage && (attrs.posterImage.large || attrs.posterImage.original)) || ''
      };
      kitsuCache[clean] = result;
      return result;
    }
    kitsuCache[clean] = { cover: '', poster: '' };
    return kitsuCache[clean];
  }).catch(function() { return { cover: '', poster: '' }; });
}

// ── Client-side Content Filter ──
var BLOCKED_WORDS = ['hentai','ecchi','erotica','yaoi','yuri','nudity','sexual','adult','r-18','r18','xxx','sukebe'];
function isBlockedItem(item) {
  if (!item || typeof item !== 'object') return false;
  var text = [item.category_name||'', item.title||'', item.category_genres||'', item.category_description||''].join(' ').toLowerCase();
  for (var i = 0; i < BLOCKED_WORDS.length; i++) {
    if (text.indexOf(BLOCKED_WORDS[i]) !== -1) return true;
  }
  return false;
}
function filterItems(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter(function(item) { return !isBlockedItem(item); });
}

// ── LocalStorage ──
function getStore(key) { try { return JSON.parse(localStorage.getItem('ah_' + key)) || {}; } catch(e) { return {}; } }
function setStore(key, val) { try { localStorage.setItem('ah_' + key, JSON.stringify(val)); } catch(e) {} }

function getUserLists() { return getStore('lists'); }
function setUserLists(lists) { setStore('lists', lists); }

function addToList(listName, anime) {
  var lists = getUserLists();
  if (!lists[listName]) lists[listName] = [];
  var aid = anime.id || anime.category_id;
  if (!lists[listName].find(function(a) { return a.id === aid; })) {
    lists[listName].push({ id: aid, title: getTitle(anime), cover: getCover(anime) });
    setUserLists(lists);
    renderProfileStats();
    if (typeof reportListActivity === 'function') reportListActivity(listName, anime);
    if (listName === 'Favoritos' && !isFollowing(aid)) {
      setFollow(true);
      showToast('Favoritado! Você será avisado de novos episódios');
    } else {
      showToast('Adicionado a ' + listName + '!');
    }
  } else {
    lists[listName] = lists[listName].filter(function(a) { return a.id !== aid; });
    setUserLists(lists);
    renderProfileStats();
    showToast('Removido de ' + listName);
  }
}

function isInList(listName, animeId) {
  var lists = getUserLists();
  return lists[listName] && lists[listName].some(function(a) { return a.id == animeId; });
}

// ── Watch History (Continue Watching) ──
function getWatchHistory() { try { return JSON.parse(localStorage.getItem('ah_watch_history')) || []; } catch(e) { return []; } }
function setWatchHistory(h) { try { localStorage.setItem('ah_watch_history', JSON.stringify(h)); } catch(e) {} }

function saveWatchProgress(animeId, title, cover, banner, episode, progress, totalEps, time) {
  var history = getWatchHistory();
  var existing = history.findIndex(function(h) { return h.id == animeId; });
  var entry = { id: animeId, title: title, cover: cover, banner: banner || cover, episode: episode, progress: progress, totalEps: totalEps, time: time || 0, updatedAt: Date.now() };
  if (existing >= 0) history.splice(existing, 1);
  history.unshift(entry);
  if (history.length > 20) history = history.slice(0, 20);
  setWatchHistory(history);
}

function renderContinueWatching() {
  var history = getWatchHistory();
  var section = document.getElementById('continue-section');
  if (history.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  document.getElementById('continue-watching').innerHTML = history.map(function(h) {
    var pct = Math.min(100, Math.round(h.progress || 0));
    return '<div class="continue-card" onclick="openDetail(\'' + safeId(h.id) + '\')">' +
      '<img src="' + escapeHtml(h.banner) + '" alt="' + escapeHtml(h.title) + '" loading="lazy">' +
      '<div class="continue-overlay"></div>' +
      '<div class="continue-play"><div class="play-circle"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>' +
      '<div class="continue-info"><div class="continue-title">' + escapeHtml(h.title) + '</div><div class="continue-ep">Episódio ' + (+h.episode || '') + '</div></div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div></div>';
  }).join('');
}

// ── Toast ──
var toastTimer;
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2000);
}

// ── Skeleton Loaders ──
function skeletonCarousel(n) {
  var h = '';
  for (var i = 0; i < (n||6); i++) h += '<div class="skeleton-card"><div class="skeleton skeleton-poster"></div><div class="skeleton skeleton-text"></div></div>';
  return '<div class="loading-carousel">' + h + '</div>';
}

// ── Poster Card ──
function createPosterCard(m) {
  var aid = safeId(m.id || m.category_id);
  return '<div class="poster-card" onclick="openDetail(\'' + aid + '\')">' +
    '<div class="poster-img"><img src="' + escapeHtml(getCover(m)) + '" alt="' + escapeHtml(getTitle(m)) + '" loading="lazy"></div>' +
    '<div class="poster-title">' + escapeHtml(getTitle(m)) + '</div></div>';
}
