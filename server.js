// ── Config ──────────────────────────────────────────────────────────────────
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PORT = process.env.PORT || 3000;
var STATIC_DIR = path.join(__dirname, 'docs');

var MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl'
};

var ATV_BASE = 'https://atv2.net/meuanimetv-74.php?';
var ATV_DECRYPT_KEY = 'pR7lM7iA7lU2oV3cD8zO4aP0rL7dH5cH';

var BLOCKED_GENRES = [
  'hentai', 'ecchi', 'erotica', 'yaoi', 'yuri', 'nudity',
  'sexual', 'adult', 'r-18', 'r18', 'pornô', 'xxx', 'sukebe'
];

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Utility Functions ───────────────────────────────────────────────────────

function fetchUrl(targetUrl, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function(resolve, reject) {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    var mod = targetUrl.startsWith('https') ? https : http;
    var req = mod.get(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      }
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var loc = res.headers.location;
        if (loc.startsWith('/')) {
          var u = new URL(targetUrl);
          loc = u.protocol + '//' + u.host + loc;
        }
        return fetchUrl(loc, maxRedirects - 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(); reject(new Error('timeout')); });
  });
}

function slugify(title) {
  return title.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ── AnimeTV API Module ──────────────────────────────────────────────────────

// Content filter: checks if an item contains blocked adult content
function isBlockedContent(item) {
  if (!item || typeof item !== 'object') return false;

  var fieldsToCheck = [
    item.category_name || '',
    item.category_genres || '',
    item.category_description || ''
  ];

  var combined = fieldsToCheck.join(' ').toLowerCase();

  for (var i = 0; i < BLOCKED_GENRES.length; i++) {
    if (combined.indexOf(BLOCKED_GENRES[i]) !== -1) {
      var name = item.category_name || item.title || 'Unknown';
      console.log('[ContentFilter] Blocked: ' + name + ' (reason: ' + BLOCKED_GENRES[i] + ')');
      return true;
    }
  }
  return false;
}

// Filter an array of items, removing adult content
function filterContentArray(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(function(item) {
    return !isBlockedContent(item);
  });
}

// Filter ATV API response (handles both arrays and single objects)
function filterATVResponse(body) {
  try {
    var data = JSON.parse(body.toString());
    if (Array.isArray(data)) {
      return JSON.stringify(filterContentArray(data));
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Single object response (info endpoint)
      if (isBlockedContent(data)) {
        return JSON.stringify({ error: true, message: 'Content blocked by filter' });
      }
      // Check nested arrays (e.g., episodes list within info)
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(data[keys[i]])) {
          data[keys[i]] = filterContentArray(data[keys[i]]);
        }
      }
      return JSON.stringify(data);
    }
    return body.toString();
  } catch (e) {
    // Not valid JSON, return as-is
    return body.toString();
  }
}

// Decrypt AnimeTV video URL
function decryptATVVideo(encryptedField) {
  try {
    var keyBytes = Buffer.from(ATV_DECRYPT_KEY, 'utf8');
    var fullStr = encryptedField;

    // Extract IV: reverse the last 64 chars, take first 16 bytes
    var last64 = fullStr.slice(-64);
    var reversed = last64.split('').reverse().join('');
    var ivBytes = Buffer.from(reversed.substring(0, 16), 'utf8');

    // Strip first 36 chars (JWT header) and last 64 chars (signature)
    var middle = fullStr.substring(36, fullStr.length - 64);

    // Middle part is Base64-encoded ciphertext
    var ciphertext = Buffer.from(middle, 'base64');

    var decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, ivBytes);
    var decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8').trim();
  } catch (err) {
    console.error('[ATV-Decrypt] Error:', err.message);
    return null;
  }
}

// Handle /api/atv-video/:videoId - decrypt AnimeTV video URL
function handleATVVideoDecrypt(videoId, res) {
  var url = ATV_BASE + 'episodios=' + videoId;
  console.log('[ATV-Video] Fetching video data for ID:', videoId);

  fetchUrl(url).then(function(result) {
    try {
      var raw = JSON.parse(result.body.toString());
      var data = Array.isArray(raw) ? raw[0] : raw;

      if (!data || typeof data !== 'object') {
        sendJSON(res, 404, { error: true, message: 'Empty response from ATV API' });
        return;
      }

      // Try known field name first, then auto-detect encrypted field
      var encField = data.mS9wR2qY7pK7vX5n || null;
      if (!encField) {
        var keys = Object.keys(data);
        console.log('[ATV-Video] Available fields:', keys.join(', '));
        for (var i = 0; i < keys.length; i++) {
          var val = data[keys[i]];
          if (typeof val === 'string' && val.length > 100 && /^[A-Za-z0-9+/=]+$/.test(val.substring(36, 100))) {
            encField = val;
            console.log('[ATV-Video] Auto-detected encrypted field:', keys[i]);
            break;
          }
        }
      }

      if (!encField) {
        console.log('[ATV-Video] No encrypted field found. Response keys:', Object.keys(data).join(', '));
        sendJSON(res, 404, { error: true, message: 'Video field not found', fields: Object.keys(data) });
        return;
      }

      var videoUrl = decryptATVVideo(encField);
      if (!videoUrl) {
        sendJSON(res, 500, { error: true, message: 'Failed to decrypt video URL' });
        return;
      }

      console.log('[ATV-Video] Decrypted URL:', videoUrl.substring(0, 80) + '...');
      sendJSON(res, 200, { error: false, video_url: videoUrl, provider: 'animetv' });
    } catch (err) {
      console.error('[ATV-Video] Parse error:', err.message);
      sendJSON(res, 500, { error: true, message: 'Failed to parse video response' });
    }
  }).catch(function(err) {
    console.error('[ATV-Video] Fetch error:', err.message);
    sendJSON(res, 502, { error: true, message: err.message });
  });
}

// Handle /api/atv/* - proxy for AnimeTV API with content filtering
function handleATVProxy(pathname, urlObj, res) {
  var atvPath = pathname.replace('/api/atv/', '');
  var atvQuery = urlObj.search || '';
  var atvUrl = ATV_BASE + atvPath + atvQuery.replace('?', '&');

  console.log('[ATV-Proxy] Fetching:', atvUrl);

  fetchUrl(atvUrl).then(function(result) {
    var filtered = filterATVResponse(result.body);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(filtered);
  }).catch(function(err) {
    console.error('[ATV-Proxy] Error:', err.message);
    sendJSON(res, 502, { error: true, message: err.message });
  });
}

// ── AnimesOnlineCC Provider ─────────────────────────────────────────────────

function searchAnimesOnlineCC(slug, episode) {
  var baseUrl = 'https://animesonlinecc.to/episodio/' + slug + '-episodio-' + episode + '/';
  console.log('[AnimesOnlineCC] Fetching:', baseUrl);

  return fetchUrl(baseUrl).then(function(result) {
    if (result.status === 404 || result.status >= 400) return null;
    var html = result.body.toString();
    var match;

    // Priority 1: Direct MP4/M3U8 video sources
    var videoRegex = /(?:src|file|source)[\s]*[=:]\s*["']?(https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8)[^"'\s<>]*)/gi;
    var videos = [];
    while ((match = videoRegex.exec(html)) !== null) {
      var url = match[1].replace(/&amp;/g, '&');
      if (videos.indexOf(url) === -1) videos.push(url);
    }
    if (videos.length > 0) {
      console.log('[AnimesOnlineCC] Found direct video:', videos[0].substring(0, 80) + '...');
      return {
        provider: 'animesonlinecc', slug: slug, episode: episode,
        video_url: videos[0],
        sources: videos.map(function(v) { return { src: v, label: 'Default' }; }),
        type: 'direct'
      };
    }

    // Priority 2: Embed iframes (Blogger, etc)
    var iframes = [];
    var iframeRegex = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = iframeRegex.exec(html)) !== null) {
      var src = match[1];
      if (src.includes('blogger.com') || src.includes('blogspot.com') ||
          src.includes('drive.google') || src.includes('player')) {
        iframes.push(src);
      }
    }
    if (iframes.length > 0) {
      return {
        provider: 'animesonlinecc', slug: slug, episode: episode,
        embed_urls: iframes, type: 'embed'
      };
    }

    return null;
  }).catch(function() { return null; });
}

// Try multiple slug variations
function tryProviders(slugVariants, episode) {
  var idx = 0;
  function next() {
    if (idx >= slugVariants.length) return Promise.resolve(null);
    var slug = slugVariants[idx++];
    return searchAnimesOnlineCC(slug, episode).then(function(result) {
      if (result) return result;
      return next();
    });
  }
  return next();
}

// ── Video Proxy Module ──────────────────────────────────────────────────────

// /api/proxy?url= - HTML/embed CORS proxy
function handleCORSProxy(urlObj, res) {
  var videoUrl = urlObj.searchParams.get('url');
  if (!videoUrl) {
    res.writeHead(400);
    res.end('Missing url param');
    return;
  }

  fetchUrl(videoUrl).then(function(result) {
    var ct = result.headers['content-type'] || 'text/html';
    var headers = { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' };
    if (result.headers['content-length']) headers['Content-Length'] = result.headers['content-length'];

    if (ct.includes('text/html')) {
      var html = result.body.toString();
      headers['X-Frame-Options'] = 'ALLOWALL';
      delete headers['Content-Length'];
      res.writeHead(200, headers);
      res.end(html);
    } else {
      res.writeHead(result.status, headers);
      res.end(result.body);
    }
  }).catch(function(err) {
    sendJSON(res, 502, { error: true, message: err.message });
  });
}

// /api/embed-proxy?url= - stream proxy for large video files
function handleStreamProxy(req, urlObj, res) {
  var embedUrl = urlObj.searchParams.get('url');
  if (!embedUrl) {
    res.writeHead(400);
    res.end('Missing url param');
    return;
  }

  var mod = embedUrl.startsWith('https') ? https : http;
  var headers = {
    'User-Agent': USER_AGENT,
    'Referer': 'https://animesonlinecc.to/'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  var proxyReq = mod.get(embedUrl, { headers: headers }, function(proxyRes) {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      res.writeHead(302, {
        'Location': '/api/embed-proxy?url=' + encodeURIComponent(proxyRes.headers.location),
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
      return;
    }
    var respHeaders = {
      'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    };
    if (proxyRes.headers['content-length']) respHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) respHeaders['Content-Range'] = proxyRes.headers['content-range'];
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function() {
    try { res.writeHead(502); res.end('Proxy error'); } catch (e) { /* already sent */ }
  });
  proxyReq.setTimeout(60000, function() { proxyReq.destroy(); });
}

// ── Router ──────────────────────────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  var urlObj;
  try {
    urlObj = new URL(req.url, 'http://localhost:' + PORT);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad URL');
    return;
  }
  var pathname = urlObj.pathname;

  // CORS headers for all responses
  var origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Route: /api/atv-video/:videoId - AnimeTV video decryption
  if (pathname.startsWith('/api/atv-video/')) {
    var videoId = pathname.replace('/api/atv-video/', '');
    if (!videoId) {
      sendJSON(res, 400, { error: true, message: 'Missing videoId' });
      return;
    }
    handleATVVideoDecrypt(videoId, res);
    return;
  }

  // Route: /api/atv/* - AnimeTV API proxy with content filtering
  if (pathname.startsWith('/api/atv/')) {
    handleATVProxy(pathname, urlObj, res);
    return;
  }

  // Route: /api/episode/:slug/:episode - episode search with ATV priority
  if (pathname.startsWith('/api/episode/')) {
    var parts = pathname.split('/').filter(Boolean);
    var slug = decodeURIComponent(parts[2] || '');
    var episode = parts[3] || '1';

    // Generate slug variants for AnimesOnlineCC fallback
    var variants = [slug];
    var altSlug = slug
      .replace(/-season-\d+/i, '')
      .replace(/-\d+nd-season/i, '')
      .replace(/-\d+rd-season/i, '')
      .replace(/-\d+th-season/i, '')
      .replace(/-\d+st-season/i, '');
    if (altSlug !== slug) variants.push(altSlug);
    variants.push(slug + '-todos-os-episodios');
    variants.push(slug + '-legendado');
    variants.push(slug + '-dublado');

    console.log('[Episode] Searching slug="' + slug + '" ep=' + episode);

    // Priority 1: Try AnimeTV decrypted video (if we have an ATV video ID)
    // The video ID can be passed as a query param: ?atv_id=XXX
    var atvId = urlObj.searchParams.get('atv_id');
    var atvPromise;

    if (atvId) {
      console.log('[Episode] Trying AnimeTV first with ID:', atvId);
      atvPromise = fetchUrl(ATV_BASE + 'episodios=' + atvId).then(function(result) {
        try {
          var raw = JSON.parse(result.body.toString());
          var data = Array.isArray(raw) ? raw[0] : raw;
          var encField = data && data.mS9wR2qY7pK7vX5n;
          if (!encField && data && typeof data === 'object') {
            var ks = Object.keys(data);
            for (var ki = 0; ki < ks.length; ki++) {
              var v = data[ks[ki]];
              if (typeof v === 'string' && v.length > 100 && /^[A-Za-z0-9+/=]+$/.test(v.substring(36, 100))) {
                encField = v; break;
              }
            }
          }
          if (encField) {
            var videoUrl = decryptATVVideo(encField);
            if (videoUrl) {
              return {
                provider: 'animetv', slug: slug, episode: episode,
                video_url: videoUrl, type: 'direct'
              };
            }
          }
        } catch (e) { /* parse error, fall through */ }
        return null;
      }).catch(function() { return null; });
    } else {
      atvPromise = Promise.resolve(null);
    }

    // Try ATV first, then fall back to AnimesOnlineCC
    atvPromise.then(function(atvResult) {
      if (atvResult) {
        sendJSON(res, 200, { error: false, data: atvResult });
        return;
      }
      // Priority 2: AnimesOnlineCC scraping fallback
      return tryProviders(variants, episode).then(function(result) {
        if (result) {
          sendJSON(res, 200, { error: false, data: result });
        } else {
          sendJSON(res, 404, { error: true, message: 'Episode not found', tried: variants });
        }
      });
    }).catch(function(err) {
      sendJSON(res, 500, { error: true, message: err.message });
    });
    return;
  }

  // Route: /api/search/:query - slugify a title
  if (pathname.startsWith('/api/search/')) {
    var query = decodeURIComponent(pathname.split('/api/search/')[1] || '');
    sendJSON(res, 200, { slug: slugify(query) });
    return;
  }

  // Route: /api/proxy?url= - HTML/embed CORS proxy
  if (pathname === '/api/proxy') {
    handleCORSProxy(urlObj, res);
    return;
  }

  // Route: /api/embed-proxy?url= - video stream proxy
  if (pathname === '/api/embed-proxy') {
    handleStreamProxy(req, urlObj, res);
    return;
  }

  // Static files from docs/
  var filePath = pathname === '/' ? '/index.html' : pathname;
  var fullPath = path.resolve(STATIC_DIR, '.' + filePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

// ── Server Startup ──────────────────────────────────────────────────────────

server.listen(PORT, function() {
  console.log('AnimeHub server running at http://localhost:' + PORT);
  console.log('API Routes:');
  console.log('  GET /api/atv-video/:videoId        - decrypt AnimeTV video URL');
  console.log('  GET /api/atv/*                     - AnimeTV API proxy (filtered)');
  console.log('  GET /api/episode/:slug/:ep[?atv_id] - episode search (ATV + fallback)');
  console.log('  GET /api/search/:query              - slugify title');
  console.log('  GET /api/proxy?url=                 - HTML/embed CORS proxy');
  console.log('  GET /api/embed-proxy?url=           - video stream proxy');
});
