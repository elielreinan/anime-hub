// AnimeHub API + static site.
// lib/      shared helpers (config, http, outbound requests, db, auth, security)
// sources/  video scrapers (DooPlay sites)
// routes/   one module per API area
var http = require('http');
var fs = require('fs');
var path = require('path');

var config = require('./lib/config');
var h = require('./lib/http');
var security = require('./lib/security');
var db = require('./lib/db');
var dooplay = require('./sources/dooplay');
var atv = require('./routes/atv');
var proxy = require('./routes/proxy');
var party = require('./routes/party');
var episode = require('./routes/episode');
var download = require('./routes/download');
var api = require('./routes');

var PORT = config.PORT, STATIC_DIR = config.STATIC_DIR, MIME = config.MIME;
var sendJSON = h.sendJSON, allowRequest = h.allowRequest;

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

  security.applyHeaders(req, res, pathname);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (pathname.startsWith('/api/') && !allowRequest(req, res, 'global')) return;

  if (pathname === '/api/status') {
    sendJSON(res, 200, {
      server: 'running', timestamp: new Date().toISOString(), commit: process.env.RENDER_GIT_COMMIT || '',
      accounts: db.enabled(), googleClientId: process.env.GOOGLE_CLIENT_ID || '',
      video_sources: dooplay.DOOPLAY_SITES.map(function(s) { return s.name; })
    });
    return;
  }

  // Accounts, community, clans, reviews, admin...
  if (api.handles(pathname)) { api.handle(req, res, urlObj); return; }

  if (pathname === '/api/party' || pathname.startsWith('/api/party/')) {
    party.handleParty(req, res, pathname, urlObj);
    return;
  }

  if (pathname === '/api/hls-proxy') {
    if (!allowRequest(req, res, 'proxy')) return;
    proxy.handleHLSProxy(urlObj, res);
    return;
  }

  if (pathname === '/api/embed-proxy') {
    if (!allowRequest(req, res, 'proxy')) return;
    proxy.handleStreamProxy(req, urlObj, res);
    return;
  }

  if (pathname.startsWith('/api/atv/')) {
    atv.handleATVProxy(pathname, urlObj, res);
    return;
  }

  if (pathname.startsWith('/api/episode/')) {
    if (!allowRequest(req, res, 'episode')) return;
    episode.handleEpisode(req, res, pathname, urlObj);
    return;
  }

  if (pathname.startsWith('/api/search/')) {
    var query = decodeURIComponent(pathname.split('/api/search/')[1] || '');
    sendJSON(res, 200, { slug: dooplay.slugify(query) });
    return;
  }

  if (pathname.startsWith('/api/')) { sendJSON(res, 404, { error: true, message: 'Não encontrado' }); return; }

  if (pathname === '/download/android') {
    if (!allowRequest(req, res, 'download')) return;
    download.handleDownload(req, res);
    return;
  }

  // Static files from docs/
  var filePath = pathname === '/' ? '/index.html' : pathname;
  var fullPath = path.resolve(STATIC_DIR, '.' + filePath);
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fullPath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

security.hardenServer(server);

// Required as a module (scripts/probe-sources.js) it only exposes the scrapers.
module.exports = { DOOPLAY_SITES: dooplay.DOOPLAY_SITES, findEpisodeEmbeds: dooplay.findEpisodeEmbeds, clearCaches: dooplay.clearCaches };

if (require.main === module) {
  db.init();
  server.listen(PORT, function() {
    console.log('AnimeHub server running at http://localhost:' + PORT);
    console.log('Video sources: ' + dooplay.DOOPLAY_SITES.map(function(s) { return s.name; }).join(', '));
    console.log('Accounts: ' + (db.enabled() ? 'on' : 'off (no DATABASE_URL)'));
  });
}
