// /api/feedback - suggestions and bug reports from the app; read by admins.
var db = require('../lib/db');
var v = require('../lib/validate');
var auth = require('../lib/auth');
var clientIp = require('../lib/http').clientIp;

var KINDS = ['bug', 'idea', 'other'];

function register(add) {
  add('POST', '/api/feedback', { optionalAuth: true, limit: 'feedback', maxBody: 8192 }, async function(ctx) {
    var kind = KINDS.indexOf(ctx.body.kind) === -1 ? 'other' : ctx.body.kind;
    var text = v.text(ctx.body.text, 2000, { multiline: true, emptyMessage: 'Escreva sua mensagem' });
    if (text.length < 5) v.fail(400, 'Conte um pouco mais (mín. 5 caracteres)');
    var contact = v.text(ctx.body.contact, 120, { optional: true });
    // Only what helps reproduce a bug: app version / screen size, never full fingerprints.
    var client = v.text(ctx.body.client, 200, { optional: true });
    // The IP is kept only as a hash, to spot floods from one place.
    await db.query('INSERT INTO feedback (user_id, kind, text, contact, client, ip_hash) VALUES ($1, $2, $3, $4, $5, $6)',
      [ctx.user ? ctx.user.id : null, kind, text, contact, client, auth.sha256('fb|' + clientIp(ctx.req)).slice(0, 16)]);
    return { ok: true };
  });

  add('GET', '/api/admin/feedback', { auth: 'admin', limit: 'admin' }, async function(ctx) {
    var all = ctx.query.get('status') === 'all';
    var r = await db.query('SELECT f.id, f.kind, f.text, f.contact, f.client, f.done_at, f.created_at, u.public_id, u.name FROM feedback f LEFT JOIN users u ON u.id = f.user_id' +
      (all ? '' : ' WHERE f.done_at IS NULL') + ' ORDER BY f.created_at DESC LIMIT 100');
    return { items: r.rows.map(function(f) {
      return { id: String(f.id), kind: f.kind, text: f.text, contact: f.contact, client: f.client, done: !!f.done_at, at: f.created_at, author: f.public_id ? { publicId: f.public_id, name: f.name } : null };
    }) };
  });

  add('POST', '/api/admin/feedback/:id/done', { auth: 'admin', limit: 'admin' }, async function(ctx) {
    var id = v.int(ctx.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) v.fail(400, 'Feedback inválido');
    await db.query('UPDATE feedback SET done_at = now() WHERE id = $1', [id]);
    auth.audit(ctx.req, ctx.user.id, 'feedback_done', String(id));
  });
}

module.exports = { register: register };
