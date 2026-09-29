// End-to-end ride tests for Berlin divided.
// Fakes the phone's GPS along the real route in Chromium and checks what the app says and plays.
//
//   cd tests && npm install && npm test
//
// Set CHROMIUM_PATH to use a specific browser binary. Map tiles and web fonts are blocked so the
// tests run offline and do not load the OpenStreetMap tile servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../berlin-divided');
const TOUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/berlin-divided.json'), 'utf8'));
const ROUTE = TOUR.route;

// ---------- geometry, same maths as the app ----------
const rad = x => x * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const cum = [0];
for (let i = 1; i < ROUTE.length; i++) cum.push(cum[i - 1] + dist(ROUTE[i - 1], ROUTE[i]));
const TOTAL = cum.at(-1);
function pointAt(d) {
  const i = Math.max(1, cum.findIndex(c => c >= d));
  if (d >= TOTAL) return ROUTE.at(-1);
  const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [ROUTE[i - 1][0] + (ROUTE[i][0] - ROUTE[i - 1][0]) * f, ROUTE[i - 1][1] + (ROUTE[i][1] - ROUTE[i - 1][1]) * f];
}
const geo = ([latitude, longitude]) => ({ latitude, longitude, accuracy: 8 });

// ---------- browser helpers ----------
let server, browser;
before(async () => {
  server = await start(ROOT);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});
after(async () => { await browser?.close(); server?.close(); });

async function openTour({ mode = 'tap', at = ROUTE[0], serviceWorkers = 'block' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 800 }, geolocation: geo(at), permissions: ['geolocation'], serviceWorkers,
  });
  await ctx.route(/tile\.openstreetmap\.org|fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.abort());
  await ctx.addInitScript(m => { if (!sessionStorage.seeded) { localStorage.clear(); localStorage.setItem('bd_storymode', JSON.stringify(m)); sessionStorage.seeded = 1; } }, mode);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(server.url);
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
  return { ctx, page, errors };
}
const audioState = page => page.evaluate(() => {
  const a = document.getElementById('audio');
  return { playing: !a.paused && !a.ended, src: a.src, t: a.currentTime, pending: __tour.pending, current: __tour.current };
});
// skip to the end of whatever is playing and wait until it has finished
async function finishAudio(page) {
  for (let i = 0; i < 200; i++) {
    const done = await page.evaluate(() => {
      const a = document.getElementById('audio');
      if (a.paused || a.ended) return true;
      if (isFinite(a.duration) && a.currentTime < a.duration - 0.3) a.currentTime = a.duration - 0.05;
      return false;
    });
    if (done) return;
    await page.waitForTimeout(25);
  }
  throw new Error('audio never finished');
}
const log = page => page.evaluate(() => __tour.log.map(x => ({ ...x })));

// ---------- tests ----------
test('full ride with GPS along the route: all stories in order, turn prompts fire, nothing throws', { timeout: 600000 }, async () => {
  const { ctx, page, errors } = await openTour({ mode: 'auto' });
  await page.click('#startBtn');
  for (let d = 0; d <= TOTAL + 8; d += 8) {
    await ctx.setGeolocation(geo(pointAt(d)));
    await page.waitForTimeout(12);
    await finishAudio(page); // a rider keeps listening before riding on; stories and prompts never overlap
  }
  for (let i = 0; i < 20 && (await audioState(page)).current !== 'outro'; i++) await finishAudio(page), await page.waitForTimeout(50);
  await finishAudio(page);

  const spoken = await log(page);
  const stories = spoken.filter(x => x.kind === 'story').map(x => x.id);
  assert.deepEqual(stories, ['intro', ...TOUR.stops.map(s => s.id), 'outro'], 'stories play once each, in route order');

  const clips = new Set(spoken.filter(x => x.kind === 'clip').map(x => x.clip));
  const legStarts = TOUR.nav.map(l => l[0].clip);
  for (const c of legStarts) assert.ok(clips.has(c), `leg start prompt ${c} played`);
  const turns = TOUR.nav.flatMap(l => l.slice(1).map(s => s.clip));
  const fired = turns.filter(c => clips.has(c)).length;
  assert.ok(fired / turns.length >= 0.9, `turn prompts: ${fired} of ${turns.length} fired`);
  const pre = spoken.filter(x => x.kind === 'pre');
  assert.ok(pre.length >= 5, `pre-announcements: ${pre.length}`);
  assert.ok(pre.every(p => /^In 150 metres, /.test(p.text)));
  assert.ok(!spoken.some(x => x.clip === TOUR.offroute), 'no off-route warning while on the route');
  assert.deepEqual(errors, []);
  console.log(`  stories ${stories.length}, turn prompts ${fired}/${turns.length}, pre-announcements ${pre.length}`);
  for (const [l, leg] of TOUR.nav.entries()) for (const st of leg.slice(1)) if (!clips.has(st.clip))
    console.log(`  not spoken (leg ${l + 1}): ${st.text}  [${Math.round(Math.min(...TOUR.stops.map(p => dist([p.lat, p.lng], [st.lat, st.lng]))))} m from a stop]`);
  await ctx.close();
});

test('tap mode: arriving never starts the story by itself', async () => {
  const { ctx, page, errors } = await openTour({ mode: 'tap' });
  await page.click('#startBtn');
  await finishAudio(page); // intro
  await ctx.setGeolocation(geo(pointAt(5)));
  await page.waitForFunction(() => __tour.pending === 'reichstag');
  await page.waitForTimeout(2500);
  assert.equal((await audioState(page)).playing && (await audioState(page)).src.includes('/stories/'), false);
  assert.match(await page.textContent('#navDist'), /Arrived/);
  await page.click('#playBtn');
  await page.waitForFunction(() => __tour.current === 'reichstag' && !document.getElementById('audio').paused);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('stop-safe mode: waits until the rider has stopped for 5 seconds', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openTour({ mode: 'stopped', at: pointAt(0) });
  await page.click('#startBtn');
  await finishAudio(page);
  // ride through the stop radius at about 20 km/h
  const t0 = Date.now();
  for (let d = 0; d <= 40; d += 1.5) { await ctx.setGeolocation(geo(pointAt(d))); await page.waitForTimeout(270); }
  assert.ok(Date.now() - t0 > 6000);
  assert.equal(await page.evaluate(() => __tour.pending), 'reichstag', 'story is waiting while moving');
  assert.equal(await page.evaluate(() => __tour.current), 'intro');
  // stand still
  const stoppedAt = Date.now();
  await page.waitForFunction(() => __tour.current === 'reichstag', null, { timeout: 12000 });
  const waited = Date.now() - stoppedAt;
  assert.ok(waited >= 4000, `started ${waited} ms after stopping`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('off route: arrow and distance back to the route, warning and "turn around"', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await openTour({ mode: 'auto' });
  await page.click('#startBtn');
  await ctx.setGeolocation(geo(pointAt(5)));
  await finishAudio(page); await page.waitForFunction(() => __tour.current === 'reichstag'); await finishAudio(page);
  // ride 20 m per second heading due west, away from the route (which runs south here)
  const [lat, lng] = pointAt(10), mPerDegLng = 111320 * Math.cos(rad(lat));
  for (let i = 1; i <= 14; i++) {
    await ctx.setGeolocation(geo([lat, lng - (i * 20) / mPerDegLng]));
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const a = document.getElementById('audio'); if (!a.paused && isFinite(a.duration)) a.currentTime = a.duration - 0.05; });
  }
  assert.equal(await page.evaluate(() => __tour.offRoute), true);
  assert.match(await page.getAttribute('#navBanner', 'class'), /\boff\b/);
  assert.match(await page.textContent('#navInstr'), /Turn around/);
  assert.match(await page.textContent('#navDist'), /\d+ m/);
  const rot = await page.$eval('#navArrow svg', e => e.style.transform);
  assert.match(rot, /rotate\((-?\d+)deg\)/);
  const r = +/rotate\((-?\d+)deg\)/.exec(rot)[1];
  assert.ok(Math.abs(((r % 360) + 540) % 360 - 180) > 120, `arrow points back (${r} deg)`);
  const spoken = await log(page);
  assert.ok(spoken.some(x => x.clip === TOUR.offroute), 'off-route warning spoken');
  assert.ok(spoken.some(x => x.kind === 'turnaround'), '"turn around" spoken');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('offline: after the first visit the tour loads and plays without a connection', { timeout: 120000 }, async () => {
  const { ctx, page, errors } = await openTour({ serviceWorkers: 'allow' });
  await page.waitForFunction(() => document.getElementById('offlineStart').classList.contains('ready'), null, { timeout: 90000 });
  assert.equal(await page.textContent('#offlineStart'), 'Tour downloaded, ready offline');
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled, null, { timeout: 15000 });
  await page.click('#testBtn');
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.3, null, { timeout: 15000 });
  await page.evaluate(() => { document.getElementById('audio').currentTime = 20; }); // seeking needs byte ranges from the cache
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 20.2, null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});
