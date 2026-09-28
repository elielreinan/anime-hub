// /api/health/report - viewers tell us whether a video host played or failed.
// A host that failed for several different viewers recently, and rarely worked,
// is flagged "instável" and sorted after the others. Nothing is ever hidden, so
// false reports can only reorder the list. Kept in memory: resets with the server.
var h = require('../lib/http');
var v = require('../lib/validate');

var WINDOW_MS = 45 * 60 * 1000;
var hosts = {}; // host -> [{ ok, ip, at }]
// Per show: which host actually played, so the best one can go first next time.
var animeHosts = {}; // normalized title -> { host -> { ok, fail, label, at } }
var ANIME_MAX = 3000;

function animeKey(title) {
  return String(title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 100);
}

function bestHost(title) {
  var m = animeHosts[animeKey(title)];
  if (!m) return null;
  var best = null;
  Object.keys(m).forEach(function(h) {
    var e = m[h];
    if (e.ok < 1 || e.ok <= e.fail) return;
    if (!best || e.ok - e.fail > best.score) best = { host: h, label: e.label, score: e.ok - e.fail, ok: e.ok };
  });
  return best;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}

function recent(host) {
  var list = hosts[host];
  if (!list) return [];
  var cut = Date.now() - WINDOW_MS;
  while (list.length && list[0].at < cut) list.shift();
  if (!list.length) delete hosts[host];
  return list;
}

function isUnstable(host) {
  var list = recent(host);
  if (list.length < 3) return false;
  var failIps = {}, ok = 0;
  list.forEach(function(e) { if (e.ok) ok++; else failIps[e.ip] = true; });
  return Object.keys(failIps).length >= 3 && ok / list.length < 0.25;
}

function snapshot() {
  return Object.keys(hosts).map(function(host) {
    var list = recent(host);
    var ok = list.filter(function(e) { return e.ok; }).length;
    return { host: host, ok: ok, failed: list.length - ok, unstable: isUnstable(host) };
  }).filter(function(x) { return x.ok + x.failed; }).sort(function(a, b) { return b.failed - a.failed; });
}

function register(add) {
  add('POST', '/api/health/report', { db: false, limit: 'health' }, async function(ctx) {
    var host = String(ctx.body.host || '').toLowerCase().slice(0, 100);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) v.fail(400, 'Host inválido');
    var list = hosts[host] = hosts[host] || [];
    if (Object.keys(hosts).length > 2000) return { ok: true };
    list.push({ ok: ctx.body.ok === true, ip: h.clientIp(ctx.req), at: Date.now() });
    if (list.length > 300) list.shift();
    var key = animeKey(ctx.body.anime);
    if (key && (animeHosts[key] || Object.keys(animeHosts).length < ANIME_MAX)) {
      var m = animeHosts[key] = animeHosts[key] || {};
      var e = m[host] = m[host] || { ok: 0, fail: 0 };
      if (ctx.body.ok === true) e.ok++; else e.fail++;
      e.label = String(ctx.body.label || '').replace(/[\u0000-\u001F<>]/g, '').slice(0, 60) || e.label;
      e.at = Date.now();
    }
    return { ok: true };
  });

  // Best server for a show, shown on its page.
  add('GET', '/api/health/anime', { db: false }, async function(ctx) {
    var b = bestHost(ctx.query.get('title'));
    return { best: b ? { host: b.host, label: b.label, plays: b.ok } : null };
  });

  // Public status page: source sites and video hosts right now.
  add('GET', '/api/status/servers', { db: false }, async function() {
    return { at: new Date().toISOString(), sources: require('../sources/dooplay').getSourceStatus(), hosts: snapshot().slice(0, 40) };
  });
}

module.exports = { register: register, hostOf: hostOf, isUnstable: isUnstable, snapshot: snapshot, bestHost: bestHost };
