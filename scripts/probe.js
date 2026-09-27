// One-off probe of embed hosts, run in CI with the local server up.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
async function get(url, headers, opts) {
  try {
    const r = await fetch(url, Object.assign({ headers: Object.assign({ 'User-Agent': UA }, headers || {}), signal: AbortSignal.timeout(15000) }, opts || {}));
    return { status: r.status, url: r.url, ct: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 0, text: '', ct: '', err: e.message }; }
}
function unpack(src) {
  const m = src.match(/}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  let p = m[1]; const a = +m[2]; let c = +m[3]; const k = m[4].split('|');
  const e = n => (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
  return p;
}
function scan(label, html) {
  const iframes = (html.match(/<iframe[^>]+src=["'][^"']+/gi) || []).map(s => s.replace(/.*src=["']/i, '')).slice(0, 3);
  const media = Array.from(new Set(html.match(/https?:[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/gi) || [])).slice(0, 3);
  const packed = /eval\(function\(p,a,c,k,e,d\)/.test(html);
  const title = (html.match(/<title>([^<]*)/i) || [])[1];
  console.log('   ' + label + ' title=' + cut(title, 60) + ' packed=' + packed + ' iframes=' + JSON.stringify(iframes) + ' media=' + JSON.stringify(media));
  (html.match(/(?:sources|file|source)\s*[:=]\s*[\[{"'][^\n]{0,160}/gi) || []).slice(0, 3).forEach(s => console.log('      src~ ' + cut(s, 200)));
  if (packed) {
    const js = unpack(html.slice(html.indexOf('eval(function(p,a,c,k,e,d)')));
    const m = js && Array.from(new Set(js.match(/https?:[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*/gi) || []));
    console.log('      unpacked media: ' + JSON.stringify(m));
    return m || [];
  }
  return media;
}
async function embeds(title, ep) {
  const r = await fetch('http://localhost:3000/api/episode/x/' + ep + '?title=' + encodeURIComponent(title)).then(r => r.json());
  console.log('\n### ' + title + ' ep ' + ep + ' trace=' + JSON.stringify(r.trace));
  return (r.data && r.data.embeds) || [];
}
async function probeHost(e) {
  console.log(' * ' + e.label + ' [' + e.kind + '] ' + e.url);
  if (e.kind === 'hls') return;
  const r = await get(e.url, { Referer: 'https://topanimes.net/' });
  console.log('   page ' + r.status + ' ' + r.url + ' len ' + r.text.length + (r.err ? ' ' + r.err : ''));
  let media = scan('outer', r.text);
  const inner = (r.text.match(/<iframe[^>]+src=["']([^"']+)/i) || [])[1];
  if (inner && !/blogger|youtube/.test(inner)) {
    const iu = new URL(inner, r.url || e.url).toString();
    const r2 = await get(iu, { Referer: e.url });
    console.log('   inner ' + r2.status + ' ' + iu.slice(0, 90) + ' len ' + r2.text.length);
    media = media.concat(scan('inner', r2.text));
  }
  for (const m of media.slice(0, 1)) {
    const p = await get(m, { Referer: new URL(e.url).origin + '/' });
    console.log('   media fetch ' + p.status + ' ' + p.ct + ' | ' + cut(p.text, 120));
  }
}
async function blogger(url) {
  const token = new URL(url).searchParams.get('token');
  const page = await get(url);
  const bl = (page.text.match(/"cfb2h":"([^"]+)"/) || [])[1];
  const sid = (page.text.match(/"FdrFJe":"([^"]+)"/) || [])[1];
  const freq = JSON.stringify([[['WcwnYd', JSON.stringify([token, '', 0]), null, 'generic']]]);
  const u = 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=' + sid + '&bl=' + bl + '&hl=pt-BR&_reqid=1234&rt=c';
  const r = await get(u, { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Origin: 'https://www.blogger.com', Referer: url }, { method: 'POST', body: 'f.req=' + encodeURIComponent(freq) + '&' });
  console.log('   blogger rpc ' + r.status + ' bl=' + bl + ' | ' + cut(r.text, 700));
  const gv = Array.from(new Set((r.text.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\\/g, '\\').replace(/\\"/g, '"').match(/https:\/\/[^"\\ ]+googlevideo\.com\/videoplayback[^"\\ ]*/g)) || []));
  console.log('   googlevideo urls: ' + gv.length + ' ' + gv.slice(0, 2).map(x => cut(x, 140)).join(' , '));
  if (gv[0]) {
    const s = await fetch(gv[0], { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } }).catch(() => ({ status: 0, headers: new Map() }));
    console.log('   googlevideo fetch ' + s.status + ' ' + (s.headers.get ? s.headers.get('content-type') : '') + ' ip-bound=' + /[?&]ip=/.test(gv[0]));
  }
}
(async () => {
  for (const [t, ep] of [['Super no Ura de Yani Suu Futari', 1], ['Death Note', 1], ['One Piece', 1000]]) {
    const list = await embeds(t, ep);
    for (const e of list) {
      if (/blogger\.com/.test(e.url)) { console.log(' * ' + e.label + ' ' + cut(e.url, 90)); await blogger(e.url); }
      else await probeHost(e);
    }
  }
})();
