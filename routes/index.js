// ── API router for account-backed areas ─────────────────────────────────────
// Each module registers routes with add(method, path, opts, handler). The router
// takes care of: database availability, rate limits, sign-in/admin checks, JSON
// bodies, and turning thrown HttpErrors into responses (anything else is a 500
// that never leaks internals).
var h = require('../lib/http');
var db = require('../lib/db');
var auth = require('../lib/auth');
var v = require('../lib/validate');

var table = [];
var PREFIX = /^\/api\/((auth|me|users|feed|rankings|community|clans|reviews|reports|feedback|admin|health|lists)(\/|$)|status\/)/;
var WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];

function add(method, path, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  var keys = [];
  var re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, function(_, k) { keys.push(k); return '([^/]+)'; }) + '/?$');
  table.push({ method: method, re: re, keys: keys, opts: opts, fn: fn });
}

function handles(pathname) { return PREFIX.test(pathname); }

async function handle(req, res, urlObj) {
  var pathname = urlObj.pathname, route = null, params = {}, wrongMethod = false;
  for (var r of table) {
    var m = pathname.match(r.re);
    if (!m) continue;
    if (r.method !== req.method) { wrongMethod = true; continue; }
    route = r;
    r.keys.forEach(function(k, i) { try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = ''; } });
    break;
  }
  if (!route) return h.sendJSON(res, wrongMethod ? 405 : 404, { error: true, message: wrongMethod ? 'Método não suportado' : 'Não encontrado' });

  var opts = route.opts;
  if (opts.db !== false) {
    if (!db.enabled()) return h.sendJSON(res, 503, { error: true, code: 'accounts_off', message: 'Contas ainda não estão disponíveis' });
    try { await db.ready(); } catch (e) { return h.sendJSON(res, 503, { error: true, message: 'Banco de dados indisponível, tente em instantes' }); }
  }
  if (opts.limit && !h.allowRequest(req, res, opts.limit)) return;
  if (WRITE.indexOf(req.method) !== -1 && !h.allowRequest(req, res, 'write')) return;

  var ctx = { req: req, res: res, url: urlObj, query: urlObj.searchParams, params: params, user: null, body: {} };
  try {
    if (opts.auth || opts.optionalAuth) {
      ctx.user = await auth.currentUser(req);
      if (opts.auth && !ctx.user) v.fail(401, 'Entre na sua conta', 'signed_out');
      if (opts.auth === 'admin' && ctx.user.role !== 'admin') v.fail(403, 'Só para administradores');
    }
    if (WRITE.indexOf(req.method) !== -1) {
      ctx.body = await h.readJsonBody(req, opts.maxBody).catch(function() { v.fail(400, 'Dados inválidos'); });
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) ctx.body = {};
    }
    var out = await route.fn(ctx);
    if (!res.headersSent) h.sendJSON(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof v.HttpError) return h.sendJSON(res, e.status, { error: true, message: e.message, code: e.code });
    console.error('[API]', req.method, pathname, e && (e.stack || e.message));
    h.sendJSON(res, 500, { error: true, message: 'Erro no servidor, tente de novo' });
  }
}

['auth', 'me', 'users', 'community', 'clans', 'reviews', 'feedback', 'admin', 'health', 'lists'].forEach(function(name) { require('./' + name).register(add); });

module.exports = { handles: handles, handle: handle };
