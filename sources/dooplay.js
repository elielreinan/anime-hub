var n = require('../lib/net');
var fetchUrl = n.fetchUrl, fetchText = n.fetchText, postForm = n.postForm;

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
      markSource(site, true);
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
    }).catch(function(err) { trace.push('error: ' + err.message); markSource(site, false, err.message); return []; });
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

// Last time each source site answered (or failed), for the public status page.
var sourceStatus = {};
function markSource(site, ok, error) {
  var s = sourceStatus[site.name] = sourceStatus[site.name] || { name: site.name };
  if (ok) s.lastOk = Date.now(); else { s.lastFail = Date.now(); s.error = String(error || '').slice(0, 120); }
}
function getSourceStatus() {
  return DOOPLAY_SITES.map(function(site) {
    var s = sourceStatus[site.name] || {};
    var ok = s.lastOk && (!s.lastFail || s.lastOk > s.lastFail);
    return { name: site.name, state: !s.lastOk && !s.lastFail ? 'unknown' : ok ? 'ok' : 'down', lastOk: s.lastOk || null, lastFail: s.lastFail || null };
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


module.exports = {
  DOOPLAY_SITES: DOOPLAY_SITES,
  findEpisodeEmbeds: findEpisodeEmbeds,
  slugify: slugify,
  hostName: hostName,
  getSourceStatus: getSourceStatus,
  clearCaches: function() { playerCache = {}; episodeListCache = {}; }
};
