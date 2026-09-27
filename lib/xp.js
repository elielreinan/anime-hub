// ── XP, levels and achievements ─────────────────────────────────────────────
// Everything is derived from what the database already knows, so it can't be
// inflated from the browser: finished episodes, completed shows, reviews, posts.
var db = require('./db');

var XP = { episode: 10, completed: 50, review: 5, post: 3 };

var LEVEL_TITLES = [[1, 'Iniciante'], [3, 'Weeb'], [6, 'Otaku'], [10, 'Senpai'], [15, 'Sensei'], [20, 'Lenda']];
function level(xp) { return Math.floor(Math.sqrt((xp || 0) / 50)) + 1; }
function levelTitle(lv) {
  var t = LEVEL_TITLES[0][1];
  LEVEL_TITLES.forEach(function(p) { if (lv >= p[0]) t = p[1]; });
  return t;
}
function levelInfo(xp) {
  var lv = level(xp);
  var cur = 50 * Math.pow(lv - 1, 2), next = 50 * Math.pow(lv, 2);
  return { xp: xp || 0, level: lv, title: levelTitle(lv), progress: Math.round(((xp - cur) / (next - cur)) * 100), next: next };
}

var ACHIEVEMENTS = [
  { id: 'first_ep', icon: '▶️', name: 'Primeiro episódio', desc: 'Assistiu um episódio até o fim', test: function(s) { return s.episodes >= 1; } },
  { id: 'ep_50', icon: '📺', name: 'Maratonista', desc: '50 episódios assistidos', test: function(s) { return s.episodes >= 50; } },
  { id: 'ep_250', icon: '🔥', name: 'Viciado', desc: '250 episódios assistidos', test: function(s) { return s.episodes >= 250; } },
  { id: 'ep_1000', icon: '👑', name: 'Lenda das maratonas', desc: '1000 episódios assistidos', test: function(s) { return s.episodes >= 1000; } },
  { id: 'done_1', icon: '✅', name: 'Missão cumprida', desc: 'Completou um anime', test: function(s) { return s.completed >= 1; } },
  { id: 'done_10', icon: '🏆', name: 'Colecionador', desc: 'Completou 10 animes', test: function(s) { return s.completed >= 10; } },
  { id: 'review_1', icon: '⭐', name: 'Crítico', desc: 'Avaliou um episódio', test: function(s) { return s.reviews >= 1; } },
  { id: 'review_25', icon: '🎬', name: 'Crítico de respeito', desc: 'Avaliou 25 episódios', test: function(s) { return s.reviews >= 25; } },
  { id: 'post_1', icon: '💬', name: 'Voz da comunidade', desc: 'Publicou na comunidade', test: function(s) { return s.posts >= 1; } },
  { id: 'friends_5', icon: '🤝', name: 'Enturmado', desc: '5 amigos', test: function(s) { return s.friends >= 5; } },
  { id: 'clan', icon: '⚔️', name: 'Membro de clã', desc: 'Entrou em um clã', test: function(s) { return s.clan; } },
  { id: 'clan_owner', icon: '🛡️', name: 'Líder', desc: 'Fundou um clã', test: function(s) { return s.clanOwner; } }
];

async function stats(userId) {
  var r = await db.query(
    'SELECT (SELECT count(*) FROM watches WHERE user_id = $1)::int AS episodes,' +
    ' (SELECT count(*) FROM reviews WHERE user_id = $1)::int AS reviews,' +
    ' (SELECT count(*) FROM posts WHERE user_id = $1 AND NOT hidden)::int AS posts,' +
    ' (SELECT count(*) FROM friends WHERE user_id = $1)::int AS friends,' +
    ' (SELECT role FROM clan_members WHERE user_id = $1) AS clan_role,' +
    " COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(u.data->'lists'->'Completados') = 'array' THEN u.data->'lists'->'Completados' ELSE '[]'::jsonb END), 0)::int AS completed" +
    ' FROM users u WHERE u.id = $1', [userId]);
  var s = r.rows[0] || {};
  return { episodes: s.episodes || 0, reviews: s.reviews || 0, posts: s.posts || 0, friends: s.friends || 0,
    completed: Math.min(s.completed || 0, 2000), clan: !!s.clan_role, clanOwner: s.clan_role === 'owner' };
}

function xpFrom(s) { return s.episodes * XP.episode + s.completed * XP.completed + s.reviews * XP.review + s.posts * XP.post; }

// Recomputes and stores a user's XP; returns { stats, xp, level..., achievements }.
async function refresh(userId) {
  var s = await stats(userId);
  var xp = xpFrom(s);
  await db.query('UPDATE users SET xp = $1 WHERE id = $2', [xp, userId]);
  return profile(s, xp);
}

function profile(s, xp) {
  var info = levelInfo(xp);
  info.stats = s;
  info.achievements = ACHIEVEMENTS.map(function(a) { return { id: a.id, icon: a.icon, name: a.name, desc: a.desc, unlocked: !!a.test(s) }; });
  return info;
}

module.exports = { refresh: refresh, stats: stats, levelInfo: levelInfo, xpFrom: xpFrom, profile: profile, ACHIEVEMENTS: ACHIEVEMENTS };
