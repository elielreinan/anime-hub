// ── Input validation ────────────────────────────────────────────────────────
var cleanText = require('./http').cleanText;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
function fail(status, message, code) { throw new HttpError(status, message, code); }

function email(v) {
  var e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) ? e : null;
}

function name(v) {
  var n = cleanText(v, 60).replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 30 ? n : null;
}

function publicId(v) {
  var id = String(v || '').replace(/^#/, '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(id) ? id : null;
}

// User-written text: required, trimmed, bounded, no control characters.
function text(v, max, opts) {
  opts = opts || {};
  var t = cleanText(v, max + 50, opts.multiline).replace(/\n{3,}/g, '\n\n').trim();
  if (!t && !opts.optional) fail(400, opts.emptyMessage || 'Escreva alguma coisa');
  if (t.length > max) fail(400, 'Texto grande demais (máx. ' + max + ' caracteres)');
  return t;
}

function animeId(v) {
  var id = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_-]{1,20}$/.test(id) ? id : null;
}

function int(v, min, max) {
  var n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Cover images: only plain https URLs, never javascript:/data: or odd schemes.
function imageUrl(v) {
  var s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  try { var u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : ''; } catch (e) { return ''; }
}

var COMMON_PASSWORDS = ['12345678', '123456789', '1234567890', 'password', 'password1', 'senha123', 'senha1234', 'qwerty123', '11111111', '00000000', 'abc12345', 'anime123', 'naruto123', 'iloveyou', '87654321', 'asdfghjk', 'qwertyui'];
function password(v, userEmail) {
  var p = String(v || '');
  if (p.length < 8) fail(400, 'A senha precisa ter pelo menos 8 caracteres');
  if (p.length > 200) fail(400, 'Senha grande demais');
  if (COMMON_PASSWORDS.indexOf(p.toLowerCase()) !== -1 || /^(.)\1+$/.test(p)) fail(400, 'Essa senha é fácil demais de adivinhar, escolha outra');
  if (userEmail && p.toLowerCase() === userEmail) fail(400, 'A senha não pode ser igual ao e-mail');
  return p;
}

module.exports = { HttpError: HttpError, fail: fail, email: email, name: name, publicId: publicId, text: text, animeId: animeId, int: int, imageUrl: imageUrl, password: password };
