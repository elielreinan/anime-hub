// ── Security headers, CORS allowlist, server timeouts ──────────────────────

var DEFAULT_ORIGINS = [
  'https://elielreinan.github.io',
  'https://anime-hub-zz7f.onrender.com',
  'https://localhost',        // Android app (Capacitor)
  'capacitor://localhost'
];
var ALLOWED = (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS).map(function(o) { return o.trim(); });

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED.indexOf(origin) !== -1) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // local development
}

// Media proxies and the public catalog are read by <video>/hls.js from anywhere the
// app runs; everything else only answers the app's own origins.
var OPEN_PATHS = /^\/api\/(hls-proxy|embed-proxy|atv\/|status$)/;

function applyHeaders(req, res, pathname) {
  var origin = req.headers.origin;
  if (OPEN_PATHS.test(pathname)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (pathname.startsWith('/api/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    if (/^\/api\/(auth|me|admin|users|community|clans|reviews)/.test(pathname)) res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
}

// Slow or oversized requests must not tie up the single free instance.
function hardenServer(server) {
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
}

module.exports = { applyHeaders: applyHeaders, hardenServer: hardenServer, originAllowed: originAllowed };
