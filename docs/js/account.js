// ── Accounts ──
// Signed in, the account is the source of truth: local changes are pushed a few
// seconds later, and a newer copy on the server replaces the local one on start.
// The first sign-in on a device merges what was already saved here into the account.
var account = (function() { try { var a = JSON.parse(localStorage.getItem('ah_account')); return a && a.token && a.user ? a : null; } catch (e) { return null; } })();
var syncTimer = null, syncDirty = false, syncApplying = false;

function saveAccount() {
  try { if (account) localStorage.setItem('ah_account', JSON.stringify(account)); else localStorage.removeItem('ah_account'); } catch (e) {}
}

function accountApi(path, method, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (account) headers.Authorization = 'Bearer ' + account.token;
  return fetch(getApiBase() + path, { method: method || 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function(r) {
    return r.json().catch(function() { return {}; }).then(function(j) {
      if (r.status === 401 && j.code === 'signed_out' && account) { signedOut(); }
      if (!r.ok) { var e = new Error(j.message || 'Erro ' + r.status); e.status = r.status; e.code = j.code; throw e; }
      return j;
    });
  });
}

function signedOut() {
  account = null;
  saveAccount();
  renderAccount();
  showToast('Sua sessão expirou, entre de novo');
}

// Local writes of synced data mark the account dirty.
['setStore', 'setWatchHistory'].forEach(function(name) {
  var orig = window[name];
  window[name] = function(key) {
    orig.apply(null, arguments);
    // Progress is saved every few seconds while watching: batch those pushes.
    if (name === 'setWatchHistory') scheduleSync(20000);
    else if (TRANSFER_KEYS.indexOf(key) !== -1) scheduleSync();
  };
});
var origWriteNotifyState = writeNotifyState;
writeNotifyState = function() { var p = origWriteNotifyState(); scheduleSync(); return p; };

function scheduleSync(delay) {
  if (!account || syncApplying) return;
  syncDirty = true;
  if (syncTimer && delay > 3000) return; // a push is already on its way
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushAccountData, delay || 3000);
}

function pushAccountData() {
  if (!account) return Promise.resolve();
  clearTimeout(syncTimer);
  syncTimer = null;
  syncDirty = false;
  return accountApi('/api/me/data', 'PUT', { data: collectUserData() }).then(function(r) {
    account.syncedAt = r.dataUpdatedAt;
    saveAccount();
  }).catch(function(e) { if (e.status !== 401) syncDirty = true; });
}

function replaceUserData(data) {
  var before = getWatchHistory()[0];
  var after = (data.history || [])[0];
  // Picked up where another device left off: offer to jump right back in.
  if (after && after.time > 20 && (!before || after.updatedAt > (before.updatedAt || 0) + 5000) && Date.now() - after.updatedAt < 12 * 3600000) {
    setTimeout(function() { showContinueBanner(after); }, 800);
  }
  syncApplying = true;
  try {
    setUserLists(data.lists || {});
    setWatchHistory(data.history || []);
    setStore('skipmarks', data.skipmarks || {});
    var settings = getStore('settings');
    Object.keys(data.settings || {}).forEach(function(k) { settings[k] = data.settings[k]; });
    setStore('settings', settings);
    notifyState.items = data.follow || {};
  } finally { syncApplying = false; }
  return origWriteNotifyState().then(refreshAfterSync);
}

function refreshAfterSync() {
  renderProfileStats();
  renderProfileName();
  renderContinueWatching();
}

// On start and when the app comes back to the foreground.
function pullAccount() {
  if (!account) return Promise.resolve();
  return accountApi('/api/me').then(function(r) {
    account.user = r.user;
    saveAccount();
    renderAccount();
    if (syncDirty) return pushAccountData();
    if (r.data && r.data.v === 1 && r.dataUpdatedAt && r.dataUpdatedAt !== account.syncedAt) {
      account.syncedAt = r.dataUpdatedAt;
      saveAccount();
      return replaceUserData(r.data);
    }
  }).catch(function() {});
}

function showContinueBanner(h) {
  var el = document.getElementById('invite-banner');
  if (el.classList.contains('show') || playerIsOpen()) return;
  el.innerHTML = '<div>Continuar de onde parou no outro aparelho: <b></b></div>' +
    '<div class="party-row"><button class="party-btn" style="flex:1" id="continue-go">Continuar</button><button class="party-btn ghost" onclick="document.getElementById(\'invite-banner\').classList.remove(\'show\')">Agora não</button></div>';
  el.querySelector('b').textContent = h.title + ' — Ep ' + h.episode + ' (' + formatTime(h.time) + ')';
  document.getElementById('continue-go').onclick = function() {
    el.classList.remove('show');
    openDetail(safeId(h.id));
  };
  el.classList.add('show');
}

function signedIn(res) {
  account = { token: res.token, user: res.user, syncedAt: null };
  saveAccount();
  return accountApi('/api/me').then(function(r) {
    return r.data && r.data.v === 1 ? mergeUserData(r.data) : null;
  }).then(pushAccountData).then(function() {
    renderAccount();
    refreshAfterSync();
    startInboxPolling();
  });
}

var authMode = 'login';
function openAuth(mode) {
  setAuthMode(mode || 'login');
  document.getElementById('auth-error').textContent = '';
  openSheet('auth-sheet');
}

function setAuthMode(mode) {
  authMode = mode;
  var reg = mode === 'register';
  document.getElementById('auth-title').textContent = reg ? 'Criar conta' : 'Entrar';
  document.getElementById('auth-submit').textContent = reg ? 'Criar conta' : 'Entrar';
  document.getElementById('auth-tab-login').className = 'party-btn' + (reg ? ' ghost' : '');
  document.getElementById('auth-tab-register').className = 'party-btn' + (reg ? '' : ' ghost');
  var name = document.getElementById('auth-name');
  name.style.display = reg ? '' : 'none';
  name.required = reg;
  if (reg && !name.value && getSettings().nickname) name.value = getSettings().nickname;
  document.getElementById('auth-password').autocomplete = reg ? 'new-password' : 'current-password';
  document.getElementById('auth-terms').style.display = reg ? '' : 'none';
  renderGoogleButton();
}

// ── Sign in with Google (Google Identity Services) ──
// Only shown when the server has GOOGLE_CLIENT_ID; the ID token is verified server-side.
var googleClientId = null, googleLoading = null;
function loadGoogle() {
  if (googleLoading) return googleLoading;
  googleLoading = fetch(getApiBase() + '/api/status').then(function(r) { return r.json(); }).then(function(st) {
    googleClientId = st.googleClientId || null;
    if (!googleClientId || window.Capacitor) return false; // Google blocks sign-in inside app WebViews
    return new Promise(function(resolve) {
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.async = true;
      sc.onload = function() { resolve(true); };
      sc.onerror = function() { resolve(false); };
      document.head.appendChild(sc);
    });
  }).catch(function() { return false; });
  return googleLoading;
}

function renderGoogleButton() {
  var box = document.getElementById('google-signin');
  loadGoogle().then(function(ok) {
    if (!ok || !window.google || !google.accounts) { box.innerHTML = ''; return; }
    google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential, ux_mode: 'popup' });
    box.innerHTML = '';
    google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', text: authMode === 'register' ? 'signup_with' : 'signin_with', shape: 'pill', locale: 'pt-BR' });
  });
}

function onGoogleCredential(resp) {
  var err = document.getElementById('auth-error');
  var accept = document.getElementById('auth-accept').checked;
  accountApi('/api/auth/google', 'POST', { credential: resp.credential, acceptTerms: accept }).then(function(res) {
    return signedIn(res).then(function() { closeSheet('auth-sheet'); showToast('Olá, ' + res.user.name + '!'); });
  }).catch(function(e) {
    if (e.code === 'terms_required') { setAuthMode('register'); err.textContent = 'Primeiro acesso: marque que aceita os termos e toque de novo em "Continuar com o Google".'; return; }
    err.textContent = e.message;
  });
}

function submitAuth(e) {
  e.preventDefault();
  var btn = document.getElementById('auth-submit'), err = document.getElementById('auth-error');
  var body = { email: document.getElementById('auth-email').value, password: document.getElementById('auth-password').value };
  if (authMode === 'register') {
    body.name = document.getElementById('auth-name').value;
    body.acceptTerms = document.getElementById('auth-accept').checked;
    if (!body.acceptTerms) { err.textContent = 'Marque que você aceita os termos de uso e a política de privacidade.'; return; }
  }
  btn.disabled = true;
  err.textContent = '';
  accountApi('/api/auth/' + authMode, 'POST', body).then(function(res) {
    return signedIn(res).then(function() {
      document.getElementById('auth-password').value = '';
      closeSheet('auth-sheet');
      showToast(authMode === 'register' ? 'Conta criada! Seu ID é #' + res.user.publicId : 'Bem-vindo de volta, ' + res.user.name + '!');
    });
  }).catch(function(e) {
    err.textContent = e.code === 'accounts_off' ? 'As contas ainda não foram ativadas no servidor.' : e.message === 'Failed to fetch' ? 'Sem conexão com o servidor' : e.message;
  }).then(function() { btn.disabled = false; });
}

function logout() {
  var p = syncDirty ? pushAccountData() : Promise.resolve();
  p.then(function() { return accountApi('/api/auth/logout', 'POST').catch(function() {}); }).then(function() {
    account = null;
    saveAccount();
    stopInboxPolling();
    renderAccount();
    closeSheet('settings-sheet');
    showToast('Você saiu da conta. Seus dados continuam neste aparelho.');
  });
}

function deleteAccount() {
  var body;
  if (account.user.hasPassword) {
    var pw = prompt('Para excluir a conta, digite sua senha. Isso apaga tudo e não pode ser desfeito.');
    if (!pw) return;
    body = { password: pw };
  } else {
    var c = prompt('Isso apaga sua conta e tudo que está nela. Digite EXCLUIR para confirmar.');
    if (c !== 'EXCLUIR') return;
    body = { confirm: 'EXCLUIR' };
  }
  accountApi('/api/me/account', 'DELETE', body).then(function() {
    account = null;
    saveAccount();
    stopInboxPolling();
    renderAccount();
    closeSheet('settings-sheet');
    showToast('Conta excluída');
  }).catch(function(e) { showToast(e.message); });
}

function changePassword() {
  var cur = account.user.hasPassword ? prompt('Senha atual:') : '';
  if (account.user.hasPassword && !cur) return;
  var next = prompt('Nova senha (mínimo 8 caracteres):');
  if (!next) return;
  accountApi('/api/auth/password', 'POST', { current: cur, password: next }).then(function() {
    account.user.hasPassword = true;
    saveAccount();
    showToast('Senha alterada. Os outros aparelhos precisarão entrar de novo.');
  }).catch(function(e) { showToast(e.message); });
}

function logoutEverywhere() {
  if (!confirm('Sair da conta em todos os aparelhos (inclusive este)?')) return;
  accountApi('/api/auth/logout-all', 'POST').then(function() {
    account = null;
    saveAccount();
    stopInboxPolling();
    renderAccount();
    closeSheet('settings-sheet');
    showToast('Você saiu de todos os aparelhos');
  }).catch(function(e) { showToast(e.message); });
}

// LGPD: download everything the server stores about you.
function exportAccount() {
  accountApi('/api/me/export').then(function(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'animehub-meus-dados-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }).catch(function(e) { showToast(e.message); });
}

// ── Avatar, level and achievements ──
function openAvatarPicker() {
  if (!account) { openAuth('register'); return; }
  openGenericSheet('Escolha seu avatar', '<div class="avatar-grid">' + Object.keys(AVATARS).map(function(id) {
    return '<button class="' + (account.user.avatar === id ? 'on' : '') + '" onclick="chooseAvatar(\'' + id + '\')" aria-label="' + id + '">' + avatarHtml(id, 64) + '</button>';
  }).join('') + '</div>');
}

function chooseAvatar(id) {
  accountApi('/api/me', 'PATCH', { avatar: id }).then(function(r) {
    account.user = r.user;
    saveAccount();
    renderAccount();
    closeGenericSheet();
  }).catch(function(e) { showToast(e.message); });
}

var levelCache = null;
function refreshLevel() {
  if (!account) { renderLevel(null); return; }
  accountApi('/api/me/level').then(renderLevel).catch(function() {});
}

function renderLevel(lv) {
  levelCache = lv;
  var el = document.getElementById('profile-level');
  if (!lv) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="level-box"><div class="level-head"><b>Nível ' + lv.level + ' · ' + escapeHtml(lv.title) + '</b><span>' + lv.xp.toLocaleString('pt-BR') + ' / ' + lv.next.toLocaleString('pt-BR') + ' XP</span></div>' +
    '<div class="level-bar"><i style="width:' + Math.max(2, Math.min(100, lv.progress)) + '%"></i></div>' +
    '<div class="achievements">' + lv.achievements.map(function(a) {
      return '<div class="ach' + (a.unlocked ? ' on' : '') + '" title="' + escapeHtml(a.desc) + '"><span>' + escapeHtml(a.icon) + '</span><small>' + escapeHtml(a.name) + '</small></div>';
    }).join('') + '</div></div>';
}

// Episodes watched to the end count for XP and the friends feed (server dedupes).
var reportedWatched = {};
function reportWatched() {
  if (!account || !currentAnime || !playerEpisode) return;
  var key = currentAnime.id + ':' + playerEpisode;
  if (reportedWatched[key]) return;
  reportedWatched[key] = true;
  accountApi('/api/me/watched', 'POST', { animeId: safeId(currentAnime.id), title: getTitle(currentAnime), cover: getCover(currentAnime), ep: playerEpisode })
    .then(function(r) { if (r.counted) showToast('+10 XP · Ep ' + playerEpisode + ' concluído'); if (r.level) levelCache = r.level; })
    .catch(function() { reportedWatched[key] = false; });
}

function reportListActivity(listName, anime) {
  if (!account || !anime) return;
  var type = listName === 'Completados' ? 'completed' : listName === 'Favoritos' ? 'favorited' : null;
  if (!type) return;
  accountApi('/api/me/activity', 'POST', { type: type, animeId: safeId(anime.id || anime.category_id), title: getTitle(anime), cover: getCover(anime) }).catch(function() {});
}

function updateAccount(changes) {
  accountApi('/api/me', 'PATCH', changes).then(function(r) {
    account.user = r.user;
    saveAccount();
    renderAccount();
  }).catch(function(e) { showToast(e.message); renderSettings(); });
}

function profileLink(id) { return location.origin + location.pathname + '?u=' + id; }

function copyText(text, msg) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function() { showToast(msg); }, function() { prompt('Copie:', text); });
  else prompt('Copie:', text);
}

function shareProfile() {
  if (!account) return;
  var link = profileLink(account.user.publicId);
  if (navigator.share) { navigator.share({ title: 'AnimeHub', text: 'Meu perfil no AnimeHub (ID #' + account.user.publicId + ')', url: link }).catch(function() {}); return; }
  copyText(link, 'Link do perfil copiado');
}

function renderAccount() {
  var box = document.getElementById('profile-account');
  var sub = document.getElementById('profile-sub');
  if (!account) {
    sub.textContent = 'Seus dados ficam salvos só neste aparelho';
    box.innerHTML = '<div class="profile-actions"><button class="party-btn" onclick="openAuth(\'login\')">Entrar</button><button class="party-btn ghost" onclick="openAuth(\'register\')">Criar conta</button></div>';
  } else {
    sub.textContent = 'Sincronizado com sua conta';
    box.innerHTML = '<button class="profile-id" onclick="copyText(\'' + safeId(account.user.publicId) + '\', \'ID copiado\')" title="Copiar ID">#' + escapeHtml(account.user.publicId) + '</button>' +
      '<div class="profile-actions"><button class="party-btn" onclick="openFriends()">Amigos</button><button class="party-btn ghost" onclick="shareProfile()">Compartilhar perfil</button><button class="party-btn ghost" onclick="openPublicProfile(\'' + safeId(account.user.publicId) + '\')">Ver meu perfil</button>' +
      (account.user.role === 'admin' ? '<button class="party-btn ghost" onclick="openAdmin()">🛡️ Admin</button>' : '') + '</div>';
  }
  var av = document.getElementById('profile-avatar');
  av.innerHTML = account ? avatarHtml(account.user.avatar, 88) : '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  av.classList.toggle('has-avatar', !!account);
  refreshLevel();
  renderProfileName();
  if (document.getElementById('settings-sheet').classList.contains('show')) renderSettings();
  if (party && partySheetOpen()) renderPartyFriends();
}

// ── Friends ──
var friendsCache = [];

function loadFriends() {
  if (!account) return Promise.resolve([]);
  return accountApi('/api/me/friends').then(function(r) { friendsCache = r.friends || []; return friendsCache; });
}

function friendStatus(f) {
  return f.watching ? '<span class="friend-status live">Assistindo ' + escapeHtml(f.watching.title) + (f.watching.ep ? ' — Ep ' + f.watching.ep : '') + '</span>' : '<span class="friend-status">#' + f.publicId + '</span>';
}

function openFriends() {
  openSheet('friends-sheet');
  document.getElementById('friends-list').innerHTML = '<div class="party-muted" style="padding:16px">Carregando...</div>';
  loadFriends().then(renderFriends).catch(function(e) { document.getElementById('friends-list').innerHTML = '<div class="party-muted" style="padding:16px">' + escapeHtml(e.message) + '</div>'; });
}

function renderFriends() {
  var el = document.getElementById('friends-list');
  el.innerHTML = friendsCache.length ? friendsCache.map(function(f) {
    return '<div class="friend-row">' + avatarHtml(f.avatar, 40) +
      '<div class="friend-info"><div class="friend-name">' + escapeHtml(f.name) + '</div>' + friendStatus(f) + '</div>' +
      (party ? '<button class="party-btn" onclick="inviteFriend(\'' + f.publicId + '\')">Chamar</button>' : '') +
      '<button class="party-btn ghost" onclick="openPublicProfile(\'' + f.publicId + '\')">Perfil</button></div>';
  }).join('') : '<div class="party-muted" style="padding:16px">Nenhum amigo ainda. Peça o ID para um amigo (fica no Perfil dele) e adicione acima. Seu ID é <b>#' + account.user.publicId + '</b>.</div>';
}

function addFriend(id) {
  id = String(id || '').replace(/^#/, '').trim().toUpperCase();
  if (!account) { openAuth('login'); return; }
  if (!id) return;
  accountApi('/api/me/friends', 'POST', { publicId: id }).then(function(r) {
    showToast(r.friend.name + ' agora é seu amigo');
    var input = document.getElementById('friend-id-input');
    if (input) input.value = '';
    return loadFriends().then(function() {
      renderFriends();
      if (document.getElementById('detail-page').classList.contains('show') && publicProfileId === r.friend.publicId) openPublicProfile(r.friend.publicId);
    });
  }).catch(function(e) { showToast(e.message); });
}

function removeFriend(id) {
  if (!confirm('Remover este amigo?')) return;
  accountApi('/api/me/friends/' + id, 'DELETE').then(function() {
    showToast('Amigo removido');
    openPublicProfile(id);
  }).catch(function(e) { showToast(e.message); });
}

// ── Public profiles (?u=ID) ──
var publicProfileId = null;

function openPublicProfile(id) {
  publicProfileId = id;
  closeSheet('friends-sheet');
  document.getElementById('detail-page').classList.add('show');
  document.getElementById('detail-banner').innerHTML = '<button class="detail-back" onclick="closeDetail()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button><div class="skeleton" style="width:100%;height:100%"></div>';
  document.getElementById('detail-body').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Carregando perfil...</div>';
  accountApi('/api/users/' + encodeURIComponent(id)).then(renderPublicProfile).catch(function(e) {
    document.getElementById('detail-body').innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">' + escapeHtml(e.code === 'accounts_off' ? 'Perfis ainda não estão disponíveis' : e.message) + '</div>';
  });
}

function renderPublicProfile(p) {
  var id = safeId(p.publicId);
  document.getElementById('detail-banner').innerHTML =
    '<button class="detail-back" onclick="closeDetail()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>' +
    '<div class="pp-banner">' + avatarHtml(p.avatar, 72) + '<h2 id="pp-name"></h2><div class="pp-sub">#' + id + ' · Nv. ' + (+p.level || 1) + ' ' + escapeHtml(p.levelTitle || '') + '</div></div>';
  document.getElementById('pp-name').textContent = p.name;
  var html = '<div class="profile-actions" style="margin:16px 0">';
  if (p.isMe) html += '<button class="party-btn ghost" onclick="shareProfile()">Compartilhar perfil</button>';
  else if (!account) html += '<button class="party-btn" onclick="openAuth(\'register\')">Crie uma conta para adicionar</button>';
  else if (p.isFriend) html += (party ? '<button class="party-btn" onclick="inviteFriend(\'' + id + '\')">Chamar para a sala</button>' : '') + '<button class="party-btn ghost" onclick="removeFriend(\'' + id + '\')">Remover amigo</button>';
  else html += '<button class="party-btn" onclick="addFriend(\'' + id + '\')">Adicionar amigo</button>';
  html += '<button class="party-btn ghost" onclick="copyText(profileLink(\'' + id + '\'), \'Link copiado\')">Copiar link</button>';
  if (account && !p.isMe) html += '<button class="party-btn ghost" onclick="reportContent(\'user\',\'' + id + '\')">Denunciar</button>';
  html += '</div>';
  if (p.clan) html += '<div class="clan-card" onclick="openClan(\'' + safeId(p.clan.publicId) + '\')">' + clanBadge(p.clan, 40) + '<div class="clan-info"><div class="clan-name">' + escapeHtml(p.clan.name) + '</div><div class="clan-desc">' + escapeHtml(roleName(p.clan.role)) + '</div></div></div>';
  if (p.private) {
    html += '<div class="empty-state">Este perfil é privado.</div>';
  } else {
    if (p.watching) {
      html += '<div class="cal-item" onclick="openDetail(\'' + safeId(p.watching.animeId) + '\')">' + (p.watching.cover ? '<img src="' + escapeHtml(p.watching.cover) + '" alt="">' : '') +
        '<div><div class="cal-time" style="color:#4ade80">ASSISTINDO AGORA</div><div class="cal-title">' + escapeHtml(p.watching.title) + '</div><div class="cal-sub">Episódio ' + (+p.watching.ep || '?') + '</div></div></div>';
    }
    if (p.progress) {
      var st = p.progress.stats;
      html += '<div class="stats-row">' + [[st.episodes, 'Episódios'], [st.completed, 'Completos'], [st.reviews, 'Avaliações'], [p.progress.xp, 'XP']].map(function(x) {
        return '<div class="stat"><div class="stat-num">' + (+x[0] || 0).toLocaleString('pt-BR') + '</div><div class="stat-label">' + x[1] + '</div></div>';
      }).join('') + '</div><div class="achievements" style="padding:0 16px">' + p.progress.achievements.filter(function(a) { return a.unlocked; }).map(function(a) {
        return '<div class="ach on" title="' + escapeHtml(a.desc) + '"><span>' + escapeHtml(a.icon) + '</span><small>' + escapeHtml(a.name) + '</small></div>';
      }).join('') + '</div>';
    }
    var any = false;
    ['Assistindo', 'Favoritos', 'Completados', 'Quero Assistir'].forEach(function(n) {
      var items = (p.lists || {})[n] || [];
      if (!items.length) return;
      any = true;
      html += '<div class="section-header" style="padding-top:12px"><h2 class="section-title">' + n + ' <span style="color:var(--muted);font-size:14px">' + items.length + '</span></h2></div><div class="anime-grid">' +
        items.map(function(a) {
          return '<div class="poster-card" onclick="openDetail(\'' + safeId(a.id) + '\')"><div class="poster-img"><img src="' + escapeHtml(a.cover) + '" alt="" loading="lazy"></div><div class="poster-title">' + escapeHtml(a.title) + '</div></div>';
        }).join('') + '</div>';
    });
    if (!any && !p.watching) html += '<div class="empty-state">Nenhum anime nas listas ainda.</div>';
  }
  document.getElementById('detail-body').innerHTML = html + '<div style="height:40px"></div>';
}

// ── "Watching now" for friends ──
var lastPresence = 0;
function reportWatching(force) {
  if (!account || !currentAnime || !playerIsOpen()) return;
  if (!force && Date.now() - lastPresence < 120000) return;
  lastPresence = Date.now();
  accountApi('/api/me/watching', 'POST', { animeId: currentAnime.id, title: getTitle(currentAnime), cover: getCover(currentAnime), ep: playerEpisode }).catch(function() {});
}
function clearWatching() {
  if (!account) return;
  lastPresence = 0;
  accountApi('/api/me/watching', 'POST', {}).catch(function() {});
}

// ── Party invites by ID ──
function inviteFriend(id) {
  if (!party) { showToast('Crie ou entre numa sala primeiro'); return; }
  if (!account) { openAuth('login'); return; }
  id = String(id || '').replace(/^#/, '').trim().toUpperCase();
  if (!id) return;
  accountApi('/api/me/invite', 'POST', { publicId: id, code: party.code }).then(function(r) {
    showToast('Convite enviado para ' + r.name);
  }).catch(function(e) { showToast(e.message); });
}

function renderPartyFriends() {
  var el = document.getElementById('party-friends');
  if (!el) return;
  if (!account) {
    el.innerHTML = '<div class="party-muted">Chame amigos pelo ID: <a href="#" style="color:var(--accent)" onclick="openAuth(\'login\');return false">entre na sua conta</a>.</div>';
    return;
  }
  el.innerHTML = '<div class="party-row"><input id="party-invite-input" maxlength="7" placeholder="Chamar pelo ID (ex.: K7Q2M9)" autocapitalize="characters" onkeydown="if(event.key===\'Enter\')inviteFriend(this.value)"><button class="party-btn ghost" onclick="inviteFriend(document.getElementById(\'party-invite-input\').value)">Chamar</button></div><div id="party-friend-chips" class="party-row" style="flex-wrap:wrap"></div>';
  loadFriends().then(function(list) {
    var chips = document.getElementById('party-friend-chips');
    if (chips) chips.innerHTML = list.slice(0, 8).map(function(f) {
      return '<button class="filter-chip" onclick="inviteFriend(\'' + f.publicId + '\')">+ ' + escapeHtml(f.name) + '</button>';
    }).join('');
  }).catch(function() {});
}

var inboxTimer = null;
function startInboxPolling() {
  stopInboxPolling();
  if (!account) return;
  checkInbox();
  inboxTimer = setInterval(function() { if (!document.hidden) checkInbox(); }, 20000);
}
function stopInboxPolling() { clearInterval(inboxTimer); inboxTimer = null; }

var pendingInvites = [];
function checkInbox() {
  if (!account) return;
  accountApi('/api/me/inbox').then(function(r) {
    (r.invites || []).forEach(function(inv) {
      if (party && party.code === inv.code) return;
      pendingInvites.push(inv);
      var list = getNotifications();
      list.unshift({ id: 'invite', title: inv.from + ' te chamou para assistir junto', body: (inv.title ? inv.title + ' · ' : '') + 'sala ' + inv.code, at: Date.now() });
      setNotifications(list.slice(0, 50));
      updateNotifBadge();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(inv.from + ' te chamou no AnimeHub', { body: 'Toque para entrar na sala ' + inv.code, icon: 'icon-192.png' }); } catch (e) {}
      }
    });
    showNextInvite();
  }).catch(function() {});
}

function showNextInvite() {
  var el = document.getElementById('invite-banner');
  var inv = pendingInvites[0];
  if (!inv) { el.classList.remove('show'); return; }
  el.innerHTML = '<div><b>' + escapeHtml(inv.from) + '</b> te chamou para assistir junto' + (inv.title ? ': <b>' + escapeHtml(inv.title) + '</b>' : '') + '</div>' +
    '<div class="party-row"><button class="party-btn" style="flex:1" onclick="acceptInvite()">Entrar na sala</button><button class="party-btn ghost" onclick="dismissInvite()">Agora não</button></div>';
  el.classList.add('show');
}
function acceptInvite() {
  var inv = pendingInvites.shift();
  showNextInvite();
  if (inv) joinParty(inv.code);
}
function dismissInvite() { pendingInvites.shift(); showNextInvite(); }

renderAccount();
if (account) { pullAccount(); startInboxPolling(); }
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && account) { pullAccount(); checkInbox(); }
  if (document.hidden && syncDirty) pushAccountData();
});
