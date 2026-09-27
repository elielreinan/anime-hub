// /api/admin/* - only for accounts listed in ADMIN_EMAILS. Every action is audited.
var db = require('../lib/db');
var v = require('../lib/validate');
var auth = require('../lib/auth');
var shared = require('./shared');
var party = require('./party');
var health = require('./health');

var A = { auth: 'admin', limit: 'admin' };

async function targetPreview(type, id) {
  var n = v.int(id, 1, Number.MAX_SAFE_INTEGER);
  if (type === 'post' && n) { var p = (await db.query('SELECT p.text, p.hidden, u.public_id FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [n])).rows[0]; return p ? { text: p.text, hidden: p.hidden, author: p.public_id } : null; }
  if (type === 'comment' && n) { var k = (await db.query('SELECT k.text, k.hidden, u.public_id FROM comments k JOIN users u ON u.id = k.user_id WHERE k.id = $1', [n])).rows[0]; return k ? { text: k.text, hidden: k.hidden, author: k.public_id } : null; }
  if (type === 'user') { var u = (await db.query('SELECT name, public_id, banned_at FROM users WHERE public_id = $1', [id])).rows[0]; return u ? { text: u.name, author: u.public_id, hidden: !!u.banned_at } : null; }
  if (type === 'clan') { var c = (await db.query('SELECT name, description, hidden FROM clans WHERE public_id = $1', [id])).rows[0]; return c ? { text: c.name + ' — ' + c.description, hidden: c.hidden } : null; }
  if (type === 'review') {
    var parts = String(id).split(':');
    var r = (await db.query('SELECT r.text, r.hidden, u.public_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.anime_id = $1 AND r.ep = $2 AND u.public_id = $3', [parts[0], v.int(parts[1], 1, 100000) || 0, parts[2] || ''])).rows[0];
    return r ? { text: r.text, hidden: r.hidden, author: r.public_id } : null;
  }
  return null;
}

async function hideTarget(type, id) {
  var n = v.int(id, 1, Number.MAX_SAFE_INTEGER);
  if (type === 'post' && n) await db.query('UPDATE posts SET hidden = TRUE WHERE id = $1', [n]);
  else if (type === 'comment' && n) await db.query('UPDATE comments SET hidden = TRUE WHERE id = $1', [n]);
  else if (type === 'clan') await db.query('UPDATE clans SET hidden = TRUE WHERE public_id = $1', [id]);
  else if (type === 'review') {
    var parts = String(id).split(':');
    await db.query('UPDATE reviews r SET hidden = TRUE FROM users u WHERE u.id = r.user_id AND r.anime_id = $1 AND r.ep = $2 AND u.public_id = $3', [parts[0], v.int(parts[1], 1, 100000) || 0, parts[2] || '']);
  }
}

function register(add) {
  add('GET', '/api/admin/stats', A, async function() {
    var c = (await db.query(
      'SELECT (SELECT count(*) FROM users)::int AS users,' +
      " (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day')::int AS users_24h," +
      " (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS users_7d," +
      " (SELECT count(DISTINCT user_id) FROM sessions WHERE last_used_at > now() - interval '1 day')::int AS active_24h," +
      ' (SELECT count(*) FROM users WHERE banned_at IS NOT NULL)::int AS banned,' +
      ' (SELECT count(*) FROM posts)::int AS posts, (SELECT count(*) FROM comments)::int AS comments,' +
      ' (SELECT count(*) FROM reviews)::int AS reviews, (SELECT count(*) FROM clans)::int AS clans,' +
      ' (SELECT count(*) FROM watches)::int AS episodes_watched,' +
      ' (SELECT count(*) FROM reports WHERE resolved_at IS NULL)::int AS open_reports')).rows[0];
    c.parties = party.count();
    c.uptimeMin = Math.round(process.uptime() / 60);
    c.memoryMb = Math.round(process.memoryUsage().rss / 1048576);
    c.servers = health.snapshot().slice(0, 30);
    return c;
  });

  add('GET', '/api/admin/users', A, async function(ctx) {
    var q = String(ctx.query.get('q') || '').trim().slice(0, 100);
    var vals = [], where = 'TRUE';
    if (q) {
      vals.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%', q.replace(/^#/, '').toUpperCase());
      where = '(name ILIKE $1 OR email ILIKE $1 OR public_id = $2)';
    }
    var r = await db.query('SELECT * FROM users WHERE ' + where + ' ORDER BY created_at DESC LIMIT 50', vals);
    return { users: r.rows.map(function(u) {
      var c = shared.card(u);
      return Object.assign(c, { email: u.email, xp: u.xp, createdAt: u.created_at, lastLoginAt: u.last_login_at, banned: !!u.banned_at, banReason: u.ban_reason, admin: auth.isAdminEmail(u.email) });
    }) };
  });

  add('POST', '/api/admin/users/:id/ban', A, async function(ctx) {
    var u = (await db.query('SELECT * FROM users WHERE public_id = $1', [v.publicId(ctx.params.id) || '-'])).rows[0];
    if (!u) v.fail(404, 'Usuário não encontrado');
    if (auth.isAdminEmail(u.email)) v.fail(400, 'Não é possível suspender um administrador');
    if (ctx.body.unban) {
      await db.query('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = $1', [u.id]);
      auth.audit(ctx.req, ctx.user.id, 'unban', u.public_id);
      return { banned: false };
    }
    var reason = v.text(ctx.body.reason, 200, { emptyMessage: 'Informe o motivo' });
    await db.query('UPDATE users SET banned_at = now(), ban_reason = $1 WHERE id = $2', [reason, u.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    auth.audit(ctx.req, ctx.user.id, 'ban', u.public_id, { reason: reason });
    return { banned: true };
  });

  add('GET', '/api/admin/reports', A, async function(ctx) {
    var open = ctx.query.get('status') !== 'all';
    var r = await db.query(
      'SELECT r.target_type, r.target_id, count(*)::int AS reports, array_agg(r.reason ORDER BY r.created_at DESC) AS reasons, max(r.created_at) AS last_at' +
      ' FROM reports r ' + (open ? 'WHERE r.resolved_at IS NULL ' : '') +
      'GROUP BY r.target_type, r.target_id ORDER BY reports DESC, last_at DESC LIMIT 50');
    var out = [];
    for (var row of r.rows) {
      out.push({ type: row.target_type, id: row.target_id, reports: row.reports, reasons: (row.reasons || []).slice(0, 5), lastAt: row.last_at, target: await targetPreview(row.target_type, row.target_id) });
    }
    return { reports: out };
  });

  // action: dismiss (keep content) | hide (hide content) | ban (hide + suspend author)
  add('POST', '/api/admin/reports/resolve', A, async function(ctx) {
    var type = ctx.body.type, id = String(ctx.body.id || ''), action = ctx.body.action;
    if (['post', 'comment', 'review', 'user', 'clan'].indexOf(type) === -1 || !/^[A-Za-z0-9:_-]{1,80}$/.test(id)) v.fail(400, 'Denúncia inválida');
    if (['dismiss', 'hide', 'ban'].indexOf(action) === -1) v.fail(400, 'Ação inválida');
    if (action !== 'dismiss') await hideTarget(type, id);
    if (action === 'ban') {
      var preview = await targetPreview(type, id);
      var author = preview && preview.author;
      if (author) {
        var u = (await db.query('SELECT * FROM users WHERE public_id = $1', [author])).rows[0];
        if (u && !auth.isAdminEmail(u.email)) {
          await db.query("UPDATE users SET banned_at = now(), ban_reason = 'Violação das regras da comunidade' WHERE id = $1", [u.id]);
          await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
        }
      }
    }
    await db.query('UPDATE reports SET resolved_at = now(), resolved_by = $1 WHERE target_type = $2 AND target_id = $3 AND resolved_at IS NULL', [ctx.user.id, type, id]);
    auth.audit(ctx.req, ctx.user.id, 'report_' + action, type + ':' + id);
  });

  add('GET', '/api/admin/audit', A, async function() {
    var r = await db.query('SELECT a.action, a.target, a.ip, a.meta, a.created_at, u.public_id, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 150');
    return { entries: r.rows.map(function(e) { return { action: e.action, target: e.target, ip: e.ip, meta: e.meta, at: e.created_at, actor: e.public_id ? { publicId: e.public_id, name: e.name } : null }; }) };
  });
}

module.exports = { register: register };
