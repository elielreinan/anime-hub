// Map page structure of reachable sources: search -> anime page -> episode page -> player -> video.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cut(s, n) { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

async function get(url, opts) {
  opts = opts || {};
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET', body: opts.body, redirect: 'follow',
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, opts.headers || {}),
      signal: AbortSignal.timeout(15000)
    });
    return { url: r.url, status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) {
    return { url, status: 0, error: (e.cause && (e.cause.code || e.cause.message)) || e.message, text: '' };
  }
}

function uniq(a) { return Array.from(new Set(a)); }
function hrefs(html) { return uniq((html.match(/href=["']([^"'#]+)["']/g) || []).map(h => h.slice(6, -1))); }

function around(html, re, width, max) {
  const out = [];
  let m;
  const g = new RegExp(re.source, 'gi');
  while ((m = g.exec(html)) && out.length < (max || 4)) out.push(cut(html.slice(Math.max(0, m.index - width), m.index + width), width * 2));
  return out;
}

function dumpPlayer(html) {
  console.log('    iframes:', uniq((html.match(/<iframe[^>]*>/gi) || []).map(t => cut(t, 220))).slice(0, 5));
  console.log('    video urls:', uniq(html.match(/https?:[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/gi) || []).slice(0, 5));
  console.log('    blogger:', uniq(html.match(/https?:\/\/(?:www\.)?blogger\.com\/video[^"'\s<>]*/gi) || []).slice(0, 3));
  console.log('    data-post/nume:', uniq((html.match(/data-(?:post|nume|type)=["'][^"']*["']/gi) || [])).slice(0, 12).join(' '));
  console.log('    ajax refs:', uniq(html.match(/(?:admin-ajax\.php|wp-json\/[a-z0-9\/_-]+|dooplay[a-z_]*|player_ajax[a-z_]*)/gi) || []).slice(0, 8));
  around(html, /player/, 220, 3).forEach(s => console.log('    ~player~', s));
}

async function flow(name, base, query, animeRe, epRe) {
  console.log('\n\n######## ' + name + ' ########');
  const s = await get(base + '/?s=' + encodeURIComponent(query));
  console.log('search', s.status, s.error || '', s.url);
  const animeLinks = hrefs(s.text).filter(h => animeRe.test(h));
  console.log('  anime links:', animeLinks.slice(0, 8));
  if (!animeLinks.length) return;

  const a = await get(animeLinks[0]);
  console.log('anime page', a.status, a.url, 'len', a.text.length);
  const epLinks = hrefs(a.text).filter(h => epRe.test(h));
  console.log('  episode links (' + epLinks.length + '):', epLinks.slice(0, 6), '...', epLinks.slice(-3));
  if (!epLinks.length) { dumpPlayer(a.text); return; }

  const e = await get(epLinks[0]);
  console.log('episode page', e.status, e.url, 'len', e.text.length);
  dumpPlayer(e.text);

  const post = (e.text.match(/data-post=["'](\d+)["']/i) || [])[1];
  const nume = (e.text.match(/data-nume=["'](\w+)["']/i) || [])[1] || '1';
  const type = (e.text.match(/data-type=["'](\w+)["']/i) || [])[1] || 'tv';
  let embed = null;
  if (post) {
    const r1 = await get(base + '/wp-json/dooplayer/v2/' + post + '/' + type + '/' + nume);
    console.log('  dooplayer v2', r1.status, cut(r1.text, 400));
    const r2 = await get(base + '/wp-admin/admin-ajax.php', { method: 'POST', body: 'action=doo_player_ajax&post=' + post + '&nume=' + nume + '&type=' + type, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: e.url } });
    console.log('  admin-ajax', r2.status, cut(r2.text, 400));
    const m = (r1.text + ' ' + r2.text).match(/"embed_url"\s*:\s*"([^"]+)"/);
    if (m) embed = m[1].replace(/\\\//g, '/');
    if (!embed) { const im = (r1.text + r2.text).match(/src=\\?["']([^"'\\]+)/); if (im) embed = im[1]; }
  }
  if (!embed) {
    const ifr = (e.text.match(/<iframe[^>]+src=["']([^"']+)["']/i) || [])[1];
    if (ifr) embed = ifr;
  }
  if (embed) {
    if (embed.indexOf('//') === 0) embed = 'https:' + embed;
    console.log('  EMBED ->', embed);
    const p = await get(embed, { headers: { Referer: e.url } });
    console.log('  embed page', p.status, p.error || '', p.url, 'len', p.text.length);
    dumpPlayer(p.text);
    around(p.text, /(?:file|sources?|src)\s*[:=]/, 160, 4).forEach(x => console.log('    ~src~', x));
  }
}

async function episode(name, url) {
  console.log('\n\n######## ' + name + ' ########');
  const e = await get(url);
  console.log('episode page', e.status, e.error || '', e.url, 'len', e.text.length);
  dumpPlayer(e.text);
  around(e.text, /<script[^>]*>[^<]*(?:src|embed|player|source)/, 400, 6).forEach(x => console.log('    ~script~', x));
  const post = (e.text.match(/data-post=["'](\d+)["']/i) || [])[1];
  const nume = (e.text.match(/data-nume=["'](\w+)["']/i) || [])[1] || '1';
  const type = (e.text.match(/data-type=["'](\w+)["']/i) || [])[1] || 'tv';
  const base = new URL(e.url || url).origin;
  let embeds = [];
  if (post) {
    for (const n of uniq((e.text.match(/data-nume=["'](\w+)["']/gi) || []).map(x => x.match(/["'](\w+)["']/)[1])).slice(0, 4)) {
      const r1 = await get(base + '/wp-json/dooplayer/v2/' + post + '/' + type + '/' + n);
      console.log('  dooplayer v2 nume=' + n, r1.status, cut(r1.text, 300));
      const r2 = await get(base + '/wp-admin/admin-ajax.php', { method: 'POST', body: 'action=doo_player_ajax&post=' + post + '&nume=' + n + '&type=' + type, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: e.url } });
      console.log('  admin-ajax nume=' + n, r2.status, cut(r2.text, 300));
      const m = (r1.text + ' ' + r2.text).match(/"embed_url"\s*:\s*"([^"]+)"/);
      if (m) embeds.push(m[1].replace(/\\\//g, '/'));
    }
  }
  (e.text.match(/<iframe[^>]+src=["']([^"']+)["']/gi) || []).forEach(t => embeds.push(t.match(/src=["']([^"']+)/i)[1]));
  embeds = uniq(embeds).slice(0, 4);
  for (let embed of embeds) {
    if (embed.indexOf('//') === 0) embed = 'https:' + embed;
    const im = embed.match(/src=["']([^"']+)/); if (im) embed = im[1];
    console.log('  EMBED ->', embed);
    const p = await get(embed, { headers: { Referer: e.url } });
    console.log('  embed page', p.status, p.error || '', p.url, 'len', p.text.length);
    dumpPlayer(p.text);
    around(p.text, /(?:file|sources?|src|url)\s*[:=]/, 180, 5).forEach(x => console.log('    ~src~', x));
  }
}

(async () => {
  await episode('topanimes death note 1', 'https://topanimes.net/episodio/death-note-episodio-1/');
  await episode('topanimes naruto shippuden 451', 'https://topanimes.net/episodio/naruto-shippuden-dublado-episodio-451/');
  const a = await get('https://animeshd.to/animes/death-note-online/');
  const eps = hrefs(a.text).filter(h => /episodio/i.test(h) && /^https?:/.test(h));
  console.log('\nanimeshd death note page', a.status, 'episodes', eps.length, eps.slice(0, 3));
  if (eps.length) await episode('animeshd ep', eps.find(h => /-1\/?$|episodio-1\b/.test(h)) || eps[0]);
  await episode('gogoanime.by', 'https://gogoanime.by/pokemon-shinsaku-anime-episode-151-english-subbed/');
})();
