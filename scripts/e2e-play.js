// End-to-end playback check through the real app UI in real Chrome:
// open the player via the app's own openPlayer(), then try each server button
// and report whether a video actually advances.
// Usage: node scripts/e2e-play.js [appUrl]   (default http://localhost:3000/)
const { chromium } = require('playwright');

const APP = process.argv[2] || 'http://localhost:3000/';
const CASES = [
  ['Death Note', 1],
  ['Naruto Shippuden (Naruto Shippuuden)', 451],
  ['One Piece', 1000],
];

async function videoProgress(frame) {
  return frame.evaluate(async () => {
    const vids = Array.from(document.querySelectorAll('video')).filter(v => v.currentSrc || v.src);
    for (const v of vids) { v.muted = true; try { await v.play(); } catch (e) {} }
    const before = vids.map(v => v.currentTime);
    await new Promise(r => setTimeout(r, 6000));
    return vids.map((v, i) => ({ adv: +(v.currentTime - before[i]).toFixed(1), t: +v.currentTime.toFixed(1), ready: v.readyState, err: v.error && v.error.code }));
  }).catch(() => []);
}

async function runCase(browser, title, ep) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 140)); });
  await page.goto(APP, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.evaluate(([title, ep]) => {
    currentAnime = { id: 1, category_name: title };
    openPlayer(1, ep, 9999);
  }, [title, ep]);
  await page.waitForFunction(() => document.querySelectorAll('.server-btn').length > 0 || /indispon|não disponível|Erro/i.test(document.getElementById('player-status').textContent), null, { timeout: 90000 }).catch(() => {});
  const servers = await page.$$eval('.server-btn', bs => bs.map(b => b.textContent));
  console.log('\n' + title + ' ep ' + ep + ': ' + servers.length + ' servers in ' + (Date.now() - t0) + 'ms ' + JSON.stringify(servers));
  if (!servers.length) {
    console.log('   status: ' + (await page.textContent('#player-status')) + ' | console: ' + logs.slice(0, 3).join(' | '));
    await page.close();
    return false;
  }

  let ok = false;
  for (let i = 0; i < Math.min(servers.length, 5); i++) {
    await page.evaluate(i => selectServer(i), i);
    await page.waitForTimeout(8000);
    const iframeMode = await page.evaluate(() => document.getElementById('player-overlay').classList.contains('iframe-mode'));
    if (iframeMode) {
      const box = await page.$eval('#player-iframe', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.click(box.x, box.y).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const results = [];
    for (const f of page.frames()) {
      const vids = await videoProgress(f);
      if (vids.length) results.push({ frame: f.url().slice(0, 50), vids });
    }
    const playing = results.some(r => r.vids.some(v => v.adv > 1));
    ok = ok || playing;
    console.log('   ' + (playing ? 'PLAYING' : 'NO-PLAY') + ' ' + servers[i] + ' ' + JSON.stringify(results));
    if (!playing) {
      const texts = [];
      for (const f of page.frames().slice(1)) texts.push(await f.evaluate(() => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100)).catch(() => '?'));
      console.log('      frames text: ' + JSON.stringify(texts) + ' | console: ' + logs.slice(-2).join(' | '));
    }
  }
  console.log('   => ' + (ok ? 'OK' : 'FAIL'));
  await page.close();
  return ok;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = 0;
  for (const [title, ep] of CASES) if (!(await runCase(browser, title, ep))) failed++;
  await browser.close();
  console.log('\n' + (CASES.length - failed) + '/' + CASES.length + ' cases playing');
  process.exitCode = failed ? 1 : 0;
})();
