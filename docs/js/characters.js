// ── Characters and voice actors (MyAnimeList via Jikan) ──
// Japanese and Brazilian Portuguese voice actors when MyAnimeList has them.

var characterCache = {};

function openCharacters() {
  if (!currentAnime) return;
  var title = getTitle(currentAnime).replace(/\s*\(?dublado\)?\s*$/i, '');
  openGenericSheet('Personagens e dublagem', '<div class="empty-state">Procurando no MyAnimeList...</div>');
  var key = normalizeTitle(title);
  var p = characterCache[key] ? Promise.resolve(characterCache[key]) :
    jikanGet('/anime?limit=1&sfw=true&q=' + encodeURIComponent(title)).then(function(j) {
      var a = j.data && j.data[0];
      if (!a) throw new Error('notfound');
      return jikanGet('/anime/' + a.mal_id + '/characters').then(function(cj) {
        var out = { malTitle: a.title, list: (cj.data || []).slice(0, 40) };
        characterCache[key] = out;
        return out;
      });
    });
  p.then(renderCharacters).catch(function(e) {
    document.getElementById('generic-body').innerHTML = '<div class="empty-state">' + (e.message === 'notfound' ? 'Não achamos este anime no MyAnimeList.' : 'O MyAnimeList não respondeu agora. Tente de novo em instantes.') + '</div>';
  });
}

function charImg(obj) { return ((obj && obj.images && (obj.images.webp || obj.images.jpg)) || {}).image_url || ''; }

function renderCharacters(data) {
  var body = document.getElementById('generic-body');
  if (!data.list.length) { body.innerHTML = '<div class="empty-state">Sem personagens cadastrados.</div>'; return; }
  var rows = data.list.map(function(c) {
    var vas = c.voice_actors || [];
    var pick = function(lang) { return vas.find(function(v) { return v.language === lang; }); };
    var jp = pick('Japanese'), br = pick('Portuguese (BR)');
    return { name: c.character && c.character.name, img: charImg(c.character), role: c.role === 'Main' ? 'Principal' : 'Secundário', jp: jp, br: br };
  });
  body.innerHTML = '<div class="party-muted" style="padding:12px 16px 0">Dados de ' + escapeHtml(data.malTitle) + ' no MyAnimeList</div>' + rows.map(function(r) {
    var va = function(v, flag) { return v ? '<div class="va">' + (charImg(v.person) ? '<img src="' + escapeHtml(charImg(v.person)) + '" alt="" loading="lazy">' : '') + '<span>' + flag + ' ' + escapeHtml(v.person && v.person.name) + '</span></div>' : ''; };
    return '<div class="char-row"><img src="' + escapeHtml(r.img) + '" alt="" loading="lazy"><div class="char-info"><b>' + escapeHtml(r.name) + '</b><small>' + r.role + '</small>' +
      va(r.jp, '🇯🇵') + va(r.br, '🇧🇷') + '</div></div>';
  }).join('');
}
