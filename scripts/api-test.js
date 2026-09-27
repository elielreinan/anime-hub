// API end-to-end test against a real Postgres. Run the server with
//   TRUST_PROXY=1 ADMIN_EMAILS=ana@test.com DATABASE_URL=... node server.js
// on an empty database, then: node scripts/api-test.js [baseUrl]
const B = process.argv[2] || 'http://localhost:3000';
const out = [];
const check = (n, ok, x) => out.push((ok ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 180) : ''));
const ipOf = {}; let nextIp = 1;
async function call(method, path, body, token, headers) {
  const ip = token ? (ipOf[token] = ipOf[token] || '203.0.113.' + (nextIp++)) : '198.51.100.' + (1 + Math.floor(Math.random() * 200));
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
(async () => {
  let r = await call('POST', '/api/auth/register', { email: 'ana@test.com', password: 'segredo123', name: 'Ana' });
  check('register without terms rejected', r.s === 400 && /termos/.test(r.j.message), r.j);
  r = await call('POST', '/api/auth/register', { email: 'ana@test.com', password: '12345678', name: 'Ana', acceptTerms: true });
  check('weak password rejected', r.s === 400, r.j.message);
  r = await call('POST', '/api/auth/register', { email: 'ana@test.com', password: 'ana@test.com', name: 'Ana', acceptTerms: true });
  check('password = email rejected', r.s === 400, r.j.message);
  r = await call('POST', '/api/auth/register', { email: 'ana@test.com', password: 'segredo123', name: 'Ana', acceptTerms: true });
  const A = r.j.token, ida = r.j.user && r.j.user.publicId;
  check('register ok, admin role from ADMIN_EMAILS', r.s === 200 && r.j.user.role === 'admin', r.j.user);
  r = await call('POST', '/api/auth/register', { email: 'leo@test.com', password: 'senhaleo1', name: 'Leo<script>', acceptTerms: true });
  const L = r.j.token, idl = r.j.user.publicId;
  check('name kept as text (escaped by client)', r.j.user.name === 'Leo<script>');
  r = await call('POST', '/api/auth/register', { email: 'bia@test.com', password: 'senhabia1', name: 'Bia', acceptTerms: true });
  const Bt = r.j.token, idb = r.j.user.publicId;
  // lockout
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/auth/login', { email: 'bia@test.com', password: 'errada' + i })).s);
  r = await call('POST', '/api/auth/login', { email: 'bia@test.com', password: 'senhabia1' });
  check('lockout after 5 wrong passwords (even right one blocked)', r.s === 429, codes.concat(r.s));
  // profile/avatar
  r = await call('PATCH', '/api/me', { avatar: 'dragon' }, A); check('avatar set', r.j.user && r.j.user.avatar === 'dragon');
  r = await call('PATCH', '/api/me', { avatar: 'javascript:alert(1)' }, A); check('bad avatar rejected', r.s === 400);
  // data sync with list Completados
  r = await call('PUT', '/api/me/data', { data: { v: 1, lists: { Completados: [{ id: 5, title: 'Frieren', cover: 'https://x/c.jpg' }], Favoritos: [{ id: 9, title: 'X', cover: 'javascript:alert(1)' }] }, history: [] } }, A);
  check('data sync', r.s === 200);
  // watched episodes -> xp
  for (const ep of [1, 2, 3]) r = await call('POST', '/api/me/watched', { animeId: '5', title: 'Frieren', cover: 'https://x/c.jpg', ep }, A);
  r = await call('POST', '/api/me/watched', { animeId: '5', title: 'Frieren', ep: 3 }, A);
  check('watched counted once per ep', r.j.counted === false && r.j.level.stats.episodes === 3, r.j.level && r.j.level.stats);
  check('xp = 3*10 + 1 completed*50 = 80', r.j.level.xp === 80, r.j.level.xp);
  check('achievements computed', r.j.level.achievements.filter(a => a.unlocked).map(a => a.id).join() === 'first_ep,done_1', r.j.level.achievements.filter(a => a.unlocked).map(a => a.id));
  r = await call('POST', '/api/me/watched', { animeId: '5/../x', title: 'x', ep: 1 }, A); check('bad anime id rejected', r.s === 400);
  // friends + feed
  await call('POST', '/api/me/friends', { publicId: ida }, L);
  r = await call('GET', '/api/feed', null, L);
  check('friend feed shows Ana watched (collapsed)', r.j.items && r.j.items.length === 1 && r.j.items[0].type === 'watched' && r.j.items[0].ep === 3 && r.j.items[0].extra.count === 3, r.j.items);
  // public profile
  r = await call('GET', '/api/users/' + ida);
  check('public profile has level, lists (unsafe cover dropped)', r.j.level === 2 && r.j.lists.Favoritos[0].cover === '' && r.j.progress.xp === 80, { level: r.j.level, fav: r.j.lists && r.j.lists.Favoritos });
  check('public profile has no email', !JSON.stringify(r.j).includes('@test.com'));
  // community
  r = await call('POST', '/api/community/posts', { text: 'Frieren é incrível! <img src=x onerror=alert(1)>' }, A);
  const post = r.j.post; check('post created', r.s === 200 && post.text.includes('<img'), post && post.text);
  r = await call('POST', '/api/community/posts', { text: '   ' }, A); check('empty post rejected', r.s === 400);
  r = await call('POST', '/api/community/posts', { text: 'x'.repeat(1001) }, A); check('long post rejected', r.s === 400);
  r = await call('POST', '/api/community/posts/' + post.id + '/like', {}, L); check('like', r.j.liked === true && r.j.likes === 1);
  r = await call('POST', '/api/community/posts/' + post.id + '/comments', { text: 'Concordo!' }, L); check('comment', r.s === 200);
  r = await call('GET', '/api/community/posts', null, L);
  check('feed lists post with counts', r.j.posts[0].likes === 1 && r.j.posts[0].comments === 1 && r.j.posts[0].liked === true && r.j.posts[0].canDelete === false, r.j.posts[0]);
  r = await call('DELETE', '/api/community/posts/' + post.id, {}, L); check('cannot delete others post', r.s === 403);
  // rate limit posts (6/min)
  const pc = []; for (let i = 0; i < 7; i++) pc.push((await call('POST', '/api/community/posts', { text: 'spam ' + i }, L)).s);
  check('post rate limit', pc.includes(429), pc);
  // reports auto-hide
  r = await call('POST', '/api/community/posts', { text: 'post ruim' }, Bt.length ? A : A);
  const bad = r.j.post ? r.j.post.id : null;
  // need 3 distinct reporters: L, B (after lock B can't login but token still valid), A is author
  await call('POST', '/api/reports', { type: 'post', id: String(bad), reason: 'ofensivo' }, L);
  await call('POST', '/api/reports', { type: 'post', id: String(bad), reason: 'ofensivo' }, L);
  await call('POST', '/api/reports', { type: 'post', id: String(bad), reason: 'spam' }, Bt);
  r = await call('POST', '/api/auth/register', { email: 'cai@test.com', password: 'senhacai1', name: 'Cai', acceptTerms: true }); const C = r.j.token;
  await call('POST', '/api/reports', { type: 'post', id: String(bad), reason: 'lixo' }, C);
  r = await call('GET', '/api/community/posts', null);
  check('3 distinct reports auto-hide', !r.j.posts.some(p => p.id === bad), r.j.posts.map(p => p.id));
  // clans
  r = await call('POST', '/api/clans', { name: 'Akatsuki', description: 'Clã dos fortes', emoji: '🔥', color: 'red' }, A);
  const clan = r.j.clan; check('clan created', r.s === 200 && clan.emoji === '🔥', r.j);
  r = await call('POST', '/api/clans', { name: 'akatsuki', emoji: '🔥' }, L); check('duplicate clan name (case) rejected', r.s === 409, r.j.message);
  r = await call('POST', '/api/clans', { name: 'Outro' }, A); check('one clan per user', r.s === 400, r.j.message);
  r = await call('POST', '/api/clans/' + clan.publicId + '/join', {}, L); check('join', r.s === 200);
  r = await call('POST', '/api/clans/' + clan.publicId + '/members/' + ida, { action: 'kick' }, L); check('member cannot kick owner', r.s === 403);
  r = await call('POST', '/api/clans/' + clan.publicId + '/members/' + idl, { action: 'mod' }, A); check('owner promotes mod', r.s === 200);
  r = await call('POST', '/api/auth/register', { email: 'dan@test.com', password: 'senhadan1', name: 'Dan', acceptTerms: true }); const D = r.j.token;
  await call('POST', '/api/clans/' + clan.publicId + '/join', {}, D);
  r = await call('POST', '/api/community/posts', { text: 'Reunião do clã hoje', clan: true }, D);
  r = await call('GET', '/api/community/posts?clan=' + clan.publicId, null, L);
  check('clan feed', r.j.posts.length === 1 && r.j.posts[0].clan.name === 'Akatsuki' && r.j.posts[0].canDelete === true, r.j.posts[0]);
  r = await call('GET', '/api/community/posts', null); check('clan post not in public feed', !r.j.posts.some(p => p.clan));
  r = await call('GET', '/api/clans/' + clan.publicId, null, L); check('clan detail', r.j.members === 3 && r.j.myRole === 'mod' && r.j.xp >= 80, { m: r.j.members, role: r.j.myRole, xp: r.j.xp });
  r = await call('GET', '/api/rankings/clans'); check('clan ranking', r.j.clans[0].name === 'Akatsuki');
  r = await call('GET', '/api/rankings/users'); check('user ranking by xp', r.j.users[0].publicId === ida, r.j.users.map(u => u.name + ':' + u.xp));
  r = await call('POST', '/api/clans/' + clan.publicId + '/leave', {}, A);
  r = await call('GET', '/api/clans/' + clan.publicId, null, L); check('owner leaves -> mod inherits', r.j.myRole === 'owner', r.j.myRole);
  // reviews
  r = await call('PUT', '/api/reviews/5/3', { rating: 5, text: 'Episódio perfeito', title: 'Frieren' }, A);
  r = await call('PUT', '/api/reviews/5/3', { rating: 3 }, L);
  r = await call('PUT', '/api/reviews/5/3', { rating: 9 }, L); check('rating range', r.s === 400);
  r = await call('GET', '/api/reviews/5/3', null, L);
  check('reviews summary (friend first)', r.j.count === 2 && r.j.avg === 4 && r.j.mine.rating === 3 && r.j.items[0].friend === true, { c: r.j.count, avg: r.j.avg, mine: r.j.mine, first: r.j.items[0] && r.j.items[0].friend });
  // health
  for (let i = 0; i < 4; i++) await call('POST', '/api/health/report', { host: 'bad.example.com', ok: false }, null, { 'X-Forwarded-For': '10.0.0.' + i });
  r = await call('POST', '/api/health/report', { host: 'javascript:x', ok: false }); check('health host validated', r.s === 400);
  // admin
  r = await call('GET', '/api/admin/stats', null, L); check('non-admin blocked', r.s === 403);
  r = await call('GET', '/api/admin/stats', null, A); check('admin stats', r.j.users === 5 && r.j.servers[0].host === 'bad.example.com' && r.j.servers[0].unstable === true, { users: r.j.users, servers: r.j.servers });
  r = await call('GET', '/api/admin/reports', null, A); check('admin sees report with preview', r.j.reports[0] && r.j.reports[0].target.text === 'post ruim', r.j.reports[0]);
  r = await call('POST', '/api/admin/users/' + idl + '/ban', { reason: 'teste' }, A); check('ban', r.j.banned === true);
  r = await call('GET', '/api/me', null, L); check('banned session dead', r.s === 401);
  r = await call('POST', '/api/auth/login', { email: 'leo@test.com', password: 'senhaleo1' }); check('banned cannot login', r.s === 403, r.j.message);
  r = await call('POST', '/api/admin/users/' + ida + '/ban', { reason: 'x' }, A); check('cannot ban admin', r.s === 400);
  r = await call('GET', '/api/admin/audit', null, A); check('audit log', r.j.entries.some(e => e.action === 'ban') && r.j.entries.some(e => e.action === 'login_failed'), r.j.entries.map(e => e.action).slice(0, 12));
  // export + delete
  r = await call('GET', '/api/me/export', null, A); check('LGPD export (no hash)', r.j.account && !('password_hash' in r.j.account) && r.j.watched.length === 3 && r.j.posts.length >= 1);
  r = await call('POST', '/api/auth/password', { current: 'segredo123', password: 'novasenha9' }, A); check('change password', r.s === 200);
  r = await call('DELETE', '/api/me/account', { password: 'novasenha9' }, C); check('delete wrong pw', r.s === 401);
  r = await call('DELETE', '/api/me/account', { password: 'senhacai1' }, C); check('delete account', r.s === 200);
  // misc hardening
  r = await call('GET', '/api/me', null, 'x'.repeat(40)); check('garbage token 401', r.s === 401);
  r = await fetch(B + '/api/community/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + A }, body: '{"text":"' + 'a'.repeat(20000) + '"}' }); check('oversized body rejected', r.status === 400);
  r = await call('GET', '/api/users/%E0%A4%A'); check('bad encoding handled', r.s === 404);
  r = await call('GET', '/api/nope'); check('unknown api 404', r.s === 404);
  r = await call('PUT', '/api/users/' + ida); check('wrong method 405', r.s === 405);
  console.log(out.join('\n'));
  console.log(out.filter(l => l.startsWith('PASS')).length + '/' + out.length);
})();
