// /api/health/report - viewers tell us whether a video host played or failed.
// A host that failed for several different viewers recently, and rarely worked,
// is flagged "instável" and sorted after the others. Nothing is ever hidden, so
// false reports can only reorder the list. Kept in memory: resets with the server.
var h = require('../lib/http');
var v = require('../lib/validate');

var WINDOW_MS = 45 * 60 * 1000;
var hosts = {}; // host -> [{ ok, ip, at }]

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
    return { ok: true };
  });
}

module.exports = { register: register, hostOf: hostOf, isUnstable: isUnstable, snapshot: snapshot };
