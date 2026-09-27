// ── Release calendar (Jikan / MyAnimeList) ──
// Broadcast times are in Japan time; shows are regrouped by the viewer's own weekday.
// Jikan's filter takes singular day names (the broadcast.day it returns is plural).
var CAL_API_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
var CAL_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
var CAL_TTL = 12 * 60 * 60 * 1000;
var calendarItems = null, calendarLoading = null, calendarDay = new Date().getDay();

// Goes through jikanGet (discover.js): one shared, rate-limited queue for all Jikan calls.
function jikanPage(day, page) {
  return jikanGet('/schedules?filter=' + day + '&sfw=true&limit=25&page=' + page);
}

// Local weekday and "HH:MM" for a JST weekday + time.
function jstToLocal(jstDay, time) {
  var hm = String(time || '').split(':');
  if (hm.length < 2) return null;
  var now = new Date();
  var base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var jstToday = new Date(now.getTime() + 9 * 3600000).getUTCDay();
  base.setUTCDate(base.getUTCDate() + ((jstDay - jstToday + 7) % 7));
  var d = new Date(base.getTime() + (+hm[0] * 60 + +hm[1]) * 60000 - 9 * 3600000);
  return { day: d.getDay(), time: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) };
}

// Days are fetched one after another; a failed page is skipped instead of losing
// the whole week, and what already arrived is shown while the rest loads.
function fetchCalendar(onProgress) {
  var cached = getStore('calendar2');
  if (cached.at && Date.now() - cached.at < CAL_TTL && cached.items && cached.items.length) return Promise.resolve(cached.items);
  var items = [], seen = {}, failures = 0, done = 0;
  var chain = Promise.resolve();
  CAL_API_DAYS.forEach(function(day, jstDay) {
    [1, 2, 3].forEach(function(page) {
      chain = chain.then(function(more) {
        if (page > 1 && !more) return false;
        return jikanPage(day, page).then(function(json) {
          (json.data || []).forEach(function(a) {
            if (seen[a.mal_id]) return;
            var when = jstToLocal(jstDay, a.broadcast && a.broadcast.time);
            if (!when) return;
            seen[a.mal_id] = true;
            items.push({ title: a.title, en: a.title_english || '', img: (a.images && (a.images.webp || a.images.jpg) || {}).image_url || '',
              day: when.day, time: when.time, eps: a.episodes || 0, score: a.score || 0 });
          });
          return !!(json.pagination && json.pagination.has_next_page);
        }, function() { failures++; return false; });
      });
    });
    chain = chain.then(function() { done++; if (onProgress) onProgress(items, done); });
  });
  return chain.then(function() {
    if (!items.length) throw new Error('empty');
    if (!failures) setStore('calendar2', { at: Date.now(), items: items });
    return items;
  });
}

function loadCalendar() {
  renderCalendarDays();
  if (calendarItems) { renderCalendar(); return; }
  document.getElementById('cal-list').innerHTML = '<div class="empty-state">Carregando lançamentos...</div>';
  if (!calendarLoading) {
    calendarLoading = fetchCalendar(function(partial, days) {
      calendarItems = partial.slice();
      renderCalendar();
      if (days < 7) document.getElementById('cal-list').insertAdjacentHTML('beforeend', '<div class="empty-state">Carregando o resto da semana (' + days + '/7)...</div>');
    }).then(function(items) {
      calendarItems = items;
      renderCalendar();
    }).catch(function() {
      calendarItems = null;
      document.getElementById('cal-list').innerHTML = '<div class="empty-state">Não foi possível carregar a agenda agora.<div class="profile-actions"><button class="party-btn ghost" onclick="loadCalendar()">Tentar de novo</button></div></div>';
    }).then(function() { calendarLoading = null; });
  }
}

function renderCalendarDays() {
  var today = new Date().getDay();
  document.getElementById('cal-days').innerHTML = CAL_LABELS.map(function(l, i) {
    var d = (today + i) % 7;
    return '<button class="filter-chip' + (d === calendarDay ? ' active' : '') + '" onclick="calendarDay=' + d + ';renderCalendarDays();renderCalendar()">' + (i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : CAL_LABELS[d]) + '</button>';
  }).join('');
}

function followedTitles() {
  var out = {};
  Object.keys(notifyState.items).forEach(function(k) { out[normalizeTitle(notifyState.items[k].title)] = true; });
  return out;
}

function normalizeTitle(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

function renderCalendar() {
  if (!calendarItems) return;
  var follow = followedTitles();
  var list = calendarItems.filter(function(a) { return a.day === calendarDay; }).sort(function(a, b) { return a.time < b.time ? -1 : 1; });
  document.getElementById('cal-list').innerHTML = list.length ? list.map(function(a) {
    var followed = follow[normalizeTitle(a.title)] || follow[normalizeTitle(a.en)];
    return '<div class="cal-item" onclick="searchFromCalendar(this.dataset.title)" data-title="' + escapeHtml(a.title) + '">' +
      '<img src="' + escapeHtml(a.img) + '" alt="" loading="lazy">' +
      '<div style="min-width:0"><div class="cal-time">' + a.time + (followed ? '<span class="cal-follow">Seguindo</span>' : '') + '</div>' +
      '<div class="cal-title">' + escapeHtml(a.title) + '</div>' +
      '<div class="cal-sub">' + escapeHtml(a.en && a.en !== a.title ? a.en : '') + (a.eps ? (a.en && a.en !== a.title ? ' · ' : '') + a.eps + ' eps' : '') + (a.score ? ' · ★ ' + a.score : '') + '</div></div></div>';
  }).join('') + '<div class="party-muted" style="padding:4px 16px">Horários no seu fuso. Os episódios chegam aqui algumas horas depois da estreia no Japão.</div>'
    : '<div style="padding:40px;text-align:center;color:var(--muted)">Nenhum lançamento neste dia.</div>';
}

function searchFromCalendar(title) {
  searchInput.value = title;
  switchTab('explore');
  doSearch();
}
