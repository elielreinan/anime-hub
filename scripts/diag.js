// Probe anime video sources from a datacenter IP (GitHub Actions) to find ones usable from Render.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cut(s, n) { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

async function get(url, opts) {
  opts = opts || {};
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      redirect: 'follow',
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, opts.headers || {}),
      signal: AbortSignal.timeout(opts.timeout || 12000)
    });
    const text = opts.noBody ? '' : await r.text();
    const blocked = r.headers.get('cf-mitigated') || (/Just a moment|cf-chl|challenge-platform|ddos-guard|DDoS-Guard/i.test(text) ? 'challenge' : '');
    return { url: r.url, status: r.status, ct: r.headers.get('content-type') || '', server: r.headers.get('server') || '', blocked, text, ms: Date.now() - t };
  } catch (e) {
    return { url, status: 0, error: (e.cause && (e.cause.code || e.cause.message)) || e.message, text: '', ms: Date.now() - t };
  }
}

function line(label, r) {
  const verdict = r.status === 0 ? 'DEAD ' : r.blocked ? 'BLOCK' : r.status >= 400 ? 'ERR  ' : 'OK   ';
  const extra = r.status === 0 ? r.error : (r.server + ' ' + cut(r.ct, 30) + ' | ' + cut(r.text, 140));
  console.log(verdict + ' ' + String(r.status).padEnd(3) + ' ' + label.padEnd(58) + ' ' + extra);
}

const PROBES = [
  // controls
  ['control jikan', 'https://api.jikan.moe/v4/anime?q=naruto&limit=1'],
  ['control kitsu', 'https://kitsu.io/api/edge/anime?filter[text]=naruto&page[limit]=1'],
  // international APIs / mirrors
  ['allanime api', 'https://api.allanime.day/api?variables=%7B%7D&query=%7B__typename%7D'],
  ['allanime.to', 'https://allanime.to/'],
  ['allmanga.to', 'https://allmanga.to/'],
  ['animepahe.ru api', 'https://animepahe.ru/api?m=search&q=naruto'],
  ['animepahe.com api', 'https://animepahe.com/api?m=search&q=naruto'],
  ['animepahe.org api', 'https://animepahe.org/api?m=search&q=naruto'],
  ['anitaku.to', 'https://anitaku.to/search.html?keyword=naruto'],
  ['anitaku.pe', 'https://anitaku.pe/search.html?keyword=naruto'],
  ['anitaku.io', 'https://anitaku.io/search.html?keyword=naruto'],
  ['gogoanime3.co', 'https://gogoanime3.co/search.html?keyword=naruto'],
  ['gogoanime.by', 'https://gogoanime.by/?s=naruto'],
  ['gogocdn ajax', 'https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=5&id=1'],
  ['hianimez.to', 'https://hianimez.to/ajax/search/suggest?keyword=naruto'],
  ['hianime.sx', 'https://hianime.sx/ajax/search/suggest?keyword=naruto'],
  ['hianime.nz', 'https://hianime.nz/ajax/search/suggest?keyword=naruto'],
  ['hianime.bz', 'https://hianime.bz/ajax/search/suggest?keyword=naruto'],
  ['hianime.do', 'https://hianime.do/ajax/search/suggest?keyword=naruto'],
  ['aniwatchtv.to', 'https://aniwatchtv.to/ajax/search/suggest?keyword=naruto'],
  ['9animetv.to', 'https://9animetv.to/ajax/search/suggest?keyword=naruto'],
  ['animekai.to', 'https://animekai.to/ajax/anime/search?keyword=naruto'],
  ['animekai.bz', 'https://animekai.bz/ajax/anime/search?keyword=naruto'],
  ['kaa.to', 'https://kaa.to/api/search?query=naruto'],
  ['miruro.tv', 'https://www.miruro.tv/'],
  ['anify api', 'https://api.anify.tv/search/anime/naruto'],
  ['consumet public', 'https://api.consumet.org/anime/gogoanime/naruto'],
  ['anime-sama.fr', 'https://anime-sama.fr/'],
  ['anime-sama.org', 'https://anime-sama.org/'],
  ['animeflv', 'https://www3.animeflv.net/browse?q=naruto'],
  ['jkanime', 'https://jkanime.net/buscar/naruto/'],
  // brazilian
  ['anroll search api', 'https://api-search.anroll.net/data?q=naruto'],
  ['anroll site', 'https://www.anroll.net/'],
  ['anroll apiv3', 'https://apiv3-prd.anroll.net/animes/1/episodes?page=1&order=desc'],
  ['animefire.plus', 'https://animefire.plus/pesquisar/naruto'],
  ['animefire.io', 'https://animefire.io/pesquisar/naruto'],
  ['animefire.net', 'https://animefire.net/pesquisar/naruto'],
  ['animefire.vip', 'https://animefire.vip/pesquisar/naruto'],
  ['goyabu.io', 'https://goyabu.io/?s=naruto'],
  ['goyabu.com', 'https://goyabu.com/?s=naruto'],
  ['animesdigital', 'https://animesdigital.org/?s=naruto'],
  ['animes.vision', 'https://animes.vision/'],
  ['anitube.vip', 'https://www.anitube.vip/?s=naruto'],
  ['anitube.site', 'https://anitube.site/?s=naruto'],
  ['animeyabu', 'https://animeyabu.net/?s=naruto'],
  ['hinatasoul', 'https://www.hinatasoul.com/busca?q=naruto'],
  ['topanimes', 'https://topanimes.net/?s=naruto'],
  ['animesonlinecc.org', 'https://animesonlinecc.org/?s=naruto'],
  ['animesonlinehd', 'https://animesonlinehd.vip/?s=naruto'],
  ['animesonline.in', 'https://animesonline.in/?s=naruto'],
  ['animesorion', 'https://animesorion.vip/?s=naruto'],
  ['animesup', 'https://www.animesup.info/?s=naruto'],
  ['q1n', 'https://q1n.net/?s=naruto'],
  ['otakuanimes', 'https://otakuanimess.net/?s=naruto'],
  ['animeshd', 'https://animeshd.to/?s=naruto'],
  ['animes.net.br', 'https://animes.net.br/?s=naruto'],
  ['animesbr.tv', 'https://animesbr.tv/?s=naruto'],
  ['bakashi', 'https://bakashi.tv/?s=naruto'],
  ['saikoanimes', 'https://saikoanimes.net/?s=naruto'],
];

async function anrollFlow() {
  console.log('\n=== Anroll flow ===');
  const s = await get('https://api-search.anroll.net/data?q=death%20note');
  line('search death note', s);
  let j; try { j = JSON.parse(s.text); } catch (e) { return; }
  console.log('  raw:', cut(JSON.stringify(j), 600));
}

async function animefireFlow(base) {
  console.log('\n=== AnimeFire flow on ' + base + ' ===');
  line('video json death-note/1', await get(base + '/video/death-note/1', { headers: { Referer: base + '/animes/death-note/1', 'X-Requested-With': 'XMLHttpRequest' } }));
  line('episode page', await get(base + '/animes/death-note/1'));
}

async function pageFlow(label, base, path) {
  const r = await get(base + path);
  line(label, r);
  if (r.status === 200 && !r.blocked) {
    const links = (r.text.match(/href=["'][^"']+["']/g) || []).filter(h => /naruto/i.test(h)).slice(0, 6);
    console.log('    naruto links:', links.join(' '));
    const iframes = (r.text.match(/<iframe[^>]+src=["'][^"']+/gi) || []).slice(0, 3);
    if (iframes.length) console.log('    iframes:', iframes.join(' '));
  }
}

(async () => {
  console.log('Node', process.version);
  console.log('\n=== Probe (' + PROBES.length + ' candidates) ===');
  const results = await Promise.all(PROBES.map(p => get(p[1]).then(r => [p[0], r])));
  results.forEach(([label, r]) => line(label, r));

  const ok = results.filter(([, r]) => r.status >= 200 && r.status < 400 && !r.blocked).map(([l, r]) => l + ' -> ' + r.url);
  console.log('\nREACHABLE (' + ok.length + '):\n  ' + ok.join('\n  '));

  await anrollFlow();
  for (const base of ['https://animefire.plus', 'https://animefire.io', 'https://animefire.net']) await animefireFlow(base);

  console.log('\n=== Search result pages (naruto links) ===');
  for (const [label, r] of results) {
    if (label.indexOf('control') === 0) continue;
    if (r.status === 200 && !r.blocked && /\?s=|search|busca|pesquisar/.test(PROBES.find(p => p[0] === label)[1])) {
      const links = (r.text.match(/href=["'][^"']+["']/g) || []).filter(h => /naruto/i.test(h)).slice(0, 5);
      console.log(label.padEnd(20), links.length ? links.join(' ') : '(no naruto links)', '| len', r.text.length);
    }
  }
})();
