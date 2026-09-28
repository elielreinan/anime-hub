// ── Detail Page (AnimeTV API) ──
var currentAnime = null;
var currentAnimeEpisodes = [];

function openDetail(id) {
  document.getElementById('detail-page').classList.add('show');
  document.getElementById('detail-body').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Carregando...</div>';
  document.getElementById('detail-banner').innerHTML = '<button class="detail-back" onclick="closeDetail()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button><div class="skeleton" style="width:100%;height:100%"></div><div class="detail-banner-gradient"></div>';

  Promise.all([
    atvFetch('info=' + id),
    atvFetch('cat_id=' + id)
  ]).then(function(results) {
    var info = (results[0] && results[0][0]) ? results[0][0] : null;
    var episodes = results[1] || [];

    if (!info) {
      document.getElementById('detail-body').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Anime não encontrado</div>';
      return;
    }

    currentAnime = info;
    currentAnimeEpisodes = episodes;
    var fallbackImg = getCover(info);

    document.getElementById('detail-banner').innerHTML =
      '<button class="detail-back" onclick="closeDetail()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>' +
      '<img id="detail-banner-img" src="' + escapeHtml(fallbackImg) + '" alt="">' +
      '<div class="detail-banner-gradient"></div>';

    fetchKitsuImages(getTitle(info)).then(function(imgs) {
      if (imgs.cover) {
        var bannerEl = document.getElementById('detail-banner-img');
        if (bannerEl) bannerEl.src = imgs.cover;
      }
      if (imgs.poster) {
        var posterEl = document.getElementById('detail-poster-img');
        if (posterEl) posterEl.src = imgs.poster;
      }
    });

    var genresArr = (info.category_genres || '').split(',').map(function(g) { return g.trim(); }).filter(Boolean);
    var subInfo = [info.ano || '', episodes.length + ' episódios'].filter(Boolean).join(' • ');

    var isFav = isInList('Favoritos', info.id);
    var isWatch = isInList('Assistindo', info.id);
    var isPlan = isInList('Quero Assistir', info.id);

    var body = '<div class="detail-meta">' +
      '<div class="detail-poster"><img id="detail-poster-img" src="' + escapeHtml(getCover(info)) + '" alt=""></div>' +
      '<div class="detail-info">' +
        '<div class="detail-title">' + escapeHtml(getTitle(info)) + '</div>' +
        '<div class="detail-sub">' + escapeHtml(subInfo) + '</div>' +
      '</div></div>' +
      '<div class="detail-actions-row">' +
        '<button class="detail-action-btn' + (isWatch ? ' active' : '') + '" onclick="addToList(\'Assistindo\',currentAnime);refreshDetail()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Assistindo</button>' +
        '<button class="detail-action-btn' + (isPlan ? ' active' : '') + '" onclick="addToList(\'Quero Assistir\',currentAnime);refreshDetail()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Quero Ver</button>' +
        '<button class="detail-action-btn' + (isFollowing(info.id) ? ' active' : '') + '" onclick="toggleFollow()"><svg width="18" height="18" viewBox="0 0 24 24" fill="' + (isFollowing(info.id) ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' + (isFollowing(info.id) ? 'Seguindo' : 'Notificar') + '</button>' +
        '<button class="detail-action-btn' + (isFav ? ' active' : '') + '" onclick="addToList(\'Favoritos\',currentAnime);refreshDetail()"><svg width="18" height="18" viewBox="0 0 24 24" fill="' + (isFav ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>Favorito</button>' +
      '</div>';

    if (info.category_description) {
      body += '<div class="detail-synopsis collapsed" id="synopsis">' + escapeHtml(cleanDesc(info.category_description)) + '</div>' +
        '<button class="detail-more" onclick="toggleSynopsis()">Ler mais</button>';
    }

    if (genresArr.length) {
      body += '<div class="detail-genres">' + genresArr.map(function(g) { return '<span class="tag">' + escapeHtml(g) + '</span>'; }).join('') + '</div>';
    }

    if (episodes.length > 0) {
      body += '<div class="section-header"><h2 class="section-title">Episódios</h2></div>' +
        '<div class="ep-ranges" id="ep-ranges"></div><div class="ep-list" id="ep-list"></div>';
    }

    body += '<div class="detail-extra"><div id="best-server" class="party-muted"></div>' +
      '<button class="party-btn ghost" onclick="openCharacters()">👥 Personagens e dublagem</button></div>';
    document.getElementById('detail-body').innerHTML = body;
    showBestServer(getTitle(info));
    if (episodes.length > 0) renderEpisodeList();
    prefetchEpisode(nextEpisodeToWatch());
  });
}

var EP_PAGE_SIZE = 50;

function detailEpisodes() {
  var n = currentAnimeEpisodes.length;
  return currentAnimeEpisodes.map(function(ep, idx) {
    var m = ep.title ? ep.title.match(/(\d+(?:\.\d+)?)\s*$/) : null;
    return { num: m ? parseFloat(m[1]) : n - idx, title: ep.title || '' };
  }).sort(function(a, b) { return a.num - b.num; });
}

function nextEpisodeToWatch() {
  var h = currentAnime && getWatchHistory().find(function(x) { return x.id == currentAnime.id; });
  if (!h) return 1;
  return h.progress >= 90 ? h.episode + 1 : h.episode;
}

function renderEpisodeList(page) {
  var eps = detailEpisodes();
  var pages = Math.ceil(eps.length / EP_PAGE_SIZE);
  if (page == null) {
    var target = nextEpisodeToWatch();
    var idx = eps.findIndex(function(e) { return e.num >= target; });
    page = idx < 0 ? pages - 1 : Math.floor(idx / EP_PAGE_SIZE);
  }
  var ranges = '';
  for (var p = 0; pages > 1 && p < pages; p++) {
    var first = eps[p * EP_PAGE_SIZE].num, last = eps[Math.min(eps.length, (p + 1) * EP_PAGE_SIZE) - 1].num;
    ranges += '<button class="filter-chip' + (p === page ? ' active' : '') + '" onclick="renderEpisodeList(' + p + ')">' + first + '–' + last + '</button>';
  }
  document.getElementById('ep-ranges').innerHTML = ranges;
  var h = getWatchHistory().find(function(x) { return x.id == currentAnime.id; });
  document.getElementById('ep-list').innerHTML = eps.slice(page * EP_PAGE_SIZE, (page + 1) * EP_PAGE_SIZE).map(function(ep) {
    var progress = h ? (h.episode === ep.num ? h.progress : (h.episode > ep.num ? 100 : 0)) : 0;
    return '<div class="ep-item' + (progress >= 90 ? ' watched' : '') + '" onclick="openPlayer(\'' + safeId(currentAnime.id) + '\',' + ep.num + ',' + eps.length + ')">' +
      '<div class="ep-thumb"><div class="ep-play-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>' +
      (progress > 0 ? '<div class="ep-progress"><div class="ep-progress-fill" style="width:' + progress + '%"></div></div>' : '') +
      '</div><div class="ep-info"><div class="ep-num">Episódio ' + ep.num + '</div><div class="ep-title">' + escapeHtml(ep.title || ('Episódio ' + ep.num)) + '</div></div></div>';
  }).join('');
}

// "Costuma funcionar melhor": the video host other viewers played this show on.
function showBestServer(title) {
  fetch(getApiBase() + '/api/health/anime?title=' + encodeURIComponent(title)).then(function(r) { return r.json(); }).then(function(j) {
    var el = document.getElementById('best-server');
    if (el && j.best) el.innerHTML = '⭐ Costuma funcionar melhor: <b></b> <small>(' + (+j.best.plays || 0) + ' reproduções recentes)</small>';
    if (el && j.best) el.querySelector('b').textContent = j.best.label || j.best.host;
  }).catch(function() {});
}

function refreshDetail() {
  if (currentAnime) openDetail(currentAnime.id);
}

function closeDetail() {
  document.getElementById('detail-page').classList.remove('show');
  currentAnime = null;
}

function toggleSynopsis() {
  var el = document.getElementById('synopsis');
  var btn = el.nextElementSibling;
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    btn.textContent = 'Ler menos';
  } else {
    el.classList.add('collapsed');
    btn.textContent = 'Ler mais';
  }
}
