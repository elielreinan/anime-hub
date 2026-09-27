// ── Accounts ────────────────────────────────────────────────────────────────
// E-mail + password accounts in Postgres (DATABASE_URL, e.g. Neon). Each user has a
// short public ID used for their profile link, friends and party invites; e-mails are
// never shown to anyone. Without DATABASE_URL every route answers 503 and the app
// keeps working with data kept only in the browser.

var crypto = require('crypto');

var pool = null;
var ready = null;
var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var SESSION_DAYS = 90;
var WATCHING_FRESH_MS = 15 * 60 * 1000;
var INVITE_TTL_MS = 10 * 60 * 1000;
var MAX_DATA_BYTES = 512 * 1024;
var inbox = {}; // user id -> [{ from, fromId, code, title, at }]

var SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (' +
  '  id BIGSERIAL PRIMARY KEY,' +
  '  public_id TEXT UNIQUE NOT NULL,' +
  '  email TEXT UNIQUE NOT NULL,' +
  '  password_hash TEXT NOT NULL,' +
  '  name TEXT NOT NULL,' +
  '  data JSONB NOT NULL DEFAULT \'{}\',' +
  '  data_updated_at TIMESTAMPTZ,' +
  '  watching JSONB,' +
  '  public_profile BOOLEAN NOT NULL DEFAULT TRUE,' +
  '  created_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS sessions (' +
  '  token_hash TEXT PRIMARY KEY,' +
  '  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
  '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
  '  expires_at TIMESTAMPTZ NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)',
  'CREATE TABLE IF NOT EXISTS friends (' +
  '  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
  '  friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
  '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
  '  PRIMARY KEY (user_id, friend_id))'
];

function init() {
  if (!process.env.DATABASE_URL) {
    console.log('Accounts: disabled (no DATABASE_URL)');
    return;
  }
  var pg = require('pg');
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
  pool.on('error', function(err) { console.error('[DB] idle client error:', err.message); });
  ready = SCHEMA.reduce(function(p, sql) { return p.then(function() { return pool.query(sql); }); }, Promise.resolve())
    .then(function() { console.log('Accounts: database ready'); })
    .catch(function(err) { console.error('[DB] schema error:', err.message); ready = null; throw err; });
  ready.catch(function() {});
  setInterval(function() {
    pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(function() {});
    var now = Date.now();
    Object.keys(inbox).forEach(function(k) {
      inbox[k] = inbox[k].filter(function(i) { return now - i.at < INVITE_TTL_MS; });
      if (!inbox[k].length) delete inbox[k];
    });
  }, 60 * 60 * 1000).unref();
}

function enabled() { return !!pool; }

// ── Passwords and sessions ──

function hashPassword(password) {
  return new Promise(function(resolve, reject) {
    var salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, function(err, key) {
      if (err) return reject(err);
      resolve('scrypt$' + salt.toString('base64') + '$' + key.toString('base64'));
    });
  });
}

function checkPassword(password, stored) {
  return new Promise(function(resolve) {
    var parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    var expected = Buffer.from(parts[2], 'base64');
    crypto.scrypt(password, Buffer.from(parts[1], 'base64'), expected.length, { N: 16384, r: 8, p: 1 }, function(err, key) {
      resolve(!err && crypto.timingSafeEqual(key, expected));
    });
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function newSession(userId) {
  var token = crypto.randomBytes(32).toString('base64url');
  return pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '" + SESSION_DAYS + " days')",
    [sha256(token), userId]).then(function() { return token; });
}

function bearer(req) {
  var m = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

// The signed-in user row, or null.
function currentUser(req) {
  var token = bearer(req);
  if (!token) return Promise.resolve(null);
  return pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha256(token)])
    .then(function(r) { return r.rows[0] || null; });
}

function newPublicId() {
  var id = '';
  for (var i = 0; i < 6; i++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return id;
}

function insertUser(email, hash, name, tries) {
  return pool.query('INSERT INTO users (public_id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING *', [newPublicId(), email, hash, name])
    .then(function(r) { return r.rows[0]; }, function(err) {
      // 23505 = unique violation: the e-mail is taken, or (rarely) the random ID collided.
      if (err.code === '23505' && /public_id/.test(err.constraint || err.detail || '') && (tries || 0) < 5) return insertUser(email, hash, name, (tries || 0) + 1);
      throw err;
    });
}

// ── Shapes sent to the browser ──

function me(u) {
  return { publicId: u.public_id, name: u.name, email: u.email, publicProfile: u.public_profile, createdAt: u.created_at };
}

function freshWatching(u) {
  var w = u.watching;
  return w && w.at && Date.now() - w.at < WATCHING_FRESH_MS ? w : null;
}

function listSummary(data) {
  var out = {};
  var lists = (data && data.lists) || {};
  Object.keys(lists).forEach(function(name) {
    out[name] = (Array.isArray(lists[name]) ? lists[name] : []).slice(0, 60).map(function(a) {
      return { id: a.id, title: a.title, cover: a.cover };
    });
  });
  return out;
}

function publicProfile(u, viewer) {
  var p = { publicId: u.public_id, name: u.name, createdAt: u.created_at, private: !u.public_profile };
  if (u.public_profile || (viewer && viewer.id === u.id)) {
    p.lists = listSummary(u.data);
    p.watching = freshWatching(u);
  }
  return p;
}

// ── Validation ──

function cleanEmail(v) {
  var e = String(v || '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) ? e : null;
}

function cleanName(v) {
  var n = String(v || '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 30 ? n : null;
}

function cleanPublicId(v) {
  var id = String(v || '').replace(/^#/, '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(id) ? id : null;
}

// ── Routes ──
// h: { sendJSON, readJsonBody, allowRequest, isParty(code) -> party or null }

function handle(req, res, pathname, h) {
  if (!pool) return h.sendJSON(res, 503, { error: true, code: 'accounts_off', message: 'Contas ainda não estão disponíveis' });
  var fail = function(err) {
    console.error('[Accounts]', err && err.message);
    h.sendJSON(res, 500, { error: true, message: 'Erro no servidor, tente de novo' });
  };
  (ready || Promise.reject(new Error('database not ready'))).then(function() {
    return route(req, res, pathname, h);
  }).catch(fail);
}

function route(req, res, pathname, h) {
  var send = h.sendJSON;
  var parts = pathname.split('/').filter(Boolean); // ['api', 'auth'|'me'|'users', ...]
  var area = parts[1], sub = parts[2] || '', arg = parts[3] || '';

  if (area === 'auth' && req.method === 'POST' && (sub === 'register' || sub === 'login')) {
    if (!h.allowRequest(req, res, 'auth')) return;
    return h.readJsonBody(req).then(function(b) {
      var email = cleanEmail(b.email), password = String(b.password || '');
      if (!email) return send(res, 400, { error: true, message: 'E-mail inválido' });
      if (password.length < 8 || password.length > 200) return send(res, 400, { error: true, message: 'A senha precisa ter pelo menos 8 caracteres' });
      if (sub === 'register') {
        var name = cleanName(b.name);
        if (!name) return send(res, 400, { error: true, message: 'O nome precisa ter de 2 a 30 caracteres' });
        return hashPassword(password).then(function(hash) { return insertUser(email, hash, name); }).then(function(u) {
          return newSession(u.id).then(function(token) { send(res, 200, { token: token, user: me(u) }); });
        }, function(err) {
          if (err.code === '23505') return send(res, 409, { error: true, message: 'Já existe uma conta com esse e-mail' });
          throw err;
        });
      }
      return pool.query('SELECT * FROM users WHERE email = $1', [email]).then(function(r) {
        var u = r.rows[0];
        // Same work and answer whether or not the e-mail exists.
        return checkPassword(password, u ? u.password_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')).then(function(ok) {
          if (!u || !ok) return send(res, 401, { error: true, message: 'E-mail ou senha incorretos' });
          return newSession(u.id).then(function(token) { send(res, 200, { token: token, user: me(u) }); });
        });
      });
    }, function() { send(res, 400, { error: true, message: 'Dados inválidos' }); });
  }

  if (area === 'users' && sub && req.method === 'GET') {
    var pid = cleanPublicId(sub);
    if (!pid) return send(res, 404, { error: true, message: 'Usuário não encontrado' });
    return Promise.all([pool.query('SELECT * FROM users WHERE public_id = $1', [pid]), currentUser(req)]).then(function(r) {
      var u = r[0].rows[0], viewer = r[1];
      if (!u) return send(res, 404, { error: true, message: 'Usuário não encontrado' });
      var out = publicProfile(u, viewer);
      if (!viewer) return send(res, 200, out);
      return pool.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [viewer.id, u.id]).then(function(f) {
        out.isFriend = !!f.rows.length;
        out.isMe = viewer.id === u.id;
        send(res, 200, out);
      });
    });
  }

  if (area !== 'me' && !(area === 'auth' && sub === 'logout')) return send(res, 404, { error: true, message: 'Não encontrado' });

  return currentUser(req).then(function(u) {
    if (!u) return send(res, 401, { error: true, code: 'signed_out', message: 'Entre na sua conta' });

    if (area === 'auth' && sub === 'logout' && req.method === 'POST') {
      return pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(bearer(req))]).then(function() { send(res, 200, { ok: true }); });
    }

    if (!sub && req.method === 'GET') {
      return send(res, 200, { user: me(u), data: u.data || {}, dataUpdatedAt: u.data_updated_at });
    }

    if (!sub && req.method === 'PATCH') {
      return h.readJsonBody(req).then(function(b) {
        var sets = [], vals = [];
        if (b.name !== undefined) {
          var name = cleanName(b.name);
          if (!name) return send(res, 400, { error: true, message: 'O nome precisa ter de 2 a 30 caracteres' });
          vals.push(name); sets.push('name = $' + vals.length);
        }
        if (b.publicProfile !== undefined) { vals.push(!!b.publicProfile); sets.push('public_profile = $' + vals.length); }
        if (!sets.length) return send(res, 200, { user: me(u) });
        vals.push(u.id);
        return pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING *', vals)
          .then(function(r) { send(res, 200, { user: me(r.rows[0]) }); });
      });
    }

    if (sub === 'data' && req.method === 'PUT') {
      return h.readJsonBody(req, MAX_DATA_BYTES).then(function(b) {
        if (!b || typeof b.data !== 'object' || Array.isArray(b.data)) return send(res, 400, { error: true, message: 'Dados inválidos' });
        return pool.query('UPDATE users SET data = $1, data_updated_at = now() WHERE id = $2 RETURNING data_updated_at', [JSON.stringify(b.data), u.id])
          .then(function(r) { send(res, 200, { ok: true, dataUpdatedAt: r.rows[0].data_updated_at }); });
      }, function() { send(res, 413, { error: true, message: 'Dados grandes demais' }); });
    }

    if (sub === 'watching' && req.method === 'POST') {
      return h.readJsonBody(req).then(function(b) {
        var w = b && b.title ? {
          animeId: String(b.animeId || '').slice(0, 20), title: String(b.title).slice(0, 200),
          cover: String(b.cover || '').slice(0, 500), ep: +b.ep || 0, at: Date.now()
        } : null;
        return pool.query('UPDATE users SET watching = $1 WHERE id = $2', [w && JSON.stringify(w), u.id]).then(function() { send(res, 200, { ok: true }); });
      });
    }

    if (sub === 'friends' && req.method === 'GET') {
      return pool.query('SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.name', [u.id]).then(function(r) {
        send(res, 200, { friends: r.rows.map(function(f) {
          return { publicId: f.public_id, name: f.name, watching: f.public_profile ? freshWatching(f) : null };
        }) });
      });
    }

    if (sub === 'friends' && req.method === 'POST') {
      return h.readJsonBody(req).then(function(b) {
        var pid = cleanPublicId(b.publicId);
        if (!pid) return send(res, 400, { error: true, message: 'ID inválido' });
        return pool.query('SELECT * FROM users WHERE public_id = $1', [pid]).then(function(r) {
          var f = r.rows[0];
          if (!f) return send(res, 404, { error: true, message: 'Ninguém com esse ID' });
          if (f.id === u.id) return send(res, 400, { error: true, message: 'Esse é o seu próprio ID' });
          // Friendship goes both ways: whoever has your ID can add you.
          return pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [u.id, f.id])
            .then(function() { send(res, 200, { friend: { publicId: f.public_id, name: f.name } }); });
        });
      });
    }

    if (sub === 'friends' && arg && req.method === 'DELETE') {
      var fid = cleanPublicId(arg);
      return pool.query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = (SELECT id FROM users WHERE public_id = $2)) OR (friend_id = $1 AND user_id = (SELECT id FROM users WHERE public_id = $2))', [u.id, fid])
        .then(function() { send(res, 200, { ok: true }); });
    }

    if (sub === 'invite' && req.method === 'POST') {
      if (!h.allowRequest(req, res, 'invite')) return;
      return h.readJsonBody(req).then(function(b) {
        var pid = cleanPublicId(b.publicId), code = String(b.code || '').toUpperCase();
        var p = h.isParty(code);
        if (!pid) return send(res, 400, { error: true, message: 'ID inválido' });
        if (!p) return send(res, 404, { error: true, message: 'Sala não encontrada' });
        return pool.query('SELECT id, name FROM users WHERE public_id = $1', [pid]).then(function(r) {
          var f = r.rows[0];
          if (!f) return send(res, 404, { error: true, message: 'Ninguém com esse ID' });
          var list = inbox[f.id] = (inbox[f.id] || []).filter(function(i) { return !(i.fromId === u.public_id && i.code === code); });
          list.push({ from: u.name, fromId: u.public_id, code: code, title: p.state.title || '', at: Date.now() });
          if (list.length > 20) list.shift();
          send(res, 200, { ok: true, name: f.name });
        });
      });
    }

    if (sub === 'inbox' && req.method === 'GET') {
      var items = (inbox[u.id] || []).filter(function(i) { return Date.now() - i.at < INVITE_TTL_MS; });
      delete inbox[u.id];
      return send(res, 200, { invites: items });
    }

    if (sub === 'account' && req.method === 'DELETE') {
      return h.readJsonBody(req).then(function(b) {
        return checkPassword(String(b.password || ''), u.password_hash).then(function(ok) {
          if (!ok) return send(res, 401, { error: true, message: 'Senha incorreta' });
          return pool.query('DELETE FROM users WHERE id = $1', [u.id]).then(function() { send(res, 200, { ok: true }); });
        });
      });
    }

    send(res, 404, { error: true, message: 'Não encontrado' });
  });
}

module.exports = { init: init, enabled: enabled, handle: handle };
