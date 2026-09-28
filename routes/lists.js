// /api/lists/* - public, shareable lists ("Meus 10 isekais favoritos").
var db = require('../lib/db');
var v = require('../lib/validate');
var auth = require('../lib/auth');
var shared = require('./shared');

var MAX_LISTS = 30, MAX_ITEMS = 50;

function cleanItems(raw) {
  if (!Array.isArray(raw)) v.fail(400, 'Itens inválidos');
  if (raw.length > MAX_ITEMS) v.fail(400, 'Uma lista pode ter até ' + MAX_ITEMS + ' animes');
  var seen = {}, out = [];
  raw.forEach(function(a) {
    var id = v.animeId(a && a.id);
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push({ id: id, title: String((a && a.title) || '').replace(/[\u0000-\u001F]/g, '').slice(0, 200), cover: v.imageUrl(a && a.cover) });
  });
  return out;
}

function listOut(l, owner) {
  return { publicId: l.public_id, title: l.title, description: l.description, items: l.items || [], count: (l.items || []).length,
    updatedAt: l.updated_at, owner: owner ? shared.card(owner) : undefined };
}

async function ownList(ctx) {
  var l = (await db.query('SELECT * FROM user_lists WHERE public_id = $1 AND user_id = $2', [v.publicId(ctx.params.id) || '-', ctx.user.id])).rows[0];
  if (!l) v.fail(404, 'Lista não encontrada');
  return l;
}

function register(add) {
  add('GET', '/api/lists/:id', {}, async function(ctx) {
    var r = (await db.query('SELECT l.*, u.public_id AS owner_pid, u.name, u.avatar, u.xp FROM user_lists l JOIN users u ON u.id = l.user_id WHERE l.public_id = $1 AND NOT l.hidden AND u.banned_at IS NULL',
      [v.publicId(ctx.params.id) || '-'])).rows[0];
    if (!r) v.fail(404, 'Lista não encontrada');
    return listOut(r, { public_id: r.owner_pid, name: r.name, avatar: r.avatar, xp: r.xp });
  });

  add('GET', '/api/users/:id/lists', {}, async function(ctx) {
    var r = await db.query('SELECT l.* FROM user_lists l JOIN users u ON u.id = l.user_id WHERE u.public_id = $1 AND u.public_profile AND NOT l.hidden AND u.banned_at IS NULL ORDER BY l.updated_at DESC LIMIT 30',
      [v.publicId(ctx.params.id) || '-']);
    return { lists: r.rows.map(function(l) { return listOut(l); }) };
  });

  add('GET', '/api/me/lists', { auth: true }, async function(ctx) {
    var r = await db.query('SELECT * FROM user_lists WHERE user_id = $1 ORDER BY updated_at DESC', [ctx.user.id]);
    return { lists: r.rows.map(function(l) { return listOut(l); }) };
  });

  add('POST', '/api/me/lists', { auth: true, limit: 'post', maxBody: 64 * 1024 }, async function(ctx) {
    var n = (await db.query('SELECT count(*)::int AS n FROM user_lists WHERE user_id = $1', [ctx.user.id])).rows[0].n;
    if (n >= MAX_LISTS) v.fail(400, 'Você já tem ' + MAX_LISTS + ' listas');
    var title = v.text(ctx.body.title, 80, { emptyMessage: 'Dê um título à lista' });
    var description = v.text(ctx.body.description, 300, { optional: true, multiline: true });
    var items = cleanItems(ctx.body.items);
    if (!items.length) v.fail(400, 'Escolha pelo menos um anime');
    var l = (await db.query('INSERT INTO user_lists (public_id, user_id, title, description, items) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [auth.randomId(6), ctx.user.id, title, description, JSON.stringify(items)])).rows[0];
    return { list: listOut(l) };
  });

  add('PUT', '/api/me/lists/:id', { auth: true, maxBody: 64 * 1024 }, async function(ctx) {
    var l = await ownList(ctx);
    var title = v.text(ctx.body.title, 80, { emptyMessage: 'Dê um título à lista' });
    var description = v.text(ctx.body.description, 300, { optional: true, multiline: true });
    var items = cleanItems(ctx.body.items);
    var r = (await db.query('UPDATE user_lists SET title = $1, description = $2, items = $3, updated_at = now() WHERE id = $4 RETURNING *',
      [title, description, JSON.stringify(items), l.id])).rows[0];
    return { list: listOut(r) };
  });

  add('DELETE', '/api/me/lists/:id', { auth: true }, async function(ctx) {
    var l = await ownList(ctx);
    await db.query('DELETE FROM user_lists WHERE id = $1', [l.id]);
  });
}

module.exports = { register: register };
