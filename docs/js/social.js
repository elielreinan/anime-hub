// ── Community: posts, friends' activity, clans, rankings ──
// Everything written by people is rendered with escapeHtml / textContent only.

var AVATARS = {
  fox: ['🦊', '#f97316,#c2410c'], cat: ['🐱', '#f59e0b,#b45309'], dragon: ['🐉', '#22c55e,#15803d'], ninja: ['🥷', '#475569,#0f172a'],
  samurai: ['⚔️', '#ef4444,#991b1b'], robot: ['🤖', '#64748b,#334155'], ghost: ['👻', '#a78bfa,#6d28d9'], panda: ['🐼', '#9ca3af,#374151'],
  tiger: ['🐯', '#fb923c,#9a3412'], owl: ['🦉', '#a16207,#713f12'], frog: ['🐸', '#4ade80,#166534'], alien: ['👽', '#34d399,#065f46'],
  sakura: ['🌸', '#f472b6,#9d174d'], star: ['⭐', '#facc15,#a16207'], moon: ['🌙', '#6366f1,#312e81'], fire: ['🔥', '#f43f5e,#9f1239']
};
var CLAN_COLORS = { orange: '#f97316', red: '#ef4444', blue: '#3b82f6', purple: '#a855f7', green: '#22c55e', pink: '#ec4899', teal: '#14b8a6', gold: '#eab308' };

function avatarHtml(id, size) {
  var a = AVATARS[id] || AVATARS.fox;
  size = size || 40;
  return '<span class="av" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.55) + 'px;background:linear-gradient(135deg,' + a[1] + ')">' + a[0] + '</span>';
}

function userLine(u, extra) {
  if (!u) return '';
  return '<button class="user-line" onclick="openPublicProfile(\'' + safeId(u.publicId) + '\')">' + avatarHtml(u.avatar, 36) +
    '<span><b>' + escapeHtml(u.name) + '</b><small>Nv. ' + (+u.level || 1) + ' · ' + escapeHtml(u.levelTitle || '') + (extra ? ' · ' + extra : '') + '</small></span></button>';
}

function timeAgo(at) {
  var s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d';
  return new Date(at).toLocaleDateString('pt-BR');
}

function needAccount(msg) {
  if (account) return false;
  showToast(msg || 'Entre na sua conta para participar');
  openAuth('login');
  return true;
}

function socialError(el, e) {
  var msg = e && e.code === 'accounts_off' ? 'A comunidade ainda não foi ativada no servidor.' : (e && e.message) || 'Erro ao carregar';
  document.getElementById(el).innerHTML = '<div class="empty-state">' + escapeHtml(msg) + '</div>';
}

// Generic full-screen sheet for clan pages, comments, admin, etc.
function openGenericSheet(title, html) {
  document.getElementById('generic-title').textContent = title;
  document.getElementById('generic-body').innerHTML = html;
  openSheet('generic-sheet');
}
function closeGenericSheet() { closeSheet('generic-sheet'); }

var communityView = 'feed';
function switchCommunity(view) {
  communityView = view;
  ['feed', 'activity', 'clans', 'ranking'].forEach(function(v) {
    document.getElementById('com-' + v).style.display = v === view ? '' : 'none';
    document.getElementById('com-tab-' + v).classList.toggle('active', v === view);
  });
  if (view === 'feed') loadFeed();
  if (view === 'activity') loadActivity();
  if (view === 'clans') loadClans();
  if (view === 'ranking') loadUserRanking();
}
function loadCommunity() { switchCommunity(communityView); }

// ── Posts ──
var feedScope = 'all', feedPosts = [], feedLoading = false;

function setFeedScope(el, scope) {
  if (scope !== 'all' && needAccount()) return;
  el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  feedScope = scope;
  loadFeed();
}

function renderComposer() {
  var el = document.getElementById('com-composer');
  if (!account) {
    el.innerHTML = '<div class="composer"><div class="party-muted">Entre na sua conta para publicar, curtir e comentar.</div><div class="profile-actions" style="justify-content:flex-start"><button class="party-btn" onclick="openAuth(\'login\')">Entrar</button><button class="party-btn ghost" onclick="openAuth(\'register\')">Criar conta</button></div></div>';
    return;
  }
  el.innerHTML = '<div class="composer">' + avatarHtml(account.user.avatar, 36) +
    '<div style="flex:1;min-width:0"><textarea id="composer-text" maxlength="1000" rows="2" placeholder="O que você está assistindo?"></textarea>' +
    '<div class="composer-row"><span class="party-muted" id="composer-anime"></span><button class="party-btn" id="composer-send" onclick="submitPost()">Publicar</button></div></div></div>';
}

function loadFeed(more) {
  renderComposer();
  if (feedLoading) return;
  var list = document.getElementById('com-posts');
  if (!more) { feedPosts = []; list.innerHTML = '<div class="empty-state">Carregando...</div>'; }
  var qs = '?scope=' + (feedScope === 'clan' ? 'all' : feedScope);
  if (feedScope === 'clan') {
    if (!myClan) { list.innerHTML = '<div class="empty-state">Você não está em um clã. <a href="#" onclick="switchCommunity(\'clans\');return false">Ver clãs</a></div>'; loadMyClan(); return; }
    qs = '?clan=' + myClan.publicId;
  }
  if (more && feedPosts.length) qs += '&before=' + feedPosts[feedPosts.length - 1].id;
  feedLoading = true;
  accountApi('/api/community/posts' + qs).then(function(r) {
    feedPosts = feedPosts.concat(r.posts);
    list.innerHTML = feedPosts.length ? feedPosts.map(postHtml).join('') +
      (r.posts.length === 20 ? '<button class="party-btn ghost load-more" onclick="loadFeed(true)">Carregar mais</button>' : '')
      : '<div class="empty-state">Nada por aqui ainda. Que tal começar a conversa?</div>';
    fillPostTexts();
  }).catch(function(e) { socialError('com-posts', e); }).then(function() { feedLoading = false; });
}

function postHtml(p) {
  return '<article class="post" id="post-' + p.id + '">' +
    '<div class="post-head">' + userLine(p.author, timeAgo(p.at)) +
      '<button class="post-menu" onclick="postMenu(' + p.id + ',' + (p.canDelete ? 1 : 0) + ')" aria-label="Opções">⋯</button></div>' +
    (p.clan ? '<div class="post-clan">' + escapeHtml(p.clan.emoji + ' ' + p.clan.name) + '</div>' : '') +
    '<div class="post-text"></div>' +
    (p.animeTitle ? '<div class="post-anime" onclick="openDetail(\'' + safeId(p.animeId) + '\')">🎬 ' + escapeHtml(p.animeTitle) + '</div>' : '') +
    '<div class="post-actions">' +
      '<button class="' + (p.liked ? 'liked' : '') + '" onclick="toggleLike(' + p.id + ', this)">❤ <span>' + p.likes + '</span></button>' +
      '<button onclick="openComments(' + p.id + ')">💬 ' + p.comments + '</button>' +
    '</div></article>';
}

// Post text goes in with textContent after the HTML is in the page.
function fillPostTexts() {
  feedPosts.forEach(function(p) {
    var el = document.querySelector('#post-' + p.id + ' .post-text');
    if (el) el.textContent = p.text;
  });
}

function submitPost() {
  var ta = document.getElementById('composer-text');
  var text = ta.value.trim();
  if (!text) return;
  var btn = document.getElementById('composer-send');
  btn.disabled = true;
  accountApi('/api/community/posts', 'POST', { text: text, clan: feedScope === 'clan' }).then(function(r) {
    ta.value = '';
    feedPosts.unshift(r.post);
    loadFeed();
    showToast('Publicado!');
  }).catch(function(e) { showToast(e.message); }).then(function() { btn.disabled = false; });
}

function toggleLike(id, btn) {
  if (needAccount()) return;
  accountApi('/api/community/posts/' + id + '/like', 'POST').then(function(r) {
    btn.classList.toggle('liked', r.liked);
    btn.querySelector('span').textContent = r.likes;
  }).catch(function(e) { showToast(e.message); });
}

function postMenu(id, canDelete) {
  var html = '<div class="transfer-box">' +
    (canDelete ? '<button class="party-btn ghost" onclick="deletePost(' + id + ')">Apagar publicação</button>' : '') +
    '<button class="party-btn ghost" onclick="reportContent(\'post\',\'' + id + '\')">Denunciar</button></div>';
  openGenericSheet('Publicação', html);
}

function deletePost(id) {
  if (!confirm('Apagar esta publicação?')) return;
  accountApi('/api/community/posts/' + id, 'DELETE').then(function() {
    closeGenericSheet();
    feedPosts = feedPosts.filter(function(p) { return p.id !== id; });
    var el = document.getElementById('post-' + id);
    if (el) el.remove();
    showToast('Publicação apagada');
  }).catch(function(e) { showToast(e.message); });
}

function reportContent(type, id) {
  if (needAccount()) return;
  var reason = prompt('Por que você está denunciando? (ex.: ofensivo, spam, spoiler)');
  if (!reason || !reason.trim()) return;
  accountApi('/api/reports', 'POST', { type: type, id: String(id), reason: reason.trim().slice(0, 300) }).then(function() {
    closeGenericSheet();
    showToast('Denúncia enviada. Obrigado!');
  }).catch(function(e) { showToast(e.message); });
}

// ── Comments ──
var commentsPostId = null;
function openComments(id) {
  commentsPostId = id;
  openGenericSheet('Comentários', '<div id="comments-list" class="comments"><div class="empty-state">Carregando...</div></div>' +
    (account ? '<div class="party-row comment-box"><input id="comment-input" maxlength="500" placeholder="Escreva um comentário" onkeydown="if(event.key===\'Enter\')sendComment()"><button class="party-btn" onclick="sendComment()">Enviar</button></div>'
      : '<div class="transfer-box"><button class="party-btn" onclick="openAuth(\'login\')">Entre para comentar</button></div>'));
  loadComments();
}

function loadComments() {
  accountApi('/api/community/posts/' + commentsPostId + '/comments').then(function(r) {
    var el = document.getElementById('comments-list');
    if (!el) return;
    el.innerHTML = '';
    if (!r.comments.length) { el.innerHTML = '<div class="empty-state">Nenhum comentário ainda.</div>'; return; }
    r.comments.forEach(function(k) {
      var row = document.createElement('div');
      row.className = 'comment';
      row.innerHTML = userLine(k.author, timeAgo(k.at)) + '<div class="comment-text"></div>' +
        '<div class="comment-actions">' + (k.canDelete ? '<button onclick="deleteComment(' + k.id + ')">Apagar</button>' : '') +
        '<button onclick="reportContent(\'comment\',\'' + k.id + '\')">Denunciar</button></div>';
      row.querySelector('.comment-text').textContent = k.text;
      el.appendChild(row);
    });
  }).catch(function(e) { socialError('comments-list', e); });
}

function sendComment() {
  var input = document.getElementById('comment-input');
  var text = input.value.trim();
  if (!text) return;
  accountApi('/api/community/posts/' + commentsPostId + '/comments', 'POST', { text: text }).then(function() {
    input.value = '';
    loadComments();
  }).catch(function(e) { showToast(e.message); });
}

function deleteComment(id) {
  accountApi('/api/community/comments/' + id, 'DELETE').then(loadComments).catch(function(e) { showToast(e.message); });
}

// ── Friends' activity ──
function activityText(a) {
  if (a.type === 'watched') return (a.extra && a.extra.count > 1 ? 'assistiu ' + a.extra.count + ' episódios de ' : 'assistiu o Ep ' + a.ep + ' de ');
  if (a.type === 'completed') return 'terminou ';
  if (a.type === 'favorited') return 'favoritou ';
  if (a.type === 'review') return 'avaliou com ' + '★'.repeat((a.extra && a.extra.rating) || 0) + ' o Ep ' + a.ep + ' de ';
  return '';
}

function loadActivity() {
  var el = document.getElementById('com-activity');
  if (!account) { el.innerHTML = '<div class="empty-state">Entre na sua conta e adicione amigos para ver o que eles estão assistindo.<div class="profile-actions"><button class="party-btn" onclick="openAuth(\'login\')">Entrar</button></div></div>'; return; }
  el.innerHTML = '<div class="empty-state">Carregando...</div>';
  accountApi('/api/feed').then(function(r) {
    if (!r.items.length) { el.innerHTML = '<div class="empty-state">Nada ainda. Adicione amigos pelo ID (Perfil → Amigos) e assista episódios até o fim.</div>'; return; }
    el.innerHTML = r.items.map(function(a) {
      return '<div class="activity" onclick="openDetail(\'' + safeId(a.animeId) + '\')">' + avatarHtml(a.user.avatar, 40) +
        '<div class="activity-body"><div><b>' + escapeHtml(a.mine ? 'Você' : a.user.name) + '</b> ' + escapeHtml(activityText(a)) + '<b>' + escapeHtml(a.title || '') + '</b></div>' +
        '<small>' + timeAgo(a.at) + '</small></div>' + (a.cover ? '<img src="' + escapeHtml(a.cover) + '" alt="" loading="lazy">' : '') + '</div>';
    }).join('');
  }).catch(function(e) { socialError('com-activity', e); });
}

// ── Clans ──
var myClan = null, clanOptions = null;

function loadMyClan() {
  if (!account) { myClan = null; return Promise.resolve(null); }
  return accountApi('/api/clans').then(function(r) { myClan = r.mine; clanOptions = r; return myClan; }).catch(function() { return null; });
}

function clanBadge(c, size) {
  size = size || 48;
  return '<span class="clan-emblem" style="width:' + size + 'px;height:' + size + 'px;background:' + (CLAN_COLORS[c.color] || CLAN_COLORS.orange) + '">' + escapeHtml(c.emoji) + '</span>';
}

function loadClans() {
  var el = document.getElementById('com-clans');
  el.innerHTML = '<div class="empty-state">Carregando...</div>';
  accountApi('/api/clans').then(function(r) {
    clanOptions = r;
    myClan = r.mine;
    var html = '';
    if (r.mine) html += '<div class="section-header"><h2 class="section-title">Meu clã</h2></div>' + clanRow(r.mine, true);
    else html += '<div class="transfer-box"><button class="party-btn" onclick="openCreateClan()">+ Criar um clã</button><div class="party-muted">Você pode estar em um clã por vez. Clãs têm feed próprio e ranking por XP.</div></div>';
    html += '<div class="section-header"><h2 class="section-title">Clãs</h2></div>';
    html += r.clans.length ? r.clans.map(function(c) { return clanRow(c); }).join('') : '<div class="empty-state">Nenhum clã ainda. Seja o primeiro!</div>';
    el.innerHTML = html;
  }).catch(function(e) { socialError('com-clans', e); });
}

function clanRow(c, mine) {
  return '<div class="clan-card" onclick="openClan(\'' + safeId(c.publicId) + '\')">' + clanBadge(c) +
    '<div class="clan-info"><div class="clan-name">' + escapeHtml(c.name) + (mine && c.role ? ' <small class="clan-role">' + escapeHtml(roleName(c.role)) + '</small>' : '') + '</div>' +
    '<div class="clan-desc">' + escapeHtml(c.description || '') + '</div>' +
    (c.members != null ? '<div class="clan-members">' + c.members + ' membros · ' + (c.xp || 0).toLocaleString('pt-BR') + ' XP</div>' : '') + '</div></div>';
}

function roleName(r) { return r === 'owner' ? 'Líder' : r === 'mod' ? 'Moderador' : 'Membro'; }

function openCreateClan() {
  if (needAccount('Entre na sua conta para criar um clã')) return;
  var opts = clanOptions || { emojis: ['⚔️'], colors: ['orange'] };
  openGenericSheet('Criar clã', '<form class="transfer-box" onsubmit="submitClan(event)">' +
    '<input class="auth-field" id="clan-name" maxlength="24" minlength="3" required placeholder="Nome do clã (3 a 24 letras)">' +
    '<input class="auth-field" id="clan-desc" maxlength="200" placeholder="Descrição (opcional)">' +
    '<div class="party-muted">Emblema</div><div class="pick-row" id="clan-emoji">' + opts.emojis.map(function(e, i) { return '<button type="button" class="pick' + (i ? '' : ' on') + '" data-v="' + escapeHtml(e) + '" onclick="pickOne(this)">' + escapeHtml(e) + '</button>'; }).join('') + '</div>' +
    '<div class="party-muted">Cor</div><div class="pick-row" id="clan-color">' + opts.colors.map(function(c, i) { return '<button type="button" class="pick color' + (i ? '' : ' on') + '" data-v="' + escapeHtml(c) + '" style="background:' + (CLAN_COLORS[c] || '#888') + '" onclick="pickOne(this)" aria-label="' + escapeHtml(c) + '"></button>'; }).join('') + '</div>' +
    '<button class="party-btn" type="submit">Criar clã</button></form>');
}

function pickOne(btn) {
  btn.parentElement.querySelectorAll('.pick').forEach(function(b) { b.classList.remove('on'); });
  btn.classList.add('on');
}

function pickedValue(id) { var b = document.querySelector('#' + id + ' .pick.on'); return b ? b.dataset.v : ''; }

function submitClan(e) {
  e.preventDefault();
  accountApi('/api/clans', 'POST', { name: document.getElementById('clan-name').value, description: document.getElementById('clan-desc').value, emoji: pickedValue('clan-emoji'), color: pickedValue('clan-color') })
    .then(function(r) { showToast('Clã criado!'); closeGenericSheet(); openClan(r.clan.publicId); loadClans(); })
    .catch(function(err) { showToast(err.message); });
}

var openClanId = null;
function openClan(id) {
  openClanId = id;
  openGenericSheet('Clã', '<div class="empty-state">Carregando...</div>');
  accountApi('/api/clans/' + id).then(renderClan).catch(function(e) { document.getElementById('generic-body').innerHTML = '<div class="empty-state">' + escapeHtml(e.message) + '</div>'; });
}

function renderClan(c) {
  document.getElementById('generic-title').textContent = c.name;
  var actions = '';
  if (!account) actions = '<button class="party-btn" onclick="openAuth(\'login\')">Entre para participar</button>';
  else if (c.myRole) actions = '<button class="party-btn ghost" onclick="leaveClan(\'' + safeId(c.publicId) + '\',\'' + c.myRole + '\')">Sair do clã</button>' +
    (c.myRole === 'owner' ? '<button class="party-btn ghost" onclick="deleteClan(\'' + safeId(c.publicId) + '\')">Apagar clã</button>' : '');
  else if (c.inAnotherClan) actions = '<div class="party-muted">Saia do seu clã atual para entrar neste.</div>';
  else if (c.full) actions = '<div class="party-muted">Clã cheio (50 membros).</div>';
  else actions = '<button class="party-btn" onclick="joinClan(\'' + safeId(c.publicId) + '\')">Entrar no clã</button>';
  var canManage = c.myRole === 'owner' || c.myRole === 'mod';
  var html = '<div class="clan-hero">' + clanBadge(c, 72) + '<div><div class="clan-name" style="font-size:20px"></div><div class="clan-desc" id="clan-desc-text"></div>' +
    '<div class="clan-members">' + c.members + ' membros · ' + (c.xp || 0).toLocaleString('pt-BR') + ' XP · desde ' + new Date(c.createdAt).toLocaleDateString('pt-BR') + '</div></div></div>' +
    '<div class="profile-actions">' + actions + (account && !c.myRole ? '<button class="party-btn ghost" onclick="reportContent(\'clan\',\'' + safeId(c.publicId) + '\')">Denunciar</button>' : '') + '</div>' +
    '<div class="section-header"><h2 class="section-title">Membros</h2></div>' +
    c.list.map(function(m) {
      var manage = '';
      if (canManage && account && m.publicId !== account.user.publicId && m.role !== 'owner') {
        if (c.myRole === 'owner') manage += '<button class="mini-btn" onclick="clanMember(\'' + safeId(c.publicId) + '\',\'' + safeId(m.publicId) + '\',\'' + (m.role === 'mod' ? 'member' : 'mod') + '\')">' + (m.role === 'mod' ? 'Tirar mod' : 'Tornar mod') + '</button>' +
          '<button class="mini-btn" onclick="clanMember(\'' + safeId(c.publicId) + '\',\'' + safeId(m.publicId) + '\',\'owner\')">Passar liderança</button>';
        if (c.myRole === 'owner' || m.role === 'member') manage += '<button class="mini-btn danger" onclick="clanMember(\'' + safeId(c.publicId) + '\',\'' + safeId(m.publicId) + '\',\'kick\')">Remover</button>';
      }
      return '<div class="friend-row">' + userLine(m, escapeHtml(roleName(m.role)) + ' · ' + (m.xp || 0) + ' XP') + '<div class="mini-actions">' + manage + '</div></div>';
    }).join('') +
    (c.myRole ? '<div class="section-header"><h2 class="section-title">Feed do clã</h2></div><div class="transfer-box"><button class="party-btn ghost" onclick="closeGenericSheet();switchTab(\'community\');switchCommunity(\'feed\');setFeedScope(document.querySelectorAll(\'#com-feed-scope .filter-chip\')[2],\'clan\')">Abrir feed do clã</button></div>' : '');
  document.getElementById('generic-body').innerHTML = html;
  document.querySelector('#generic-body .clan-hero .clan-name').textContent = c.emoji + ' ' + c.name;
  document.getElementById('clan-desc-text').textContent = c.description || '';
}

function joinClan(id) {
  accountApi('/api/clans/' + id + '/join', 'POST').then(function() { showToast('Bem-vindo ao clã!'); openClan(id); loadMyClan(); if (communityView === 'clans') loadClans(); })
    .catch(function(e) { showToast(e.message); });
}
function leaveClan(id, role) {
  if (!confirm(role === 'owner' ? 'Você é o líder. Se sair, a liderança passa para outro membro (ou o clã é apagado se você for o único). Sair?' : 'Sair do clã?')) return;
  accountApi('/api/clans/' + id + '/leave', 'POST').then(function() { showToast('Você saiu do clã'); myClan = null; closeGenericSheet(); loadClans(); })
    .catch(function(e) { showToast(e.message); });
}
function deleteClan(id) {
  if (!confirm('Apagar o clã para todos? Isso não pode ser desfeito.')) return;
  accountApi('/api/clans/' + id, 'DELETE').then(function() { showToast('Clã apagado'); myClan = null; closeGenericSheet(); loadClans(); })
    .catch(function(e) { showToast(e.message); });
}
function clanMember(clanId, userId, action) {
  if (action === 'kick' && !confirm('Remover esta pessoa do clã?')) return;
  if (action === 'owner' && !confirm('Passar a liderança? Você vira moderador.')) return;
  accountApi('/api/clans/' + clanId + '/members/' + userId, 'POST', { action: action }).then(function() { openClan(clanId); })
    .catch(function(e) { showToast(e.message); });
}

// ── Rankings ──
function setRankingMode(el, mode) {
  el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById('rank-users').style.display = mode === 'users' ? '' : 'none';
  document.getElementById('rank-clans').style.display = mode === 'clans' ? '' : 'none';
  document.getElementById('ranking-anime').style.display = mode === 'anime' ? '' : 'none';
  if (mode === 'users') loadUserRanking();
  if (mode === 'clans') loadClanRanking();
  if (mode === 'anime') loadRanking(null, 'score');
}

function rankPos(i) { return '<div class="rank-pos ' + (i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '') + '">' + (i + 1) + '</div>'; }

function loadUserRanking() {
  var el = document.getElementById('rank-users');
  el.innerHTML = '<div class="empty-state">Carregando...</div>';
  accountApi('/api/rankings/users').then(function(r) {
    el.innerHTML = r.users.length ? r.users.map(function(u, i) {
      var me = account && account.user.publicId === u.publicId;
      return '<div class="rank-item' + (me ? ' me' : '') + '" onclick="openPublicProfile(\'' + safeId(u.publicId) + '\')">' + rankPos(i) + avatarHtml(u.avatar, 40) +
        '<div class="rank-info"><div class="rank-name">' + escapeHtml(u.name) + (me ? ' <small>(você)</small>' : '') + '</div><div class="rank-detail">Nv. ' + u.level + ' · ' + escapeHtml(u.levelTitle) + '</div></div>' +
        '<div class="rank-score">' + u.xp.toLocaleString('pt-BR') + '<small> XP</small></div></div>';
    }).join('') : '<div class="empty-state">Ninguém pontuou ainda. XP vem de episódios assistidos até o fim, animes completos, avaliações e publicações.</div>';
  }).catch(function(e) { socialError('rank-users', e); });
}

function loadClanRanking() {
  var el = document.getElementById('rank-clans');
  el.innerHTML = '<div class="empty-state">Carregando...</div>';
  accountApi('/api/rankings/clans').then(function(r) {
    el.innerHTML = r.clans.length ? r.clans.map(function(c, i) {
      return '<div class="rank-item" onclick="openClan(\'' + safeId(c.publicId) + '\')">' + rankPos(i) + clanBadge(c, 40) +
        '<div class="rank-info"><div class="rank-name">' + escapeHtml(c.name) + '</div><div class="rank-detail">' + c.members + ' membros</div></div>' +
        '<div class="rank-score">' + (c.xp || 0).toLocaleString('pt-BR') + '<small> XP</small></div></div>';
    }).join('') : '<div class="empty-state">Nenhum clã ainda.</div>';
  }).catch(function(e) { socialError('rank-clans', e); });
}
