// A full GPS ride along every built tour: every story plays once, in order, turn prompts fire,
// no stop is missed and nothing throws. Prints the real distance and riding or walking time.
//
//   cd tests && npm test -- tours.test.mjs            # every ready tour in tours/index.json
//   TOURS=amsterdam/war node --test tours.test.mjs   # only these (space separated)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../berlin-divided');
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tours/index.json'), 'utf8')).tours;
const WANT = (process.env.TOURS || '').split(/\s+/).filter(Boolean);
const TOURS = CATALOGUE.filter(t => t.ready && (!WANT.length || WANT.includes(t.path)));

const rad = x => x * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

let server, browser;
before(async () => {
  server = await start(ROOT);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function finishAudio(page) {
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate(() => {
      const a = document.getElementById('audio');
      if ((a.paused || a.ended) && !__tour.tts) return true;
      if (isFinite(a.duration) && a.currentTime < a.duration - 0.3) a.currentTime = a.duration - 0.05;
      return false;
    });
    if (done) return;
    await page.waitForTimeout(25);
  }
  throw new Error('audio never finished');
}

for (const entry of TOURS) {
  test(`${entry.path}: full ride along the route`, { timeout: 900000 }, async () => {
    const base = `tours/${entry.path}/`;
    const T = JSON.parse(fs.readFileSync(path.join(ROOT, base, 'tour.json'), 'utf8'));
    const route = T.route, cum = [0];
    for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + dist(route[i - 1], route[i]));
    const total = cum.at(-1);
    const pointAt = d => {
      if (d >= total) return route.at(-1);
      const i = Math.max(1, cum.findIndex(c => c >= d)), f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f];
    };
    const geo = ([latitude, longitude]) => ({ latitude, longitude, accuracy: 8 });
    // what the app logs for a step: its clip path when it has audio, else the text read by the phone
    const key = st => (st.clip ? new URL(base + st.clip, server.url).pathname.slice(1) : st.text);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, geolocation: geo(route[0]), permissions: ['geolocation'], serviceWorkers: 'block', locale: 'en-GB' });
    await ctx.route(/tile\.openstreetmap\.org|fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.abort());
    await ctx.addInitScript(p => {
      if (!sessionStorage.seeded) { localStorage.clear(); localStorage.setItem('bd_storymode', '"auto"'); localStorage.setItem('bd_tour', JSON.stringify(p)); sessionStorage.seeded = 1; }
      const q = []; let busy = false; // headless Chromium has no voices: "speak" each sentence in 20 ms
      const next = () => { const u = q.shift(); if (!u) { busy = false; return; } busy = true; setTimeout(() => { u.onend && u.onend(); next(); }, 20); };
      Object.defineProperty(window, 'speechSynthesis', { value: { speak(u) { q.push(u); if (!busy) next(); }, cancel() { q.length = 0; }, pause() {}, resume() {}, getVoices: () => [], get speaking() { return busy; } } });
    }, entry.path);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(server.url);
    await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
    assert.equal(await page.evaluate(() => __tour.travel), T.mode);
    await page.click('#homeCard'); await page.click('#startBtn');

    const step = T.mode === 'walk' ? 5 : 8;
    for (let d = 0; d <= total + step; d += step) {
      await ctx.setGeolocation(geo(pointAt(d)));
      await page.waitForTimeout(12);
      await finishAudio(page);
    }
    for (let i = 0; i < 20 && await page.evaluate(() => __tour.current) !== 'outro'; i++) { await finishAudio(page); await page.waitForTimeout(50); }
    await finishAudio(page);

    const log = await page.evaluate(() => __tour.log.map(x => ({ ...x })));
    const stories = log.filter(x => x.kind === 'story').map(x => x.id);
    assert.deepEqual(stories, ['intro', ...T.stops.map(s => s.id), 'outro'], 'every story once, in route order, no stop missed');
    const said = new Set(log.filter(x => x.kind === 'clip').map(x => x.clip || x.text));
    for (const [l, leg] of T.legs.entries()) assert.ok(said.has(key(leg.steps[0])), `leg ${l + 1} starts with directions`);
    const turns = T.legs.flatMap(l => l.steps.slice(1));
    const fired = turns.filter(st => said.has(key(st))).length;
    assert.ok(!turns.length || fired / turns.length >= 0.9, `turn prompts: ${fired} of ${turns.length} fired`);
    const offroute = T.offroute && (T.offroute.clip ? key(T.offroute) : T.offroute.text);
    assert.ok(!log.some(x => (x.clip || x.text) === offroute), 'no off-route warning while on the route');
    await page.waitForFunction(() => __tour.screen === 'complete');
    assert.deepEqual(errors, []);
    console.log(`  ${entry.path}: ${(total / 1000).toFixed(1)} km, ${T.mode === 'walk' ? 'walking' : 'riding'} ${T.ride_min} min, tour ${T.duration_min} min; stories ${stories.length}, turn prompts ${fired}/${turns.length}`);
    for (const [l, leg] of T.legs.entries()) for (const st of leg.steps.slice(1)) if (!said.has(key(st))) console.log(`    not spoken (leg ${l + 1}): ${st.text}`);
    await ctx.close();
  });
}
