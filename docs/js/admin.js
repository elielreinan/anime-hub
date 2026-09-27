// ── Admin panel (only for accounts in ADMIN_EMAILS; the server checks every call) ──

function openAdmin() {
  openGenericSheet('Administração', '<div class="rank-tabs" style="padding-top:12px">' +
    ['stats:Visão geral', 'reports:Denúncias', 'users:Usuários', 'audit:Auditoria'].map(function(t, i) {
      var p = t.split(':');
      return '<button class="filter-chip' + (i ? '' : ' active') + '" onclick="adminTab(this,\'' + p[0] + '\')">' + p[1] + '</button>';
    }).join('') + '</div><div id="admin-body"></div>');
  adminStats();
}

function adminTab(el, tab) {
  el.parentElement.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  ({ stats: adminStats, reports: adminReports, users: adminUsers, audit: adminAudit })[tab]();
}

function adminBody(html) { var el = document.getElementById('admin-body'); if (el) el.innerHTML = html; }
function adminFail(e) { adminBody('<div class="empty-state">' + escapeHtml(e.message) + '</div>'); }

function adminStats() {
  adminBody('<div class="empty-state">Carregando...</div>');
  accountApi('/api/admin/stats').then(function(s) {
    var cards = [['Usuários', s.users], ['Novos 24h', s.users_24h], ['Novos 7d', s.users_7d], ['Ativos 24h', s.active_24h], ['Suspensos', s.banned],
      ['Publicações', s.posts], ['Comentários', s.comments], ['Avaliações', s.reviews], ['Clãs', s.clans], ['Episódios vistos', s.episodes_watched],
      ['Denúncias abertas', s.open_reports], ['Salas agora', s.parties], ['Memória (MB)', s.memoryMb], ['No ar há (min)', s.uptimeMin]];
    adminBody('<div class="admin-grid">' + cards.map(function(c) { return '<div class="admin-card"><b>' + (+c[1] || 0).toLocaleString('pt-BR') + '</b><span>' + c[0] + '</span></div>'; }).join('') + '</div>' +
      '<div class="section-header"><h2 class="section-title">Servidores de vídeo (45 min)</h2></div>' +
      (s.servers.length ? s.servers.map(function(x) { return '<div class="friend-row"><div class="friend-info"><div class="friend-name">' + escapeHtml(x.host) + (x.unstable ? ' <span class="badge-bad">instável</span>' : '') + '</div><div class="friend-status">' + x.ok + ' ok · ' + x.failed + ' falhas</div></div></div>'; }).join('') : '<div class="empty-state">Sem relatos ainda.</div>'));
  }).catch(adminFail);
}

function adminReports() {
  adminBody('<div class="empty-state">Carregando...</div>');
  accountApi('/api/admin/reports').then(function(r) {
    if (!r.reports.length) { adminBody('<div class="empty-state">Nenhuma denúncia aberta. 🎉</div>'); return; }
    adminBody(r.reports.map(function(x, i) {
      return '<div class="admin-report"><div><b>' + escapeHtml(x.type) + '</b> · ' + x.reports + ' denúncia(s)' + (x.target && x.target.author ? ' · autor #' + escapeHtml(x.target.author) : '') + (x.target && x.target.hidden ? ' · <i>oculto</i>' : '') + '</div>' +
        '<div class="admin-quote" id="rep-' + i + '"></div><div class="party-muted">Motivos: ' + escapeHtml(x.reasons.join(' · ')) + '</div>' +
        '<div class="mini-actions"><button class="mini-btn" onclick="adminResolve(\'' + safeId(x.type) + '\',\'' + reportKey(x.id) + '\',\'dismiss\')">Manter</button>' +
        '<button class="mini-btn" onclick="adminResolve(\'' + safeId(x.type) + '\',\'' + reportKey(x.id) + '\',\'hide\')">Ocultar</button>' +
        '<button class="mini-btn danger" onclick="adminResolve(\'' + safeId(x.type) + '\',\'' + reportKey(x.id) + '\',\'ban\')">Ocultar e suspender autor</button></div></div>';
    }).join(''));
    r.reports.forEach(function(x, i) { var el = document.getElementById('rep-' + i); if (el) el.textContent = x.target ? x.target.text : '(conteúdo removido)'; });
  }).catch(adminFail);
}

function reportKey(id) { return String(id).replace(/[^A-Za-z0-9:_-]/g, ''); }

function adminResolve(type, id, action) {
  if (action === 'ban' && !confirm('Ocultar e suspender o autor?')) return;
  accountApi('/api/admin/reports/resolve', 'POST', { type: type, id: id, action: action }).then(function() { showToast('Feito'); adminReports(); }).catch(function(e) { showToast(e.message); });
}

function adminUsers(q) {
  adminBody('<div class="party-row" style="padding:12px 16px"><input id="admin-q" placeholder="Nome, e-mail ou ID" value="' + escapeHtml(q || '') + '" onkeydown="if(event.key===\'Enter\')adminUsers(this.value)"><button class="party-btn" onclick="adminUsers(document.getElementById(\'admin-q\').value)">Buscar</button></div><div id="admin-users" class="empty-state">Carregando...</div>');
  accountApi('/api/admin/users?q=' + encodeURIComponent(q || '')).then(function(r) {
    var el = document.getElementById('admin-users');
    el.className = '';
    el.innerHTML = r.users.map(function(u) {
      return '<div class="friend-row">' + avatarHtml(u.avatar, 36) + '<div class="friend-info"><div class="friend-name">' + escapeHtml(u.name) + ' <small>#' + escapeHtml(u.publicId) + '</small>' + (u.admin ? ' <span class="badge-ok">admin</span>' : '') + (u.banned ? ' <span class="badge-bad">suspenso</span>' : '') + '</div>' +
        '<div class="friend-status">' + escapeHtml(u.email) + ' · ' + u.xp + ' XP · desde ' + new Date(u.createdAt).toLocaleDateString('pt-BR') + '</div></div>' +
        (u.admin ? '' : '<button class="mini-btn' + (u.banned ? '' : ' danger') + '" onclick="adminBan(\'' + safeId(u.publicId) + '\',' + (u.banned ? 1 : 0) + ')">' + (u.banned ? 'Reativar' : 'Suspender') + '</button>') + '</div>';
    }).join('') || '<div class="empty-state">Ninguém encontrado.</div>';
  }).catch(adminFail);
}

function adminBan(id, banned) {
  var body = banned ? { unban: true } : { reason: prompt('Motivo da suspensão:') || '' };
  if (!banned && !body.reason.trim()) return;
  accountApi('/api/admin/users/' + id + '/ban', 'POST', body).then(function() { showToast(banned ? 'Conta reativada' : 'Conta suspensa'); adminUsers(document.getElementById('admin-q').value); })
    .catch(function(e) { showToast(e.message); });
}

function adminAudit() {
  adminBody('<div class="empty-state">Carregando...</div>');
  accountApi('/api/admin/audit').then(function(r) {
    adminBody(r.entries.map(function(e) {
      return '<div class="friend-row"><div class="friend-info"><div class="friend-name">' + escapeHtml(e.action) + (e.target ? ' <small>' + escapeHtml(e.target) + '</small>' : '') + '</div>' +
        '<div class="friend-status">' + (e.actor ? escapeHtml(e.actor.name) + ' #' + escapeHtml(e.actor.publicId) + ' · ' : '') + escapeHtml(e.ip || '') + ' · ' + new Date(e.at).toLocaleString('pt-BR') + '</div></div></div>';
    }).join('') || '<div class="empty-state">Vazio.</div>');
  }).catch(adminFail);
}
