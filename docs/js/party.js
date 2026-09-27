// ── Watch party ──
var party = null;
var partyPendingSync = null;
var partyRemoteEpisode = false;
var CLIENT_ID = (function() {
  try {
    var id = sessionStorage.getItem('ah_client');
    if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('ah_client', id); }
    return id;
  } catch (e) { return Math.random().toString(36).slice(2, 10); }
})();

function partyName() { return displayName(); }

// Play/pause/seek done by the app itself (loading, resume, remote sync) must not be echoed
// to the room. Each one marks the next media event of its type as ours; user actions never are.
var ownMediaEvents = { play: 0, pause: 0, seek: 0 };
function expectOwnMediaEvent(type) { ownMediaEvents[type] = Date.now() + 8000; }
function isOwnMediaEvent(type) {
  if (ownMediaEvents[type] > Date.now()) { ownMediaEvents[type] = 0; return true; }
  return false;
}
function programmaticSeek(t) { expectOwnMediaEvent('seek'); videoEl.currentTime = t; }
function programmaticPlay() {
  if (!videoEl.paused) return Promise.resolve();
  expectOwnMediaEvent('play');
  return videoEl.play();
}
function programmaticPause() {
  if (videoEl.paused) return;
  expectOwnMediaEvent('pause');
  videoEl.pause();
}

function partyApi(path, body) {
  var opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  return fetch(getApiBase() + '/api/party' + path, opts).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function playerIsOpen() { return document.getElementById('player-overlay').classList.contains('show'); }
function partySheetOpen() { return document.getElementById('party-panel').classList.contains('show'); }

// A room exists on its own: create it from anywhere, then whoever opens an
// episode takes everyone in the room along.
function createParty() {
  var body = {};
  if (playerIsOpen() && currentAnime) {
    body = { animeId: currentAnime.id, title: getTitle(currentAnime), cover: getCover(currentAnime),
      ep: playerEpisode, totalEps: playerTotalEps, time: videoEl.currentTime || 0, playing: !videoEl.paused };
  }
  partyApi('', body).then(function(res) {
    connectParty(res.code);
    renderPartyPanel();
  }).catch(function() { showToast('Não foi possível criar a sala'); });
}

function joinParty(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return;
  partyApi('/' + encodeURIComponent(code)).then(function(res) {
    // The 'state' event that arrives on connect opens the room's episode, if any.
    connectParty(code);
    showToast('Você entrou na sala ' + code);
    if (!res.state.animeId || !res.state.ep) openPartySheet();
    else closePartySheet();
  }).catch(function() { showToast('Sala não encontrada'); });
}

// keep: reconnecting to the same room, so chat and state stay on screen.
function connectParty(code, keep) {
  var old = party;
  if (old && old.events) old.events.close();
  party = { code: code, members: 1, names: [], messages: [], state: null, vote: null, events: null, retries: 0 };
  if (keep && old) { party.messages = old.messages; party.state = old.state; party.members = old.members; party.names = old.names; }
  var es = new EventSource(getApiBase() + '/api/party/' + encodeURIComponent(code) + '/events?clientId=' + CLIENT_ID + '&name=' + encodeURIComponent(partyName()));
  party.events = es;
  es.onopen = function() { if (party && party.events === es) party.retries = 0; };
  es.onmessage = function(m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (e) { return; }
    handlePartyEvent(ev);
  };
  // The browser retries dropped connections itself; it gives up (CLOSED) when the
  // room is gone, which happens when the free server restarts or falls asleep.
  es.onerror = function() {
    if (party && party.events === es && es.readyState === 2) restoreParty(code);
  };
  updatePartyUi();
}

function restoreParty(code) {
  if (!party || party.code !== code) return;
  var attempt = party.retries++;
  partyApi('/' + encodeURIComponent(code)).catch(function(err) {
    if (!/404/.test(err.message)) throw err;
    var st = party.state || {};
    var body = { code: code, animeId: st.animeId, title: st.title, cover: st.cover, ep: st.ep, totalEps: st.totalEps };
    if (isSameEpisode(st) && videoEl.duration) { body.time = videoEl.currentTime; body.playing = !videoEl.paused; }
    return partyApi('', body);
  }).then(function() {
    if (party && party.code === code) connectParty(code, true);
  }).catch(function() {
    if (party && party.code === code) setTimeout(function() { restoreParty(code); }, Math.min(30000, 3000 * (attempt + 1)));
  });
}

function leaveParty() {
  if (!party) return;
  if (party.events) party.events.close();
  party = null;
  partyPendingSync = null;
  updatePartyUi();
  renderPartyPanel();
  showToast('Você saiu da sala');
}

function isSameEpisode(st) {
  return playerIsOpen() && currentAnime && String(currentAnime.id) === String(st.animeId) && playerEpisode === st.ep;
}

function handlePartyEvent(ev) {
  if (!party) return;
  if (ev.type === 'members') { party.members = ev.count; party.names = ev.names || []; updatePartyUi(); renderPartyMembers(); return; }
  if (ev.type === 'chat') { appendPartyMessage(ev.name, ev.text); return; }
  if (ev.type === 'reaction') { floatReaction(ev.emoji, ev.name); return; }
  if (ev.type === 'vote') { handlePartyVote(ev); return; }
  if (ev.type === 'join' || ev.type === 'leave') { appendPartyMessage(null, ev.name + (ev.type === 'join' ? ' entrou na sala' : ' saiu da sala')); return; }
  if (ev.type === 'state') {
    var st = ev.state;
    party.state = st;
    renderPartyNow();
    renderPartyVote();
    if (!st.animeId || !st.ep) return;
    var sync = { time: st.time + (st.playing ? st.elapsed : 0), playing: st.playing };
    if (!isSameEpisode(st)) openRemoteEpisode(st, sync);
    else if (videoEl.duration) applyPartySync(sync);
    else partyPendingSync = sync;
    return;
  }
  if (ev.type === 'episode') {
    party.state = { animeId: ev.animeId, title: ev.title, cover: ev.cover, totalEps: ev.totalEps, ep: ev.ep };
    renderPartyNow();
    renderPartyVote();
    if (ev.from === CLIENT_ID || isSameEpisode(ev)) return;
    appendPartyMessage(null, ev.from === 'vote' ? 'A sala votou: indo para o Ep ' + ev.ep : ev.name + ' abriu ' + ev.title + ' — Ep ' + ev.ep);
    openRemoteEpisode(ev, { time: 0, playing: true });
    return;
  }
  if (ev.from === CLIENT_ID) return;
  var remote = { time: ev.time, playing: ev.playing };
  if (!videoEl.duration) { partyPendingSync = remote; return; }
  applyPartySync(remote);
  var verb = { play: 'deu play', pause: 'pausou', seek: 'pulou para ' + formatTime(ev.time) }[ev.type];
  if (verb) showToast(ev.name + ' ' + verb);
}

function openRemoteEpisode(st, sync) {
  partyPendingSync = sync;
  var ready = Promise.resolve();
  if (!currentAnime || String(currentAnime.id) !== String(st.animeId)) {
    document.getElementById('detail-page').classList.remove('show');
    ready = Promise.all([atvFetch('info=' + st.animeId), atvFetch('cat_id=' + st.animeId)]).then(function(r) {
      currentAnime = (r[0] && r[0][0]) || { id: st.animeId };
      currentAnimeEpisodes = r[1] || [];
    }, function() {
      currentAnime = { id: st.animeId };
      currentAnimeEpisodes = [];
    }).then(function() {
      // Same title as whoever opened it, so everyone resolves the same servers.
      currentAnime.category_name = st.title;
    });
  }
  return ready.then(function() {
    partyRemoteEpisode = true;
    openPlayer(st.animeId, st.ep, st.totalEps || currentAnimeEpisodes.length);
    partyRemoteEpisode = false;
  });
}

function goToPartyEpisode() {
  if (!party) return;
  partyApi('/' + party.code).then(function(res) {
    var st = res.state;
    closePartySheet();
    openRemoteEpisode(st, { time: st.time + (st.playing ? st.elapsed : 0), playing: st.playing });
  }).catch(function() { showToast('Não foi possível abrir o episódio da sala'); });
}

function applyPartySync(sync) {
  if (Math.abs(videoEl.currentTime - sync.time) > 1.5) programmaticSeek(sync.time);
  if (sync.playing) programmaticPlay().catch(function() { showToast('Toque no play para sincronizar com a sala'); });
  else programmaticPause();
}

function partyTakePendingSync() {
  var s = partyPendingSync;
  partyPendingSync = null;
  return s;
}

function partyLocalAction(type) {
  if (!party || !videoEl.duration) return;
  partyApi('/' + party.code + '/action', { clientId: CLIENT_ID, name: partyName(), type: type, time: videoEl.currentTime, playing: !videoEl.paused }).catch(function() {});
}

function partyEpisodeOpened(ep) {
  if (!party || partyRemoteEpisode || !currentAnime) return;
  partyApi('/' + party.code + '/action', {
    clientId: CLIENT_ID, name: partyName(), type: 'episode', ep: ep,
    animeId: currentAnime.id, title: getTitle(currentAnime), cover: getCover(currentAnime), totalEps: playerTotalEps
  }).catch(function() {});
}

function sendPartyChat() {
  var input = document.getElementById('party-chat-input');
  var text = input && input.value.trim();
  if (!party || !text) return;
  input.value = '';
  partyApi('/' + party.code + '/action', { clientId: CLIENT_ID, name: partyName(), type: 'chat', text: text }).catch(function() { showToast('Mensagem não enviada'); });
}

var PARTY_REACTIONS = ['😂', '😮', '😍', '🔥', '😭', '👏'];

function sendReaction(emoji) {
  if (!party) return;
  partyApi('/' + party.code + '/action', { clientId: CLIENT_ID, name: partyName(), type: 'reaction', emoji: emoji }).catch(function() {});
}

function floatReaction(emoji, name) {
  var layer = document.getElementById('reaction-layer');
  if (layer.childElementCount > 30) return;
  var el = document.createElement('div');
  el.className = 'reaction-float';
  el.style.left = (8 + Math.random() * 80) + '%';
  el.textContent = emoji;
  if (name) { var who = document.createElement('small'); who.textContent = name; el.appendChild(who); }
  layer.appendChild(el);
  setTimeout(function() { el.remove(); }, 2900);
}

function voteNext(cancel) {
  if (!party) return;
  partyApi('/' + party.code + '/action', { clientId: CLIENT_ID, name: partyName(), type: 'vote', cancel: !!cancel }).catch(function() { showToast('Não foi possível votar'); });
}

function handlePartyVote(ev) {
  var before = party.vote;
  party.vote = ev.ep ? ev : null;
  var mine = ev.voters && ev.voters.indexOf(CLIENT_ID) !== -1;
  if (ev.ep && (!before || before.ep !== ev.ep) && !mine) {
    showToast(ev.by + ' quer ir para o Ep ' + ev.ep + '. Abra a sala para votar');
    appendPartyMessage(null, ev.by + ' quer ir para o Ep ' + ev.ep);
  }
  renderPartyVote();
}

function renderPartyVote() {
  var el = document.getElementById('party-vote');
  if (!el || !party) return;
  var st = party.state, v = party.vote;
  if (v && v.ep) {
    var mine = v.voters && v.voters.indexOf(CLIENT_ID) !== -1;
    el.className = 'party-vote active';
    el.innerHTML = '<span>Ir para o Ep ' + v.ep + '? <b>' + v.count + '/' + v.needed + '</b> votos</span>' +
      (mine ? '<button class="party-btn ghost" onclick="voteNext(true)">Tirar voto</button>' : '<button class="party-btn" onclick="voteNext()">Votar</button>');
  } else if (st && st.ep && (!st.totalEps || st.ep < st.totalEps)) {
    el.className = 'party-vote';
    el.innerHTML = '<span>Todo mundo pronto pro próximo?</span><button class="party-btn ghost" onclick="voteNext()">Votar no Ep ' + (st.ep + 1) + '</button>';
  } else {
    el.className = 'party-vote';
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
}

function appendPartyMessage(name, text) {
  if (!party) return;
  party.messages.push({ name: name, text: text });
  if (party.messages.length > 100) party.messages.shift();
  var chat = document.getElementById('party-chat');
  if (chat) { chat.appendChild(partyMessageEl(name, text)); chat.scrollTop = chat.scrollHeight; }
}

function partyMessageEl(name, text) {
  var el = document.createElement('div');
  el.className = 'party-msg' + (name ? '' : ' system');
  if (name) {
    var b = document.createElement('b');
    b.textContent = name + ': ';
    el.appendChild(b);
  }
  el.appendChild(document.createTextNode(text));
  return el;
}

function updatePartyUi() {
  var inRoom = !!party;
  var count = inRoom ? party.members + (party.members === 1 ? ' pessoa' : ' pessoas') : '';
  document.getElementById('party-btn').classList.toggle('active', inRoom);
  document.getElementById('party-btn-label').textContent = inRoom ? party.code + ' · ' + party.members : 'Juntos';
  document.getElementById('header-party-btn').classList.toggle('active', inRoom);
  document.getElementById('header-party-label').textContent = inRoom ? party.code : 'Juntos';
  var pill = document.getElementById('party-pill');
  pill.textContent = inRoom ? 'Sala ' + party.code + ' · ' + count : '';
  pill.classList.toggle('show', inRoom && !playerIsOpen() && !partySheetOpen());
}

function renderPartyMembers() {
  var el = document.getElementById('party-members');
  if (el && party) el.textContent = party.members + (party.members === 1 ? ' pessoa' : ' pessoas') + ' na sala' + (party.names.length ? ': ' + party.names.join(', ') : '');
}

function renderPartyNow() {
  var el = document.getElementById('party-now');
  if (!el || !party) return;
  var st = party.state;
  if (st && st.animeId && st.ep) {
    el.innerHTML = 'Assistindo agora: <b>' + escapeHtml(st.title) + ' — Ep ' + st.ep + '</b>' +
      (isSameEpisode(st) ? '' : '<div style="margin-top:8px"><button class="party-btn" onclick="goToPartyEpisode()">Ir para o episódio</button></div>');
  } else {
    el.innerHTML = 'Ninguém escolheu um anime ainda. Abra um anime e toque em um episódio: todo mundo na sala vai junto.' +
      '<div style="margin-top:8px"><button class="party-btn ghost" onclick="closePartySheet();closePlayer();switchTab(\'explore\')">Escolher anime</button></div>';
  }
}

function openPartySheet() {
  renderPartyPanel();
  document.getElementById('party-panel').classList.add('show');
  document.getElementById('party-backdrop').classList.add('show');
  updatePartyUi();
}

function closePartySheet() {
  document.getElementById('party-panel').classList.remove('show');
  document.getElementById('party-backdrop').classList.remove('show');
  updatePartyUi();
}

function togglePartyPanel() {
  if (partySheetOpen()) closePartySheet(); else openPartySheet();
}

function renderPartyPanel() {
  var panel = document.getElementById('party-panel');
  var head = '<div class="party-head"><span>Assistir junto</span><button class="player-close" onclick="closePartySheet()" aria-label="Fechar">✕</button></div>';
  if (!party) {
    panel.innerHTML = head +
      '<div class="party-muted">Crie uma sala, mande o link pra galera e escolham juntos o que assistir. Quando alguém abrir um episódio, todo mundo na sala vai junto, com play, pause e pulos sincronizados.</div>' +
      '<button class="party-btn" onclick="createParty()">Criar sala</button>' +
      '<div class="party-row"><input id="party-code-input" maxlength="8" placeholder="Código da sala" autocapitalize="characters" onkeydown="if(event.key===\'Enter\')joinParty(this.value)">' +
      '<button class="party-btn ghost" onclick="joinParty(document.getElementById(\'party-code-input\').value)">Entrar</button></div>';
    return;
  }
  panel.innerHTML = head +
    '<div class="party-code">' + escapeHtml(party.code) + '</div>' +
    '<div class="party-row"><button class="party-btn" style="flex:1" onclick="shareParty()">Convidar</button><button class="party-btn ghost" onclick="leaveParty()">Sair da sala</button></div>' +
    '<div class="party-now" id="party-now"></div>' +
    '<div class="party-vote" id="party-vote"></div>' +
    '<div class="party-reactions">' + PARTY_REACTIONS.map(function(e) { return '<button onclick="sendReaction(\'' + e + '\')" aria-label="Reagir ' + e + '">' + e + '</button>'; }).join('') + '</div>' +
    '<div class="party-muted" id="party-members"></div>' +
    '<div id="party-friends"></div>' +
    '<div class="party-chat" id="party-chat"></div>' +
    '<div class="party-row"><input id="party-chat-input" maxlength="300" placeholder="Mensagem" onkeydown="if(event.key===\'Enter\')sendPartyChat()"><button class="party-btn" onclick="sendPartyChat()">Enviar</button></div>';
  var chat = document.getElementById('party-chat');
  party.messages.forEach(function(m) { chat.appendChild(partyMessageEl(m.name, m.text)); });
  chat.scrollTop = chat.scrollHeight;
  renderPartyNow();
  renderPartyMembers();
  renderPartyVote();
  renderPartyFriends();
}

function shareParty() {
  if (!party) return;
  var link = location.origin + location.pathname + '?party=' + party.code;
  var text = 'Bora assistir anime junto no AnimeHub? Entra na sala ' + party.code;
  if (navigator.share) { navigator.share({ title: 'AnimeHub', text: text, url: link }).catch(function() {}); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(function() { showToast('Link da sala copiado'); }, function() { prompt('Copie o link da sala:', link); });
  else prompt('Copie o link da sala:', link);
}
