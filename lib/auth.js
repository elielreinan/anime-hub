// ── Passwords, sessions, lockout, audit ─────────────────────────────────────
var crypto = require('crypto');
var db = require('./db');
var clientIp = require('./http').clientIp;

var SESSION_DAYS = 90;
var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(function(e) { return e.trim(); }).filter(Boolean);

var SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  return new Promise(function(resolve, reject) {
    var salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, SCRYPT, function(err, key) {
      if (err) return reject(err);
      resolve('scrypt$' + salt.toString('base64') + '$' + key.toString('base64'));
    });
  });
}

var DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
function checkPassword(password, stored) {
  return new Promise(function(resolve) {
    var parts = String(stored || DUMMY_HASH).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    var expected = Buffer.from(parts[2], 'base64');
    crypto.scrypt(String(password), Buffer.from(parts[1], 'base64'), expected.length, SCRYPT, function(err, key) {
      resolve(!err && stored != null && crypto.timingSafeEqual(key, expected));
    });
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function randomId(len) {
  var id = '';
  for (var i = 0; i < len; i++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return id;
}

async function newSession(user, req, days) {
  var token = crypto.randomBytes(32).toString('base64url');
  await db.query("INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    [sha256(token), user.id, String(req.headers['user-agent'] || '').slice(0, 200), days || SESSION_DAYS]);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return token;
}

function bearer(req) {
  var m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  return m ? m[1] : null;
}

// The signed-in user row, or null. Sessions of banned users don't count.
async function currentUser(req) {
  var token = bearer(req);
  if (!token) return null;
  var r = await db.query('UPDATE sessions SET last_used_at = now() WHERE token_hash = $1 AND expires_at > now() RETURNING user_id', [sha256(token)]);
  if (!r.rows.length) return null;
  var u = (await db.query('SELECT * FROM users WHERE id = $1', [r.rows[0].user_id])).rows[0];
  if (!u || u.banned_at) return null;
  // Admins are whoever ADMIN_EMAILS lists, checked on every request.
  u.role = ADMIN_EMAILS.indexOf(u.email) !== -1 ? 'admin' : (u.role === 'admin' ? 'user' : u.role);
  return u;
}

function isAdminEmail(email) { return ADMIN_EMAILS.indexOf(String(email).toLowerCase()) !== -1; }

// ── Brute-force protection ──
// Per e-mail: 5 wrong passwords in 15 minutes lock that e-mail for 15 minutes.
// Per IP the route itself is rate limited.
var failures = {};
var LOCK_WINDOW = 15 * 60 * 1000, LOCK_AFTER = 5;

function lockedFor(email) {
  var f = failures[email];
  if (!f) return 0;
  if (Date.now() - f.first > LOCK_WINDOW) { delete failures[email]; return 0; }
  return f.count >= LOCK_AFTER ? Math.ceil((f.first + LOCK_WINDOW - Date.now()) / 60000) : 0;
}
function recordFailure(email) {
  var f = failures[email];
  if (!f || Date.now() - f.first > LOCK_WINDOW) f = failures[email] = { first: Date.now(), count: 0 };
  f.count++;
}
function clearFailures(email) { delete failures[email]; }
setInterval(function() {
  var now = Date.now();
  Object.keys(failures).forEach(function(k) { if (now - failures[k].first > LOCK_WINDOW) delete failures[k]; });
}, 10 * 60 * 1000).unref();

function audit(req, actorId, action, target, meta) {
  return db.query('INSERT INTO audit_log (actor_id, action, target, ip, meta) VALUES ($1, $2, $3, $4, $5)',
    [actorId || null, action, target == null ? null : String(target).slice(0, 200), req ? clientIp(req).slice(0, 64) : null, meta ? JSON.stringify(meta) : null])
    .catch(function(e) { console.error('[audit]', e.message); });
}

module.exports = {
  hashPassword: hashPassword, checkPassword: checkPassword, sha256: sha256, randomId: randomId,
  newSession: newSession, bearer: bearer, currentUser: currentUser, isAdminEmail: isAdminEmail,
  lockedFor: lockedFor, recordFailure: recordFailure, clearFailures: clearFailures, audit: audit
};
