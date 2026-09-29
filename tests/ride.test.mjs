// End-to-end ride tests for Berlin divided.
// Fakes the phone's GPS along the real route in Chromium and checks what the app says and plays.
//
//   (cd berlin-divided && npm install) && cd tests && npm install && npm test
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

async function openTour({ mode = 'tap', travel = 'bike', bonus = [], at = ROUTE[0], serviceWorkers = 'block' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 800 }, geolocation: geo(at), permissions: ['geolocation'], serviceWorkers,
  });
  await ctx.route(/tile\.openstreetmap\.org|fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.abort());
  await ctx.addInitScript(([m, t, b]) => { if (!sessionStorage.seeded) { localStorage.clear(); localStorage.setItem('bd_storymode', JSON.stringify(m)); localStorage.setItem('bd_travel', JSON.stringify(t)); localStorage.setItem('bd_bonus', JSON.stringify(b)); sessionStorage.seeded = 1; } }, [mode, travel, bonus]);
  // headless Chromium has no voices; a stand-in that "speaks" each sentence in 20 ms keeps runs deterministic
  await ctx.addInitScript(() => {
    const q = []; let busy = false;
    const next = () => { const u = q.shift(); if (!u) { busy = false; return; } busy = true; setTimeout(() => { u.onend && u.onend(); next(); }, 20); };
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { value: {
      speak(u) { if (u.text) window.__spoken.push(u.text); q.push(u); if (!busy) next(); },
      cancel() { q.length = 0; }, pause() {}, resume() {}, getVoices: () => [], get speaking() { return busy; },
    } });
  });
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

test('tell me more: offered after the story, then read out in full', async () => {
  const { ctx, page, errors } = await openTour({ mode: 'tap' });
  await page.click('#startBtn');
  await finishAudio(page);
  await ctx.setGeolocation(geo(pointAt(5)));
  await page.waitForFunction(() => __tour.pending === 'reichstag');
  await page.click('#playBtn');
  await page.waitForFunction(() => __tour.current === 'reichstag');
  await finishAudio(page);
  await page.waitForFunction(() => document.getElementById('moreBtn').classList.contains('offer'));
  assert.match(await page.textContent('#moreBtn'), /Tell me more about the Reichstag/);
  assert.match(await page.textContent('#kicker'), /Tell me more/);
  const before = await page.evaluate(() => window.__spoken.length);
  await page.click('#moreBtn');
  assert.equal(await page.isHidden('#moreBtn'), true, 'no offer while it plays');
  await page.waitForFunction(() => !__tour.tts, null, { timeout: 20000 });
  const read = await page.evaluate(n => window.__spoken.slice(n).join(' '), before);
  const more = TOUR.stops[0].more.text;
  assert.ok(read.startsWith(more.slice(0, 40)) && read.endsWith(more.slice(-40)), 'whole deep dive read out');
  assert.ok((await log(page)).some(x => x.kind === 'more' && x.id === 'reichstag'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('bonus stop: detour after its stop, story, back to the route; can be skipped', { timeout: 90000 }, async () => {
  const bonus = TOUR.bonus.find(b => b.id === 'traenenpalast');
  const { ctx, page, errors } = await openTour({ mode: 'auto', bonus: ['traenenpalast'] });
  assert.match(await page.textContent('#bonusPick'), /Tränenpalast/);
  await page.click('#startBtn');
  await ctx.setGeolocation(geo(pointAt(5)));
  await finishAudio(page); await page.waitForFunction(() => __tour.current === 'reichstag'); await finishAudio(page);
  await page.waitForFunction(() => __tour.bonus === 'traenenpalast');
  assert.match(await page.textContent('#navInstr'), /Bonus stop: The Tränenpalast/);
  assert.equal(await page.isVisible('#navSkip'), true);
  const legStart = TOUR.nav[0][0].clip;
  assert.ok(!(await log(page)).some(x => x.clip === legStart), 'directions to stop 2 wait until after the detour');
  // ride there in a straight line, well off the route
  const from = pointAt(5), to = [bonus.lat, bonus.lng];
  for (let i = 1; i <= 12; i++) {
    await ctx.setGeolocation(geo([from[0] + (to[0] - from[0]) * i / 12, from[1] + (to[1] - from[1]) * i / 12]));
    await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => __tour.current === 'traenenpalast', null, { timeout: 5000 });
  assert.ok(!(await log(page)).some(x => x.clip === TOUR.offroute), 'no off-route warning on the detour');
  await page.waitForFunction(() => !__tour.tts, null, { timeout: 20000 }); // read by the stand-in voice
  assert.equal(await page.evaluate(() => __tour.bonus), null);
  assert.match(await page.textContent('#navInstr'), /head back to the route/i);
  assert.ok(await page.evaluate(() => __tour.played.includes('traenenpalast')));
  assert.match(await page.textContent('#stopList'), /bonus/);
  await ctx.close();

  // skipping it starts the normal directions straight away
  const second = await openTour({ mode: 'auto', bonus: ['traenenpalast'] });
  await second.page.click('#startBtn');
  await second.ctx.setGeolocation(geo(pointAt(5)));
  await finishAudio(second.page); await second.page.waitForFunction(() => __tour.current === 'reichstag'); await finishAudio(second.page);
  await second.page.waitForFunction(() => __tour.bonus === 'traenenpalast');
  await second.page.click('#navSkip');
  await second.page.waitForFunction(c => __tour.log.some(x => x.clip === c), legStart);
  assert.equal(await second.page.evaluate(() => __tour.bonus), null);
  assert.deepEqual([...errors, ...second.errors], []);
  await second.ctx.close();
});

test('then and now: the stop photo shows with its credit and licence, and opens full size', async () => {
  const { ctx, page, errors } = await openTour({ mode: 'tap' });
  // no photos are downloaded yet, so give the first stop one (the app icon) through the tour JSON
  const photo = { src: 'icons/icon-512.png', caption: 'A test photo', year: '1961', author: 'Test Author',
    licence: 'CC BY-SA 3.0 de', licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/de/deed.en', source: 'https://commons.wikimedia.org/wiki/File:Test.jpg' };
  await page.route('**/data/berlin-divided.json', async r => {
    const j = await (await r.fetch()).json(); j.stops[0].photo = photo; r.fulfill({ json: j });
  });
  await page.reload(); await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
  await page.click('#startBtn');
  assert.equal(await page.isHidden('#photo'), true, 'no photo with the intro');
  await finishAudio(page);
  await ctx.setGeolocation(geo(pointAt(5)));
  await page.waitForFunction(() => __tour.pending === 'reichstag');
  assert.equal(await page.isVisible('#photo'), true, 'photo shows on arrival');
  assert.equal(await page.textContent('#photoCap'), 'A test photo, 1961.');
  assert.match(await page.textContent('#photoCredit'), /Test Author, CC BY-SA 3\.0 de/);
  await page.click('#photoOpen');
  assert.equal(await page.isVisible('#lightbox'), true);
  assert.equal(await page.getAttribute('#lightCredit a[href*="creativecommons"]', 'href'), photo.licenceUrl);
  assert.equal(await page.getAttribute('#lightCredit a[href*="commons.wikimedia"]', 'href'), photo.source);
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#lightbox'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('group ride: followers hear the leader\'s story in step and see each other on the map', { timeout: 90000 }, async () => {
  const lead = await openTour({ mode: 'auto', at: [52.5203, 13.3738] }); // 250 m from the first stop
  await lead.page.fill('#groupName', 'Anna');
  await lead.page.click('#groupCreate');
  await lead.page.waitForFunction(() => __tour.group && __tour.group.online && __tour.group.code);
  const code = await lead.page.textContent('#groupCodeShow');
  assert.match(code, /^[A-HJKMNP-Z]{4}$/);

  // the follower stands somewhere else: stories follow the leader, not the follower's own position
  const fol = await openTour({ mode: 'auto', at: pointAt(3000) });
  await fol.page.fill('#groupName', 'Ben');
  await fol.page.fill('#groupCode', code.toLowerCase());
  await fol.page.click('#groupJoin');
  await fol.page.waitForFunction(() => __tour.group && __tour.group.online && __tour.group.members === 2);
  assert.match(await fol.page.textContent('#groupWho'), /Following Anna/);
  await lead.page.waitForFunction(() => __tour.group.members === 2);
  assert.match(await lead.page.textContent('#groupWho'), /You lead · 1 rider with you/);

  await lead.page.click('#startBtn'); await fol.page.click('#startBtn');
  await finishAudio(lead.page);
  await lead.ctx.setGeolocation(geo(pointAt(5)));
  await lead.page.waitForFunction(() => __tour.current === 'reichstag' && !document.getElementById('audio').paused);
  await fol.page.waitForFunction(() => __tour.current === 'reichstag' && !document.getElementById('audio').paused, null, { timeout: 8000 });
  // jump the leader ahead: the follower catches up
  await lead.page.evaluate(() => { document.getElementById('audio').currentTime = 40; });
  await fol.page.waitForFunction(() => Math.abs(document.getElementById('audio').currentTime - 40) < 3, null, { timeout: 8000 });
  const [a, b] = await Promise.all([lead.page, fol.page].map(p => p.evaluate(() => document.getElementById('audio').currentTime)));
  assert.ok(Math.abs(a - b) < 2.5, `in step: leader ${a.toFixed(1)} s, follower ${b.toFixed(1)} s`);
  // pause and resume together
  await lead.page.click('#playBtn');
  await fol.page.waitForFunction(() => document.getElementById('audio').paused, null, { timeout: 8000 });
  await lead.page.click('#playBtn');
  await fol.page.waitForFunction(() => !document.getElementById('audio').paused, null, { timeout: 8000 });

  // positions: each sees the other on the map, with a name
  await fol.ctx.setGeolocation(geo(pointAt(3010)));
  await lead.page.waitForFunction(() => [...document.querySelectorAll('.membername')].some(e => e.textContent === 'Ben'), null, { timeout: 10000 });
  await lead.ctx.setGeolocation(geo(pointAt(8)));
  await fol.page.waitForFunction(() => [...document.querySelectorAll('.membername')].some(e => e.textContent === 'Anna (leads)'), null, { timeout: 10000 });
  assert.ok(!(await log(fol.page)).some(x => x.kind === 'story' && x.id === 'potsdamer'), 'follower\'s own position does not start stories');

  // the leader reloads the page and is still the leader
  await lead.page.reload(); await lead.page.waitForFunction(() => __tour.group && __tour.group.online);
  assert.equal(await lead.page.evaluate(() => __tour.group.leader), true);
  assert.deepEqual([...lead.errors, ...fol.errors], []);
  await lead.ctx.close(); await fol.ctx.close();
});

test('group ride: a wrong code says so', async () => {
  const { ctx, page, errors } = await openTour();
  await page.fill('#groupCode', 'QQQQ'); await page.click('#groupJoin');
  await page.waitForFunction(() => !document.getElementById('groupErr').hidden);
  assert.match(await page.textContent('#groupErr'), /No group with that code/);
  assert.equal(await page.evaluate(() => __tour.group), null);
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

test('walking vs cycling: smaller stop radius and longer time estimate on foot', async () => {
  const facts = {};
  for (const travel of ['bike', 'walk']) {
    const stop = [TOUR.stops[0].lat, TOUR.stops[0].lng], along = m => { let d = 0; while (dist(pointAt(d), stop) < m) d += 1; return pointAt(d); };
    const { ctx, page, errors } = await openTour({ mode: 'auto', travel, at: along(70) });
    facts[travel] = [await page.textContent('#factHow'), await page.textContent('#factTime')];
    await page.click('#startBtn');
    await finishAudio(page);
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => __tour.pending), null, '70 m away is outside both radii');
    await ctx.setGeolocation(geo(along(38))); // 38 m from the first stop
    await page.waitForTimeout(1200);
    facts[travel].push(await page.evaluate(() => __tour.pending || __tour.current));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  assert.deepEqual(facts.bike, ['by bike', '~2 h', 'reichstag']);
  assert.equal(facts.walk[0], 'on foot');
  assert.equal(facts.walk[2], 'intro', 'on foot, 38 m is not yet at the stop');
  const hours = t => parseFloat(/~([\d.]+) h/.exec(t)[1]);
  assert.ok(hours(facts.walk[1]) >= 4, `walking estimate ${facts.walk[1]}`);
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
