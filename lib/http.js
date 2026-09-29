// ── HTTP helpers: JSON, bodies, rate limits ─────────────────────────────────

function sendJSON(res, statusCode, data) {
  // CORS headers come from lib/security (allowlist), not from here.
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Rejects bodies over maxBytes (default 16 KB). The rest of an oversized body is
// discarded so the error response can still be delivered; past 1 MB the socket is cut.
function readJsonBody(req, maxBytes) {
  return new Promise(function(resolve, reject) {
    var size = 0, chunks = [], limit = maxBytes || 16384, tooBig = false;
    req.on('data', function(c) {
      size += c.length;
      if (tooBig) { if (size > Math.max(limit * 4, 1048576)) req.destroy(); return; }
      if (size > limit) { tooBig = true; chunks = []; reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', function() {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Trims to max characters and drops control characters (keeps line breaks only when allowed).
function cleanText(v, max, multiline) {
  var t = String(v == null ? '' : v).replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g : /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
  return t.slice(0, max);
}

// Per-IP fixed windows, so one visitor can't eat the free instance. Video playback
// fetches a segment every few seconds, so the proxy limit leaves plenty of room.

var RATE_LIMITS = {
  proxy: { max: 1200, windowMs: 60000 },
  episode: { max: 60, windowMs: 60000 },
  partyCreate: { max: 10, windowMs: 60000 },
  partyAction: { max: 120, windowMs: 60000 },
  auth: { max: 10, windowMs: 60000 },
  invite: { max: 30, windowMs: 60000 },
  global: { max: 2000, windowMs: 60000 },
  write: { max: 60, windowMs: 60000 },
  post: { max: 6, windowMs: 60000 },
  clan: { max: 3, windowMs: 60000 },
  comment: { max: 20, windowMs: 60000 },
  report: { max: 10, windowMs: 60000 },
  feedback: { max: 5, windowMs: 600000 },
  health: { max: 120, windowMs: 60000 },
  admin: { max: 120, windowMs: 60000 },
  download: { max: 10, windowMs: 60000 }
};
var rateHits = {};

// Proxy headers can be forged by anyone, so they are only trusted behind Render
// (RENDER is set there), whose Cloudflare edge overwrites True-Client-IP and the first
// X-Forwarded-For entry with the real address. TRUST_PROXY=1 does the same for tests.
var TRUST_PROXY = !!(process.env.RENDER || process.env.TRUST_PROXY);
function clientIp(req) {
  if (TRUST_PROXY) {
    var tci = req.headers['true-client-ip'];
    if (tci) return String(tci).trim().slice(0, 64);
    var fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64);
  }
  return String(req.socket.remoteAddress || '').slice(0, 64);
}

// true when the request may go ahead; otherwise answers 429 itself.
function allowRequest(req, res, bucket) {
  var rule = RATE_LIMITS[bucket], key = bucket + '|' + clientIp(req), now = Date.now();
  var hit = rateHits[key];
  if (!hit || now - hit.start > rule.windowMs) hit = rateHits[key] = { start: now, count: 0 };
  if (++hit.count <= rule.max) return true;
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((hit.start + rule.windowMs - now) / 1000)) });
  res.end(JSON.stringify({ error: true, message: 'Muitas requisições, tente de novo em instantes' }));
  return false;
}

setInterval(function() {
  var now = Date.now();
  Object.keys(rateHits).forEach(function(k) { if (now - rateHits[k].start > 120000) delete rateHits[k]; });
}, 60000).unref();

module.exports = { sendJSON: sendJSON, readJsonBody: readJsonBody, cleanText: cleanText, clientIp: clientIp, allowRequest: allowRequest, RATE_LIMITS: RATE_LIMITS };
