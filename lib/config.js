// ── Config ──────────────────────────────────────────────────────────────────
var path = require('path');

var PORT = process.env.PORT || 3000;
var STATIC_DIR = path.join(__dirname, '..', 'docs');

var MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl'
};


var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

module.exports = { PORT: PORT, STATIC_DIR: STATIC_DIR, MIME: MIME, USER_AGENT: USER_AGENT };
