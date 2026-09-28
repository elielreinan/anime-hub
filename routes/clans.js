// /api/clans/* - create, join, leave and run a clan. One clan per user, 50 members max.
var db = require('../lib/db');
var v = require('../lib/validate');
var auth = require('../lib/auth');
var xp = require('../lib/xp');
var shared = require('./shared');

var MAX_MEMBERS = 50;
// Weekly challenge: episodes the whole clan finished since Monday (UTC).
var WEEK_GOALS = [50, 150, 300];
var WEEK_START = "date_trunc('week', now())";

function weekChallenge(episodes) {
  var goal = WEEK_GOALS.find(function(g) { return episodes < g; }) || WEEK_GOALS[WEEK_GOALS.length - 1];
  return { episodes: episodes, goal: goal, tiers: WEEK_GOALS, done: WEEK_GOALS.filter(function(g) { return episodes >= g; }).length };
}

async function clanByPublicId(id) {
  var pid = v.publicId(id);
  var c = pid && (await db.query('SELECT * FROM clans WHERE public_id = $1 AND NOT hidden', [pid])).rows[0];
  if (!c) v.fail(404, 'Clã não encontrado');
  return c;
}

async function roleIn(clanId, userId) {
  var m = (await db.query('SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2', [clanId, userId])).rows[0];
  return m ? m.role : null;
}

function clanName(v0) {
  var n = v.text(v0, 24, { emptyMessage: 'Dê um nome ao clã' }).replace(/\s+/g, ' ');
  if (n.length < 3) v.fail(400, 'O nome precisa ter de 3 a 24 caracteres');
  return n;
}

function register(add) {
  add('GET', '/api/clans', { optionalAuth: true }, async function(ctx) {
    var q = String(ctx.query.get('q') || '').trim().slice(0, 24);
    var vals = [], where = 'NOT c.hidden';
    if (q) { vals.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); where += ' AND c.name ILIKE $1'; }
    var r = await db.query(
      'SELECT c.*, count(m.user_id) AS members, COALESCE(sum(u.xp), 0) AS xp FROM clans c' +
      ' LEFT JOIN clan_members m ON m.clan_id = c.id LEFT JOIN users u ON u.id = m.user_id' +
      ' WHERE ' + where + ' GROUP BY c.id ORDER BY xp DESC, members DESC, c.created_at LIMIT 50', vals);
    var mine = null;
    if (ctx.user) {
      var m = (await db.query('SELECT c.*, m.role FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = $1', [ctx.user.id])).rows[0];
      if (m) mine = Object.assign(shared.clanCard(m), { role: m.role });
    }
    return { clans: r.rows.map(shared.clanCard), mine: mine, emojis: shared.CLAN_EMOJIS, colors: shared.CLAN_COLORS };
  });

  add('POST', '/api/clans', { auth: true, limit: 'clan' }, async function(ctx) {
    var b = ctx.body;
    var name = clanName(b.name);
    var description = v.text(b.description, 200, { optional: true, multiline: false });
    var emoji = shared.CLAN_EMOJIS.indexOf(b.emoji) !== -1 ? b.emoji : shared.CLAN_EMOJIS[0];
    var color = shared.CLAN_COLORS.indexOf(b.color) !== -1 ? b.color : shared.CLAN_COLORS[0];
    var clan = await db.tx(async function(c) {
      if ((await c.query('SELECT 1 FROM clan_members WHERE user_id = $1', [ctx.user.id])).rows.length) v.fail(400, 'Saia do seu clã atual antes de criar outro');
      var row;
      try {
        row = (await c.query('INSERT INTO clans (public_id, name, description, emoji, color, owner_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [auth.randomId(6), name, description, emoji, color, ctx.user.id])).rows[0];
      } catch (e) {
        if (e.code === '23505') v.fail(409, 'Já existe um clã com esse nome');
        throw e;
      }
      await c.query("INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, 'owner')", [row.id, ctx.user.id]);
      return row;
    });
    auth.audit(ctx.req, ctx.user.id, 'clan_created', clan.public_id);
    xp.refresh(ctx.user.id).catch(function() {});
    return { clan: shared.clanCard(clan) };
  });

  add('GET', '/api/clans/:id', { optionalAuth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    var members = (await db.query('SELECT u.*, m.role, m.joined_at FROM clan_members m JOIN users u ON u.id = m.user_id WHERE m.clan_id = $1 AND u.banned_at IS NULL ORDER BY (m.role = \'owner\') DESC, (m.role = \'mod\') DESC, u.xp DESC', [c.id])).rows;
    var out = shared.clanCard(c);
    out.createdAt = c.created_at;
    out.members = members.length;
    out.xp = members.reduce(function(s, u) { return s + (u.xp || 0); }, 0);
    out.list = members.map(function(u) { var k = shared.card(u); k.role = u.role; k.xp = u.xp; return k; });
    out.myRole = ctx.user ? await roleIn(c.id, ctx.user.id) : null;
    out.inAnotherClan = !!ctx.user && !out.myRole && !!(await db.query('SELECT 1 FROM clan_members WHERE user_id = $1', [ctx.user.id])).rows.length;
    out.full = members.length >= MAX_MEMBERS;
    var week = (await db.query('SELECT u.public_id, count(w.*)::int AS n FROM clan_members m JOIN users u ON u.id = m.user_id LEFT JOIN watches w ON w.user_id = m.user_id AND w.watched_at >= ' + WEEK_START +
      ' WHERE m.clan_id = $1 GROUP BY u.public_id', [c.id])).rows;
    var byUser = {};
    week.forEach(function(r) { byUser[r.public_id] = r.n; });
    out.list.forEach(function(k) { k.week = byUser[k.publicId] || 0; });
    out.week = weekChallenge(week.reduce(function(s, r) { return s + r.n; }, 0));
    return out;
  });

  add('POST', '/api/clans/:id/join', { auth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    await db.tx(async function(t) {
      if ((await t.query('SELECT 1 FROM clan_members WHERE user_id = $1', [ctx.user.id])).rows.length) v.fail(400, 'Você já está em um clã');
      var n = (await t.query('SELECT count(*)::int AS n FROM clan_members WHERE clan_id = $1', [c.id])).rows[0].n;
      if (n >= MAX_MEMBERS) v.fail(400, 'O clã está cheio');
      await t.query('INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)', [c.id, ctx.user.id]);
    });
    xp.refresh(ctx.user.id).catch(function() {});
  });

  add('POST', '/api/clans/:id/leave', { auth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    var role = await roleIn(c.id, ctx.user.id);
    if (!role) v.fail(400, 'Você não está neste clã');
    await db.tx(async function(t) {
      await t.query('DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2', [c.id, ctx.user.id]);
      if (role === 'owner') {
        var heir = (await t.query("SELECT user_id FROM clan_members WHERE clan_id = $1 ORDER BY (role = 'mod') DESC, joined_at LIMIT 1", [c.id])).rows[0];
        if (heir) {
          await t.query("UPDATE clan_members SET role = 'owner' WHERE clan_id = $1 AND user_id = $2", [c.id, heir.user_id]);
          await t.query('UPDATE clans SET owner_id = $1 WHERE id = $2', [heir.user_id, c.id]);
        } else {
          await t.query('DELETE FROM clans WHERE id = $1', [c.id]);
        }
      }
    });
    xp.refresh(ctx.user.id).catch(function() {});
  });

  add('PATCH', '/api/clans/:id', { auth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    if ((await roleIn(c.id, ctx.user.id)) !== 'owner') v.fail(403, 'Só o líder pode editar o clã');
    var b = ctx.body, sets = [], vals = [];
    function set(col, val) { vals.push(val); sets.push(col + ' = $' + vals.length); }
    if (b.description !== undefined) set('description', v.text(b.description, 200, { optional: true }));
    if (b.emoji !== undefined && shared.CLAN_EMOJIS.indexOf(b.emoji) !== -1) set('emoji', b.emoji);
    if (b.color !== undefined && shared.CLAN_COLORS.indexOf(b.color) !== -1) set('color', b.color);
    if (!sets.length) return { clan: shared.clanCard(c) };
    vals.push(c.id);
    var row = (await db.query('UPDATE clans SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING *', vals)).rows[0];
    return { clan: shared.clanCard(row) };
  });

  // Owner: kick anyone but themselves, set roles. Mods: kick plain members.
  add('POST', '/api/clans/:id/members/:user', { auth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    var myRole = await roleIn(c.id, ctx.user.id);
    var target = (await db.query('SELECT u.id, m.role FROM users u JOIN clan_members m ON m.user_id = u.id AND m.clan_id = $1 WHERE u.public_id = $2', [c.id, v.publicId(ctx.params.user) || '-'])).rows[0];
    if (!target) v.fail(404, 'Essa pessoa não está no clã');
    var action = ctx.body.action;
    if (action === 'kick') {
      var allowed = target.id !== ctx.user.id && (myRole === 'owner' || (myRole === 'mod' && target.role === 'member'));
      if (!allowed) v.fail(403, 'Você não pode remover esta pessoa');
      await db.query('DELETE FROM clan_members WHERE clan_id = $1 AND user_id = $2', [c.id, target.id]);
      auth.audit(ctx.req, ctx.user.id, 'clan_kick', c.public_id, { user: target.id });
    } else if (action === 'mod' || action === 'member') {
      if (myRole !== 'owner' || target.id === ctx.user.id) v.fail(403, 'Só o líder pode mudar cargos');
      await db.query('UPDATE clan_members SET role = $1 WHERE clan_id = $2 AND user_id = $3', [action, c.id, target.id]);
    } else if (action === 'owner') {
      if (myRole !== 'owner' || target.id === ctx.user.id) v.fail(403, 'Só o líder pode passar a liderança');
      await db.tx(async function(t) {
        await t.query("UPDATE clan_members SET role = 'mod' WHERE clan_id = $1 AND user_id = $2", [c.id, ctx.user.id]);
        await t.query("UPDATE clan_members SET role = 'owner' WHERE clan_id = $1 AND user_id = $2", [c.id, target.id]);
        await t.query('UPDATE clans SET owner_id = $1 WHERE id = $2', [target.id, c.id]);
      });
      auth.audit(ctx.req, ctx.user.id, 'clan_transfer', c.public_id, { to: target.id });
    } else {
      v.fail(400, 'Ação inválida');
    }
  });

  add('DELETE', '/api/clans/:id', { auth: true }, async function(ctx) {
    var c = await clanByPublicId(ctx.params.id);
    var myRole = await roleIn(c.id, ctx.user.id);
    if (myRole !== 'owner' && ctx.user.role !== 'admin') v.fail(403, 'Só o líder pode apagar o clã');
    await db.query('DELETE FROM clans WHERE id = $1', [c.id]);
    auth.audit(ctx.req, ctx.user.id, 'clan_deleted', c.public_id);
  });
}

module.exports = { register: register };
