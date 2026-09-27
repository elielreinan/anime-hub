// One-off probe of player internals, run in CI with the local server up.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
async function get(url, headers) {
  try {
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), signal: AbortSignal.timeout(15000) });
    return { status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 0, text: '', ct: '', err: e.message }; }
}
async function embeds(title, ep) {
  const r = await fetch('http://localhost:3000/api/episode/x/' + ep + '?title=' + encodeURIComponent(title)).then(r => r.json());
  return (r.data && r.data.embeds) || [];
}
(async () => {
  console.log('=== sk-api ===');
  const naruto = await embeds('Naruto Shippuden', 451);
  const sk = naruto.find(e => e.url.includes('sk-api'));
  const skBase = sk ? sk.url : 'https://sk-api.alibabacdn.net/?id=7JSpX4SZRhKyfPV78VJm2-Naruto-Shipp%C3%BBden/451';
  for (const ep of ['451', '450', '1']) {
    const u = new URL(skBase.replace(/\/451/, '/' + ep));
    u.searchParams.set('mode', 'to-salvando-seu-ip');
    for (const ref of ['https://topanimes.net/', '']) {
      const r = await get(u.toString(), ref ? { Referer: ref } : {});
      console.log('ep ' + ep + ' ref=' + (ref || 'none') + ' -> ' + r.status + ' ' + r.ct + ' | ' + cut(r.text, 400));
      let j; try { j = JSON.parse(r.text); } catch (e) { continue; }
      const m = j.midias && j.midias[0];
      if (!m) continue;
      for (const ref2 of ['', 'https://sk-api.alibabacdn.net/', 'https://topanimes.net/']) {
        const p = await get(m.url, ref2 ? { Referer: ref2 } : {});
        console.log('   m3u8 ref=' + (ref2 || 'none') + ' -> ' + p.status + ' ' + p.ct + ' | ' + cut(p.text, 300));
        const seg = (p.text.split('\n').find(l => l && l[0] !== '#') || '').trim();
        if (p.status === 200 && seg) {
          const segUrl = new URL(seg, m.url).toString();
          const s = await fetch(segUrl, { headers: { 'User-Agent': UA, Referer: ref2 || undefined, Range: 'bytes=0-1023' } }).catch(e => ({ status: 0 }));
          console.log('   first entry ' + cut(segUrl, 120) + ' -> ' + s.status + ' ' + (s.headers ? s.headers.get('content-type') : ''));
        }
      }
      break;
    }
  }

  console.log('\n=== blogger availability markers ===');
  const dn = await embeds('Death Note', 1);
  const cases = [['good', dn.find(e => e.url.includes('blogger'))], ['bad', naruto.find(e => e.url.includes('blogger'))]];
  for (const [label, e] of cases) {
    if (!e) { console.log(label, 'no blogger embed'); continue; }
    const r = await get(e.url);
    const t = r.text;
    console.log(label, r.status, 'len', t.length,
      'unavailable:', /unavailable|indispon/i.test(t),
      'streams:', /streams/.test(t), 'play_url:', /play_url/.test(t), 'googlevideo:', /googlevideo/.test(t), 'iframe_api:', /iframe_api/.test(t));
    const idx = t.search(/VIDEO_CONFIG|streams|play_url|video_id|videoId/);
    console.log('   ', idx >= 0 ? cut(t.slice(Math.max(0, idx - 100), idx + 400), 500) : '(no config marker)');
  }

  console.log('\n=== filemoon / others quick status ===');
  for (const e of (await embeds('One Piece', 1000)).concat(dn)) {
    if (e.url.includes('blogger')) continue;
    const r = await get(e.url, { Referer: 'https://elielreinan.github.io/' });
    console.log(r.status, e.label, cut(e.url, 60), '|', cut(r.text.replace(/<[^>]+>/g, ' '), 140));
  }
})();
