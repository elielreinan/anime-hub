var http = require('http');
var https = require('https');
var n = require('../lib/net');
var fetchUrl = n.fetchUrl, publicUrl = n.publicUrl, publicLookup = n.publicLookup, safeProxyType = n.safeProxyType, proxyHeaders = n.proxyHeaders;
var sendJSON = require('../lib/http').sendJSON;
var USER_AGENT = require('../lib/config').USER_AGENT;

// ── HLS Proxy ──────────────────────────────────────────────────────────────

function handleHLSProxy(urlObj, res) {
  var hlsUrl = urlObj.searchParams.get('url');
  var referer = urlObj.searchParams.get('referer') || '';
  if (!hlsUrl || !publicUrl(hlsUrl)) { res.writeHead(400); res.end('Invalid url'); return; }

  fetchUrl(hlsUrl, 5, 20000, referer ? { Referer: referer } : null).then(function(result) {
    if (result.status >= 400) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*' });
      res.end('Upstream error: ' + result.status);
      return;
    }

    var content = result.body.toString();
    // Not an m3u8 manifest - just proxy the binary data (TS segment, key, etc.)
    if (content.indexOf('#EXTM3U') === -1) {
      var ct = safeProxyType(result.headers['content-type'], 'video/mp2t');
      res.writeHead(200, proxyHeaders({ 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' }));
      res.end(result.body);
      return;
    }

    console.log('[HLS-Proxy] Manifest:', hlsUrl.substring(0, 80));
    var refParam = referer ? '&referer=' + encodeURIComponent(referer) : '';
    // Resolve with URL(): CDN tokens put slashes in the query string, so the
    // manifest's "directory" can't be found by cutting at the last '/'.
    function proxied(uri) {
      return '/api/hls-proxy?url=' + encodeURIComponent(new URL(uri, hlsUrl).toString()) + refParam;
    }

    var rewritten = content.split('\n').map(function(line) {
      var trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, function(match, uri) { return 'URI="' + proxied(uri) + '"'; });
      }
      return proxied(trimmed);
    });

    res.writeHead(200, proxyHeaders({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }));
    res.end(rewritten.join('\n'));
  }).catch(function(err) {
    console.error('[HLS-Proxy] Error:', err.message);
    sendJSON(res, err.code === 'EBLOCKED' ? 400 : 502, { error: true, message: 'HLS proxy: ' + err.message });
  });
}

// ── Video Proxy Module ──────────────────────────────────────────────────────

// /api/embed-proxy?url= - stream proxy for large video files
function handleStreamProxy(req, urlObj, res) {
  var embedUrl = urlObj.searchParams.get('url');
  var customReferer = urlObj.searchParams.get('referer');
  var target = embedUrl && publicUrl(embedUrl);
  if (!target) {
    res.writeHead(400);
    res.end('Invalid url');
    return;
  }

  var referer = customReferer || target.origin + '/';
  var mod = target.protocol === 'https:' ? https : http;
  var headers = {
    'User-Agent': USER_AGENT,
    'Referer': referer
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  var proxyReq = mod.get(target, { headers: headers, lookup: publicLookup }, function(proxyRes) {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      var next;
      try { next = new URL(proxyRes.headers.location, target).toString(); } catch (e) { res.writeHead(502); res.end('Bad redirect'); return; }
      res.writeHead(302, {
        'Location': '/api/embed-proxy?url=' + encodeURIComponent(next) + (customReferer ? '&referer=' + encodeURIComponent(customReferer) : ''),
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
      return;
    }
    var respHeaders = proxyHeaders({
      'Content-Type': safeProxyType(proxyRes.headers['content-type'], 'video/mp4'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });
    if (proxyRes.headers['content-length']) respHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) respHeaders['Content-Range'] = proxyRes.headers['content-range'];
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function(err) {
    try { res.writeHead(err.code === 'EBLOCKED' ? 400 : 502); res.end('Proxy error'); } catch (e) { /* already sent */ }
  });
  proxyReq.setTimeout(60000, function() { proxyReq.destroy(); });
}

module.exports = { handleHLSProxy: handleHLSProxy, handleStreamProxy: handleStreamProxy };
