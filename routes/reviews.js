// /api/reviews/:animeId/:ep - 1-5 star ratings with an optional comment, per episode.
var db = require('../lib/db');
var v = require('../lib/validate');
var xp = require('../lib/xp');
var shared = require('./shared');

function episodeParams(ctx) {
  var animeId = v.animeId(ctx.params.anime), ep = v.int(ctx.params.ep, 1, 100000);
  if (!animeId || !ep) v.fail(400, 'Episódio inválido');
  return { animeId: animeId, ep: ep };
}

function register(add) {
  add('GET', '/api/reviews/:anime/:ep', { optionalAuth: true }, async function(ctx) {
    var e = episodeParams(ctx), viewerId = ctx.user ? ctx.user.id : 0;
    var sum = (await db.query('SELECT count(*)::int AS n, COALESCE(avg(rating), 0)::float AS avg, array_agg(rating) AS ratings FROM reviews r JOIN users u ON u.id = r.user_id WHERE anime_id = $1 AND ep = $2 AND NOT r.hidden AND u.banned_at IS NULL', [e.animeId, e.ep])).rows[0];
    var dist = [0, 0, 0, 0, 0];
    (sum.ratings || []).forEach(function(r) { if (r) dist[r - 1]++; });
    var items = (await db.query(
      'SELECT r.*, u.public_id, u.name, u.avatar, u.xp, EXISTS (SELECT 1 FROM friends f WHERE f.user_id = $3 AND f.friend_id = r.user_id) AS friend' +
      " FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.anime_id = $1 AND r.ep = $2 AND NOT r.hidden AND u.banned_at IS NULL AND r.text <> ''" +
      ' ORDER BY friend DESC, r.updated_at DESC LIMIT 40', [e.animeId, e.ep, viewerId])).rows;
    var mine = viewerId ? (await db.query('SELECT rating, text, spoiler FROM reviews WHERE user_id = $1 AND anime_id = $2 AND ep = $3', [viewerId, e.animeId, e.ep])).rows[0] : null;
    return {
      count: sum.n, avg: Math.round(sum.avg * 10) / 10, dist: dist, mine: mine || null,
      items: items.map(function(r) { return { rating: r.rating, text: r.text, spoiler: !!r.spoiler, at: r.updated_at, friend: r.friend, author: shared.card(r), mine: +r.user_id === viewerId }; })
    };
  });

  add('PUT', '/api/reviews/:anime/:ep', { auth: true, limit: 'comment' }, async function(ctx) {
    var e = episodeParams(ctx);
    var rating = v.int(ctx.body.rating, 1, 5);
    if (!rating) v.fail(400, 'Escolha de 1 a 5 estrelas');
    var text = v.text(ctx.body.text, 500, { optional: true, multiline: true });
    var title = v.text(ctx.body.title, 200, { optional: true });
    var fresh = (await db.query(
      'INSERT INTO reviews (user_id, anime_id, ep, rating, text, spoiler) VALUES ($1, $2, $3, $4, $5, $6)' +
      ' ON CONFLICT (user_id, anime_id, ep) DO UPDATE SET rating = EXCLUDED.rating, text = EXCLUDED.text, spoiler = EXCLUDED.spoiler, updated_at = now(), hidden = FALSE RETURNING (xmax = 0) AS inserted',
      [ctx.user.id, e.animeId, e.ep, rating, text, ctx.body.spoiler === true])).rows[0].inserted;
    if (fresh && title) {
      await db.query('INSERT INTO activities (user_id, type, anime_id, title, ep, extra) VALUES ($1, $2, $3, $4, $5, $6)',
        [ctx.user.id, 'review', e.animeId, title, e.ep, JSON.stringify({ rating: rating })]);
    }
    return { level: await xp.refresh(ctx.user.id) };
  });

  add('DELETE', '/api/reviews/:anime/:ep', { auth: true }, async function(ctx) {
    var e = episodeParams(ctx);
    await db.query('DELETE FROM reviews WHERE user_id = $1 AND anime_id = $2 AND ep = $3', [ctx.user.id, e.animeId, e.ep]);
    xp.refresh(ctx.user.id).catch(function() {});
  });
}

module.exports = { register: register };
