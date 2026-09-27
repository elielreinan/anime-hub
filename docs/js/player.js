// ── Player ──
var playerAnimeId = null;
var playerEpisode = 0;
var playerTotalEps = 0;
var playerEmbeds = [];
var playerServerIndex = -1;
var playerUsingProxy = false;
var playerRequestId = 0;
var playerWatchdog = null;
var playerResumeDone = false;
var playerSwitchTime = 0;
var nextCountdownTimer = null;
var lastProgressSave = 0;
var episodeRequests = {};
var videoEl = document.getElementById('player-video');

function slugify(title) {
  return title
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+(Dublado|Legendado|PT-PT|PT-BR)\s*/gi, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}


function formatTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function setPlayerStatus(msg, spinning) {
  document.getElementById('player-placeholder').style.display = 'flex';
  document.getElementById('player-status').textContent = msg;
  document.getElementById('player-spinner').style.display = spinning ? 'block' : 'none';
}

function showPlayerError(msg) {
  setPlayerStatus(msg, false);
  var btn = document.createElement('button');
  btn.textContent = 'Voltar';
  btn.className = 'party-btn';
  btn.style.marginTop = '16px';
  btn.onclick = closePlayer;
  var status = document.getElementById('player-status');
  status.appendChild(document.createElement('br'));
  status.appendChild(btn);
}

function preferredLang() {
  var title = currentAnime ? getTitle(currentAnime) : '';
  if (/dublado/i.test(title)) return 'dub';
  if (/legendado/i.test(title)) return 'sub';
  return getSettings().lang;
}

function episodeApiUrl(ep) {
  var title = currentAnime ? getTitle(currentAnime) : '';
  return getApiBase() + '/api/episode/' + encodeURIComponent(slugify(title) || 'anime') + '/' + ep +
    '?title=' + encodeURIComponent(title) + '&lang=' + preferredLang();
}

// Shared by playback and prefetch, so opening a prefetched episode reuses the request.
function fetchEpisodePlayers(ep) {
  var url = episodeApiUrl(ep);
  var cached = episodeRequests[url];
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.promise;
  var promise = fetch(url).then(function(r) { return r.json(); }).then(function(d) {
    var embeds = (d && d.data && d.data.embeds) || [];
    if (!embeds.length) delete episodeRequests[url];
    return embeds;
  });
  promise.catch(function() { delete episodeRequests[url]; });
  episodeRequests[url] = { at: Date.now(), promise: promise };
  return promise;
}

function prefetchEpisode(ep) {
  if (!currentAnime || ep < 1 || (playerTotalEps && ep > playerTotalEps)) return;
  fetchEpisodePlayers(ep).catch(function() {});
}

function openPlayer(animeId, ep, totalEps) {
  var requestId = ++playerRequestId;
  playerAnimeId = animeId;
  playerEpisode = ep;
  playerTotalEps = totalEps;
  playerEmbeds = [];
  playerServerIndex = -1;
  playerSwitchTime = 0;
  autoSkipState = null;
  resetPlayerMedia();
  cancelNextCountdown();
  hideCornerButtons();
  document.getElementById('player-servers').innerHTML = '';
  document.getElementById('player-ep-info').textContent = (currentAnime ? getTitle(currentAnime) : 'Anime') + ' — Ep ' + ep;
  document.getElementById('prev-ep-btn').disabled = ep <= 1;
  document.getElementById('next-ep-btn').disabled = !!totalEps && ep >= totalEps;
  document.getElementById('player-overlay').classList.add('show');
  setPlayerStatus('Procurando servidores...', true);
  partyEpisodeOpened(ep);
  if (party) { updatePartyUi(); renderPartyNow(); }
  lastPresence = 0;
  reportWatching(true);

  var slowTimer = setTimeout(function() {
    if (requestId === playerRequestId && playerServerIndex < 0) setPlayerStatus('Acordando o servidor... na primeira vez pode levar até 1 minuto.', true);
  }, 8000);

  fetchEpisodePlayers(ep).then(function(embeds) {
    clearTimeout(slowTimer);
    if (requestId !== playerRequestId) return;
    if (!embeds.length) { showPlayerError('Episódio não disponível no momento'); return; }
    playerEmbeds = embeds;
    renderServerButtons();
    selectServer(0);
    prefetchEpisode(ep + 1);
  }).catch(function() {
    clearTimeout(slowTimer);
    if (requestId === playerRequestId) showPlayerError('Erro de conexão com o servidor');
  });
}

function renderServerButtons() {
  var bar = document.getElementById('player-servers');
  bar.innerHTML = '';
  playerEmbeds.forEach(function(e, i) {
    var btn = document.createElement('button');
    btn.className = 'server-btn';
    btn.textContent = (i + 1) + '. ' + e.label + (e.unstable ? ' · instável' : '');
    if (e.unstable) btn.classList.add('unstable');
    btn.onclick = function() { selectServer(i); };
    bar.appendChild(btn);
  });
}

function selectServer(i, viaProxy) {
  var e = playerEmbeds[i];
  if (!e) return;
  if (i !== playerServerIndex && videoEl.currentTime > 5) playerSwitchTime = videoEl.currentTime;
  playerServerIndex = i;
  playerUsingProxy = !!(viaProxy || e.proxy);
  playerResumeDone = false;
  var buttons = document.getElementById('player-servers').children;
  for (var k = 0; k < buttons.length; k++) buttons[k].classList.toggle('active', k === i);
  resetPlayerMedia();
  if (e.kind === 'iframe') loadEmbed(e.url);
  else playStream(e, playerUsingProxy);
}

// A direct stream can fail on CORS or IP-bound links: retry once through the server, then move on.
// Tell the server whether a video host worked, so broken ones sink in everyone's list.
var healthReported = {};
function reportServerHealth(ok) {
  var e = playerEmbeds[playerServerIndex];
  if (!e || !e.host || e.kind === 'iframe') return;
  var key = playerRequestId + ':' + playerServerIndex + ':' + (ok ? 1 : 0);
  if (healthReported[key]) return;
  healthReported[key] = true;
  fetch(getApiBase() + '/api/health/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: e.host, ok: !!ok }) }).catch(function() {});
}

function streamFailed() {
  if (playerEmbeds[playerServerIndex] && !playerUsingProxy) { selectServer(playerServerIndex, true); return; }
  reportServerHealth(false);
  var btn = document.getElementById('player-servers').children[playerServerIndex];
  if (btn) btn.classList.add('failed');
  tryNextServer();
}

function tryNextServer() {
  if (playerServerIndex + 1 < playerEmbeds.length) {
    showToast('Servidor indisponível, tentando o próximo...');
    selectServer(playerServerIndex + 1);
  } else {
    resetPlayerMedia();
    showPlayerError('Nenhum servidor conseguiu tocar este episódio');
  }
}

function streamUrl(e, viaProxy) {
  if (!viaProxy) return e.url;
  var endpoint = e.kind === 'hls' ? '/api/hls-proxy' : '/api/embed-proxy';
  return getApiBase() + endpoint + '?url=' + encodeURIComponent(e.url) + (e.referer ? '&referer=' + encodeURIComponent(e.referer) : '');
}

function playStream(e, viaProxy) {
  var src = streamUrl(e, viaProxy);
  var failed = false;
  function fail() { if (!failed) { failed = true; streamFailed(); } }
  setPlayerStatus('Carregando vídeo...', true);
  videoEl.style.display = 'block';
  videoEl.onerror = function() { if (!window._hls) fail(); };
  if (e.kind === 'hls' && window.Hls && Hls.isSupported()) {
    var hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
    var mediaRetries = 0;
    window._hls = hls;
    hls.on(Hls.Events.ERROR, function(ev, data) {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 1) { hls.recoverMediaError(); return; }
      fail();
    });
    hls.loadSource(src);
    hls.attachMedia(videoEl);
  } else if (e.kind === 'hls' && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    failed = true;
    var btn = document.getElementById('player-servers').children[playerServerIndex];
    if (btn) btn.classList.add('failed');
    tryNextServer();
    return;
  } else {
    videoEl.src = src;
  }
  playerWatchdog = setTimeout(function() { if (videoEl.readyState < 2) fail(); }, 25000);
  programmaticPlay().catch(function() {});
}

function resetPlayerMedia() {
  clearTimeout(playerWatchdog);
  if (window._hls) { try { window._hls.destroy(); } catch (e) {} window._hls = null; }
  videoEl.onerror = null;
  lastPlaybackTime = 0;
  resetStall();
  programmaticPause();
  videoEl.removeAttribute('src');
  videoEl.load();
  videoEl.style.display = 'none';
  var iframe = document.getElementById('player-iframe');
  iframe.src = 'about:blank';
  iframe.style.display = 'none';
  document.getElementById('player-overlay').classList.remove('iframe-mode');
}

function loadEmbed(url) {
  document.getElementById('player-overlay').classList.add('iframe-mode');
  var iframe = document.getElementById('player-iframe');
  iframe.src = url;
  iframe.style.display = 'block';
  document.getElementById('player-placeholder').style.display = 'none';
  saveCurrentProgress(5);
}

function hidePlayerPlaceholder() {
  clearTimeout(playerWatchdog);
  reportServerHealth(true);
  document.getElementById('player-placeholder').style.display = 'none';
}

videoEl.addEventListener('loadeddata', hidePlayerPlaceholder);
videoEl.addEventListener('playing', hidePlayerPlaceholder);

videoEl.addEventListener('loadedmetadata', function() {
  if (playerResumeDone) return;
  playerResumeDone = true;
  var sync = partyTakePendingSync();
  if (sync) { applyPartySync(sync); return; }
  var t = playerSwitchTime;
  if (!t && getSettings().resume && currentAnime) {
    var h = getWatchHistory().find(function(x) { return x.id == currentAnime.id && x.episode === playerEpisode; });
    if (h && h.time) t = h.time;
  }
  if (t > 20 && videoEl.duration && t < videoEl.duration - 30) {
    programmaticSeek(t);
    if (!playerSwitchTime) showToast('Continuando de ' + formatTime(t));
  }
});

videoEl.addEventListener('timeupdate', function() {
  if (!videoEl.seeking) lastPlaybackTime = videoEl.currentTime;
  document.getElementById('skip-opening-btn').style.visibility = videoEl.currentTime < 360 ? 'visible' : 'hidden';
  if (Date.now() - lastProgressSave > 5000) saveCurrentProgress();
  maybeAutoSkip();
  updateSkipEndingButton();
  if (!videoEl.paused) reportWatching();
  if (videoEl.duration > 120 && videoEl.currentTime / videoEl.duration >= 0.9) reportWatched();
});

videoEl.addEventListener('ended', function() {
  saveCurrentProgress(100);
  hideCornerButtons();
  if (getSettings().autoplay && hasNextEpisode()) startNextCountdown();
  else showToast('Episódio concluído!');
});

videoEl.addEventListener('play', function() { if (!isOwnMediaEvent('play')) partyLocalAction('play'); });
videoEl.addEventListener('pause', function() { if (!isOwnMediaEvent('pause') && !videoEl.ended) partyLocalAction('pause'); });
// Pausing is a good moment to save progress to the account for other devices.
videoEl.addEventListener('pause', function() { if (!currentAnime) return; saveCurrentProgress(); if (typeof syncDirty !== 'undefined' && syncDirty) pushAccountData(); });
// 'seeking' carries the target time right away; 'seeked' waits for the new position to
// buffer, which on Safari can take long enough that the room never hears about the seek.
// Jumps under 2s are the player skipping buffer gaps (hls.js does this at the start),
// not the viewer, and the room ignores drift that small anyway.
var lastPlaybackTime = 0;
videoEl.addEventListener('seeking', function() {
  var own = isOwnMediaEvent('seek');
  var jump = Math.abs(videoEl.currentTime - lastPlaybackTime);
  lastPlaybackTime = videoEl.currentTime;
  if (!own && jump >= 2) partyLocalAction('seek');
});

function saveCurrentProgress(forcePct) {
  if (!currentAnime || !playerEpisode) return;
  lastProgressSave = Date.now();
  var d = videoEl.duration, t = videoEl.currentTime || 0;
  var pct = forcePct != null ? forcePct : (d ? (t / d) * 100 : 0);
  if (!pct) return;
  saveWatchProgress(currentAnime.id, getTitle(currentAnime), getCover(currentAnime), getCover(currentAnime), playerEpisode, pct, playerTotalEps, forcePct === 100 ? 0 : t);
}

function closePlayer() {
  saveCurrentProgress();
  playerRequestId++;
  resetPlayerMedia();
  cancelNextCountdown();
  document.getElementById('player-overlay').classList.remove('show');
  clearWatching();
  renderContinueWatching();
  if (party) updatePartyUi();
}

function skipOpening() {
  if (!videoEl.duration) return;
  var s = getSettings().skipSeconds;
  rememberOpeningSkip(videoEl.currentTime, s);
  videoEl.currentTime = Math.min(videoEl.duration - 1, videoEl.currentTime + s);
  showToast('Pulou ' + s + 's');
}

// ── Opening/ending skips ──
// Where the viewer skips the opening is remembered per anime; after two episodes
// the opening is skipped on its own at that point (with a "Voltar" to undo).
var autoSkipState = null;
var autoSkipTimer = null;

function rememberOpeningSkip(from, len) {
  if (!currentAnime || from > 360) return;
  var marks = getStore('skipmarks'), id = String(currentAnime.id), m = marks[id] || { count: 0 };
  if (m.lastEp === playerEpisode) return;
  m.from = from; m.len = len; m.lastEp = playerEpisode; m.count = (m.count || 0) + 1;
  marks[id] = m;
  setStore('skipmarks', marks);
  if (m.count === 2 && getSettings().autoSkip) showToast('Nos próximos episódios a abertura será pulada sozinha');
}

function maybeAutoSkip() {
  if (!currentAnime || videoEl.paused || !videoEl.duration) return;
  if (!autoSkipState) {
    var m = getStore('skipmarks')[String(currentAnime.id)];
    autoSkipState = { mark: getSettings().autoSkip && m && m.count >= 2 && m.lastEp !== playerEpisode ? m : null, done: false };
  }
  var st = autoSkipState, m = st.mark, t = videoEl.currentTime;
  if (!m || st.done || t < m.from || t > m.from + 4 || videoEl.duration < m.from + m.len + 60) return;
  st.done = true;
  st.from = t;
  videoEl.currentTime = t + m.len;
  var btn = document.getElementById('undo-skip-btn');
  btn.classList.add('show');
  clearTimeout(autoSkipTimer);
  autoSkipTimer = setTimeout(function() { btn.classList.remove('show'); }, 8000);
}

function undoAutoSkip() {
  document.getElementById('undo-skip-btn').classList.remove('show');
  if (!autoSkipState || autoSkipState.from == null) return;
  videoEl.currentTime = autoSkipState.from;
  // They wanted this opening: stop skipping it until they skip twice again.
  var marks = getStore('skipmarks'), id = currentAnime && String(currentAnime.id);
  if (id && marks[id]) { marks[id].count = 0; setStore('skipmarks', marks); }
}

function hasNextEpisode() { return !playerTotalEps || playerEpisode < playerTotalEps; }

function updateSkipEndingButton() {
  var d = videoEl.duration, left = d - videoEl.currentTime;
  var show = d > 600 && left < 110 && left > 8 && hasNextEpisode() && !nextCountdownTimer;
  document.getElementById('skip-ending-btn').classList.toggle('show', show);
}

function skipEnding() {
  document.getElementById('skip-ending-btn').classList.remove('show');
  saveCurrentProgress(100);
  nextEpisode();
}

// ── Stall watchdog ──
// Some HLS streams sit "playing" with plenty buffered but the clock never moves
// (seen with hls.js on Safari's engine). Nudge the playhead, then reset the decoder,
// then move on to the proxy / next server like any other failure.
var stall = { t: -1, since: 0, step: 0 };
function resetStall() { stall.t = -1; stall.since = 0; stall.step = 0; }
setInterval(function() {
  if (!playerIsOpen() || videoEl.style.display === 'none' || videoEl.paused || videoEl.seeking || videoEl.ended || videoEl.readyState < 3) { stall.since = 0; return; }
  if (Math.abs(videoEl.currentTime - stall.t) > 0.05) { stall.t = videoEl.currentTime; stall.since = Date.now(); stall.step = 0; return; }
  if (!stall.since) { stall.since = Date.now(); return; }
  if (Date.now() - stall.since < 4000) return;
  stall.since = Date.now();
  stall.step++;
  if (stall.step === 1) programmaticSeek(videoEl.currentTime + 0.3);
  else if (stall.step === 2 && window._hls) window._hls.recoverMediaError();
  else if (stall.step >= 2) { resetStall(); streamFailed(); }
}, 1000);

function hideCornerButtons() {
  clearTimeout(autoSkipTimer);
  document.getElementById('skip-ending-btn').classList.remove('show');
  document.getElementById('undo-skip-btn').classList.remove('show');
}

// ── Playback speed ──
var SPEEDS = [1, 1.25, 1.5, 2, 0.75];
function cycleSpeed() {
  if (!ownPlayerActive()) return;
  var i = SPEEDS.indexOf(videoEl.playbackRate);
  var next = SPEEDS[(i + 1) % SPEEDS.length];
  videoEl.playbackRate = next;
  setSetting('speed', next);
  document.getElementById('speed-btn').textContent = next + '×';
  showToast('Velocidade ' + next + '×');
}
videoEl.addEventListener('loadedmetadata', function() {
  var sp = getSettings().speed || 1;
  if (party) sp = 1; // everyone in a room watches at normal speed so they stay in sync
  videoEl.playbackRate = sp;
  document.getElementById('speed-btn').textContent = sp + '×';
});

// ── Picture-in-picture and casting ──
function ownPlayerActive() {
  if (videoEl.style.display !== 'none') return true;
  showToast('Só funciona com os servidores que tocam no player do app');
  return false;
}

function togglePip() {
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function() {}); return; }
  if (!ownPlayerActive()) return;
  if (videoEl.requestPictureInPicture && document.pictureInPictureEnabled) {
    videoEl.requestPictureInPicture().catch(function() { showToast('Janela flutuante indisponível agora'); });
  } else if (videoEl.webkitSetPresentationMode) {
    videoEl.webkitSetPresentationMode(videoEl.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  }
}

function castVideo() {
  if (!ownPlayerActive()) return;
  if (videoEl.webkitShowPlaybackTargetPicker) { videoEl.webkitShowPlaybackTargetPicker(); return; }
  if (videoEl.remote && videoEl.remote.prompt) {
    videoEl.remote.prompt().catch(function(e) {
      showToast(e && e.name === 'NotSupportedError' ? 'Este servidor não pode ser transmitido. Tente um servidor Blogger ou Player HD.' : 'Nenhuma TV encontrada na sua rede');
    });
  }
}

(function initMediaButtons() {
  var pip = (document.pictureInPictureEnabled && videoEl.requestPictureInPicture) || videoEl.webkitSetPresentationMode;
  var cast = videoEl.webkitShowPlaybackTargetPicker || (videoEl.remote && videoEl.remote.prompt);
  document.getElementById('pip-btn').classList.toggle('hidden', !pip);
  document.getElementById('cast-btn').classList.toggle('hidden', !cast);
})();

function seekBy(seconds) {
  if (!videoEl.duration) return;
  videoEl.currentTime = Math.max(0, Math.min(videoEl.duration - 1, videoEl.currentTime + seconds));
}

function nextEpisode() {
  cancelNextCountdown();
  if (playerTotalEps && playerEpisode >= playerTotalEps) { showToast('Último episódio'); return; }
  saveCurrentProgress();
  openPlayer(playerAnimeId, playerEpisode + 1, playerTotalEps);
}

function prevEpisode() {
  if (playerEpisode <= 1) { showToast('Primeiro episódio'); return; }
  saveCurrentProgress();
  openPlayer(playerAnimeId, playerEpisode - 1, playerTotalEps);
}

function startNextCountdown() {
  var sec = 5;
  document.getElementById('next-countdown-sec').textContent = sec;
  document.getElementById('next-countdown').classList.add('show');
  clearInterval(nextCountdownTimer);
  nextCountdownTimer = setInterval(function() {
    sec--;
    document.getElementById('next-countdown-sec').textContent = sec;
    if (sec <= 0) nextEpisode();
  }, 1000);
}

function cancelNextCountdown() {
  clearInterval(nextCountdownTimer);
  nextCountdownTimer = null;
  document.getElementById('next-countdown').classList.remove('show');
}

document.addEventListener('keydown', function(e) {
  if (!document.getElementById('player-overlay').classList.contains('show')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) return;
  var onVideo = e.target === videoEl;
  if (e.key === 'ArrowRight' && !onVideo) { seekBy(10); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' && !onVideo) { seekBy(-10); e.preventDefault(); }
  else if ((e.key === ' ' || e.key === 'k') && !onVideo) { if (videoEl.paused) videoEl.play().catch(function() {}); else videoEl.pause(); e.preventDefault(); }
  else if (e.key === 'n' || e.key === 'N') nextEpisode();
  else if (e.key === 's' || e.key === 'S') skipOpening();
  else if (e.key === 'Escape') closePlayer();
});
