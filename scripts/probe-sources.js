// Tries candidate DooPlay sites with the real scraper, one at a time, and reports
// which of them return playable servers. Used to find a third video source.
// Usage: node scripts/probe-sources.js [https://site1 https://site2 ...]
const src = require('../server.js');

const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://animesonlinecc.to', 'https://animesonline.cloud', 'https://animesonlinehd.to',
  'https://animesonlinebr.org', 'https://animesgratis.org', 'https://animesup.info',
  'https://animesorionvip.net', 'https://animesorion.to', 'https://animeszone.net',
  'https://animesflix.net', 'https://animesonline.in', 'https://animesonline.nz',
  'https://goyabu.to', 'https://animeyabu.net', 'https://animesdigital.org',
  'https://animesonlinegames.com', 'https://animes.vision', 'https://animesbr.tv',
  'https://animeshouse.net', 'https://animesonline.vip', 'https://www.animesonlinecc.to'
];
const TESTS = [['Death Note', 1, 'sub'], ['Naruto Shippuden', 1, 'dub'], ['One Piece', 1000, 'sub']];

(async () => {
  const working = [];
  for (const base of CANDIDATES) {
    src.DOOPLAY_SITES.length = 0;
    src.DOOPLAY_SITES.push({ name: 'Probe', base });
    src.clearCaches();
    let hits = 0;
    const notes = [];
    for (const [title, ep, lang] of TESTS) {
      const r = await Promise.race([
        src.findEpisodeEmbeds(title, ep, lang).catch(e => ({ embeds: [], trace: { error: e.message } })),
        new Promise(res => setTimeout(() => res({ embeds: [], trace: { error: 'timeout' } }), 60000))
      ]);
      if (r.embeds.length) hits++;
      notes.push(title + ' ' + ep + ': ' + r.embeds.map(e => e.kind + ':' + e.label).join(', ') + ' ' + JSON.stringify(r.trace).slice(0, 220));
    }
    console.log('\n' + base + ' => ' + hits + '/' + TESTS.length);
    notes.forEach(n => console.log('   ' + n));
    if (hits) working.push(base + ' (' + hits + '/' + TESTS.length + ')');
  }
  console.log('\nWORKING: ' + (working.join(', ') || 'none'));
  process.exit(0);
})();
