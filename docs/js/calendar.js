// ── Release calendar (Jikan / MyAnimeList) ──
// Broadcast times are in Japan time; shows are regrouped by the viewer's own weekday.
// Broadcast day names as Jikan writes them ("Mondays"), indexed like Date.getDay().
var CAL_DAY_NAMES = ['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays'];
var CAL_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
var calendarItems = null, calendarLoading = null, calendarDay = new Date().getDay();

// Local weekday and "HH:MM" for a JST weekday + time.
function jstToLocal(jstDay, time) {
  var hm = String(time || '').split(':');
  if (hm.length < 2) return null;
  // Work on Japan's calendar date (UTC+9, no DST): its midnight on the next jstDay,
  // plus the broadcast time, minus 9h is the real instant.
  var jstNow = new Date(Date.now() + 9 * 3600000);
  var base = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()) + ((jstDay - jstNow.getUTCDay() + 7) % 7) * 86400000;
  var d = new Date(base + (+hm[0] * 60 + +hm[1]) * 60000 - 9 * 3600000);
  return { day: d.getDay(), time: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) };
}

// The week is built from everything airing now (discover.js), using each show's
// broadcast day and time in Japan, converted to the viewer's time zone.
function fetchCalendar() {
  return getAiringShows().then(function(shows) {
    var items = [];
    shows.forEach(function(c) {
      var jstDay = CAL_DAY_NAMES.indexOf(String(c.bday).toLowerCase());
      if (jstDay === -1) return;
      var when = jstToLocal(jstDay, c.btime);
      if (!when) return;
      items.push({ title: c.title, en: c.en, img: c.img, day: when.day, time: when.time, eps: c.eps, score: c.score });
    });
    if (!items.length) throw new Error('empty');
    return items;
  });
}

// One request shared by the agenda and the home's "Lançados hoje".
function getCalendarItems() {
  if (calendarItems) return Promise.resolve(calendarItems);
  if (!calendarLoading) {
    calendarLoading = fetchCalendar().then(function(items) { calendarItems = items; calendarLoading = null; return items; },
      function(e) { calendarLoading = null; throw e; });
  }
  return calendarLoading;
}

function loadCalendar() {
  renderCalendarDays();
  if (calendarItems) { renderCalendar(); return; }
  document.getElementById('cal-list').innerHTML = '<div class="empty-state">Carregando lançamentos...</div>';
  getCalendarItems().then(renderCalendar, function() {
    document.getElementById('cal-list').innerHTML = '<div class="empty-state">Não foi possível carregar a agenda agora.<div class="profile-actions"><button class="party-btn ghost" onclick="loadCalendar()">Tentar de novo</button></div></div>';
  });
}

// ── Home: "Lançados hoje" ──
// Episodes that really arrived in our catalog (its "latest" feed, newest first) for
// shows that aired in Japan in the last 30 hours. The feed has no dates, so the
// MyAnimeList broadcast time is what tells today's episode from last week's.
function lastBroadcastMs(jstDay, time) {
  var hm = String(time || '').split(':');
  if (hm.length < 2) return 0;
  var jstNow = new Date(Date.now() + 9 * 3600000);
  var base = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()) + ((jstDay - jstNow.getUTCDay() + 7) % 7) * 86400000;
  var t = base + (+hm[0] * 60 + +hm[1]) * 60000 - 9 * 3600000;
  return t > Date.now() ? t - 7 * 86400000 : t;
}

function catalogShowName(epTitle) {
  return String(epTitle || '').replace(/\s+Epis[oó]dio\s+\d+.*$/i, '').replace(/\s*\((Dublado|Legendado)\)|\s+Dublado$/i, '').trim();
}

function loadTodayReleases() {
  var section = document.getElementById('today-section');
  if (!section) return;
  Promise.all([getAiringShows(), atvFetch('latest')]).then(function(r) {
    var shows = r[0] || [], latest = filterItems(r[1] || []);
    var recent = [];
    shows.forEach(function(c) {
      var day = CAL_DAY_NAMES.indexOf(String(c.bday).toLowerCase());
      if (day === -1) return;
      var at = lastBroadcastMs(day, c.btime);
      if (at && Date.now() - at < 30 * 3600000) {
        recent.push({ at: at, keys: [c.title, c.en].concat(catalogQueries(c.title, c.en).slice(2, 4)).map(normalizeTitle).filter(function(k) { return k.length >= 4; }) });
      }
    });
    var seen = {}, list = [];
    latest.forEach(function(ep) {
      var id = safeId(ep.category_id);
      if (!id || seen[id]) return;
      var name = catalogShowName(ep.title), n = normalizeTitle(name);
      var hit = recent.filter(function(s) { return s.keys.some(function(k) { return n === k || n.indexOf(k + ' ') === 0 || k.indexOf(n + ' ') === 0; }); })[0];
      if (!hit) return;
      seen[id] = true;
      var m = String(ep.title).match(/Epis[oó]dio\s+(\d+)/i);
      list.push({ id: id, name: name, ep: m ? m[1] : '', img: ep.category_image ? ATV_IMG + ep.category_image : '', at: hit.at });
    });
    if (!list.length) { section.style.display = 'none'; return; }
    document.getElementById('today-count').textContent = list.length + (list.length === 1 ? ' episódio novo' : ' episódios novos');
    document.getElementById('today-releases').innerHTML = list.map(function(a) {
      var hours = Math.max(1, Math.round((Date.now() - a.at) / 3600000));
      return '<div class="poster-card" onclick="openDetail(\'' + a.id + '\')">' +
        '<div class="poster-img"><img src="' + escapeHtml(a.img) + '" alt="" loading="lazy">' +
        (a.ep ? '<span class="today-badge out">Ep ' + escapeHtml(a.ep) + '</span>' : '') + '</div>' +
        '<div class="poster-title">' + escapeHtml(a.name) + '</div>' +
        '<div class="poster-sub">no Japão há ' + hours + 'h</div></div>';
    }).join('');
    section.style.display = '';
  }).catch(function() { section.style.display = 'none'; });
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
    return '<div class="cal-item" onclick="catalogLookup(this.dataset.title, this.dataset.en)" data-title="' + escapeHtml(a.title) + '" data-en="' + escapeHtml(a.en || '') + '">' +
      '<img src="' + escapeHtml(a.img) + '" alt="" loading="lazy">' +
      '<div style="min-width:0"><div class="cal-time">' + a.time + (followed ? '<span class="cal-follow">Seguindo</span>' : '') + '</div>' +
      '<div class="cal-title">' + escapeHtml(a.title) + '</div>' +
      '<div class="cal-sub">' + escapeHtml(a.en && a.en !== a.title ? a.en : '') + (a.eps ? (a.en && a.en !== a.title ? ' · ' : '') + a.eps + ' eps' : '') + (a.score ? ' · ★ ' + a.score : '') + '</div></div></div>';
  }).join('') + '<div class="party-muted" style="padding:4px 16px">Horários no seu fuso. Os episódios chegam aqui algumas horas depois da estreia no Japão.</div>'
    : '<div style="padding:40px;text-align:center;color:var(--muted)">Nenhum lançamento neste dia.</div>';
}

