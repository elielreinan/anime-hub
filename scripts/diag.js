// Video source diagnostics, run from a datacenter IP (GitHub Actions) to mirror Render.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const AA_REFERER = 'https://allmanga.to';
const AA_API = 'https://api.allanime.day/api';
const AA_BASE = 'https://allanime.day';

const SEARCH_GQL = 'query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows(search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin) { edges { _id name englishName availableEpisodes __typename } } }';
const EPISODE_GQL = 'query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode(showId: $showId translationType: $translationType episodeString: $episodeString) { episodeString sourceUrls } }';

function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s; }

async function get(url, headers, opts) {
  const t = Date.now();
  try {
    const r = await fetch(url, Object.assign({ headers: Object.assign({ 'User-Agent': UA }, headers || {}), signal: AbortSignal.timeout(20000) }, opts || {}));
    const text = opts && opts.noBody ? '' : await r.text();
    return { status: r.status, ct: r.headers.get('content-type'), text, ms: Date.now() - t };
  } catch (e) {
    return { status: 0, error: e.message + (e.cause ? ' / ' + e.cause.message : ''), text: '', ms: Date.now() - t };
  }
}

function gqlUrl(variables, query) {
  return AA_API + '?variables=' + encodeURIComponent(JSON.stringify(variables)) + '&query=' + encodeURIComponent(query);
}

function decodeSourceUrl(s) {
  if (!s || s.indexOf('--') !== 0) return s;
  const hex = s.slice(2);
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ 56);
  return out;
}

async function probeVideo(url, referer) {
  const r = await get(url, { Referer: referer, Range: 'bytes=0-1023' });
  const head = r.text ? cut(r.text.replace(/\s+/g, ' '), 120) : '';
  console.log('      probe', r.status, r.ct || '', r.error || '', head.indexOf('#EXTM3U') !== -1 ? '[m3u8 OK]' : '');
  return r.status >= 200 && r.status < 400;
}

async function testAllAnime(query, episode, mode) {
  console.log('\n=== AllAnime: "' + query + '" ep ' + episode + ' (' + mode + ') ===');
  const s = await get(gqlUrl({ search: { allowAdult: false, allowUnknown: false, query }, limit: 10, page: 1, translationType: mode, countryOrigin: 'ALL' }, SEARCH_GQL), { Referer: AA_REFERER });
  console.log('  search', s.status, s.ms + 'ms', s.error || '', cut(s.text, 600));
  let data;
  try { data = JSON.parse(s.text); } catch (e) { return; }
  const edges = (data && data.data && data.data.shows && data.data.shows.edges) || [];
  if (!edges.length) { console.log('  no shows'); return; }
  edges.slice(0, 5).forEach(e => console.log('   -', e._id, '|', e.name, '|', e.englishName, '|', JSON.stringify(e.availableEpisodes)));
  const show = edges[0];

  const ep = await get(gqlUrl({ showId: show._id, translationType: mode, episodeString: String(episode) }, EPISODE_GQL), { Referer: AA_REFERER });
  console.log('  episode', ep.status, ep.ms + 'ms', ep.error || '', cut(ep.text, 400));
  let epData;
  try { epData = JSON.parse(ep.text); } catch (e) { return; }
  const sources = (epData && epData.data && epData.data.episode && epData.data.episode.sourceUrls) || [];
  console.log('  sources:', sources.length);

  for (const src of sources) {
    const decoded = decodeSourceUrl(src.sourceUrl);
    console.log('   * ' + src.sourceName + ' (prio ' + src.priority + ', type ' + src.type + '): ' + cut(decoded, 160));
    if (decoded.indexOf('/') === 0) {
      const path = decoded.replace('/clock?', '/clock.json?');
      const l = await get(AA_BASE + path, { Referer: AA_REFERER });
      console.log('     clock', l.status, l.ms + 'ms', l.error || '', cut(l.text, 500));
      let lj;
      try { lj = JSON.parse(l.text); } catch (e) { continue; }
      for (const link of (lj.links || []).slice(0, 3)) {
        console.log('     link', link.resolutionStr, link.hls ? 'HLS' : 'MP4', cut(link.link, 200), link.headers ? JSON.stringify(link.headers) : '');
        let url = link.link;
        const wix = url.match(/repackager\.wixmp\.com\/(.+?)\/,([^/]*),\/mp4\/file\.mp4\.urlset/);
        if (wix) {
          const q = wix[2].split(',').filter(Boolean)[0];
          url = 'https://' + wix[1] + '/' + q + '/mp4/file.mp4';
          console.log('      wix direct ->', url);
        }
        await probeVideo(url, (link.headers && link.headers.Referer) || AA_REFERER);
      }
    } else if (decoded.indexOf('http') === 0) {
      await probeVideo(decoded, AA_REFERER);
    }
  }
}

async function testConsumet() {
  console.log('\n=== Consumet providers ===');
  let mod;
  try { mod = await import('@consumet/extensions'); } catch (e) { console.log('  load failed', e.message); return; }
  const ANIME = mod.ANIME;
  console.log('  available:', Object.keys(ANIME).join(', '));
  for (const name of ['AnimeKai', 'AnimePahe', 'AnimeUnity', 'AnimeSaturn', 'KickAssAnime']) {
    if (!ANIME[name]) continue;
    const t = Date.now();
    try {
      const r = await Promise.race([new ANIME[name]().search('Death Note'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000))]);
      console.log('  ' + name + ': ' + ((r && r.results) || []).length + ' results', (Date.now() - t) + 'ms', r && r.results && r.results[0] ? JSON.stringify(r.results[0]).slice(0, 150) : '');
    } catch (e) {
      console.log('  ' + name + ': ERROR', e.message);
    }
  }
}

(async () => {
  console.log('Node', process.version);
  await testAllAnime('Death Note', 1, 'sub');
  await testAllAnime('Naruto Shippuden', 451, 'sub');
  await testAllAnime('One Piece', 1100, 'sub');
  await testConsumet();
})();
