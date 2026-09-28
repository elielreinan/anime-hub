// ── Public lists ("Meus 10 isekais favoritos"), shareable at ?list=ID ──

var myListsCache = [];

function listLink(id) { return location.origin + location.pathname + '?list=' + id; }

function loadMyLists() {
  var el = document.getElementById('profile-public-lists');
  if (!el) return;
  if (!account) { el.innerHTML = ''; return; }
  accountApi('/api/me/lists').then(function(r) {
    myListsCache = r.lists;
    el.innerHTML = '<div class="section-header" style="padding-top:16px"><h2 class="section-title">Listas públicas</h2><button class="party-btn ghost mini" onclick="openListEditor()">+ Nova</button></div>' +
      (r.lists.length ? r.lists.map(listRowHtml).join('') : '<div class="empty-state">Monte listas como "Meus 10 isekais favoritos" e compartilhe o link.</div>');
    fillListTitles(el, r.lists);
  }).catch(function() { el.innerHTML = ''; });
}

function listRowHtml(l) {
  var covers = l.items.slice(0, 4).map(function(a) { return '<img src="' + escapeHtml(a.cover) + '" alt="" loading="lazy">'; }).join('');
  return '<div class="list-card" onclick="openPublicList(\'' + safeId(l.publicId) + '\')"><div class="list-covers">' + covers + '</div>' +
    '<div class="clan-info"><div class="clan-name"></div><div class="clan-desc">' + l.count + ' animes</div></div></div>';
}

// Renders titles as text after the HTML is in place.
function fillListTitles(root, lists) {
  root.querySelectorAll('.list-card .clan-name').forEach(function(el, i) { if (lists[i]) el.textContent = lists[i].title; });
}

// Picks from the anime already in your own lists (Assistindo, Favoritos...).
function openListEditor(id) {
  if (!account) { openAuth('login'); return; }
  var editing = id ? myListsCache.find(function(l) { return l.publicId === id; }) : null;
  var chosen = {};
  (editing ? editing.items : []).forEach(function(a) { chosen[a.id] = true; });
  var pool = [], seen = {};
  var lists = getUserLists();
  Object.keys(lists).forEach(function(name) {
    (lists[name] || []).forEach(function(a) { var aid = safeId(a.id); if (aid && !seen[aid]) { seen[aid] = true; pool.push({ id: aid, title: a.title || a.category_name || '', cover: a.cover || '' }); } });
  });
  (editing ? editing.items : []).forEach(function(a) { if (!seen[a.id]) { seen[a.id] = true; pool.push(a); } });
  window._listPool = pool;
  openGenericSheet(editing ? 'Editar lista' : 'Nova lista pública', '<div class="transfer-box">' +
    '<input class="auth-field" id="list-title" maxlength="80" placeholder="Título (ex.: Meus 10 isekais favoritos)">' +
    '<textarea class="auth-field" id="list-desc" maxlength="300" rows="2" placeholder="Descrição (opcional)"></textarea>' +
    '<div class="party-muted">Escolha os animes (vêm das suas listas: Assistindo, Favoritos...). Máximo 50.</div>' +
    (pool.length ? '<div class="list-pick">' + pool.map(function(a, i) {
      return '<label class="list-pick-item"><input type="checkbox" data-i="' + i + '"' + (chosen[a.id] ? ' checked' : '') + '><img src="' + escapeHtml(a.cover) + '" alt="" loading="lazy"><span></span></label>';
    }).join('') + '</div>' : '<div class="empty-state">Adicione animes aos Favoritos ou a outra lista primeiro.</div>') +
    '<div class="party-row"><button class="party-btn" style="flex:1" onclick="saveList(' + (editing ? '\'' + safeId(editing.publicId) + '\'' : 'null') + ')">Salvar</button>' +
    (editing ? '<button class="party-btn ghost" onclick="deleteList(\'' + safeId(editing.publicId) + '\')">Apagar</button>' : '') + '</div></div>');
  document.getElementById('list-title').value = editing ? editing.title : '';
  document.getElementById('list-desc').value = editing ? editing.description : '';
  document.querySelectorAll('.list-pick-item span').forEach(function(el, i) { el.textContent = pool[i].title; });
}

function saveList(id) {
  var items = [];
  document.querySelectorAll('.list-pick input:checked').forEach(function(cb) { items.push(window._listPool[+cb.dataset.i]); });
  var body = { title: document.getElementById('list-title').value, description: document.getElementById('list-desc').value, items: items };
  accountApi(id ? '/api/me/lists/' + id : '/api/me/lists', id ? 'PUT' : 'POST', body).then(function(r) {
    showToast('Lista salva!');
    closeGenericSheet();
    loadMyLists();
    openPublicList(r.list.publicId);
  }).catch(function(e) { showToast(e.message); });
}

function deleteList(id) {
  if (!confirm('Apagar esta lista?')) return;
  accountApi('/api/me/lists/' + id, 'DELETE').then(function() { showToast('Lista apagada'); closeGenericSheet(); loadMyLists(); })
    .catch(function(e) { showToast(e.message); });
}

function openPublicList(id) {
  openGenericSheet('Lista', '<div class="empty-state">Carregando...</div>');
  accountApi('/api/lists/' + id).then(function(l) {
    var mine = account && l.owner && l.owner.publicId === account.user.publicId;
    document.getElementById('generic-title').textContent = l.title;
    var html = '<div class="transfer-box"><div class="list-desc"></div>' + userLine(l.owner, l.count + ' animes') +
      '<div class="party-row"><button class="party-btn" style="flex:1" onclick="shareList(\'' + safeId(l.publicId) + '\')">Compartilhar</button>' +
      (mine ? '<button class="party-btn ghost" onclick="closeGenericSheet();openListEditor(\'' + safeId(l.publicId) + '\')">Editar</button>' : '') + '</div></div>' +
      '<div class="anime-grid">' + l.items.map(function(a, i) {
        return '<div class="poster-card" onclick="closeGenericSheet();openDetail(\'' + safeId(a.id) + '\')"><div class="poster-img"><img src="' + escapeHtml(a.cover) + '" alt="" loading="lazy"><span class="poster-score">#' + (i + 1) + '</span></div><div class="poster-title"></div></div>';
      }).join('') + '</div>';
    document.getElementById('generic-body').innerHTML = html;
    document.querySelector('#generic-body .list-desc').textContent = l.description || '';
    document.querySelectorAll('#generic-body .poster-title').forEach(function(el, i) { el.textContent = l.items[i].title; });
  }).catch(function(e) {
    document.getElementById('generic-body').innerHTML = '<div class="empty-state">' + escapeHtml(e.code === 'accounts_off' ? 'Listas ainda não foram ativadas no servidor.' : e.message) + '</div>';
  });
}

function shareList(id) {
  var link = listLink(id);
  if (navigator.share) { navigator.share({ title: 'AnimeHub', text: 'Olha essa lista de animes', url: link }).catch(function() {}); return; }
  copyText(link, 'Link da lista copiado');
}

// Lists on someone's public profile.
function loadUserLists(publicId, containerId) {
  accountApi('/api/users/' + publicId + '/lists').then(function(r) {
    var el = document.getElementById(containerId);
    if (!el || !r.lists.length) return;
    el.innerHTML = '<div class="section-header" style="padding-top:12px"><h2 class="section-title">Listas públicas</h2></div>' + r.lists.map(listRowHtml).join('');
    fillListTitles(el, r.lists);
  }).catch(function() {});
}
