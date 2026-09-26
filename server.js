var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');

var PORT = 3000;
var STATIC_DIR = path.join(__dirname, 'docs');

var MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function fetchUrl(targetUrl) {
  return new Promise(function(resolve, reject) {
    var mod = targetUrl.startsWith('https') ? https : http;
    var req = mod.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': targetUrl } }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, function() { req.destroy(); reject(new Error('timeout')); });
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

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API: /api/episode/:slug/:episode
  if (pathname.startsWith('/api/episode/')) {
    var parts = pathname.split('/').filter(Boolean);
    var slug = parts[2];
    var episode = parts[3] || '1';

    var animeFireUrl = 'https://animefire.plus/video/' + slug + '/' + episode;

    console.log('[API] Fetching:', animeFireUrl);

    fetchUrl(animeFireUrl).then(function(result) {
      try {
        var json = JSON.parse(result.body.toString());
        if (json.data && json.data.length > 0) {
          var videoUrl = json.data[0].src;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: false,
            provider: 'anime-fire',
            slug: slug,
            episode: episode,
            video_url: videoUrl,
            sources: json.data.map(function(d) { return { src: d.src, label: d.label || 'SD' }; })
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: true, message: 'Episode not found', slug: slug }));
        }
      } catch(e) {
        // Try alternate slugs
        var altSlugs = [slug + '-legendado', slug + '-todos-os-episodios'];
        tryAlternateSlugs(altSlugs, episode, res);
      }
    }).catch(function(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: err.message }));
    });
    return;
  }

  // API: /api/search/:query - search for anime slug
  if (pathname.startsWith('/api/search/')) {
    var query = decodeURIComponent(pathname.split('/api/search/')[1] || '');
    var searchSlug = slugify(query);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slug: searchSlug, variants: [searchSlug, searchSlug + '-legendado', searchSlug + '-todos-os-episodios', searchSlug + '-dublado'] }));
    return;
  }

  // API: /api/proxy?url= - video proxy for CORS
  if (pathname === '/api/proxy') {
    var videoUrl = parsed.query.url;
    if (!videoUrl) { res.writeHead(400); res.end('Missing url'); return; }

    var mod = videoUrl.startsWith('https') ? https : http;
    var proxyReq = mod.get(videoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://animefire.plus/' }
    }, function(proxyRes) {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        res.writeHead(302, { 'Location': '/api/proxy?url=' + encodeURIComponent(proxyRes.headers.location) });
        res.end();
        return;
      }
      var headers = { 'Content-Type': proxyRes.headers['content-type'] || 'video/mp4', 'Access-Control-Allow-Origin': '*' };
      if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function() { res.writeHead(502); res.end('Proxy error'); });
    proxyReq.setTimeout(30000, function() { proxyReq.destroy(); });
    return;
  }

  // Static files
  var filePath = pathname === '/' ? '/index.html' : pathname;
  var fullPath = path.join(STATIC_DIR, filePath);

  if (!fullPath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(fullPath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    var ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function tryAlternateSlugs(slugs, episode, res) {
  if (slugs.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: true, message: 'No sources found' }));
    return;
  }
  var slug = slugs.shift();
  var altUrl = 'https://animefire.plus/video/' + slug + '/' + episode;
  fetchUrl(altUrl).then(function(result) {
    try {
      var json = JSON.parse(result.body.toString());
      if (json.data && json.data.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: false,
          provider: 'anime-fire',
          slug: slug,
          episode: episode,
          video_url: json.data[0].src,
          sources: json.data.map(function(d) { return { src: d.src, label: d.label || 'SD' }; })
        }));
      } else {
        tryAlternateSlugs(slugs, episode, res);
      }
    } catch(e) {
      tryAlternateSlugs(slugs, episode, res);
    }
  }).catch(function() { tryAlternateSlugs(slugs, episode, res); });
}

server.listen(PORT, function() {
  console.log('AnimeHub server running at http://localhost:' + PORT);
  console.log('API endpoints:');
  console.log('  GET /api/episode/:slug/:episode');
  console.log('  GET /api/search/:query');
  console.log('  GET /api/proxy?url=<video_url>');
});
