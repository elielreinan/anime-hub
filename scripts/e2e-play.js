// End-to-end playback check through the real app UI in real Chrome:
// open the player via the app's own openPlayer(), then try each server button
// and report whether a video actually advances.
// Usage: node scripts/e2e-play.js [appUrl]   (default http://localhost:3000/)
const { chromium, webkit } = require('playwright');
const ENGINE = process.env.BROWSER || 'chrome';

const APP = process.argv[2] || 'http://localhost:3000/';
const CASES = [
  ['Super no Ura de Yani Suu Futari', 1],
  ['Death Note', 1],
  ['Naruto Shippuden (Naruto Shippuuden)', 451],
  ['One Piece', 1000],
];

async function videoProgress(frame) {
  const run = frame.evaluate(async () => {
    const vids = Array.from(document.querySelectorAll('video')).filter(v => v.currentSrc || v.src);
    vids.forEach(v => { v.muted = true; v.play().catch(() => {}); });
    const before = vids.map(v => v.currentTime);
    await new Promise(r => setTimeout(r, 6000));
    return vids.map((v, i) => ({ adv: +(v.currentTime - before[i]).toFixed(1), t: +v.currentTime.toFixed(1), ready: v.readyState, err: v.error && v.error.code }));
  }).catch(() => []);
  return Promise.race([run, new Promise(r => setTimeout(() => r([]), 12000))]);
}

// Reload once the service worker is active so it controls the page, as it does for
// returning users (a first visit is not controlled and hides worker bugs).
async function openApp(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  const controlled = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise(r => setTimeout(() => r(false), 10000))
  ])).catch(() => false);
  if (controlled) await page.reload({ waitUntil: 'load' });
  return page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)).catch(() => false);
}

async function runCase(browser, title, ep) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 140)); });
  const sw = await openApp(page, APP);
  const t0 = Date.now();
  await page.evaluate(([title, ep]) => {
    currentAnime = { id: 1, category_name: title };
    openPlayer(1, ep, 9999);
  }, [title, ep]);
  await page.waitForFunction(() => document.querySelectorAll('.server-btn').length > 0 || /indispon|não disponível|Erro/i.test(document.getElementById('player-status').textContent), null, { timeout: 90000 }).catch(() => {});
  const servers = await page.$$eval('.server-btn', bs => bs.map(b => b.textContent));
  console.log('\n' + title + ' ep ' + ep + ' [' + ENGINE + (sw ? ', sw' : '') + ']: ' + servers.length + ' servers in ' + (Date.now() - t0) + 'ms ' + JSON.stringify(servers));
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

// Room-first party: A creates a room on the home screen, B joins through the link,
// A opens an episode and B must follow; then a seek on A must move B too.
async function partyCase(browser, title, ep) {
  const a = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await openApp(a, APP);
  await a.evaluate(() => createParty());
  await a.waitForFunction(() => party && document.querySelector('.party-code'), null, { timeout: 60000 });
  const code = await a.evaluate(() => party.code);
  const b = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await b.goto(APP + '?party=' + code, { waitUntil: 'load' });
  await a.waitForFunction(() => party.members === 2, null, { timeout: 30000 }).catch(() => {});
  // Muted like a viewer who already tapped play: browsers block unmuted autoplay without a gesture.
  const logHooks = () => {
    document.getElementById('player-video').muted = true;
    window._plog = [];
    const h = handlePartyEvent, api = partyApi;
    window.handlePartyEvent = ev => { _plog.push('recv ' + ev.type + (ev.time != null ? ' ' + ev.time.toFixed(1) : '') + ' dur=' + document.getElementById('player-video').duration); h(ev); };
    window.partyApi = (path, body) => { if (body && body.type) _plog.push('send ' + body.type + (body.time != null ? ' ' + body.time.toFixed(1) : '')); return api(path, body); };
  };
  await a.evaluate(logHooks);
  await b.evaluate(logHooks);
  await a.evaluate(([title, ep]) => { closePartySheet(); currentAnime = { id: 1, category_name: title }; openPlayer(1, ep, 9999); }, [title, ep]);
  const followed = await b.waitForFunction(ep => playerIsOpen() && playerEpisode === ep && document.getElementById('player-video').readyState >= 2, ep, { timeout: 120000 }).then(() => true, () => false);
  await a.waitForFunction(() => document.getElementById('player-video').readyState >= 2, null, { timeout: 120000 }).catch(() => {});
  await a.evaluate(() => { const v = document.getElementById('player-video'); v.muted = true; v.currentTime = 120; v.play(); });
  await a.waitForTimeout(8000);
  const ta = await a.evaluate(() => document.getElementById('player-video').currentTime);
  const tb = await b.evaluate(() => document.getElementById('player-video').currentTime);
  const ok = followed && Math.abs(ta - tb) < 3 && tb > 100;
  console.log('\nparty ' + code + ' (' + title + ') [' + ENGINE + ']: B followed=' + followed + ' A=' + ta.toFixed(1) + 's B=' + tb.toFixed(1) + 's => ' + (ok ? 'OK' : 'FAIL'));
  if (!ok) {
    console.log('   A log: ' + JSON.stringify(await a.evaluate(() => window._plog || [])));
    console.log('   B log: ' + JSON.stringify(await b.evaluate(() => window._plog || [])));
  }
  await a.close();
  await b.close();
  return ok;
}

(async () => {
  const browser = ENGINE === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = 0;
  const cases = process.env.ONLY === 'party' ? [] : CASES;
  for (const [title, ep] of cases) if (!(await runCase(browser, title, ep))) failed++;
  if (!(await partyCase(browser, 'Naruto Shippuden (Naruto Shippuuden)', 451))) failed++;
  await browser.close();
  console.log('\n' + (cases.length + 1 - failed) + '/' + (cases.length + 1) + ' checks passing');
  process.exitCode = failed ? 1 : 0;
})();
