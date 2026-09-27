// /api/users/:id (public profile) and /api/rankings/*.
var db = require('../lib/db');
var v = require('../lib/validate');
var xp = require('../lib/xp');
var shared = require('./shared');

function listSummary(data) {
  var out = {}, lists = (data && data.lists) || {};
  ['Assistindo', 'Favoritos', 'Completados', 'Quero Assistir'].forEach(function(name) {
    var arr = Array.isArray(lists[name]) ? lists[name] : [];
    out[name] = arr.slice(0, 60).map(function(a) {
      return { id: v.animeId(a && a.id) || '', title: String((a && (a.title || a.category_name)) || '').slice(0, 200), cover: v.imageUrl(a && (a.cover || a.category_image)) };
    }).filter(function(a) { return a.id; });
  });
  return out;
}

function register(add) {
  add('GET', '/api/users/:id', { optionalAuth: true }, async function(ctx) {
    var pid = v.publicId(ctx.params.id);
    if (!pid) v.fail(404, 'Usuário não encontrado');
    var u = (await db.query('SELECT * FROM users WHERE public_id = $1 AND banned_at IS NULL', [pid])).rows[0];
    if (!u) v.fail(404, 'Usuário não encontrado');
    var viewer = ctx.user, isMe = !!viewer && viewer.id === u.id;
    var out = shared.card(u);
    out.createdAt = u.created_at;
    out.private = !u.public_profile;
    out.isMe = isMe;
    var clan = (await db.query('SELECT c.*, m.role FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = $1 AND NOT c.hidden', [u.id])).rows[0];
    out.clan = clan ? Object.assign(shared.clanCard(clan), { role: clan.role }) : null;
    if (viewer && !isMe) out.isFriend = !!(await db.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [viewer.id, u.id])).rows.length;
    if (u.public_profile || isMe) {
      out.lists = listSummary(u.data);
      out.watching = shared.freshWatching(u);
      out.progress = xp.profile(await xp.stats(u.id), u.xp);
      out.recent = (await db.query('SELECT type, anime_id, title, cover, ep, created_at FROM activities WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [u.id])).rows
        .map(function(a) { return { type: a.type, animeId: a.anime_id, title: a.title, cover: a.cover, ep: a.ep, at: a.created_at }; });
    }
    return out;
  });

  add('GET', '/api/rankings/users', {}, async function() {
    var r = await db.query('SELECT * FROM users WHERE public_profile AND banned_at IS NULL AND xp > 0 ORDER BY xp DESC, created_at LIMIT 50');
    return { users: r.rows.map(function(u) { var c = shared.card(u); c.xp = u.xp; return c; }) };
  });

  add('GET', '/api/rankings/clans', {}, async function() {
    var r = await db.query(
      'SELECT c.*, count(m.user_id) AS members, COALESCE(sum(u.xp), 0) AS xp FROM clans c' +
      ' JOIN clan_members m ON m.clan_id = c.id JOIN users u ON u.id = m.user_id AND u.banned_at IS NULL' +
      ' WHERE NOT c.hidden GROUP BY c.id ORDER BY xp DESC, members DESC LIMIT 30');
    return { clans: r.rows.map(shared.clanCard) };
  });
}

module.exports = { register: register };
