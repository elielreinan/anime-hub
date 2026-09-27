// ── Config ──────────────────────────────────────────────────────────────────
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

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

var BLOCKED_GENRES = [
  'hentai', 'ecchi', 'erotica', 'yaoi', 'yuri', 'nudity',
  'sexual', 'adult', 'r-18', 'r18', 'pornô', 'xxx', 'sukebe'
];

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Utility Functions ───────────────────────────────────────────────────────

function fetchUrl(targetUrl, maxRedirects, timeoutMs, extraHeaders) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function(resolve, reject) {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    var mod = targetUrl.startsWith('https') ? https : http;
    var options = {
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
        var loc = res.headers.location;
        if (loc.startsWith('/')) {
          var u = new URL(targetUrl);
          loc = u.protocol + '//' + u.host + loc;
        }
        return fetchUrl(loc, maxRedirects - 1, timeoutMs, extraHeaders).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, function() { req.destroy(); reject(new Error('timeout')); });
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

// ── Video Sources (DooPlay-based PT-BR sites) ───────────────────────────────
// Both sites run the WordPress DooPlay theme: search -> /animes/<slug>/ ->
// episode list -> episode page (data-post/data-nume) -> admin-ajax embed URL.
// Embeds are returned for the browser to load directly: the hosts bind the
// stream URLs to the viewer's IP, so the server can't hand out raw streams.

var DOOPLAY_SITES = [
  { name: 'AnimesHD', base: 'https://animeshd.to' },
  { name: 'TopAnimes', base: 'https://topanimes.net' }
];
var SLUG_NOISE = ['dublado', 'legendado', 'online', 'hd', 'hdd', 'todos', 'os', 'episodios', 'tv', 'anime'];
var EPISODE_LIST_TTL = 30 * 60 * 1000;
var episodeListCache = {};

function normalizeForMatch(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Naruto Shippuden (Naruto Shippuuden) Dublado" -> ["Naruto Shippuden", "Naruto Shippuuden"]
function titleQueries(title) {
  var alt = (title.match(/\(([^)]+)\)/) || [])[1];
  var main = title.replace(/\([^)]*\)/g, ' ').replace(/\b(dublado|legendado)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  var queries = main ? [main] : [];
  if (alt && normalizeForMatch(alt) !== normalizeForMatch(main)) queries.push(alt.trim());
  return queries;
}

function fetchText(url) {
  return fetchUrl(url).then(function(r) {
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.body.toString();
  });
}

function postForm(targetUrl, body, referer) {
  return new Promise(function(resolve, reject) {
    var u = new URL(targetUrl);
    var req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': referer,
        'Accept-Encoding': 'identity'
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

// Best dub and best sub /animes/<slug>/ links whose slug matches the query words.
function pickAnimeVersions(html, base, query) {
  var host = new URL(base).hostname.replace(/^www\./, '');
  var qWords = normalizeForMatch(query).split(' ').filter(Boolean);
  var re = /href=["'](https?:\/\/([^\/"']+)\/animes\/([a-z0-9-]+)\/?)["']/gi;
  var best = { dub: null, sub: null }, m;
  while ((m = re.exec(html)) !== null) {
    if (m[2].replace(/^www\./, '') !== host) continue;
    var slugWords = m[3].split('-');
    var hits = qWords.filter(function(w) { return slugWords.indexOf(w) !== -1; }).length;
    if (!qWords.length || hits < Math.ceil(qWords.length * 0.75)) continue;
    var extra = slugWords.filter(function(w) { return qWords.indexOf(w) === -1 && SLUG_NOISE.indexOf(w) === -1; }).length;
    var dub = slugWords.indexOf('dublado') !== -1;
    var score = hits * 10 - extra * 2;
    var key = dub ? 'dub' : 'sub';
    if (!best[key] || score > best[key].score) best[key] = { url: m[1], score: score, dub: dub };
  }
  return [best.sub, best.dub].filter(Boolean);
}

// Episode number -> URL. Sidebars list other shows' episodes too, so keep only the
// dominant "<prefix>-episodio-N" group, which is the show's own episode list.
function parseEpisodeList(html) {
  var re = /href=["'](https?:\/\/[^"']+\/([a-z0-9-]+?)-episodio-(\d+)\/?)["']/gi;
  var byPrefix = {}, m;
  while ((m = re.exec(html)) !== null) {
    var group = byPrefix[m[2]] = byPrefix[m[2]] || {};
    var n = parseInt(m[3], 10);
    if (!group[n]) group[n] = m[1];
  }
  var best = {}, bestCount = 0;
  Object.keys(byPrefix).forEach(function(p) {
    var c = Object.keys(byPrefix[p]).length;
    if (c > bestCount) { bestCount = c; best = byPrefix[p]; }
  });
  return best;
}

// Dub and sub versions of a show on one site, each with its episode list.
function getAnimeVersions(site, title, trace) {
  var cacheKey = site.name + '|' + normalizeForMatch(title);
  var cached = episodeListCache[cacheKey];
  if (cached && Date.now() - cached.at < EPISODE_LIST_TTL) {
    trace.push('cached ' + cached.versions.length + ' versions');
    return Promise.resolve(cached.versions);
  }

  var queries = titleQueries(title);
  var i = 0;
  function tryQuery() {
    if (i >= queries.length) return Promise.resolve([]);
    var q = queries[i++];
    return fetchText(site.base + '/?s=' + encodeURIComponent(q)).then(function(html) {
      var picks = pickAnimeVersions(html, site.base, q);
      trace.push('search "' + q + '" -> ' + (picks.map(function(p) { return p.url; }).join(' , ') || 'no match'));
      if (!picks.length) return tryQuery();
      return Promise.all(picks.map(function(p) {
        return fetchText(p.url).then(function(animeHtml) {
          var episodes = parseEpisodeList(animeHtml);
          trace.push(p.url.split('/animes/')[1] + ': ' + Object.keys(episodes).length + ' episodes');
          return { url: p.url, dub: p.dub, episodes: episodes };
        }).catch(function(err) { trace.push('anime page error: ' + err.message); return null; });
      })).then(function(versions) {
        versions = versions.filter(function(v) { return v && Object.keys(v.episodes).length; });
        if (!versions.length) return tryQuery();
        episodeListCache[cacheKey] = { at: Date.now(), versions: versions };
        return versions;
      });
    });
  }
  return tryQuery();
}

function unwrapEmbed(raw) {
  var url = String(raw || '');
  var src = url.match(/src=["']([^"']+)/);
  if (src) url = src[1];
  if (url.indexOf('//') === 0) url = 'https:' + url;
  try {
    var u = new URL(url);
    if (/\/aviso\/?$/.test(u.pathname) && u.searchParams.get('url')) return u.searchParams.get('url');
  } catch (e) { return null; }
  return url;
}

function getEpisodeEmbeds(site, episodeUrl, trace) {
  return fetchText(episodeUrl).then(function(html) {
    var post = (html.match(/data-post=["'](\d+)["']/) || [])[1];
    var type = (html.match(/data-type=["'](\w+)["']/) || [])[1] || 'tv';
    var numes = [], re = /data-nume=["'](\w+)["']/g, m;
    while ((m = re.exec(html)) !== null) {
      if (m[1] !== 'trailer' && numes.indexOf(m[1]) === -1) numes.push(m[1]);
    }
    if (!post) return [];
    return Promise.all(numes.map(function(nume) {
      var body = 'action=doo_player_ajax&post=' + post + '&nume=' + nume + '&type=' + type;
      return postForm(site.base + '/wp-admin/admin-ajax.php', body, episodeUrl).then(function(r) {
        var data = JSON.parse(r.body);
        return data && data.embed_url ? unwrapEmbed(data.embed_url) : null;
      }).catch(function() { return null; });
    }));
  }).then(function(urls) {
    return urls.filter(function(u) { return u && /^https?:\/\//.test(u); });
  });
}

var DEAD_EMBED_TEXT = /no longer available|can't find the video|has been deleted|file (?:was )?(?:not found|deleted|removed)|domain may be for sale|video (?:is )?unavailable/i;
var QUALITY_ORDER = [/1080|FHD|FULL/i, /720|HD/i, /480|SD/i, /LD|360/i];

function qualityRank(q) {
  for (var i = 0; i < QUALITY_ORDER.length; i++) if (QUALITY_ORDER[i].test(q || '')) return i;
  return QUALITY_ORDER.length;
}

// sk-api only answers with the source site as Referer; its JSON lists HLS streams
// that play from any IP, so the server resolves it and the app plays it via /api/hls-proxy.
function resolveSkApi(url, referer) {
  var u = new URL(url);
  u.searchParams.set('mode', 'to-salvando-seu-ip');
  return fetchUrl(u.toString(), 3, 8000, { Referer: referer }).then(function(r) {
    var data = JSON.parse(r.body.toString());
    if (data.status !== 'success' || !data.midias || !data.midias.length) return null;
    var best = data.midias.slice().sort(function(a, b) { return qualityRank(a.qualidade) - qualityRank(b.qualidade); })[0];
    return best && best.url ? { kind: 'hls', url: best.url, quality: best.qualidade } : null;
  }).catch(function() { return null; });
}

function embedAlive(url) {
  return fetchUrl(url, 3, 6000).then(function(r) {
    return r.status < 400 && !DEAD_EMBED_TEXT.test(r.body.toString().slice(0, 20000));
  }).catch(function() { return false; });
}

function resolvePlayer(url, site) {
  var host = new URL(url).hostname.replace(/^www\./, '');
  if (host.indexOf('sk-api') === 0) {
    return resolveSkApi(url, site.base + '/').then(function(s) {
      return s ? { kind: 'hls', url: s.url, name: 'Player HD' + (s.quality ? ' ' + s.quality : ''), rank: 0 } : null;
    });
  }
  if (host.indexOf('blogger.com') !== -1) return Promise.resolve({ kind: 'iframe', url: url, name: 'Blogger', rank: 1 });
  var name = host.indexOf('filemoon') !== -1 ? 'Filemoon' : host.split('.')[0];
  var rank = host.indexOf('filemoon') !== -1 ? 2 : 3;
  return embedAlive(url).then(function(ok) { return ok ? { kind: 'iframe', url: url, name: name, rank: rank } : null; });
}

function findEpisodeEmbeds(title, episode) {
  var wantDub = /dublado/i.test(title);
  var epNum = parseInt(episode, 10);
  var traces = {};
  return Promise.all(DOOPLAY_SITES.map(function(site) {
    var trace = traces[site.name] = [];
    return getAnimeVersions(site, title, trace).then(function(versions) {
      return Promise.all(versions.map(function(v) {
        var epUrl = v.episodes[epNum];
        var tag = v.dub ? 'dub' : 'sub';
        if (!epUrl) { trace.push(tag + ': episode ' + epNum + ' not found'); return []; }
        return getEpisodeEmbeds(site, epUrl, trace).then(function(urls) {
          return Promise.all(urls.map(function(u) { return resolvePlayer(u, site); })).then(function(players) {
            var alive = players.filter(Boolean);
            trace.push(tag + ': ' + urls.length + ' options, ' + alive.length + ' usable');
            return alive.map(function(p) {
              return {
                kind: p.kind, url: p.url, provider: site.name,
                label: (v.dub ? 'Dublado' : 'Legendado') + ' · ' + p.name,
                rank: (v.dub === wantDub ? 0 : 10) + p.rank
              };
            });
          });
        });
      }));
    }).then(function(lists) {
      return [].concat.apply([], lists);
    }).catch(function(err) { trace.push('error: ' + err.message); return []; });
  })).then(function(lists) {
    var embeds = [].concat.apply([], lists).sort(function(a, b) { return a.rank - b.rank; });
    return { embeds: embeds, trace: traces };
  });
}

// ── HLS Proxy ──────────────────────────────────────────────────────────────

function handleHLSProxy(urlObj, res) {
  var hlsUrl = urlObj.searchParams.get('url');
  var referer = urlObj.searchParams.get('referer') || '';
  if (!hlsUrl) { res.writeHead(400); res.end('Missing url'); return; }

  fetchUrl(hlsUrl, 5, 20000, referer ? { Referer: referer } : null).then(function(result) {
    if (result.status >= 400) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*' });
      res.end('Upstream error: ' + result.status);
      return;
    }

    var content = result.body.toString();
    // Not an m3u8 manifest - just proxy the binary data (TS segment, key, etc.)
    if (content.indexOf('#EXTM3U') === -1) {
      var ct = result.headers['content-type'] || 'video/mp2t';
      res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
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

    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(rewritten.join('\n'));
  }).catch(function(err) {
    console.error('[HLS-Proxy] Error:', err.message);
    sendJSON(res, 502, { error: true, message: 'HLS proxy: ' + err.message });
  });
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
  var customReferer = urlObj.searchParams.get('referer');
  if (!embedUrl) {
    res.writeHead(400);
    res.end('Missing url param');
    return;
  }

  var referer = customReferer || '';
  if (!referer) {
    try { referer = new URL(embedUrl).origin + '/'; } catch(e) { referer = 'https://animesonlinecc.to/'; }
  }

  var mod = embedUrl.startsWith('https') ? https : http;
  var headers = {
    'User-Agent': USER_AGENT,
    'Referer': referer
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

  // Route: /api/status - server status
  if (pathname === '/api/status') {
    sendJSON(res, 200, {
      server: 'running', timestamp: new Date().toISOString(),
      video_sources: DOOPLAY_SITES.map(function(s) { return s.name; })
    });
    return;
  }

  // Route: /api/hls-proxy?url= - HLS manifest proxy
  if (pathname === '/api/hls-proxy') {
    handleHLSProxy(urlObj, res);
    return;
  }

  // Route: /api/atv/* - AnimeTV API proxy with content filtering
  if (pathname.startsWith('/api/atv/')) {
    handleATVProxy(pathname, urlObj, res);
    return;
  }

  // Route: /api/episode/:slug/:episode?title= - find player embeds for an episode
  if (pathname.startsWith('/api/episode/')) {
    var parts = pathname.split('/').filter(Boolean);
    var slug = decodeURIComponent(parts[2] || '');
    var episode = parts[3] || '1';
    var title = urlObj.searchParams.get('title') || slug.replace(/-/g, ' ');

    findEpisodeEmbeds(title, episode).then(function(result) {
      console.log('[Episode] "' + title + '" ep ' + episode + ': ' + result.embeds.length + ' players', JSON.stringify(result.trace));
      if (!result.embeds.length) {
        sendJSON(res, 404, { error: true, message: 'Episódio não encontrado', trace: result.trace });
        return;
      }
      var embeds = result.embeds.map(function(e) { return { kind: e.kind, url: e.url, label: e.label, provider: e.provider }; });
      sendJSON(res, 200, { error: false, data: { type: 'embed', provider: embeds[0].provider, embed_url: embeds[0].url, embeds: embeds }, trace: result.trace });
    }).catch(function(err) {
      console.error('[Episode] Error:', err.message);
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
  console.log('  GET /api/atv/*                       - AnimeTV API proxy (filtered)');
  console.log('  GET /api/episode/:slug/:ep[?title=]  - find player embeds');
  console.log('  GET /api/hls-proxy?url=              - HLS manifest proxy');
  console.log('  GET /api/search/:query               - slugify title');
  console.log('  GET /api/proxy?url=                  - HTML/embed CORS proxy');
  console.log('  GET /api/embed-proxy?url=            - video stream proxy');
  console.log('  GET /api/status                      - server status');
  console.log('Video sources: ' + DOOPLAY_SITES.map(function(s) { return s.name; }).join(', '));
});
