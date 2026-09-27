// End-to-end check: ask the local server for an episode's players, load each one in real Chrome
// inside our app's page, and report whether a <video> actually advances.
const { chromium } = require('playwright');

const API = 'http://localhost:3000';
const CASES = [
  ['Death Note', 1],
  ['Naruto Shippuden (Naruto Shippuuden)', 451],
  ['One Piece', 1000],
];

async function probeEmbed(browser, embed) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 120)));
  await page.goto(API + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(url => {
    document.body.innerHTML = '';
    const f = document.createElement('iframe');
    f.src = url;
    f.allow = 'autoplay; encrypted-media; fullscreen';
    f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0';
    document.body.appendChild(f);
  }, embed.url);
  await page.waitForTimeout(8000);
  await page.mouse.click(640, 360).catch(() => {});
  await page.waitForTimeout(4000);

  const found = [];
  for (const frame of page.frames()) {
    const vids = await frame.evaluate(async () => {
      const out = [];
      for (const v of document.querySelectorAll('video')) {
        v.muted = true;
        try { await v.play(); } catch (e) {}
        out.push(v);
      }
      await new Promise(r => setTimeout(r, 6000));
      return out.map(v => ({ t: +v.currentTime.toFixed(1), ready: v.readyState, err: v.error && v.error.code, src: (v.currentSrc || '').slice(0, 80) }));
    }).catch(e => [{ evalError: e.message.slice(0, 80) }]);
    if (vids.length) found.push({ frame: frame.url().slice(0, 70), vids });
  }
  const playing = found.some(f => f.vids.some(v => v.t > 0.5));
  console.log('   ' + (playing ? 'PLAYING' : 'NO-PLAY') + ' ' + embed.label + ' | ' + embed.url.slice(0, 90));
  found.forEach(f => console.log('      frame ' + f.frame + ' -> ' + JSON.stringify(f.vids)));
  if (!found.length) console.log('      no <video> in ' + page.frames().length + ' frames; errors: ' + errors.slice(0, 3).join(' | '));
  await page.close();
  return playing;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let anyCaseFailed = false;
  for (const [title, ep] of CASES) {
    const t = Date.now();
    const r = await fetch(API + '/api/episode/x/' + ep + '?title=' + encodeURIComponent(title)).then(r => r.json());
    const embeds = (r.data && r.data.embeds) || [];
    console.log('\n' + title + ' ep ' + ep + ': ' + embeds.length + ' players in ' + (Date.now() - t) + 'ms');
    console.log('   trace ' + JSON.stringify(r.trace));
    let ok = false;
    for (const e of embeds.slice(0, 4)) ok = (await probeEmbed(browser, e)) || ok;
    console.log('   => ' + (ok ? 'OK: at least one player plays' : 'FAIL: nothing played'));
    if (!ok) anyCaseFailed = true;
  }
  await browser.close();
  process.exitCode = anyCaseFailed ? 1 : 0;
})();
