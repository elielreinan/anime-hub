// ── Discovery: filtered search, recommendations, season pages, trailers ──
// Filters, recommendations and seasons come from Jikan (MyAnimeList). Tapping one
// of those looks the title up in our catalog, which is what actually plays.

var jikanQueue = Promise.resolve();
// Jikan allows ~3 requests/second: calls are spaced out, each has a 15s timeout, and
// 429/5xx answers are retried twice. A stuck call can't hold the queue forever.
function jikanGet(path) {
  var p = jikanQueue.then(function() { return new Promise(function(r) { setTimeout(r, 380); }); }).then(function attempt(tries) {
    tries = tries || 0;
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function() { if (ctrl) ctrl.abort(); }, 15000);
    return fetch('https://api.jikan.moe/v4' + path, ctrl ? { signal: ctrl.signal } : undefined).then(function(r) {
      clearTimeout(timer);
      if ((r.status === 429 || r.status >= 500) && tries < 2) return new Promise(function(res) { setTimeout(res, 1500); }).then(function() { return attempt(tries + 1); });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function(err) {
      clearTimeout(timer);
      if (tries < 1) return attempt(tries + 1);
      throw err;
    });
  });
  jikanQueue = p.catch(function() {});
  return p;
}

// Everything airing now: this season plus long-running shows still on air (One Piece...).
// Both come with their broadcast day/time, which the week agenda is built from.
var AIRING_TTL = 6 * 60 * 60 * 1000;
var airingPromise = null;
function getAiringShows() {
  var cached = getStore('airing');
  if (cached.at && Date.now() - cached.at < AIRING_TTL && cached.items && cached.items.length) return Promise.resolve(cached.items);
  if (airingPromise) return airingPromise;
  var items = [], seen = {};
  var add = function(j) {
    (j.data || []).forEach(function(a) {
      if (seen[a.mal_id]) return;
      seen[a.mal_id] = true;
      var c = jikanCard(a);
      c.bday = a.broadcast && a.broadcast.day || '';
      c.btime = a.broadcast && a.broadcast.time || '';
      items.push(c);
    });
    return !!(j.pagination && j.pagination.has_next_page);
  };
  var pages = ['/seasons/now?sfw=true&page=1', '/seasons/now?sfw=true&page=2', '/seasons/now?sfw=true&page=3', '/top/anime?filter=airing&sfw=true&page=1', '/top/anime?filter=airing&sfw=true&page=2'];
  airingPromise = pages.reduce(function(p, path) {
    return p.then(function(more) {
      if (more === false && /seasons\/now.*page=[23]/.test(path)) return false;
      return jikanGet(path).then(add, function() { return !/seasons/.test(path); });
    });
  }, Promise.resolve(true)).then(function() {
    airingPromise = null;
    if (!items.length) throw new Error('empty');
    setStore('airing', { at: Date.now(), items: items });
    return items;
  }, function(e) { airingPromise = null; throw e; });
  return airingPromise;
}

function jikanCard(a) {
  var img = (a.images && (a.images.webp || a.images.jpg) || {}).image_url || '';
  return { title: a.title, en: a.title_english || '', img: img, score: a.score || 0, year: a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || '',
    eps: a.episodes || 0, trailer: a.trailer && a.trailer.youtube_id ? a.trailer.youtube_id : '', genres: (a.genres || []).concat(a.themes || []).map(function(g) { return g.name; }), status: a.status || '', members: a.members || 0 };
}

var discoverCards = {};
function discoverCardHtml(c, key, withTrailer) {
  discoverCards[key] = c;
  return '<div class="poster-card" onclick="openFromDiscover(\'' + key + '\')">' +
    '<div class="poster-img"><img src="' + escapeHtml(c.img) + '" alt="" loading="lazy">' +
    (c.score ? '<span class="poster-score">★ ' + escapeHtml(String(c.score)) + '</span>' : '') +
    (withTrailer && c.trailer ? '<button class="poster-trailer" onclick="event.stopPropagation();openTrailer(\'' + safeId(c.trailer) + '\')" aria-label="Ver trailer">▶ Trailer</button>' : '') +
    '</div><div class="poster-title">' + escapeHtml(c.title) + '</div>' +
    '<div class="poster-sub">' + escapeHtml([c.year, c.eps ? c.eps + ' eps' : ''].filter(Boolean).join(' · ')) + '</div></div>';
}

function openFromDiscover(key) {
  var c = discoverCards[key];
  if (c) catalogLookup(c.title, c.en);
}

// Finds a title in our catalog: opens it directly when there's a single match.
function catalogLookup(title, alt) {
  showToast('Procurando "' + title + '" no catálogo...');
  var search = function(q) { return atvFetch('search=' + encodeURIComponent(q)).then(function(raw) { var d = filterItems(raw); return Array.isArray(d) ? d : []; }); };
  search(title).then(function(res) { return res.length || !alt ? res : search(alt); }).then(function(res) {
    if (!res.length) { showToast('Esse ainda não está no nosso catálogo'); return; }
    if (res.length === 1) { openDetail(safeId(res[0].id || res[0].category_id)); return; }
    openGenericSheet('Escolha no catálogo', '<div class="anime-grid" style="margin-top:12px">' + res.slice(0, 30).map(createPosterCard).join('') + '</div>');
  }).catch(function() { showToast('Erro ao buscar no catálogo'); });
}

// ── Trailers (YouTube, privacy-enhanced domain) ──
function openTrailer(id) {
  id = safeId(id);
  if (!id) return;
  document.getElementById('trailer-frame').src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
  document.getElementById('trailer-modal').classList.add('show');
}
function closeTrailer() {
  document.getElementById('trailer-modal').classList.remove('show');
  document.getElementById('trailer-frame').src = 'about:blank';
}

// ── Explore filters ──
var GENRE_IDS = { 'Ação': 1, 'Aventura': 2, 'Comédia': 4, 'Drama': 8, 'Fantasia': 10, 'Terror': 14, 'Mecha': 18, 'Música': 19, 'Mistério': 7, 'Romance': 22, 'Sci-Fi': 24, 'Esportes': 30, 'Sobrenatural': 37, 'Suspense': 41, 'Slice of Life': 36, 'Isekai': 62 };

(function initFilters() {
  var y = new Date().getFullYear(), opts = '<option value="">Ano: todos</option>';
  for (var i = y + 1; i >= 1980; i--) opts += '<option value="' + i + '">' + i + '</option>';
  document.getElementById('f-year').innerHTML = opts;
  var chips = '<button class="filter-chip active" onclick="searchGenre(this,null)">Todos</button>';
  Object.keys(GENRE_IDS).forEach(function(g) { chips += '<button class="filter-chip" onclick="searchGenre(this,\'' + g + '\')">' + escapeHtml(g) + '</button>'; });
  document.getElementById('genre-filters').innerHTML = chips;
})();

function explorefilters() {
  return { audio: document.getElementById('f-audio').value, status: document.getElementById('f-status').value, year: document.getElementById('f-year').value,
    order: document.getElementById('f-order').value, genre: currentGenre };
}

var GENRE_EN = { 'Ação': 'Action', 'Aventura': 'Adventure', 'Comédia': 'Comedy', 'Drama': 'Drama', 'Fantasia': 'Fantasy', 'Terror': 'Horror', 'Mecha': 'Mecha', 'Música': 'Music',
  'Mistério': 'Mystery', 'Romance': 'Romance', 'Sci-Fi': 'Sci-Fi', 'Esportes': 'Sports', 'Sobrenatural': 'Supernatural', 'Suspense': 'Suspense', 'Slice of Life': 'Slice of Life', 'Isekai': 'Isekai' };

// Genre / year / order applied here, on lists we already have.
function applyLocalFilters(list, q, f) {
  var nq = normalizeTitle(q);
  var out = list.filter(function(c) {
    if (nq && normalizeTitle(c.title + ' ' + c.en).indexOf(nq) === -1) return false;
    if (f.genre && c.genres.indexOf(GENRE_EN[f.genre]) === -1) return false;
    if (f.year && String(c.year) !== String(f.year)) return false;
    return true;
  });
  var by = { score: function(a, b) { return (b.score || 0) - (a.score || 0); }, title: function(a, b) { return a.title.localeCompare(b.title); },
    start_date: function(a, b) { return (b.year || 0) - (a.year || 0); } }[f.order] || function(a, b) { return (b.members || 0) - (a.members || 0); };
  return out.sort(by);
}

// Filters: "Em lançamento" and "Em breve" come from the season lists (reliable and
// cached); anything else goes to MyAnimeList's search, which is often slow.
function filteredSearch(q, f) {
  if (f.status === 'airing') return getAiringShows().then(function(list) { return applyLocalFilters(list, q, f); });
  if (f.status === 'upcoming') {
    var up = seasonCache.upcoming ? Promise.resolve(seasonCache.upcoming) : jikanGet('/seasons/upcoming?sfw=true').then(function(j) { return (j.data || []).map(jikanCard); });
    return up.then(function(list) { return applyLocalFilters(list, q, f); });
  }
  var qs = ['sfw=true', 'limit=24'];
  if (q) qs.push('q=' + encodeURIComponent(q));
  if (f.genre && GENRE_IDS[f.genre]) qs.push('genres=' + GENRE_IDS[f.genre]);
  if (f.status) qs.push('status=' + f.status);
  if (f.year) qs.push('start_date=' + f.year + '-01-01', 'end_date=' + f.year + '-12-31');
  if (f.order) qs.push('order_by=' + f.order, 'sort=' + (f.order === 'title' ? 'asc' : 'desc'));
  return jikanGet('/anime?' + qs.join('&')).then(function(j) { return (j.data || []).map(jikanCard); }, function() {
    // Search is down: at least filter what's airing.
    return getAiringShows().then(function(list) {
      var res = applyLocalFilters(list, q, f);
      res.fallback = true;
      return res;
    });
  });
}

// ── Recommendations (from what you watched and favorited) ──
var RECS_TTL = 24 * 60 * 60 * 1000;
function loadRecommendations() {
  var seeds = [];
  getWatchHistory().slice(0, 3).forEach(function(h) { if (h.title && seeds.indexOf(h.title) === -1) seeds.push(h.title); });
  ((getUserLists().Favoritos) || []).slice(0, 2).forEach(function(a) { var t = a.title || a.category_name; if (t && seeds.indexOf(t) === -1) seeds.push(t); });
  seeds = seeds.slice(0, 3);
  if (!seeds.length) return;
  var key = seeds.join('|');
  var cached = getStore('recs');
  if (cached.key === key && Date.now() - cached.at < RECS_TTL && cached.items && cached.items.length) { renderRecs(cached); return; }
  var seen = {}, items = [];
  var known = {};
  getWatchHistory().forEach(function(h) { known[normalizeTitle(h.title)] = true; });
  seeds.reduce(function(p, title) {
    return p.then(function() {
      return jikanGet('/anime?limit=1&sfw=true&q=' + encodeURIComponent(title.replace(/\s*\(?dublado\)?/i, ''))).then(function(j) {
        var a = j.data && j.data[0];
        if (!a) return;
        return jikanGet('/anime/' + a.mal_id + '/recommendations').then(function(rj) {
          (rj.data || []).slice(0, 8).forEach(function(r) {
            var e = r.entry;
            if (!e || seen[e.mal_id] || known[normalizeTitle(e.title)]) return;
            seen[e.mal_id] = true;
            items.push({ title: e.title, en: '', img: ((e.images && (e.images.webp || e.images.jpg)) || {}).image_url || '', score: 0, year: '', eps: 0 });
          });
        });
      }).catch(function() {});
    });
  }, Promise.resolve()).then(function() {
    var data = { key: key, at: Date.now(), because: seeds[0], items: items.slice(0, 18) };
    setStore('recs', data);
    renderRecs(data);
  });
}

function renderRecs(data) {
  if (!data.items.length) return;
  document.getElementById('recs-title').textContent = 'Porque você assistiu ' + data.because;
  document.getElementById('recs').innerHTML = data.items.map(function(c, i) { return discoverCardHtml(c, 'rec' + i); }).join('');
  document.getElementById('recs-section').style.display = '';
}

// ── Season pages (Agenda → Temporada / Próxima) ──
var calendarView = 'week', seasonCache = {};
function switchCalendarView(view) {
  calendarView = view;
  ['week', 'now', 'upcoming'].forEach(function(v) { document.getElementById('cal-tab-' + v).classList.toggle('active', v === view); });
  document.getElementById('cal-week').style.display = view === 'week' ? '' : 'none';
  document.getElementById('cal-season').style.display = view === 'week' ? 'none' : '';
  if (view === 'week') loadCalendar();
  else loadSeason(view);
}

function loadSeason(which) {
  var el = document.getElementById('cal-season');
  if (seasonCache[which]) { renderSeason(which); return; }
  el.innerHTML = '<div class="empty-state">Carregando temporada...</div>';
  var items = [], seen = {};
  [1, 2].reduce(function(p, page) {
    return p.then(function(more) {
      if (more === false) return false;
      return jikanGet('/seasons/' + which + '?sfw=true&page=' + page).then(function(j) {
        (j.data || []).forEach(function(a) { if (!seen[a.mal_id]) { seen[a.mal_id] = true; items.push(jikanCard(a)); } });
        return !!(j.pagination && j.pagination.has_next_page);
      });
    });
  }, Promise.resolve(true)).then(function() {
    seasonCache[which] = items.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    renderSeason(which);
  }).catch(function() { el.innerHTML = '<div class="empty-state">Não foi possível carregar a temporada agora.</div>'; });
}

function renderSeason(which) {
  var list = seasonCache[which] || [];
  document.getElementById('cal-season').innerHTML = list.length
    ? '<div class="anime-grid" style="margin-top:4px">' + list.map(function(c, i) { return discoverCardHtml(c, which + i, true); }).join('') + '</div>'
    : '<div class="empty-state">Nada anunciado ainda.</div>';
}
