var crypto = require('crypto');
var h = require('../lib/http');
var sendJSON = h.sendJSON, readJsonBody = h.readJsonBody, cleanText = h.cleanText, allowRequest = h.allowRequest;

// ── Watch Party ─────────────────────────────────────────────────────────────
// Rooms live in memory: clients receive events over SSE and send actions by POST.
// Anyone in the room can play/pause/seek/change episode; the last action wins.

var parties = {};
var PARTY_TTL = 3 * 60 * 60 * 1000;
var PARTY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var PARTY_ACTIONS = ['play', 'pause', 'seek', 'episode', 'chat', 'reaction', 'vote'];
var PARTY_REACTIONS = ['😂', '😮', '😍', '🔥', '😭', '👏'];
var PARTY_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function newPartyCode() {
  var code;
  do {
    code = '';
    for (var i = 0; i < 6; i++) code += PARTY_CODE_CHARS[crypto.randomInt(PARTY_CODE_CHARS.length)];
  } while (parties[code]);
  return code;
}



function partyState(p) {
  var s = p.state;
  return { animeId: s.animeId, title: s.title, cover: s.cover, ep: s.ep, totalEps: s.totalEps, time: s.time, playing: s.playing, elapsed: (Date.now() - s.at) / 1000 };
}

function partyBroadcast(p, msg) {
  var data = 'data: ' + JSON.stringify(msg) + '\n\n';
  p.clients.forEach(function(c) { c.res.write(data); });
}

function partyMembers(p) {
  return { type: 'members', count: p.clients.length, names: p.clients.map(function(c) { return c.name; }) };
}

function partyVoteMsg(p) {
  var v = p.vote;
  if (!v) return { type: 'vote', ep: 0, count: 0, needed: 0 };
  return { type: 'vote', ep: v.ep, by: v.by, count: Object.keys(v.voters).length, needed: Math.max(1, Math.ceil(p.clients.length / 2)), voters: Object.keys(v.voters) };
}

function partyCheckVote(p) {
  var msg = partyVoteMsg(p);
  if (p.vote && msg.count === 0) { delete p.vote; msg = partyVoteMsg(p); }
  if (p.vote && msg.count >= msg.needed) {
    var s = p.state;
    if (s.totalEps && p.vote.ep > s.totalEps) { delete p.vote; partyBroadcast(p, partyVoteMsg(p)); return; }
    s.ep = p.vote.ep; s.time = 0; s.playing = true; s.at = Date.now();
    delete p.vote;
    partyBroadcast(p, { type: 'episode', from: 'vote', name: 'A sala', animeId: s.animeId, title: s.title, cover: s.cover, totalEps: s.totalEps, ep: s.ep });
    partyBroadcast(p, partyVoteMsg(p));
    return;
  }
  partyBroadcast(p, msg);
}

function handleParty(req, res, pathname, urlObj) {
  var parts = pathname.split('/').filter(Boolean);
  var code = (parts[2] || '').toUpperCase();
  var action = parts[3] || '';

  if (!code) {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: true, message: 'Use POST' });
    if (!allowRequest(req, res, 'partyCreate')) return;
    return readJsonBody(req).then(function(b) {
      // A client whose room vanished (server restart or sleep) recreates it under
      // the same code, so the invite link keeps working.
      var wanted = String(b.code || '').toUpperCase();
      if (PARTY_CODE_RE.test(wanted) && parties[wanted]) return sendJSON(res, 200, { code: wanted });
      var c = PARTY_CODE_RE.test(wanted) ? wanted : newPartyCode();
      parties[c] = {
        code: c, clients: [], lastActive: Date.now(),
        state: {
          animeId: cleanText(b.animeId, 20), title: cleanText(b.title, 200), cover: cleanText(b.cover, 500),
          ep: +b.ep || 0, totalEps: +b.totalEps || 0, time: +b.time || 0, playing: !!b.playing, at: Date.now()
        }
      };
      sendJSON(res, 200, { code: c });
    }).catch(function() { sendJSON(res, 400, { error: true, message: 'Dados inválidos' }); });
  }

  var p = parties[code];
  if (!p) return sendJSON(res, 404, { error: true, message: 'Sala não encontrada' });
  p.lastActive = Date.now();

  if (!action && req.method === 'GET') {
    return sendJSON(res, 200, { code: code, state: partyState(p), members: p.clients.length });
  }

  if (action === 'events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    var client = { res: res, id: cleanText(urlObj.searchParams.get('clientId'), 20), name: cleanText(urlObj.searchParams.get('name'), 30) || 'Alguém' };
    p.clients.push(client);
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'state', state: partyState(p) }) + '\n\n');
    if (p.vote) res.write('data: ' + JSON.stringify(partyVoteMsg(p)) + '\n\n');
    partyBroadcast(p, { type: 'join', name: client.name });
    partyBroadcast(p, partyMembers(p));
    var ping = setInterval(function() { res.write(': ping\n\n'); }, 25000);
    req.on('close', function() {
      clearInterval(ping);
      p.clients = p.clients.filter(function(c) { return c !== client; });
      p.lastActive = Date.now();
      if (p.vote) { delete p.vote.voters[client.id]; partyCheckVote(p); }
      partyBroadcast(p, { type: 'leave', name: client.name });
      partyBroadcast(p, partyMembers(p));
    });
    return;
  }

  if (action === 'action' && req.method === 'POST') {
    if (!allowRequest(req, res, 'partyAction')) return;
    return readJsonBody(req).then(function(b) {
      if (PARTY_ACTIONS.indexOf(b.type) === -1) return sendJSON(res, 400, { error: true, message: 'Ação inválida' });
      var s = p.state;
      var msg = { type: b.type, from: cleanText(b.clientId, 20), name: cleanText(b.name, 30) || 'Alguém' };
      if (b.type === 'chat') {
        msg.text = cleanText(b.text, 300).trim();
        if (!msg.text) return sendJSON(res, 400, { error: true, message: 'Mensagem vazia' });
      } else if (b.type === 'reaction') {
        if (PARTY_REACTIONS.indexOf(b.emoji) === -1) return sendJSON(res, 400, { error: true, message: 'Reação inválida' });
        msg.emoji = b.emoji;
      } else if (b.type === 'vote') {
        // Vote to go to the next episode; half the room (rounded up) is enough.
        if (!s.ep) return sendJSON(res, 400, { error: true, message: 'Nenhum episódio na sala' });
        if (!p.vote || p.vote.ep !== s.ep + 1) p.vote = { ep: s.ep + 1, voters: {}, by: msg.name };
        if (b.cancel) delete p.vote.voters[msg.from]; else p.vote.voters[msg.from] = true;
        partyCheckVote(p);
        return sendJSON(res, 200, { ok: true });
      } else if (b.type === 'episode') {
        delete p.vote;
        if (b.animeId) {
          s.animeId = cleanText(b.animeId, 20); s.title = cleanText(b.title, 200);
          s.cover = cleanText(b.cover, 500); s.totalEps = +b.totalEps || 0;
        }
        s.ep = +b.ep || s.ep; s.time = 0; s.playing = true; s.at = Date.now();
        msg.animeId = s.animeId; msg.title = s.title; msg.cover = s.cover; msg.totalEps = s.totalEps; msg.ep = s.ep;
      } else {
        s.time = +b.time || 0;
        s.playing = b.type === 'play' ? true : b.type === 'pause' ? false : !!b.playing;
        s.at = Date.now();
        msg.time = s.time;
        msg.playing = s.playing;
      }
      partyBroadcast(p, msg);
      sendJSON(res, 200, { ok: true });
    }).catch(function() { sendJSON(res, 400, { error: true, message: 'Dados inválidos' }); });
  }

  sendJSON(res, 405, { error: true, message: 'Método não suportado' });
}

setInterval(function() {
  var now = Date.now();
  Object.keys(parties).forEach(function(c) {
    if (!parties[c].clients.length && now - parties[c].lastActive > PARTY_TTL) delete parties[c];
  });
}, 10 * 60 * 1000).unref();

module.exports = { handleParty: handleParty, getParty: function(code) { return parties[code] || null; }, count: function() { return Object.keys(parties).length; } };
