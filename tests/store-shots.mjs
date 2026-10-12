// Screenshots for the Google Play listing (1080 x 1920) and the feature graphic (1024 x 500),
// taken from the real app with real map tiles. Needs internet. Writes to the folder given:
//   node tests/store-shots.mjs ../store-assets
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../berlin-divided');
const OUT = path.resolve(process.argv[2] || 'store-assets');
fs.mkdirSync(OUT, { recursive: true });
const war = JSON.parse(fs.readFileSync(path.join(ROOT, 'tours/amsterdam/war/tour.json'), 'utf8'));

const server = await start(ROOT);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'] });

async function phone(locale, at, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, locale, geolocation: { latitude: at[0], longitude: at[1], accuracy: 8 }, permissions: ['geolocation'], serviceWorkers: 'block' });
  await ctx.route('**/api/status', r => r.fulfill({ json: { make: true, ask: true } }));
  await ctx.addInitScript(() => { localStorage.setItem('bd_storymode', '"tap"'); });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto(server.url + query);
  await page.waitForFunction(() => window.__tour && !document.getElementById('startBtn').disabled);
  return { ctx, page };
}
const settle = page => page.waitForTimeout(3500); // map tiles and 3D buildings
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) }).then(() => console.log('wrote', name));

for (const locale of ['en-GB', 'nl-NL']) {
  const tag = locale.slice(0, 2);
  // 1. home, standing on the Dam
  let { ctx, page } = await phone(locale, [52.3731, 4.8914]);
  await page.waitForFunction(() => document.getElementById('brandCity')?.textContent === 'Amsterdam', null, { timeout: 20000 });
  await settle(page); await shot(page, `${tag}-1-home.png`);
  // 2. the three questions
  await page.click('#makeCta'); await page.click('#interestPick [data-k="war"]').catch(() => {});
  await page.waitForTimeout(400); await shot(page, `${tag}-2-make.png`);
  await ctx.close();
  // 3. a tour page with its map, and 4. riding it in 3D
  ({ ctx, page } = await phone(locale, [war.stops[0].lat, war.stops[0].lng], '?tour=amsterdam/war'));
  await page.click('#homeCard'); await settle(page); await shot(page, `${tag}-3-tour.png`);
  const route = war.route, mid = route[Math.floor(route.length * 0.35)];
  await ctx.setGeolocation({ latitude: mid[0], longitude: mid[1], accuracy: 6 });
  await page.click('#startBtn'); await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) { const p = route[Math.floor(route.length * 0.35) + i]; await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 6 }); await page.waitForTimeout(300); }
  await settle(page); await shot(page, `${tag}-4-ride.png`);
  // 5. a story, with the guide to ask
  await page.click('#openStory').catch(() => {}); await page.waitForTimeout(800); await shot(page, `${tag}-5-story.png`);
  await ctx.close();
}

// the feature graphic: the brand on the app's purple, with a tilted map card
const fg = await browser.newPage({ viewport: { width: 1024, height: 500 } });
await fg.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&display=swap" rel="stylesheet">
<style>body{margin:0;width:1024px;height:500px;overflow:hidden;font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:linear-gradient(135deg,#584DD3,#3A2FB0);color:#fff;display:flex;align-items:center}
.l{padding:0 0 0 70px;width:520px}.logo{width:84px;height:84px;border-radius:50%;background:#fff;display:grid;place-items:center;margin-bottom:26px}
h1{font-size:54px;line-height:1.05;margin:0 0 16px;font-weight:800}p{font-size:22px;margin:0;opacity:.9}
.r{flex:1;height:100%;position:relative}.card{position:absolute;right:60px;top:60px;width:300px;height:380px;border-radius:32px;background:#fff;transform:rotate(6deg);box-shadow:0 30px 60px rgba(0,0,0,.35);overflow:hidden}
.card svg{width:100%;height:100%}</style></head><body>
<div class="l"><div class="logo"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M12 22s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z" fill="#584DD3"/><circle cx="12" cy="11" r="2.6" fill="#fff"/></svg></div>
<h1>Your city,<br>told on the way</h1><p>Audio tours on foot or by bike, made for where you are.</p></div>
<div class="r"><div class="card"><svg viewBox="0 0 300 380"><rect width="300" height="380" fill="#EEF0F7"/>
<g stroke="#fff" stroke-width="14"><path d="M-10 90 L310 60"/><path d="M60 -10 L90 390"/><path d="M-10 250 L310 290"/><path d="M200 -10 L230 390"/></g>
<path d="M70 330 C 90 260, 150 250, 160 190 S 210 110, 230 60" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>
<path d="M70 330 C 90 260, 150 250, 160 190 S 210 110, 230 60" fill="none" stroke="#584DD3" stroke-width="7" stroke-linecap="round"/>
<g font-family="sans-serif" font-weight="700" font-size="13" text-anchor="middle"><circle cx="70" cy="330" r="14" fill="#584DD3"/><text x="70" y="335" fill="#fff">1</text>
<circle cx="160" cy="190" r="14" fill="#E63946"/><text x="160" y="195" fill="#fff">2</text><circle cx="230" cy="60" r="14" fill="#fff" stroke="#C0C0D0" stroke-width="2"/><text x="230" y="65" fill="#8888A0">3</text></g></svg></div></div>
</body></html>`, { waitUntil: 'networkidle' });
await fg.screenshot({ path: path.join(OUT, 'feature-graphic.png') }); console.log('wrote feature-graphic.png');
fs.copyFileSync(path.join(ROOT, 'icons/icon-512.png'), path.join(OUT, 'icon-512.png'));

await browser.close(); server.close();
