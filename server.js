// ── Config ──────────────────────────────────────────────────────────────────
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var dns = require('dns');
var net = require('net');

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

var DEAD_EMBED_TEXT = /no longer available|can't find the video|has been deleted|file (?:was )?(?:not found|deleted|removed)|domain may be for sale|video (?:is )?unavailable|location\.href\s*=\s*["']\/lander/i;
var QUALITY_ORDER = [/1080|FHD|FULL/i, /720|HD/i, /480|SD/i, /LD|360/i];

function qualityRank(q) {
  for (var i = 0; i < QUALITY_ORDER.length; i++) if (QUALITY_ORDER[i].test(q || '')) return i;
  return QUALITY_ORDER.length;
}

// Dean Edwards packer, used by many embed hosts to hide their jwplayer setup.
function unpackAll(html) {
  var out = html, idx = html.indexOf('eval(function(p,a,c,k,e,d)');
  while (idx !== -1) {
    var m = html.slice(idx).match(/}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) break;
    var p = m[1], a = +m[2], c = +m[3], k = m[4].split('|');
    var enc = function(n) { return (n < a ? '' : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); };
    while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + enc(c) + '\\b', 'g'), k[c]);
    out += '\n' + p;
    idx = html.indexOf('eval(function(p,a,c,k,e,d)', idx + 1);
  }
  return out;
}

// Stream URLs from jwplayer/Playerjs pages: sources:[{file:"..."}], file:"[720p]url,[1080p]url", <source src>.
function extractMedia(html) {
  var found = [], seen = {}, m;
  var re = /["']?(?:file|src|source)["']?\s*[:=]\s*["']([^"']+)["']/gi;
  while ((m = re.exec(html)) !== null) {
    m[1].replace(/\\\//g, '/').split(/,(?=\[)/).forEach(function(part) {
      var labeled = part.match(/^\[([^\]]*)\](.+)$/);
      var url = (labeled ? labeled[2] : part).trim();
      if (!/^https?:\/\//.test(url) || !/\.(m3u8|mp4)(?:[\/?#]|$)/i.test(url) || seen[url]) return;
      seen[url] = true;
      found.push({ url: url, quality: labeled ? labeled[1] : '', kind: /\.m3u8/i.test(url) ? 'hls' : 'mp4' });
    });
  }
  return found.sort(function(a, b) { return qualityRank(a.quality) - qualityRank(b.quality); });
}

// sk-api only answers with the source site as Referer; its JSON lists HLS streams.
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

function itagRank(u) {
  var itag = (u.match(/[?&]itag=(\d+)/) || [])[1];
  return itag === '22' ? 0 : itag === '18' ? 1 : 2;
}

// The Blogger player gets its stream list from an internal RPC. The googlevideo URLs it
// returns are bound to the requesting IP, so the app plays them through /api/embed-proxy.
function resolveBlogger(url) {
  var token = new URL(url).searchParams.get('token');
  return fetchText(url).then(function(html) {
    var bl = (html.match(/"cfb2h":"([^"]+)"/) || [])[1] || '';
    var sid = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1] || '';
    var freq = JSON.stringify([[['WcwnYd', JSON.stringify([token, '', 0]), null, 'generic']]]);
    var rpc = 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g' +
      '&f.sid=' + encodeURIComponent(sid) + '&bl=' + encodeURIComponent(bl) + '&hl=pt-BR&_reqid=' + (10000 + Math.floor(Math.random() * 90000)) + '&rt=c';
    return postForm(rpc, 'f.req=' + encodeURIComponent(freq) + '&', url, {
      'Origin': 'https://www.blogger.com',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': null
    });
  }).then(function(r) {
    var line = r.body.split('\n').filter(function(l) { return l.indexOf('"wrb.fr"') !== -1; })[0];
    if (!line) return null;
    var payload = JSON.parse(line)[0][2];
    var urls = [];
    (function walk(x) {
      if (typeof x === 'string') { if (x.indexOf('googlevideo.com/videoplayback') !== -1) urls.push(x); }
      else if (Array.isArray(x)) x.forEach(walk);
    })(payload ? JSON.parse(payload) : null);
    // A valid RPC answer with no streams means the video was taken down.
    return { url: urls.sort(function(a, b) { return itagRank(a) - itagRank(b); })[0] || null };
  }).catch(function() { return null; });
}

// Check that a stream answers before offering it: HLS playlist (following one level of
// variants) and its first segment, or the first bytes of an MP4.
function verifyStream(kind, url, referer) {
  var headers = referer ? { Referer: referer } : null;
  function firstBytes(u) {
    return fetchUrl(u, 3, 7000, Object.assign({ Range: 'bytes=0-1' }, headers || {})).then(function(r) { return r.status < 400; });
  }
  if (kind !== 'hls') return firstBytes(url).catch(function() { return false; });
  return fetchUrl(url, 3, 7000, headers).then(function(r) {
    var text = r.body.toString();
    if (r.status >= 400 || text.indexOf('#EXTM3U') === -1) return false;
    var entry = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l && l[0] !== '#'; })[0];
    if (!entry) return false;
    var next = new URL(entry, url).toString();
    return /#EXT-X-STREAM-INF/.test(text) ? verifyStream('hls', next, referer) : firstBytes(next);
  }).catch(function() { return false; });
}

// Fetch an embed page and pull the stream out of its player setup.
// Markers of an actual video player page; parked domains and landers have none of them.
var PLAYER_PAGE = /<video|jwplayer|playerjs|plyr|videojs|video\.js|clappr|\.m3u8|\.mp4|hls\.js|<iframe[^>]+(?:embed|player)/i;

// 720p (or the best below it) plays on nearly every phone; 1080p files are more often
// HEVC or high-profile, so they are offered as a separate server instead of the default.
function pickQualities(media) {
  var compatible = media.filter(function(m) { return qualityRank(m.quality) >= 1; })[0] || media[0];
  var picks = [compatible];
  var hd = media.filter(function(m) { return qualityRank(m.quality) === 0; })[0];
  if (hd && hd !== compatible) picks.push(hd);
  return picks;
}

function resolveGeneric(url, site) {
  return fetchUrl(url, 5, 8000, { Referer: site.base + '/' }).then(function(r) {
    if (r.status >= 400) return null;
    var html = r.body.toString();
    if (DEAD_EMBED_TEXT.test(html.slice(0, 20000))) return null;
    var media = extractMedia(unpackAll(html));
    var origin = new URL(r.url).origin + '/';
    return { media: media.length ? pickQualities(media) : [], referer: origin, playerLike: PLAYER_PAGE.test(html) };
  }).catch(function() { return null; });
}

function hostName(url) { return new URL(url).hostname.replace(/^www\./, ''); }

// Player kinds: 'hls' / 'mp4' play in the app's own <video>; 'iframe' embeds the host page
// and is only offered when no stream could be extracted.
function resolvePlayer(url, site) {
  var host = hostName(url);
  if (host.indexOf('sk-api') === 0) {
    return resolveSkApi(url, site.base + '/').then(function(s) {
      return s ? { kind: 'hls', url: s.url, name: 'Player HD' + (s.quality ? ' ' + s.quality : ''), rank: 1 } : null;
    });
  }
  if (host.indexOf('blogger.com') !== -1) {
    return resolveBlogger(url).then(function(res) {
      if (!res) return { kind: 'iframe', url: url, name: 'Blogger (externo)', rank: 6 };
      if (!res.url) return null;
      return { kind: 'mp4', url: res.url, proxy: true, name: 'Blogger' + (itagRank(res.url) === 0 ? ' 720p' : ''), rank: 2 };
    });
  }
  if (host.indexOf('filemoon') !== -1) {
    return embedAlive(url).then(function(ok) { return ok ? { kind: 'iframe', url: url, name: 'Filemoon (externo)', rank: 7 } : null; });
  }
  return resolveGeneric(url, site).then(function(res) {
    if (!res) return null;
    if (res.media.length) {
      return Promise.all(res.media.map(function(m, i) {
        return verifyStream(m.kind, m.url, res.referer).then(function(ok) {
          if (!ok) return null;
          return { kind: m.kind, url: m.url, referer: res.referer, name: host.split('.')[0] + (m.quality ? ' ' + m.quality : ''), rank: i === 0 ? 0 : 3 };
        });
      }));
    }
    // The source site's own pages (interstitials, donation walls) and pages without any
    // player (parked domains) are not offered.
    if (host === hostName(site.base) || !res.playerLike) return null;
    return { kind: 'iframe', url: url, name: host.split('.')[0] + ' (externo)', rank: 8 };
  });
}

function embedAlive(url) {
  return fetchUrl(url, 3, 6000).then(function(r) {
    return r.status < 400 && !DEAD_EMBED_TEXT.test(r.body.toString().slice(0, 20000));
  }).catch(function() { return false; });
}

var PLAYER_CACHE_TTL = 15 * 60 * 1000;
var playerCache = {};

// lang: 'dub' | 'sub' | '' (falls back to "Dublado" in the title).
function findEpisodeEmbeds(title, episode, lang) {
  var wantDub = lang ? lang === 'dub' : /dublado/i.test(title);
  var epNum = parseInt(episode, 10);
  var key = normalizeForMatch(title) + '|' + epNum + '|' + wantDub;
  var cached = playerCache[key];
  if (cached && (cached.pending || Date.now() - cached.at < PLAYER_CACHE_TTL)) return cached.promise;

  var traces = {};
  var promise = Promise.all(DOOPLAY_SITES.map(function(site) {
    var trace = traces[site.name] = [];
    return getAnimeVersions(site, title, trace).then(function(versions) {
      return Promise.all(versions.map(function(v) {
        var epUrl = v.episodes[epNum];
        var tag = v.dub ? 'dub' : 'sub';
        if (!epUrl) { trace.push(tag + ': episode ' + epNum + ' not found'); return []; }
        return getEpisodeEmbeds(site, epUrl, trace).then(function(urls) {
          return Promise.all(urls.map(function(u) { return resolvePlayer(u, site); })).then(function(players) {
            var usable = [].concat.apply([], players).filter(Boolean);
            trace.push(tag + ': ' + urls.length + ' options, ' + usable.length + ' usable');
            return usable.map(function(p) {
              return {
                kind: p.kind, url: p.url, referer: p.referer || '', proxy: !!p.proxy, provider: site.name,
                label: (v.dub ? 'Dublado' : 'Legendado') + ' · ' + p.name,
                rank: (v.dub === wantDub ? 0 : 20) + p.rank
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
    var result = { embeds: embeds, trace: traces };
    playerCache[key] = { at: Date.now(), promise: Promise.resolve(result) };
    if (!embeds.length) delete playerCache[key];
    return result;
  }, function(err) {
    delete playerCache[key];
    throw err;
  });
  playerCache[key] = { pending: true, promise: promise };
  return promise;
}

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

// ── Rate limiting ───────────────────────────────────────────────────────────
// Per-IP fixed windows, so one visitor can't eat the free instance. Video playback
// fetches a segment every few seconds, so the proxy limit leaves plenty of room.

var RATE_LIMITS = {
  proxy: { max: 1200, windowMs: 60000 },
  episode: { max: 60, windowMs: 60000 },
  partyCreate: { max: 10, windowMs: 60000 },
  partyAction: { max: 120, windowMs: 60000 }
};
var rateHits = {};

function clientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
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

function readJsonBody(req) {
  return new Promise(function(resolve, reject) {
    var size = 0, chunks = [];
    req.on('data', function(c) {
      size += c.length;
      if (size > 16384) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function cleanText(v, max) { return String(v == null ? '' : v).slice(0, max); }

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Route: /api/status - server status
  if (pathname === '/api/status') {
    sendJSON(res, 200, {
      server: 'running', timestamp: new Date().toISOString(), commit: process.env.RENDER_GIT_COMMIT || '',
      video_sources: DOOPLAY_SITES.map(function(s) { return s.name; })
    });
    return;
  }

  // Route: /api/party[/:code[/events|/action]] - watch party rooms
  if (pathname === '/api/party' || pathname.startsWith('/api/party/')) {
    handleParty(req, res, pathname, urlObj);
    return;
  }

  // Route: /api/hls-proxy?url= - HLS manifest proxy
  if (pathname === '/api/hls-proxy') {
    if (!allowRequest(req, res, 'proxy')) return;
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
    if (!allowRequest(req, res, 'episode')) return;
    var parts = pathname.split('/').filter(Boolean);
    var slug = decodeURIComponent(parts[2] || '');
    var episode = parts[3] || '1';
    var title = urlObj.searchParams.get('title') || slug.replace(/-/g, ' ');

    findEpisodeEmbeds(title, episode, urlObj.searchParams.get('lang') || '').then(function(result) {
      console.log('[Episode] "' + title + '" ep ' + episode + ': ' + result.embeds.length + ' players', JSON.stringify(result.trace));
      if (!result.embeds.length) {
        sendJSON(res, 404, { error: true, message: 'Episódio não encontrado', trace: result.trace });
        return;
      }
      var embeds = result.embeds.map(function(e) { return { kind: e.kind, url: e.url, label: e.label, provider: e.provider, referer: e.referer, proxy: e.proxy }; });
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

  // Route: /api/embed-proxy?url= - video stream proxy
  if (pathname === '/api/embed-proxy') {
    if (!allowRequest(req, res, 'proxy')) return;
    handleStreamProxy(req, urlObj, res);
    return;
  }

  // Static files from docs/
  var filePath = pathname === '/' ? '/index.html' : pathname;
  var fullPath = path.resolve(STATIC_DIR, '.' + filePath);

  // Security: prevent path traversal
  if (fullPath !== STATIC_DIR && !fullPath.startsWith(STATIC_DIR + path.sep)) {
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

// Required as a module (scripts/probe-sources.js) it only exposes the scrapers.
module.exports = {
  DOOPLAY_SITES: DOOPLAY_SITES,
  findEpisodeEmbeds: findEpisodeEmbeds,
  clearCaches: function() { playerCache = {}; episodeListCache = {}; }
};
if (require.main === module) server.listen(PORT, function() {
  console.log('AnimeHub server running at http://localhost:' + PORT);
  console.log('API Routes:');
  console.log('  GET /api/atv/*                       - AnimeTV API proxy (filtered)');
  console.log('  GET /api/episode/:slug/:ep[?title=]  - find player embeds');
  console.log('  GET /api/hls-proxy?url=              - HLS manifest proxy');
  console.log('  GET /api/search/:query               - slugify title');
  console.log('  GET /api/embed-proxy?url=            - video stream proxy');
  console.log('  GET /api/status                      - server status');
  console.log('  /api/party[/:code[/events|/action]]  - watch party rooms');
  console.log('Video sources: ' + DOOPLAY_SITES.map(function(s) { return s.name; }).join(', '));
});
