// ── Ranking (AnimeTV API) ──
function loadRanking(el, sort) {
  if (el) {
    el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
    el.classList.add('active');
  }

  document.getElementById('ranking-list').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Carregando ranking...</div>';

  atvFetch('populares').then(function(raw) {
    var data = filterItems(raw);
    if (!Array.isArray(data)) data = [];
    var media = data.slice(0, 20);
    document.getElementById('ranking-list').innerHTML = media.map(function(m, i) {
      var posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      var aid = m.id || m.category_id;
      return '<div class="rank-item" onclick="openDetail(\'' + safeId(aid) + '\')" style="cursor:pointer">' +
        '<div class="rank-pos ' + posClass + '">' + (i + 1) + '</div>' +
        '<div class="rank-avatar"><img src="' + escapeHtml(getCover(m)) + '" alt="" style="border-radius:50%"></div>' +
        '<div class="rank-info"><div class="rank-name">' + escapeHtml(getTitle(m)) + '</div></div></div>';
    }).join('');
  });
}

// ── Profile ──
function renderProfileStats() {
  var lists = getUserLists();
  var watching = (lists['Assistindo'] || []).length;
  var completed = (lists['Completados'] || []).length;
  var favs = (lists['Favoritos'] || []).length;
  var plan = (lists['Quero Assistir'] || []).length;

  document.getElementById('profile-stats').innerHTML =
    '<div class="stat"><div class="stat-num">' + watching + '</div><div class="stat-label">Assistindo</div></div>' +
    '<div class="stat"><div class="stat-num">' + completed + '</div><div class="stat-label">Completados</div></div>' +
    '<div class="stat"><div class="stat-num">' + favs + '</div><div class="stat-label">Favoritos</div></div>' +
    '<div class="stat"><div class="stat-num">' + plan + '</div><div class="stat-label">Planejados</div></div>';

  var listData = [
    { name: 'Assistindo', count: watching, cls: 'watching', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>' },
    { name: 'Quero Assistir', count: plan, cls: 'plan', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
    { name: 'Completados', count: completed, cls: 'completed', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' },
    { name: 'Favoritos', count: favs, cls: 'favorites', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>' },
  ];

  document.getElementById('profile-lists').innerHTML = listData.map(function(l) {
    return '<div class="list-item" onclick="showListDetail(\'' + l.name + '\')">' +
      '<div class="list-icon ' + l.cls + '">' + l.icon + '</div>' +
      '<div class="list-info"><div class="list-name">' + l.name + '</div><div class="list-count">' + l.count + ' anime</div></div>' +
      '<span class="chevron"><svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span></div>';
  }).join('');
}

function showListDetail(listName) {
  var lists = getUserLists();
  var items = lists[listName] || [];
  if (items.length === 0) { showToast('Lista vazia'); return; }

  document.getElementById('detail-page').classList.add('show');
  document.getElementById('detail-banner').innerHTML =
    '<button class="detail-back" onclick="closeDetail()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>' +
    '<div style="width:100%;height:100%;background:linear-gradient(135deg,var(--accent),#ff7246);display:flex;align-items:center;justify-content:center"><h2 style="font-size:28px;font-weight:900">' + listName + '</h2></div>' +
    '<div class="detail-banner-gradient"></div>';

  var body = '<div class="anime-grid" style="margin-top:20px">';
  items.forEach(function(a) {
    body += '<div class="poster-card" onclick="openDetail(\'' + safeId(a.id) + '\')">' +
      '<div class="poster-img"><img src="' + escapeHtml(a.cover) + '" alt="' + escapeHtml(a.title) + '" loading="lazy"></div>' +
      '<div class="poster-title">' + escapeHtml(a.title) + '</div></div>';
  });
  body += '</div>';
  document.getElementById('detail-body').innerHTML = body;
}
