// /api/auth/* - sign up, sign in (password or Google), sign out, change password.
var db = require('../lib/db');
var auth = require('../lib/auth');
var v = require('../lib/validate');
var fetchUrl = require('../lib/net').fetchUrl;
var shared = require('./shared');

async function insertUser(fields, tries) {
  try {
    var r = await db.query(
      'INSERT INTO users (public_id, email, password_hash, google_sub, name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [auth.randomId(6), fields.email, fields.passwordHash || null, fields.googleSub || null, fields.name, auth.isAdminEmail(fields.email) ? 'admin' : 'user']);
    return r.rows[0];
  } catch (e) {
    // 23505 = unique violation: e-mail taken, or (rarely) the random public ID collided.
    if (e.code === '23505' && /public_id/.test(e.constraint || '') && (tries || 0) < 5) return insertUser(fields, (tries || 0) + 1);
    if (e.code === '23505') v.fail(409, 'Já existe uma conta com esse e-mail');
    throw e;
  }
}

async function signedIn(ctx, u, action) {
  if (u.banned_at) v.fail(403, 'Esta conta foi suspensa' + (u.ban_reason ? ': ' + u.ban_reason : ''));
  var token = await auth.newSession(u, ctx.req);
  auth.audit(ctx.req, u.id, action);
  u.role = auth.isAdminEmail(u.email) ? 'admin' : u.role;
  return { token: token, user: shared.me(u) };
}

// Google Identity Services ID token, checked by Google itself.
async function verifyGoogle(credential) {
  var clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) v.fail(503, 'Login com Google não está configurado');
  if (!/^[A-Za-z0-9._-]{100,4096}$/.test(String(credential || ''))) v.fail(400, 'Credencial inválida');
  var r = await fetchUrl('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), 2, 10000);
  if (r.status !== 200) v.fail(401, 'Não foi possível confirmar sua conta Google');
  var t = JSON.parse(r.body.toString());
  var validIssuer = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (t.aud !== clientId || !validIssuer || +t.exp * 1000 < Date.now() || String(t.email_verified) !== 'true' || !t.sub || !t.email) {
    v.fail(401, 'Não foi possível confirmar sua conta Google');
  }
  return t;
}

function register(add) {
  add('POST', '/api/auth/register', { limit: 'auth' }, async function(ctx) {
    var b = ctx.body;
    var email = v.email(b.email);
    if (!email) v.fail(400, 'E-mail inválido');
    var password = v.password(b.password, email);
    var name = v.name(b.name);
    if (!name) v.fail(400, 'O nome precisa ter de 2 a 30 caracteres');
    if (b.acceptTerms !== true) v.fail(400, 'Você precisa aceitar os termos de uso e a política de privacidade');
    var u = await insertUser({ email: email, passwordHash: await auth.hashPassword(password), name: name });
    return signedIn(ctx, u, 'register');
  });

  add('POST', '/api/auth/login', { limit: 'auth' }, async function(ctx) {
    var email = v.email(ctx.body.email);
    var password = String(ctx.body.password || '').slice(0, 200);
    if (!email || !password) v.fail(400, 'Informe e-mail e senha');
    var minutes = auth.lockedFor(email);
    if (minutes) v.fail(429, 'Muitas tentativas erradas. Tente de novo em ' + minutes + ' min.');
    var u = (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
    // Same work and the same answer whether or not the e-mail exists.
    var ok = await auth.checkPassword(password, u && u.password_hash);
    if (!u || !ok) {
      auth.recordFailure(email);
      if (u) auth.audit(ctx.req, u.id, 'login_failed');
      v.fail(401, u && !u.password_hash && u.google_sub ? 'Essa conta entra com o Google' : 'E-mail ou senha incorretos');
    }
    auth.clearFailures(email);
    return signedIn(ctx, u, 'login');
  });

  add('POST', '/api/auth/google', { limit: 'auth' }, async function(ctx) {
    var t = await verifyGoogle(ctx.body.credential);
    var email = v.email(t.email);
    if (!email) v.fail(400, 'E-mail inválido');
    var u = (await db.query('SELECT * FROM users WHERE google_sub = $1', [t.sub])).rows[0];
    if (!u) {
      // Google verified this e-mail; password sign-ups never were. So the Google owner takes
      // over: the old password and every session are dropped, in case someone else created
      // the account with this address. They can set a new password in settings.
      var byEmail = (await db.query('UPDATE users SET google_sub = $1, password_hash = NULL WHERE email = $2 AND google_sub IS NULL RETURNING *', [t.sub, email])).rows[0];
      if (byEmail) {
        u = byEmail;
        await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
        auth.audit(ctx.req, u.id, 'google_linked');
      }
    }
    if (!u) {
      if (ctx.body.acceptTerms !== true) v.fail(400, 'Aceite os termos de uso para criar sua conta', 'terms_required');
      u = await insertUser({ email: email, googleSub: t.sub, name: v.name(t.name) || email.split('@')[0].slice(0, 30) });
      return signedIn(ctx, u, 'register_google');
    }
    return signedIn(ctx, u, 'login_google');
  });

  add('POST', '/api/auth/logout', { auth: true }, async function(ctx) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [auth.sha256(auth.bearer(ctx.req))]);
  });

  add('POST', '/api/auth/logout-all', { auth: true }, async function(ctx) {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [ctx.user.id]);
    auth.audit(ctx.req, ctx.user.id, 'logout_all');
  });

  add('POST', '/api/auth/password', { auth: true, limit: 'auth' }, async function(ctx) {
    var u = ctx.user;
    if (u.password_hash && !(await auth.checkPassword(String(ctx.body.current || ''), u.password_hash))) v.fail(401, 'Senha atual incorreta');
    var next = v.password(ctx.body.password, u.email);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await auth.hashPassword(next), u.id]);
    // Every other device has to sign in again with the new password.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, auth.sha256(auth.bearer(ctx.req))]);
    auth.audit(ctx.req, u.id, 'password_changed');
  });
}

module.exports = { register: register };
