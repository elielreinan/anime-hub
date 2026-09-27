// ── Outbound requests ───────────────────────────────────────────────────────
var http = require('http');
var https = require('https');
var dns = require('dns');
var net = require('net');
var USER_AGENT = require('./config').USER_AGENT;

// The proxies take URLs from the browser, so outbound requests may only reach
// public addresses: never this machine or Render's private network.
function isPrivateAddress(ip) {
  if (net.isIPv6(ip)) {
    var mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateAddress(mapped[1]);
    var hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      var hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    var h = ip.toLowerCase();
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h);
  }
  var p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] < 128) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] < 32) ||
    (p[0] === 192 && p[1] === 168);
}

function blockedError() {
  var e = new Error('Blocked address');
  e.code = 'EBLOCKED';
  return e;
}

// dns.lookup replacement for http(s) requests; also covers redirects and DNS rebinding.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, options, function(err, address, family) {
    if (err) return callback(err);
    var list = Array.isArray(address) ? address : [{ address: address }];
    if (list.some(function(a) { return isPrivateAddress(a.address); })) return callback(blockedError());
    callback(null, address, family);
  });
}

// Parsed http(s) URL that may be fetched, or null.
function publicUrl(raw) {
  var u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  var host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) return null;
  return u;
}

// Upstream bodies are served from this origin: never let them run as a page.
function safeProxyType(ct, fallback) {
  if (!ct || /html|xml|javascript|ecmascript|svg/i.test(ct)) return fallback;
  return ct;
}
var PROXY_SAFETY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

function proxyHeaders(headers) {
  Object.keys(PROXY_SAFETY_HEADERS).forEach(function(k) { headers[k] = PROXY_SAFETY_HEADERS[k]; });
  return headers;
}

function fetchUrl(targetUrl, maxRedirects, timeoutMs, extraHeaders) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function(resolve, reject) {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    if (!publicUrl(targetUrl)) return reject(blockedError());
    var mod = targetUrl.startsWith('https') ? https : http;
    var options = {
      lookup: publicLookup,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }
    };
    if (extraHeaders) Object.keys(extraHeaders).forEach(function(k) { options.headers[k] = extraHeaders[k]; });

    var req = mod.get(targetUrl, options, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        var loc;
        try { loc = new URL(res.headers.location, targetUrl).toString(); } catch (e) { return reject(e); }
        return fetchUrl(loc, maxRedirects - 1, timeoutMs, extraHeaders).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: targetUrl });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, function() { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchText(url) {
  return fetchUrl(url).then(function(r) {
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.body.toString();
  });
}

function postForm(targetUrl, body, referer, extraHeaders) {
  return new Promise(function(resolve, reject) {
    var u = new URL(targetUrl);
    var headers = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': referer,
      'Accept-Encoding': 'identity'
    };
    Object.keys(extraHeaders || {}).forEach(function(k) {
      if (extraHeaders[k] === null) delete headers[k]; else headers[k] = extraHeaders[k];
    });
    var req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: headers, lookup: publicLookup }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

module.exports = {
  isPrivateAddress: isPrivateAddress, blockedError: blockedError, publicLookup: publicLookup, publicUrl: publicUrl,
  safeProxyType: safeProxyType, proxyHeaders: proxyHeaders, fetchUrl: fetchUrl, fetchText: fetchText, postForm: postForm
};
