// /download/android - the Android app, served from our own address so Chrome
// downloads it directly (GitHub's release link redirects to another domain, which
// installed PWAs and some browsers open as a page instead of downloading).
var fetchUrl = require('../lib/net').fetchUrl;

var RELEASE_URL = 'https://github.com/elielreinan/anime-hub/releases/download/android/AnimeHub.apk';
var TTL = 30 * 60 * 1000;
var cached = null, pending = null;

function getApk() {
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.body);
  if (pending) return pending;
  pending = fetchUrl(RELEASE_URL, 5, 60000, { Accept: 'application/octet-stream' }).then(function(r) {
    pending = null;
    // An APK is a zip: it must start with "PK".
    if (r.status !== 200 || r.body.length < 100000 || r.body[0] !== 0x50 || r.body[1] !== 0x4b) throw new Error('bad release (' + r.status + ')');
    cached = { at: Date.now(), body: r.body };
    return r.body;
  }, function(e) { pending = null; throw e; });
  return pending;
}

function handleDownload(req, res) {
  getApk().then(function(body) {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="AnimeHub.apk"',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=600'
    });
    res.end(body);
  }).catch(function(e) {
    console.error('[Download]', e.message);
    // Fall back to GitHub rather than failing.
    res.writeHead(302, { Location: RELEASE_URL });
    res.end();
  });
}

module.exports = { handleDownload: handleDownload };
