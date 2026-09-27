// /api/community/* - posts, likes, comments; /api/reports - flag abuse.
// Everything written by users is plain text (the app never renders it as HTML),
// length-limited, rate limited per IP, and hidden automatically after 3 reports.
var db = require('../lib/db');
var v = require('../lib/validate');
var auth = require('../lib/auth');
var xp = require('../lib/xp');
var shared = require('./shared');

var AUTO_HIDE_REPORTS = 3;

function postOut(p, viewer) {
  return {
    id: +p.id, text: p.text, animeId: p.anime_id, animeTitle: p.anime_title, at: p.created_at,
    author: shared.card(p), clan: p.clan_public_id ? { publicId: p.clan_public_id, name: p.clan_name, emoji: p.clan_emoji } : null,
    likes: +p.likes || 0, comments: +p.comments || 0, liked: !!p.liked,
    canDelete: !!viewer && (viewer.id === +p.user_id || viewer.role === 'admin' || !!p.viewer_clan_mod)
  };
}

var POST_SELECT =
  'SELECT p.*, u.public_id, u.name, u.avatar, u.xp, c.public_id AS clan_public_id, c.name AS clan_name, c.emoji AS clan_emoji,' +
  ' (SELECT count(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,' +
  ' (SELECT count(*) FROM comments k WHERE k.post_id = p.id AND NOT k.hidden) AS comments,' +
  ' EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,' +
  " EXISTS (SELECT 1 FROM clan_members cm WHERE cm.clan_id = p.clan_id AND cm.user_id = $1 AND cm.role IN ('owner', 'mod')) AS viewer_clan_mod" +
  ' FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN clans c ON c.id = p.clan_id';

async function visiblePost(id) {
  var pid = v.int(id, 1, Number.MAX_SAFE_INTEGER);
  var p = pid && (await db.query('SELECT p.* FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1 AND NOT p.hidden AND u.banned_at IS NULL', [pid])).rows[0];
  if (!p) v.fail(404, 'Publicação não encontrada');
  return p;
}

async function canModerateClanPost(user, post) {
  if (!post.clan_id) return false;
  return !!(await db.query("SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2 AND role IN ('owner', 'mod')", [post.clan_id, user.id])).rows.length;
}

function register(add) {
  // scope: all (public posts) | friends | clan=<publicId>
  add('GET', '/api/community/posts', { optionalAuth: true }, async function(ctx) {
    var viewerId = ctx.user ? ctx.user.id : 0;
    var where = ['NOT p.hidden', 'u.banned_at IS NULL'], vals = [viewerId];
    var before = v.int(ctx.query.get('before'), 1, Number.MAX_SAFE_INTEGER);
    if (before) { vals.push(before); where.push('p.id < $' + vals.length); }
    var clanId = ctx.query.get('clan'), scope = ctx.query.get('scope') || 'all';
    if (clanId) {
      vals.push(v.publicId(clanId) || '-'); where.push('c.public_id = $' + vals.length);
    } else if (scope === 'friends') {
      if (!ctx.user) v.fail(401, 'Entre na sua conta', 'signed_out');
      where.push('(p.user_id = $1 OR p.user_id IN (SELECT friend_id FROM friends WHERE user_id = $1))', 'p.clan_id IS NULL');
    } else {
      where.push('p.clan_id IS NULL');
    }
    var r = await db.query(POST_SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY p.id DESC LIMIT 20', vals);
    return { posts: r.rows.map(function(p) { return postOut(p, ctx.user); }) };
  });

  add('POST', '/api/community/posts', { auth: true, limit: 'post' }, async function(ctx) {
    var b = ctx.body;
    var text = v.text(b.text, 1000, { multiline: true });
    var animeId = b.animeId ? v.animeId(b.animeId) : null;
    var animeTitle = animeId ? v.text(b.animeTitle, 200, { optional: true }) : null;
    var clanId = null;
    if (b.clan) {
      var m = (await db.query('SELECT clan_id FROM clan_members WHERE user_id = $1', [ctx.user.id])).rows[0];
      if (!m) v.fail(400, 'Você não está em um clã');
      clanId = m.clan_id;
    }
    var p = (await db.query('INSERT INTO posts (user_id, clan_id, text, anime_id, anime_title) VALUES ($1, $2, $3, $4, $5) RETURNING id', [ctx.user.id, clanId, text, animeId, animeTitle])).rows[0];
    xp.refresh(ctx.user.id).catch(function() {});
    var full = (await db.query(POST_SELECT + ' WHERE p.id = $2', [ctx.user.id, p.id])).rows[0];
    return { post: postOut(full, ctx.user) };
  });

  add('DELETE', '/api/community/posts/:id', { auth: true }, async function(ctx) {
    var p = await visiblePost(ctx.params.id);
    var own = +p.user_id === ctx.user.id, admin = ctx.user.role === 'admin';
    if (!own && !admin && !(await canModerateClanPost(ctx.user, p))) v.fail(403, 'Você não pode apagar esta publicação');
    await db.query('DELETE FROM posts WHERE id = $1', [p.id]);
    if (!own) auth.audit(ctx.req, ctx.user.id, 'post_deleted', p.id, { author: +p.user_id });
  });

  add('POST', '/api/community/posts/:id/like', { auth: true }, async function(ctx) {
    var p = await visiblePost(ctx.params.id);
    var del = await db.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [p.id, ctx.user.id]);
    if (!del.rowCount) await db.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.id, ctx.user.id]);
    var n = (await db.query('SELECT count(*)::int AS n FROM post_likes WHERE post_id = $1', [p.id])).rows[0].n;
    return { liked: !del.rowCount, likes: n };
  });

  add('GET', '/api/community/posts/:id/comments', { optionalAuth: true }, async function(ctx) {
    var p = await visiblePost(ctx.params.id);
    var r = await db.query('SELECT k.*, u.public_id, u.name, u.avatar, u.xp FROM comments k JOIN users u ON u.id = k.user_id WHERE k.post_id = $1 AND NOT k.hidden AND u.banned_at IS NULL ORDER BY k.id LIMIT 200', [p.id]);
    return { comments: r.rows.map(function(k) {
      return { id: +k.id, text: k.text, at: k.created_at, author: shared.card(k), canDelete: !!ctx.user && (ctx.user.id === +k.user_id || ctx.user.role === 'admin' || ctx.user.id === +p.user_id) };
    }) };
  });

  add('POST', '/api/community/posts/:id/comments', { auth: true, limit: 'comment' }, async function(ctx) {
    var p = await visiblePost(ctx.params.id);
    var text = v.text(ctx.body.text, 500, { multiline: true });
    var k = (await db.query('INSERT INTO comments (post_id, user_id, text) VALUES ($1, $2, $3) RETURNING *', [p.id, ctx.user.id, text])).rows[0];
    return { comment: { id: +k.id, text: k.text, at: k.created_at, author: shared.card(ctx.user), canDelete: true } };
  });

  add('DELETE', '/api/community/comments/:id', { auth: true }, async function(ctx) {
    var id = v.int(ctx.params.id, 1, Number.MAX_SAFE_INTEGER);
    var k = id && (await db.query('SELECT k.*, p.user_id AS post_author FROM comments k JOIN posts p ON p.id = k.post_id WHERE k.id = $1', [id])).rows[0];
    if (!k) v.fail(404, 'Comentário não encontrado');
    if (+k.user_id !== ctx.user.id && +k.post_author !== ctx.user.id && ctx.user.role !== 'admin') v.fail(403, 'Você não pode apagar este comentário');
    await db.query('DELETE FROM comments WHERE id = $1', [id]);
  });

  // Reports: post | comment | review (id "animeId:ep:userPublicId") | user | clan
  add('POST', '/api/reports', { auth: true, limit: 'report' }, async function(ctx) {
    var type = ctx.body.type, id = String(ctx.body.id || '');
    if (['post', 'comment', 'review', 'user', 'clan'].indexOf(type) === -1 || !/^[A-Za-z0-9:_-]{1,80}$/.test(id)) v.fail(400, 'Denúncia inválida');
    var reason = v.text(ctx.body.reason, 300, { emptyMessage: 'Diga o motivo da denúncia' });
    var r = await db.query('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id', [ctx.user.id, type, id, reason]);
    if (r.rows.length && (type === 'post' || type === 'comment')) {
      var n = (await db.query('SELECT count(*)::int AS n FROM reports WHERE target_type = $1 AND target_id = $2 AND resolved_at IS NULL', [type, id])).rows[0].n;
      if (n >= AUTO_HIDE_REPORTS) {
        var idNum = v.int(id, 1, Number.MAX_SAFE_INTEGER);
        if (idNum) await db.query('UPDATE ' + (type === 'post' ? 'posts' : 'comments') + ' SET hidden = TRUE WHERE id = $1', [idNum]);
      }
    }
    return { ok: true };
  });
}

module.exports = { register: register };
