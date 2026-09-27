// End-to-end check: ask the local server for an episode's players, load each one in real Chrome
// inside our app's page, and report whether a <video> actually advances.
const { chromium } = require('playwright');

const API = 'http://localhost:3000';
const CASES = [
  ['Death Note', 1],
  ['Naruto Shippuden (Naruto Shippuuden)', 451],
  ['One Piece', 1000],
];

// Host the iframe on the real app origin so embeds see the same Referer users send.
const APP_ORIGIN = 'https://elielreinan.github.io';

async function probeEmbed(browser, embed, referrerPolicy) {
  const page = await browser.newPage();
  const net = [];
  page.on('response', r => {
    const u = r.url();
    if (/mode=|m3u8|\.mp4|videoplayback|api/i.test(u) && !/google-analytics|gtag|doubleclick/.test(u)) net.push(r.status() + ' ' + u.slice(0, 110));
  });
  await page.route(APP_ORIGIN + '/anime-hub/player-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>' }));
  await page.goto(APP_ORIGIN + '/anime-hub/player-test');
  await page.evaluate(([url, rp]) => {
    const f = document.createElement('iframe');
    f.src = url;
    f.allow = 'autoplay; encrypted-media; fullscreen';
    if (rp) f.referrerPolicy = rp;
    f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0';
    document.body.appendChild(f);
  }, [embed.url, referrerPolicy]);
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
  console.log('   ' + (playing ? 'PLAYING' : 'NO-PLAY') + ' [' + (referrerPolicy || 'default') + '] ' + embed.label + ' | ' + embed.url.slice(0, 90));
  found.forEach(f => console.log('      frame ' + f.frame + ' -> ' + JSON.stringify(f.vids)));
  if (!playing) {
    for (const frame of page.frames().slice(1)) {
      const text = await frame.evaluate(() => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160)).catch(() => '?');
      console.log('      text ' + frame.url().slice(0, 60) + ' :: ' + text);
    }
    net.slice(0, 8).forEach(n => console.log('      net ' + n));
  }
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
    for (const e of embeds.slice(0, 4)) {
      let played = await probeEmbed(browser, e, '');
      if (!played) played = await probeEmbed(browser, e, 'no-referrer');
      ok = played || ok;
    }
    console.log('   => ' + (ok ? 'OK: at least one player plays' : 'FAIL: nothing played'));
    if (!ok) anyCaseFailed = true;
  }
  await browser.close();
  process.exitCode = anyCaseFailed ? 1 : 0;
})();
