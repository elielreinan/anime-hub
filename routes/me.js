// /api/me/* and /api/feed - the signed-in user's own account.
var db = require('../lib/db');
var auth = require('../lib/auth');
var v = require('../lib/validate');
var xp = require('../lib/xp');
var shared = require('./shared');
var party = require('./party');

var MAX_DATA_BYTES = 512 * 1024;
var INVITE_TTL_MS = 10 * 60 * 1000;
var inbox = {}; // user id -> [{ from, fromId, avatar, code, title, at }]

setInterval(function() {
  var now = Date.now();
  Object.keys(inbox).forEach(function(k) {
    inbox[k] = inbox[k].filter(function(i) { return now - i.at < INVITE_TTL_MS; });
    if (!inbox[k].length) delete inbox[k];
  });
}, 5 * 60 * 1000).unref();

async function userByPublicId(id) {
  var pid = v.publicId(id);
  if (!pid) v.fail(400, 'ID inválido');
  var u = (await db.query('SELECT * FROM users WHERE public_id = $1 AND banned_at IS NULL', [pid])).rows[0];
  if (!u) v.fail(404, 'Ninguém com esse ID');
  return u;
}

// One feed line per show per few hours instead of one per episode.
async function addActivity(userId, type, a, extra) {
  if (type === 'watched') {
    var recent = (await db.query("SELECT id FROM activities WHERE user_id = $1 AND type = 'watched' AND anime_id = $2 AND created_at > now() - interval '3 hours' ORDER BY created_at DESC LIMIT 1", [userId, a.animeId])).rows[0];
    if (recent) {
      await db.query("UPDATE activities SET ep = $1, created_at = now(), extra = jsonb_set(COALESCE(extra, '{}'), '{count}', to_jsonb(COALESCE((extra->>'count')::int, 1) + 1)) WHERE id = $2", [a.ep, recent.id]);
      return;
    }
  }
  await db.query('INSERT INTO activities (user_id, type, anime_id, title, cover, ep, extra) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, type, a.animeId || null, a.title || null, a.cover || null, a.ep || null, extra ? JSON.stringify(extra) : null]);
}

function animeFromBody(b, needEp) {
  var a = { animeId: v.animeId(b.animeId), title: v.text(b.title, 200), cover: v.imageUrl(b.cover), ep: v.int(b.ep, 1, 100000) };
  if (!a.animeId) v.fail(400, 'Anime inválido');
  if (needEp && !a.ep) v.fail(400, 'Episódio inválido');
  return a;
}

function register(add) {
  add('GET', '/api/me', { auth: true }, async function(ctx) {
    var u = ctx.user;
    return { user: shared.me(u), data: u.data || {}, dataUpdatedAt: u.data_updated_at, level: xp.levelInfo(u.xp) };
  });

  add('PATCH', '/api/me', { auth: true }, async function(ctx) {
    var b = ctx.body, sets = [], vals = [];
    function set(col, val) { vals.push(val); sets.push(col + ' = $' + vals.length); }
    if (b.name !== undefined) { var name = v.name(b.name); if (!name) v.fail(400, 'O nome precisa ter de 2 a 30 caracteres'); set('name', name); }
    if (b.avatar !== undefined) { if (shared.AVATARS.indexOf(b.avatar) === -1) v.fail(400, 'Avatar inválido'); set('avatar', b.avatar); }
    if (b.publicProfile !== undefined) set('public_profile', !!b.publicProfile);
    if (!sets.length) return { user: shared.me(ctx.user) };
    vals.push(ctx.user.id);
    var u = (await db.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING *', vals)).rows[0];
    u.role = ctx.user.role;
    return { user: shared.me(u) };
  });

  add('PUT', '/api/me/data', { auth: true, maxBody: MAX_DATA_BYTES }, async function(ctx) {
    var data = ctx.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1) v.fail(400, 'Dados inválidos');
    var r = await db.query('UPDATE users SET data = $1, data_updated_at = now() WHERE id = $2 RETURNING data_updated_at', [JSON.stringify(data), ctx.user.id]);
    return { ok: true, dataUpdatedAt: r.rows[0].data_updated_at };
  });

  add('POST', '/api/me/watching', { auth: true }, async function(ctx) {
    var b = ctx.body, w = null;
    if (b.title) {
      var a = animeFromBody(b, false);
      w = { animeId: a.animeId, title: a.title, cover: a.cover, ep: a.ep || 0, at: Date.now() };
    }
    await db.query('UPDATE users SET watching = $1 WHERE id = $2', [w && JSON.stringify(w), ctx.user.id]);
  });

  // An episode watched to the end (>= 90%). Counts once per episode.
  add('POST', '/api/me/watched', { auth: true }, async function(ctx) {
    var a = animeFromBody(ctx.body, true);
    var r = await db.query('INSERT INTO watches (user_id, anime_id, ep, title, cover) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING ep',
      [ctx.user.id, a.animeId, a.ep, a.title, a.cover]);
    if (r.rows.length) await addActivity(ctx.user.id, 'watched', a);
    return { counted: !!r.rows.length, level: await xp.refresh(ctx.user.id) };
  });

  // Feed events the client knows about: finished a show, added a favorite.
  add('POST', '/api/me/activity', { auth: true }, async function(ctx) {
    var type = ctx.body.type;
    if (['completed', 'favorited'].indexOf(type) === -1) v.fail(400, 'Tipo inválido');
    var a = animeFromBody(ctx.body, false);
    var dup = (await db.query('SELECT 1 FROM activities WHERE user_id = $1 AND type = $2 AND anime_id = $3', [ctx.user.id, type, a.animeId])).rows.length;
    if (!dup) await addActivity(ctx.user.id, type, a);
    return { level: await xp.refresh(ctx.user.id) };
  });

  add('GET', '/api/me/level', { auth: true }, async function(ctx) {
    return xp.refresh(ctx.user.id);
  });

  // ── Friends ──
  add('GET', '/api/me/friends', { auth: true }, async function(ctx) {
    var r = await db.query('SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 AND u.banned_at IS NULL ORDER BY u.name', [ctx.user.id]);
    return { friends: r.rows.map(function(f) {
      var c = shared.card(f);
      c.watching = f.public_profile ? shared.freshWatching(f) : null;
      return c;
    }) };
  });

  add('POST', '/api/me/friends', { auth: true }, async function(ctx) {
    var f = await userByPublicId(ctx.body.publicId);
    if (f.id === ctx.user.id) v.fail(400, 'Esse é o seu próprio ID');
    var count = (await db.query('SELECT count(*)::int AS n FROM friends WHERE user_id = $1', [ctx.user.id])).rows[0].n;
    if (count >= 500) v.fail(400, 'Limite de amigos atingido');
    // Friendship goes both ways: whoever has your ID can add you.
    await db.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [ctx.user.id, f.id]);
    return { friend: shared.card(f) };
  });

  add('DELETE', '/api/me/friends/:id', { auth: true }, async function(ctx) {
    var f = await userByPublicId(ctx.params.id);
    await db.query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [ctx.user.id, f.id]);
  });

  // ── Watch party invites by ID ──
  add('POST', '/api/me/invite', { auth: true, limit: 'invite' }, async function(ctx) {
    var code = String(ctx.body.code || '').toUpperCase();
    var p = /^[A-Z0-9]{6}$/.test(code) && party.getParty(code);
    if (!p) v.fail(404, 'Sala não encontrada');
    var f = await userByPublicId(ctx.body.publicId);
    if (f.id === ctx.user.id) v.fail(400, 'Esse é o seu próprio ID');
    var list = inbox[f.id] = (inbox[f.id] || []).filter(function(i) { return !(i.fromId === ctx.user.public_id && i.code === code); });
    list.push({ from: ctx.user.name, fromId: ctx.user.public_id, avatar: ctx.user.avatar, code: code, title: p.state.title || '', at: Date.now() });
    if (list.length > 20) list.shift();
    return { ok: true, name: f.name };
  });

  add('GET', '/api/me/inbox', { auth: true }, async function(ctx) {
    var items = (inbox[ctx.user.id] || []).filter(function(i) { return Date.now() - i.at < INVITE_TTL_MS; });
    delete inbox[ctx.user.id];
    return { invites: items };
  });

  // ── Friends' activity ──
  add('GET', '/api/feed', { auth: true }, async function(ctx) {
    var r = await db.query(
      'SELECT a.*, u.public_id, u.name, u.avatar, u.xp FROM activities a JOIN users u ON u.id = a.user_id' +
      ' WHERE (a.user_id = $1 OR a.user_id IN (SELECT friend_id FROM friends WHERE user_id = $1))' +
      '   AND u.banned_at IS NULL AND (u.public_profile OR u.id = $1)' +
      ' ORDER BY a.created_at DESC LIMIT 60', [ctx.user.id]);
    return { items: r.rows.map(function(a) {
      return { id: +a.id, type: a.type, animeId: a.anime_id, title: a.title, cover: a.cover, ep: a.ep, extra: a.extra, at: a.created_at, user: shared.card(a), mine: a.public_id === ctx.user.public_id };
    }) };
  });

  // ── LGPD: everything we store about you, and deleting it ──
  add('GET', '/api/me/export', { auth: true, limit: 'auth' }, async function(ctx) {
    var id = ctx.user.id, q = function(sql) { return db.query(sql, [id]).then(function(r) { return r.rows; }); };
    var u = Object.assign({}, ctx.user);
    delete u.password_hash;
    auth.audit(ctx.req, id, 'export');
    return {
      exportedAt: new Date().toISOString(), account: u,
      sessions: await q('SELECT created_at, last_used_at, expires_at, user_agent FROM sessions WHERE user_id = $1'),
      friends: await q('SELECT u.public_id, u.name, f.created_at FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1'),
      watched: await q('SELECT anime_id, ep, title, watched_at FROM watches WHERE user_id = $1 ORDER BY watched_at'),
      activities: await q('SELECT type, anime_id, title, ep, created_at FROM activities WHERE user_id = $1 ORDER BY created_at'),
      reviews: await q('SELECT anime_id, ep, rating, text, created_at FROM reviews WHERE user_id = $1'),
      posts: await q('SELECT id, text, anime_title, created_at FROM posts WHERE user_id = $1'),
      comments: await q('SELECT post_id, text, created_at FROM comments WHERE user_id = $1'),
      clan: await q('SELECT c.name, m.role, m.joined_at FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = $1')
    };
  });

  add('DELETE', '/api/me/account', { auth: true, limit: 'auth' }, async function(ctx) {
    var u = ctx.user;
    if (u.password_hash) {
      if (!(await auth.checkPassword(String(ctx.body.password || ''), u.password_hash))) v.fail(401, 'Senha incorreta');
    } else if (ctx.body.confirm !== 'EXCLUIR') {
      v.fail(400, 'Digite EXCLUIR para confirmar');
    }
    await db.tx(async function(c) {
      // Clans they own go to the oldest remaining member, or away if empty.
      var owned = (await c.query("SELECT clan_id FROM clan_members WHERE user_id = $1 AND role = 'owner'", [u.id])).rows;
      for (var o of owned) {
        var heir = (await c.query('SELECT user_id FROM clan_members WHERE clan_id = $1 AND user_id <> $2 ORDER BY (role = \'mod\') DESC, joined_at LIMIT 1', [o.clan_id, u.id])).rows[0];
        if (heir) {
          await c.query("UPDATE clan_members SET role = 'owner' WHERE clan_id = $1 AND user_id = $2", [o.clan_id, heir.user_id]);
          await c.query('UPDATE clans SET owner_id = $1 WHERE id = $2', [heir.user_id, o.clan_id]);
        } else {
          await c.query('DELETE FROM clans WHERE id = $1', [o.clan_id]);
        }
      }
      await c.query('DELETE FROM users WHERE id = $1', [u.id]);
    });
    auth.audit(ctx.req, null, 'account_deleted', u.public_id);
  });
}

module.exports = { register: register };
