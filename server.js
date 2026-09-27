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

// Domains with known SSL certificate issues - use relaxed verification
var RELAXED_SSL_DOMAINS = ['betteranime.net', 'betteranime.com', 'superanimes.biz', 'animesonline.cc'];
var relaxedAgent = new https.Agent({ rejectUnauthorized: false });

// ── Utility Functions ───────────────────────────────────────────────────────

function fetchUrl(targetUrl, maxRedirects) {
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

    // Relax SSL for domains with certificate issues
    try {
      var host = new URL(targetUrl).hostname;
      if (RELAXED_SSL_DOMAINS.some(function(d) { return host.indexOf(d) !== -1; })) {
        options.agent = relaxedAgent;
      }
    } catch(e) {}

    var req = mod.get(targetUrl, options, function(res) {
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

// ── Brazilian Anime Sites Scraper ───────────────────────────────────────────

// Generic video source extractor - finds video URLs in any HTML page
function extractVideoFromPage(html) {
  var results = { videos: [], bloggerEmbeds: [], embeds: [] };
  var match;

  // Google Video URLs (highest priority - direct MP4 from Google CDN)
  var gvRegex = /https?:\/\/r+\d*---sn-[a-z0-9._-]+\.googlevideo\.com\/videoplayback[^"'\s<>\\)}\]]+/gi;
  while ((match = gvRegex.exec(html)) !== null) {
    var gvUrl = match[0].replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (results.videos.indexOf(gvUrl) === -1) results.videos.push(gvUrl);
  }

  // Direct MP4/M3U8/WEBM sources in quotes
  var videoRegex = /["'](https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8|webm)(?:\?[^"'\s<>]*)?)/gi;
  while ((match = videoRegex.exec(html)) !== null) {
    var url = match[1].replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (results.videos.indexOf(url) === -1 && !url.includes('googlevideo.com')) {
      results.videos.push(url);
    }
  }

  // HTML5 video source tags
  var sourceRegex = /<source[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = sourceRegex.exec(html)) !== null) {
    var srcUrl = match[1].replace(/&amp;/g, '&');
    if (srcUrl.match(/\.(mp4|m3u8|webm)/i) && results.videos.indexOf(srcUrl) === -1) {
      results.videos.push(srcUrl);
    }
  }

  // JWPlayer / video player configs (file:"url", source:"url")
  var playerRegex = /["'](?:file|source|src|url|video_url|videoUrl|stream_url|streamUrl|link)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((match = playerRegex.exec(html)) !== null) {
    var pUrl = match[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (results.videos.indexOf(pUrl) === -1) results.videos.push(pUrl);
  }

  // data-video, data-src, data-file attributes on any element
  var dataAttrRegex = /data-(?:video|src|file|url|stream)=["'](https?:\/\/[^"']+)["']/gi;
  while ((match = dataAttrRegex.exec(html)) !== null) {
    var daUrl = match[1].replace(/&amp;/g, '&');
    if (results.videos.indexOf(daUrl) === -1) results.videos.push(daUrl);
  }

  // Video tag src directly
  var videoTagRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = videoTagRegex.exec(html)) !== null) {
    var vtUrl = match[1].replace(/&amp;/g, '&');
    if (results.videos.indexOf(vtUrl) === -1) results.videos.push(vtUrl);
  }

  // Iframes (Blogger, Google Drive, players)
  var iframeRegex = /<iframe[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
  while ((match = iframeRegex.exec(html)) !== null) {
    var src = match[1].replace(/&amp;/g, '&');
    if (src.indexOf('http') !== 0) continue;
    if (src.includes('blogger.com') || src.includes('blogspot.com')) {
      if (results.bloggerEmbeds.indexOf(src) === -1) results.bloggerEmbeds.push(src);
    } else if (src.includes('drive.google') || src.includes('docs.google') ||
               src.includes('player') || src.includes('embed') || src.includes('video') ||
               src.includes('stream') || src.includes('watch') || src.includes('play')) {
      if (results.embeds.indexOf(src) === -1) results.embeds.push(src);
    }
  }

  // Links to .mp4/.m3u8 files (some sites use <a> tags)
  var linkRegex = /<a[^>]+href=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    var lUrl = match[1].replace(/&amp;/g, '&');
    if (results.videos.indexOf(lUrl) === -1) results.videos.push(lUrl);
  }

  return results;
}

// Resolve Blogger/Blogspot embed to actual video URL
function resolveBloggerEmbed(embedUrl) {
  console.log('[Blogger] Resolving:', embedUrl.substring(0, 100));
  return fetchUrl(embedUrl).then(function(result) {
    if (result.status >= 400) return null;
    var html = result.body.toString();
    var sources = extractVideoFromPage(html);
    if (sources.videos.length > 0) {
      console.log('[Blogger] Resolved to:', sources.videos[0].substring(0, 80));
      return sources.videos[0];
    }
    return null;
  }).catch(function(err) {
    console.log('[Blogger] Error:', err.message);
    return null;
  });
}

// Resolve any embed URL to direct video URL
function resolveEmbedUrl(embedUrl) {
  if (embedUrl.includes('blogger.com') || embedUrl.includes('blogspot.com')) {
    return resolveBloggerEmbed(embedUrl);
  }
  return fetchUrl(embedUrl).then(function(result) {
    if (result.status >= 400) return null;
    var sources = extractVideoFromPage(result.body.toString());
    return sources.videos.length > 0 ? sources.videos[0] : null;
  }).catch(function() { return null; });
}

// Generic scraper: tries a list of URLs, extracts video sources
function scrapeVideoFromUrls(urls, providerName) {
  var idx = 0;
  function tryNext() {
    if (idx >= urls.length) return Promise.resolve(null);
    var url = urls[idx++];
    console.log('[' + providerName + '] Trying:', url);

    return fetchUrl(url).then(function(result) {
      if (result.status >= 400) {
        console.log('[' + providerName + '] HTTP ' + result.status);
        return tryNext();
      }
      var html = result.body.toString();
      var sources = extractVideoFromPage(html);
      console.log('[' + providerName + '] Found: ' + sources.videos.length + ' videos, ' +
        sources.bloggerEmbeds.length + ' blogger, ' + sources.embeds.length + ' embeds');

      // Direct video (Google Video, MP4, M3U8)
      if (sources.videos.length > 0) {
        var videoUrl = sources.videos[0];
        var origin = '';
        try { origin = new URL(url).origin + '/'; } catch(e) {}
        return {
          provider: providerName, video_url: videoUrl, type: 'direct',
          isM3U8: videoUrl.indexOf('.m3u8') !== -1, referer: origin
        };
      }

      // Blogger embed - resolve to direct URL
      if (sources.bloggerEmbeds.length > 0) {
        return resolveBloggerEmbed(sources.bloggerEmbeds[0]).then(function(videoUrl) {
          if (videoUrl) {
            return { provider: providerName, video_url: videoUrl, type: 'direct', isM3U8: videoUrl.indexOf('.m3u8') !== -1 };
          }
          return { provider: providerName, embed_url: sources.bloggerEmbeds[0], type: 'embed' };
        });
      }

      // Other embeds - try to resolve each one
      if (sources.embeds.length > 0) {
        var embedIdx = 0;
        function tryNextEmbed() {
          if (embedIdx >= sources.embeds.length) return Promise.resolve(null);
          var embedUrl = sources.embeds[embedIdx++];
          console.log('[' + providerName + '] Resolving embed:', embedUrl.substring(0, 80));
          return resolveEmbedUrl(embedUrl).then(function(videoUrl) {
            if (videoUrl) {
              return { provider: providerName, video_url: videoUrl, type: 'direct', isM3U8: videoUrl.indexOf('.m3u8') !== -1 };
            }
            return tryNextEmbed();
          }).catch(function() { return tryNextEmbed(); });
        }
        return tryNextEmbed().then(function(result) {
          if (result) return result;
          return { provider: providerName, embed_url: sources.embeds[0], type: 'embed' };
        });
      }

      return tryNext();
    }).catch(function(err) {
      console.log('[' + providerName + '] Error:', err.message);
      return tryNext();
    });
  }

  return tryNext();
}

// Generate URL patterns for Brazilian anime sites
function generateBrazilianUrls(title, episode) {
  var slug = slugify(title);
  var epNum = parseInt(episode);
  var sites = {};

  // AnimeFire
  sites.animefire = [
    'https://animefire.plus/animes/' + slug + '/' + epNum,
    'https://animefire.plus/video/' + slug + '-episodio-' + epNum,
    'https://animefire.plus/animes/' + slug + '-todos-os-episodios/' + epNum,
    'https://animefire.plus/animes/' + slug + '-legendado/' + epNum,
    'https://animefire.plus/animes/' + slug + '-dublado/' + epNum,
  ];

  // BetterAnime
  sites.betteranime = [
    'https://betteranime.net/anime/legendado/' + slug + '/' + epNum,
    'https://betteranime.net/anime/dublado/' + slug + '/' + epNum,
    'https://betteranime.net/anime/' + slug + '/' + epNum,
  ];

  // Goyabu
  sites.goyabu = [
    'https://goyabu.to/' + slug + '-episodio-' + epNum + '/',
    'https://goyabu.to/' + slug + '-ep-' + epNum + '/',
    'https://goyabu.to/assistir/' + slug + '-episodio-' + epNum + '/',
  ];

  // AnimesHouse
  sites.animeshouse = [
    'https://animeshouse.net/episodio/' + slug + '-episodio-' + epNum + '/',
    'https://animeshouse.net/episodio/' + slug + '-ep-' + epNum + '/',
    'https://animeshouse.net/' + slug + '-episodio-' + epNum + '/',
    'https://animeshouse.net/episodio/' + slug + '-episode-' + epNum + '/',
  ];

  // AnimeQ
  sites.animeq = [
    'https://animeq.blog/' + slug + '-episodio-' + epNum + '/',
    'https://animeq.blog/assistir/' + slug + '-ep-' + epNum + '/',
  ];

  // AnimesOnline.cc
  sites.animesonline = [
    'https://animesonline.cc/episodio/' + slug + '-episodio-' + epNum + '/',
    'https://animesonline.cc/episodio/' + slug + '-ep-' + epNum + '/',
    'https://animesonline.cc/' + slug + '-episodio-' + epNum + '/',
  ];

  // SuperAnimes
  sites.superanimes = [
    'https://superanimes.biz/anime/' + slug + '/' + epNum,
    'https://superanimes.biz/' + slug + '-episodio-' + epNum,
  ];

  return sites;
}

// Search all Brazilian anime sites in parallel
function searchBrazilianSites(title, episode) {
  var sites = generateBrazilianUrls(title, episode);
  console.log('[BrSites] Searching all Brazilian sites for: "' + title + '" ep ' + episode);

  var promises = Object.keys(sites).map(function(name) {
    return scrapeVideoFromUrls(sites[name], name).catch(function() { return null; });
  });

  return Promise.all(promises).then(function(results) {
    var directResult = null;
    var embedResult = null;

    for (var i = 0; i < results.length; i++) {
      if (results[i]) {
        if (results[i].type === 'direct' && !directResult) directResult = results[i];
        else if (results[i].type === 'embed' && !embedResult) embedResult = results[i];
      }
    }

    var result = directResult || embedResult;
    if (result) {
      console.log('[BrSites] Found result from:', result.provider, '- type:', result.type);
      return result;
    }

    console.log('[BrSites] Guess-based URLs failed, trying search-based scraping...');
    return searchBrazilianSitesViaSearch(title, episode);
  });
}

// ── Search-based scraping (WordPress-style /?s= search) ────────────────────
// Sites confirmed reachable (not Cloudflare-blocked) but with unknown URL slugs
var SEARCH_BASED_SITES = {
  betteranime: 'https://betteranime.net',
  animeshouse: 'https://animeshouse.net'
};

function normalizeForMatch(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve href (absolute or relative) to absolute URL, only if same host as origin (ignoring www.)
function resolveSameOriginUrl(href, origin) {
  if (!href) return null;
  try {
    var abs;
    if (href.indexOf('http') === 0) {
      abs = href;
    } else if (href.indexOf('//') === 0) {
      abs = new URL(origin).protocol + href;
    } else if (href.indexOf('/') === 0) {
      abs = origin + href;
    } else {
      return null; // relative without leading slash - too ambiguous, skip
    }
    var h = new URL(abs);
    var o = new URL(origin);
    var hh = h.hostname.replace(/^www\./, '');
    var oh = o.hostname.replace(/^www\./, '');
    if (hh !== oh) return null;
    return abs;
  } catch (e) {
    return null;
  }
}

// Extract every <a> tag: href + combined visible text (inner text + title attr + img alt)
function extractAllLinks(html, origin) {
  var linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var match;
  var links = [];
  while ((match = linkRegex.exec(html)) !== null) {
    var attrs = match[1];
    var inner = match[2];
    var hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    var abs = resolveSameOriginUrl(hrefMatch[1], origin);
    if (!abs) continue;

    var titleAttrMatch = attrs.match(/\btitle=["']([^"']+)["']/i);
    var altAttrMatch = inner.match(/\balt=["']([^"']+)["']/i);
    var innerText = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    var combinedText = [innerText, titleAttrMatch && titleAttrMatch[1], altAttrMatch && altAttrMatch[1]]
      .filter(Boolean).join(' ');

    links.push({ href: abs, text: combinedText });
  }
  return links;
}

// Find candidate anime page links on a search results page, ranked by title word overlap
function extractSearchResultLinks(html, origin, title) {
  var links = extractAllLinks(html, origin);
  var titleWords = normalizeForMatch(title).split(' ').filter(function(w) { return w.length > 1; });
  var seen = {};
  var scored = [];

  links.forEach(function(link) {
    var href = link.href;
    if (/\/(page|category|tag|author|feed|wp-|attachment)\//.test(href) || href.indexOf('?s=') !== -1) return;
    if (seen[href]) return;

    var textNorm = normalizeForMatch(link.text);
    if (!textNorm) return;

    var score = 0;
    titleWords.forEach(function(w) { if (textNorm.indexOf(w) !== -1) score++; });
    if (score === 0) return;

    seen[href] = true;
    scored.push({ href: href, text: link.text, score: score });
  });

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored;
}

function searchSiteAnimePage(baseUrl, title, providerName, trace) {
  var searchUrl = baseUrl + '/?s=' + encodeURIComponent(title);
  if (trace) trace.searchUrl = searchUrl;
  console.log('[' + providerName + '] Search:', searchUrl);
  return fetchUrl(searchUrl).then(function(result) {
    if (trace) trace.searchStatus = result.status;
    if (result.status >= 400) return null;
    var origin = new URL(baseUrl).origin;
    var html = result.body.toString();
    var candidates = extractSearchResultLinks(html, origin, title);
    if (trace) {
      trace.candidates = candidates.slice(0, 5).map(function(c) { return { href: c.href, text: c.text.substring(0, 60), score: c.score }; });
      trace.htmlLength = html.length;
      trace.linkCount = extractAllLinks(html, origin).length;
    }
    return candidates.length > 0 ? candidates[0].href : null;
  }).catch(function(err) {
    if (trace) trace.searchError = err.message;
    console.log('[' + providerName + '] Search error:', err.message);
    return null;
  });
}

// Find the episode link on an anime's page matching the given episode number
function findEpisodeLink(animePageUrl, episode, trace) {
  return fetchUrl(animePageUrl).then(function(result) {
    if (trace) trace.animePageStatus = result.status;
    if (result.status >= 400) return null;
    var html = result.body.toString();
    var origin;
    try { origin = new URL(animePageUrl).origin; } catch (e) { origin = ''; }

    var epPatterns = [
      new RegExp('episodio[-_]?0*' + episode + '(?:[^0-9]|$)', 'i'),
      new RegExp('epis[oó]dio\\s*0*' + episode + '(?:[^0-9]|$)', 'i'),
      new RegExp('ep[-_]?0*' + episode + '(?:[^0-9]|$)', 'i'),
      new RegExp('cap[ií]tulo\\s*0*' + episode + '(?:[^0-9]|$)', 'i'),
      new RegExp('(?:^|[^0-9])0*' + episode + '(?:[^0-9]|$)')
    ];

    var links = extractAllLinks(html, origin);
    if (trace) trace.animePageLinkCount = links.length;

    for (var i = 0; i < links.length; i++) {
      var hay = links[i].href + ' ' + links[i].text;
      for (var j = 0; j < epPatterns.length - 1; j++) {
        if (epPatterns[j].test(hay)) return links[i].href;
      }
    }
    // Last resort: loose number match only on visible text (risk of false positives, so lowest priority)
    for (var k = 0; k < links.length; k++) {
      if (epPatterns[epPatterns.length - 1].test(links[k].text)) return links[k].href;
    }
    return null;
  }).catch(function(err) {
    if (trace) trace.animePageError = err.message;
    return null;
  });
}

// Full pipeline: search for anime -> find episode -> extract video
function searchAndScrapeSite(baseUrl, title, episode, providerName, trace) {
  return searchSiteAnimePage(baseUrl, title, providerName, trace).then(function(animeUrl) {
    if (trace) trace.animeUrl = animeUrl;
    if (!animeUrl) {
      console.log('[' + providerName + '] search: no anime match for "' + title + '"');
      return null;
    }
    console.log('[' + providerName + '] matched anime page:', animeUrl);

    return findEpisodeLink(animeUrl, episode, trace).then(function(epUrl) {
      if (trace) trace.episodeUrl = epUrl;
      if (!epUrl) {
        console.log('[' + providerName + '] no episode link found for ep', episode);
        return null;
      }
      console.log('[' + providerName + '] episode url:', epUrl);

      return fetchUrl(epUrl).then(function(result) {
        if (trace) trace.episodePageStatus = result.status;
        if (result.status >= 400) return null;
        var sources = extractVideoFromPage(result.body.toString());
        if (trace) trace.sourcesFound = { videos: sources.videos.length, bloggerEmbeds: sources.bloggerEmbeds.length, embeds: sources.embeds.length };
        var origin = '';
        try { origin = new URL(epUrl).origin + '/'; } catch (e) {}

        if (sources.videos.length > 0) {
          return { provider: providerName, video_url: sources.videos[0], type: 'direct',
            isM3U8: sources.videos[0].indexOf('.m3u8') !== -1, referer: origin };
        }
        if (sources.bloggerEmbeds.length > 0) {
          return resolveBloggerEmbed(sources.bloggerEmbeds[0]).then(function(v) {
            if (v) return { provider: providerName, video_url: v, type: 'direct', isM3U8: v.indexOf('.m3u8') !== -1 };
            return { provider: providerName, embed_url: sources.bloggerEmbeds[0], type: 'embed' };
          });
        }
        if (sources.embeds.length > 0) {
          return resolveEmbedUrl(sources.embeds[0]).then(function(v) {
            if (v) return { provider: providerName, video_url: v, type: 'direct', isM3U8: v.indexOf('.m3u8') !== -1 };
            return { provider: providerName, embed_url: sources.embeds[0], type: 'embed' };
          });
        }
        return null;
      }).catch(function(err) {
        if (trace) trace.episodePageError = err.message;
        return null;
      });
    });
  }).catch(function(err) {
    if (trace) trace.error = err.message;
    return null;
  });
}

function searchBrazilianSitesViaSearch(title, episode) {
  var names = Object.keys(SEARCH_BASED_SITES);
  var idx = 0;
  function next() {
    if (idx >= names.length) return Promise.resolve(null);
    var name = names[idx++];
    return searchAndScrapeSite(SEARCH_BASED_SITES[name], title, episode, name).then(function(r) {
      if (r) return r;
      return next();
    });
  }
  return next();
}

// ── Consumet Video Provider (@consumet/extensions) ─────────────────────────

var consumetProviders = null;
var consumetLoadAttempted = false;

function loadConsumetProviders() {
  if (consumetProviders) return Promise.resolve(consumetProviders);
  if (consumetLoadAttempted) return Promise.resolve(null);
  consumetLoadAttempted = true;

  return import('@consumet/extensions').then(function(mod) {
    var ANIME = mod.ANIME || (mod.default && mod.default.ANIME);
    if (!ANIME) {
      console.error('[Consumet] No ANIME module found');
      return null;
    }
    var providers = [];
    // AnimeKai first (active), then Hianime as fallback
    var names = ['AnimeKai', 'Hianime', 'AnimePahe', 'KickAssAnime'];
    names.forEach(function(name) {
      if (ANIME[name]) {
        try {
          var inst = new ANIME[name]();
          if (typeof inst.search === 'function' && typeof inst.fetchAnimeInfo === 'function' && typeof inst.fetchEpisodeSources === 'function') {
            providers.push({ name: name, instance: inst });
            console.log('[Consumet] Loaded provider:', name);
          }
        } catch(e) { /* skip */ }
      }
    });
    if (providers.length === 0) {
      console.error('[Consumet] No working providers');
      return null;
    }
    consumetProviders = providers;
    return providers;
  }).catch(function(err) {
    console.error('[Consumet] Load failed:', err.message);
    return null;
  });
}

function normalizeTitle(title) {
  return title
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+(Dublado|Legendado|PT-PT|PT-BR)\s*/gi, ' ')
    .replace(/\s+(Season|Temporada)\s+\d+/gi, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+Season/gi, '')
    .replace(/\s*[-–—]\s*\d+ª?\s*Temporada/gi, '')
    .trim();
}

function searchConsumetVideo(title, episode) {
  return loadConsumetProviders().then(function(providers) {
    if (!providers || providers.length === 0) return null;

    var epNum = parseInt(episode);
    var searchTitle = normalizeTitle(title);
    var providerIdx = 0;

    function tryNextProvider() {
      if (providerIdx >= providers.length) return Promise.resolve(null);
      var prov = providers[providerIdx++];
      console.log('[Consumet] Trying provider:', prov.name, 'for:', searchTitle, 'ep', episode);

      return prov.instance.search(searchTitle).then(function(results) {
        if (!results || !results.results || results.results.length === 0) {
          console.log('[Consumet]', prov.name, '- no search results');
          return tryNextProvider();
        }
        var animeId = results.results[0].id;
        console.log('[Consumet]', prov.name, '- match:', animeId, '(' + (results.results[0].title || '') + ')');
        return prov.instance.fetchAnimeInfo(animeId);
      }).then(function(info) {
        if (!info || !info.episodes || info.episodes.length === 0) {
          console.log('[Consumet]', prov.name, '- no episodes');
          return tryNextProvider();
        }
        var ep = info.episodes.find(function(e) { return e.number === epNum; });
        if (!ep) ep = info.episodes[epNum - 1];
        if (!ep) {
          console.log('[Consumet]', prov.name, '- ep', episode, 'not found (has', info.episodes.length, ')');
          return tryNextProvider();
        }
        console.log('[Consumet]', prov.name, '- fetching sources for:', ep.id);
        return prov.instance.fetchEpisodeSources(ep.id);
      }).then(function(sources) {
        if (!sources || !sources.sources || sources.sources.length === 0) {
          console.log('[Consumet]', prov.name, '- no video sources');
          return tryNextProvider();
        }
        var best = sources.sources.find(function(s) { return s.quality === '1080p'; }) ||
                   sources.sources.find(function(s) { return s.quality === '720p'; }) ||
                   sources.sources.find(function(s) { return s.quality === 'default'; }) ||
                   sources.sources[0];
        var isHLS = (best.isM3U8 === true) || (best.url && best.url.indexOf('.m3u8') !== -1);
        var referer = (sources.headers && sources.headers.Referer) ? sources.headers.Referer : '';

        console.log('[Consumet]', prov.name, '- found video:', best.quality || 'default', isHLS ? 'HLS' : 'MP4');
        return {
          provider: prov.name.toLowerCase(),
          video_url: best.url,
          type: 'direct',
          isM3U8: isHLS,
          quality: best.quality || 'default',
          referer: referer
        };
      }).catch(function(err) {
        console.log('[Consumet]', prov.name, '- error:', err.message);
        return tryNextProvider();
      });
    }

    return tryNextProvider();
  });
}

// Pre-load consumet providers at startup (non-blocking)
loadConsumetProviders();

// ── HLS Proxy ──────────────────────────────────────────────────────────────

function handleHLSProxy(urlObj, res) {
  var hlsUrl = urlObj.searchParams.get('url');
  var referer = urlObj.searchParams.get('referer') || '';
  if (!hlsUrl) { res.writeHead(400); res.end('Missing url'); return; }

  if (!referer) {
    try { referer = new URL(hlsUrl).origin + '/'; } catch(e) { referer = ''; }
  }

  console.log('[HLS-Proxy] Fetching:', hlsUrl.substring(0, 80));

  fetchUrl(hlsUrl).then(function(result) {
    if (result.status >= 400) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*' });
      res.end('Upstream error: ' + result.status);
      return;
    }

    var content = result.body.toString();
    // Not an m3u8 manifest - just proxy the binary data (TS segment, key, etc.)
    if (content.indexOf('#EXTM3U') === -1 && !hlsUrl.match(/\.m3u8/i)) {
      var ct = result.headers['content-type'] || 'video/mp2t';
      res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(result.body);
      return;
    }

    var baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);
    var refParam = referer ? '&referer=' + encodeURIComponent(referer) : '';

    var lines = content.split('\n');
    var rewritten = lines.map(function(line) {
      var trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI= inside tags (encryption keys, init segments)
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, function(match, uri) {
          var absUrl = uri.startsWith('http') ? uri : baseUrl + uri;
          var proxy = uri.indexOf('.m3u8') !== -1 ? '/api/hls-proxy' : '/api/hls-proxy';
          return 'URI="' + proxy + '?url=' + encodeURIComponent(absUrl) + refParam + '"';
        });
      }

      // URL line (segment or sub-manifest)
      var absUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
      return '/api/hls-proxy?url=' + encodeURIComponent(absUrl) + refParam;
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

// ── Debug & Status Handlers ────────────────────────────────────────────────

function handleTestSites(res) {
  var testSites = [
    'https://animefire.plus',
    'https://betteranime.net',
    'https://goyabu.to',
    'https://animeshouse.net',
    'https://animeq.blog',
    'https://animesonline.cc',
    'https://superanimes.biz',
    'https://animesonlinecc.to',
    'https://atv2.net',
  ];

  Promise.all(testSites.map(function(site) {
    var start = Date.now();
    return fetchUrl(site).then(function(r) {
      var snippet = r.body.toString().substring(0, 200);
      var hasCloudflare = snippet.includes('cloudflare') || snippet.includes('cf-') || snippet.includes('challenge');
      return { site: site, status: r.status, time_ms: Date.now() - start, ok: r.status < 400, cloudflare: hasCloudflare };
    }).catch(function(e) {
      return { site: site, error: e.message, time_ms: Date.now() - start, ok: false };
    });
  })).then(function(results) {
    var reachable = results.filter(function(r) { return r.ok; }).map(function(r) { return r.site; });
    sendJSON(res, 200, { results: results, reachable: reachable, total: results.length, reachable_count: reachable.length });
  });
}

function handleDebugVideo(title, episode, res) {
  console.log('[Debug] Testing all providers for:', title, 'ep', episode);
  var results = { title: title, episode: episode, slug: slugify(title), providers: {} };
  var startTime = Date.now();
  var slug = slugify(title);
  var promises = [];

  // Test Consumet
  promises.push(
    searchConsumetVideo(title, episode)
      .then(function(r) { results.providers.consumet = r || { status: 'no_results' }; })
      .catch(function(e) { results.providers.consumet = { status: 'error', error: e.message }; })
  );

  // Test AnimesOnlineCC
  var variants = [slug, slug + '-legendado', slug + '-dublado', slug + '-todos-os-episodios'];
  promises.push(
    tryProviders(variants, episode)
      .then(function(r) { results.providers.animesonlinecc = r || { status: 'no_results', urls_tried: variants.map(function(v) { return 'https://animesonlinecc.to/episodio/' + v + '-episodio-' + episode + '/'; }) }; })
      .catch(function(e) { results.providers.animesonlinecc = { status: 'error', error: e.message }; })
  );

  // Test each Brazilian site individually (guess-based URL patterns)
  var sites = generateBrazilianUrls(title, episode);
  Object.keys(sites).forEach(function(name) {
    promises.push(
      scrapeVideoFromUrls(sites[name], name)
        .then(function(r) { results.providers[name] = r || { status: 'no_results', urls_tried: sites[name] }; })
        .catch(function(e) { results.providers[name] = { status: 'error', error: e.message }; })
    );
  });

  // Test search-based scraping (real site search, for sites with unknown URL patterns)
  Object.keys(SEARCH_BASED_SITES).forEach(function(name) {
    var key = name + '_search';
    var trace = {};
    promises.push(
      searchAndScrapeSite(SEARCH_BASED_SITES[name], title, episode, key, trace)
        .then(function(r) { results.providers[key] = r ? Object.assign({}, r, { trace: trace }) : { status: 'no_results', trace: trace }; })
        .catch(function(e) { results.providers[key] = { status: 'error', error: e.message, trace: trace }; })
    );
  });

  Promise.all(promises).then(function() {
    results.elapsed_ms = Date.now() - startTime;
    results.working = Object.keys(results.providers).filter(function(k) {
      var p = results.providers[k];
      return p && (p.video_url || p.embed_url);
    });
    results.summary = results.working.length > 0
      ? 'Encontrado em: ' + results.working.join(', ')
      : 'Nenhum provedor retornou video';
    sendJSON(res, 200, results);
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

  // Route: /api/status - server status and provider info
  if (pathname === '/api/status') {
    var status = {
      server: 'running', version: '2.0', timestamp: new Date().toISOString(),
      consumet: { loaded: !!consumetProviders, attempted: consumetLoadAttempted, providers: consumetProviders ? consumetProviders.map(function(p) { return p.name; }) : [] },
      video_providers: ['consumet', 'animefire', 'betteranime', 'goyabu', 'animeshouse', 'animeq', 'animesonline', 'superanimes', 'animesonlinecc'],
      endpoints: ['/api/status', '/api/test-sites', '/api/debug-video/{title}/{ep}', '/api/episode/{slug}/{ep}?title=', '/api/atv/*']
    };
    sendJSON(res, 200, status);
    return;
  }

  // Route: /api/test-sites - test connectivity to anime source sites
  if (pathname === '/api/test-sites') {
    handleTestSites(res);
    return;
  }

  // Route: /api/debug-video/:title/:episode - test all providers for a specific anime/episode
  if (pathname.startsWith('/api/debug-video/')) {
    var dParts = pathname.split('/').filter(Boolean);
    var dTitle = decodeURIComponent(dParts[2] || '');
    var dEpisode = dParts[3] || '1';
    if (!dTitle) { sendJSON(res, 400, { error: true, message: 'Uso: /api/debug-video/{titulo}/{episodio}' }); return; }
    handleDebugVideo(dTitle, dEpisode, res);
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

  // Route: /api/episode/:slug/:episode - episode search with multi-provider fallback
  if (pathname.startsWith('/api/episode/')) {
    var parts = pathname.split('/').filter(Boolean);
    var slug = decodeURIComponent(parts[2] || '');
    var episode = parts[3] || '1';
    var title = urlObj.searchParams.get('title') || slug.replace(/-/g, ' ');

    // Generate slug variants for AnimesOnlineCC fallback
    var variants = [slug];
    var altSlug = slug
      .replace(/-season-\d+/i, '')
      .replace(/-\d+nd-season/i, '')
      .replace(/-\d+rd-season/i, '')
      .replace(/-\d+th-season/i, '')
      .replace(/-\d+st-season/i, '')
      .replace(/-\d+a-temporada/i, '');
    if (altSlug !== slug) variants.push(altSlug);
    var noSuffix = slug.replace(/-dublado$/i, '').replace(/-legendado$/i, '').replace(/-online$/i, '');
    if (noSuffix !== slug && variants.indexOf(noSuffix) === -1) variants.push(noSuffix);
    variants.push(slug + '-todos-os-episodios');
    variants.push(slug + '-legendado');
    variants.push(slug + '-dublado');

    console.log('[Episode] Searching title="' + title + '" slug="' + slug + '" ep=' + episode);

    Promise.resolve().then(function() {
      return searchConsumetVideo(title, episode).then(function(consumetResult) {
        if (consumetResult) {
          console.log('[Episode] Consumet found video via', consumetResult.provider);
          sendJSON(res, 200, { error: false, data: consumetResult });
          return;
        }

        // Priority 3: Brazilian anime sites (parallel search)
        console.log('[Episode] Consumet failed, trying Brazilian sites...');
        return searchBrazilianSites(title, episode).then(function(brResult) {
          if (brResult) {
            console.log('[Episode] Brazilian site found video via', brResult.provider);
            sendJSON(res, 200, { error: false, data: brResult });
            return;
          }

          // Priority 4: AnimesOnlineCC scraping fallback
          console.log('[Episode] Brazilian sites failed, trying AnimesOnlineCC...');
          return tryProviders(variants, episode).then(function(result) {
            if (result) {
              sendJSON(res, 200, { error: false, data: result });
            } else {
              sendJSON(res, 404, { error: true, message: 'Episodio nao encontrado em nenhum provedor',
                providers_tried: ['consumet', 'animefire', 'betteranime', 'goyabu', 'animeshouse', 'animeq', 'animesonline', 'superanimes', 'animesonlinecc'] });
            }
          });
        });
      });
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
  console.log('  GET /api/episode/:slug/:ep[?title=]  - multi-provider video search');
  console.log('  GET /api/hls-proxy?url=              - HLS manifest proxy');
  console.log('  GET /api/search/:query               - slugify title');
  console.log('  GET /api/proxy?url=                  - HTML/embed CORS proxy');
  console.log('  GET /api/embed-proxy?url=            - video stream proxy');
  console.log('  GET /api/status                      - server status');
  console.log('  GET /api/test-sites                  - test anime site connectivity');
  console.log('  GET /api/debug-video/:title/:ep      - debug all video providers');
  console.log('Video providers: AnimeTV -> Consumet -> BrSites (AnimeFire/BetterAnime/Goyabu/AnimesHouse/AnimeQ) -> AnimesOnlineCC');
});
