// ── Hero Carousel ──
var heroAnimes = [];
var heroIndex = 0;
var heroInterval = null;
var HERO_COUNT = 5;

function buildHeroSlides(animes) {
  heroAnimes = animes.slice(0, HERO_COUNT);
  var slidesEl = document.getElementById('hero-slides');
  var dotsEl = document.getElementById('hero-dots');

  slidesEl.innerHTML = heroAnimes.map(function(m, idx) {
    var fallbackImg = getCover(m);
    var desc = cleanDesc(m.category_description || '').slice(0, 120);
    if (desc) desc += '...';
    var tags = (m.category_genres || '').split(',').slice(0, 4).map(function(g) { return g.trim(); }).filter(Boolean).map(function(g) { return '<span class="tag">' + g + '</span>'; }).join('');
    var aid = m.id || m.category_id;
    return '<div class="hero-slide">' +
      '<img class="hero-img" id="hero-img-' + idx + '" src="' + escapeHtml(fallbackImg) + '" alt="' + escapeHtml(getTitle(m)) + '">' +
      '<div class="hero-gradient"></div>' +
      '<div class="hero-content">' +
        '<h2 class="hero-title">' + escapeHtml(getTitle(m)) + '</h2>' +
        '<div class="hero-desc">' + escapeHtml(desc) + '</div>' +
        '<div class="hero-tags">' + tags + '</div>' +
        '<div class="hero-buttons">' +
          '<button class="btn-primary" onclick="openDetail(\'' + safeId(aid) + '\')"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>Detalhes</button>' +
          '<button class="btn-secondary" onclick="addToList(\'Quero Assistir\',heroAnimes[' + idx + '])"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Minha Lista</button>' +
        '</div>' +
      '</div></div>';
  }).join('');

  dotsEl.innerHTML = heroAnimes.map(function(_, i) {
    return '<button class="hero-dot' + (i === 0 ? ' active' : '') + '" onclick="goToHeroSlide(' + i + ')"></button>';
  }).join('');

  heroAnimes.forEach(function(m, idx) {
    fetchKitsuImages(getTitle(m)).then(function(imgs) {
      var heroEl = document.getElementById('hero-img-' + idx);
      if (heroEl && (imgs.cover || imgs.poster)) {
        heroEl.src = imgs.cover || imgs.poster;
      }
    });
  });

  startHeroCarousel();
}

function goToHeroSlide(i) {
  heroIndex = i;
  document.getElementById('hero-slides').style.transform = 'translateX(-' + (heroIndex * 100) + '%)';
  var dots = document.querySelectorAll('.hero-dot');
  dots.forEach(function(d, idx) { d.classList.toggle('active', idx === heroIndex); });
  restartHeroTimer();
}

function startHeroCarousel() {
  clearInterval(heroInterval);
  heroInterval = setInterval(function() {
    heroIndex = (heroIndex + 1) % heroAnimes.length;
    goToHeroSlide(heroIndex);
  }, 5000);
}

function restartHeroTimer() {
  clearInterval(heroInterval);
  heroInterval = setInterval(function() {
    heroIndex = (heroIndex + 1) % heroAnimes.length;
    goToHeroSlide(heroIndex);
  }, 5000);
}

// Touch swipe for hero
(function() {
  var hero = document.getElementById('hero-section');
  var startX = 0;
  hero.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; }, { passive: true });
  hero.addEventListener('touchend', function(e) {
    var diff = startX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
      if (diff > 0 && heroIndex < heroAnimes.length - 1) goToHeroSlide(heroIndex + 1);
      else if (diff < 0 && heroIndex > 0) goToHeroSlide(heroIndex - 1);
    }
  }, { passive: true });
})();

// ── Fetch Home Data (AnimeTV API) ──
['trending','popular','seasonal','top-rated'].forEach(function(id) {
  document.getElementById(id).innerHTML = skeletonCarousel();
});

renderContinueWatching();

// Load latest + populares + categories in parallel
Promise.all([
  atvFetch('latest'),
  atvFetch('populares'),
  atvFetch('categoria=dublado'),
  atvFetch('calendario')
]).then(function(results) {
  var latest = filterItems(results[0] || []);
  var populares = filterItems(results[1] || []);
  var dublados = filterItems(results[2] || []);
  var calendario = filterItems(results[3] || []);

  // For hero, fetch info of first 5 populares to get descriptions
  var heroIds = populares.slice(0, HERO_COUNT);
  Promise.all(heroIds.map(function(a) {
    return atvFetch('info=' + a.id).then(function(info) {
      if (info && info[0]) {
        a.category_description = info[0].category_description;
        a.category_genres = info[0].category_genres;
      }
      return a;
    }).catch(function() { return a; });
  })).then(function(heroData) {
    buildHeroSlides(heroData);
  });

  // Map latest episodes to anime cards (group by category_id, show unique)
  var seen = {};
  var latestAnimes = [];
  latest.forEach(function(ep) {
    if (!seen[ep.category_id]) {
      seen[ep.category_id] = true;
      latestAnimes.push({ id: ep.category_id, category_name: ep.title.replace(/ Episodio \d+$/i, '').replace(/ Episódio \d+$/i, ''), category_image: ep.category_image });
    }
  });

  document.getElementById('trending').innerHTML = latestAnimes.slice(0, 15).map(createPosterCard).join('');
  document.getElementById('popular').innerHTML = populares.slice(0, 15).map(createPosterCard).join('');
  document.getElementById('seasonal').innerHTML = dublados.slice(0, 15).map(createPosterCard).join('');
  document.getElementById('top-rated').innerHTML = populares.slice(15, 30).map(createPosterCard).join('');
}).catch(function(e) {
  console.error('AnimeTV fetch error:', e);
  ['trending','popular','seasonal','top-rated'].forEach(function(id) {
    document.getElementById(id).innerHTML = '<div style="padding:20px;color:var(--muted)">Erro ao carregar. Verifique sua conexão.</div>';
  });
});

// ── Explore / Search ──
// Plain text search uses our catalog (AnimeTV). Genre/status/year/order filters use
// MyAnimeList (discover.js) and each result is then looked up in the catalog on tap.
var searchTimer;
var searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', function() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() { doSearch(); }, 400);
});

var currentGenre = null;
function searchGenre(el, genre) {
  el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  currentGenre = genre;
  doSearch();
}

var searchSeq = 0;
function doSearch() {
  var q = searchInput.value.trim();
  var f = explorefilters();
  var seq = ++searchSeq;
  var results = document.getElementById('search-results'), count = document.getElementById('explore-count');
  document.getElementById('search-loading').style.display = 'block';
  results.innerHTML = '';
  count.textContent = '';
  var done = function(html, n) {
    if (seq !== searchSeq) return;
    document.getElementById('search-loading').style.display = 'none';
    results.innerHTML = html;
    count.textContent = n ? n + ' resultados' : '';
  };
  var empty = '<div class="empty-state">Nenhum anime encontrado</div>';

  if (f.genre || f.status || f.year || f.order) {
    filteredSearch(q, f).then(function(list) {
      var note = list.fallback ? 'A busca do MyAnimeList está fora do ar agora; mostrando só os animes em lançamento.' : 'Resultados do MyAnimeList: toque para abrir no catálogo.';
      done(list.length ? '<div class="party-muted" style="padding:0 16px 8px">' + note + '</div><div class="anime-grid">' +
        list.map(function(c, i) { return discoverCardHtml(c, 'srch' + i, true); }).join('') + '</div>' : empty, list.length);
    }).catch(function() { done('<div class="empty-state">O MyAnimeList não respondeu agora. Tente de novo em instantes.</div>'); });
    return;
  }

  atvFetch(q ? 'search=' + encodeURIComponent(q) : 'populares').then(function(raw) {
    var data = filterItems(raw);
    if (!Array.isArray(data)) data = [];
    if (f.audio === 'dub') data = data.filter(function(m) { return /dublad/i.test(getTitle(m)); });
    if (f.audio === 'sub') data = data.filter(function(m) { return !/dublad/i.test(getTitle(m)); });
    done(data.length ? '<div class="anime-grid">' + data.map(createPosterCard).join('') + '</div>' : empty, data.length);
  }).catch(function() { done('<div class="empty-state">Erro ao buscar</div>'); });
}
