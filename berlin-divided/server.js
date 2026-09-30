// Audio tours server: serves the app and runs group rides over a WebSocket at /group.
// One process, so Railway needs a single service: `npm start` (PORT from the environment).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.md': 'text/plain; charset=utf-8',
};
const PRIVATE = /^\/(server\.js|package(-lock)?\.json|serve\.json|node_modules(\/|$)|lib(\/|$))|\/\./; // never served
const COMPRESS = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

/* ---------- static files ---------- */
function serveFile(req, res, root = ROOT, prefix = '') {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (PRIVATE.test(pathname)) { res.writeHead(404).end(); return; }
  let file = path.join(root, pathname.slice(prefix.length));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    // the app shell, service worker and tour data must update quickly; everything else is versioned by name
    headers['Cache-Control'] = /\.(html|js|css|json|webmanifest)$/.test(file) && !pathname.startsWith('/vendor/') ? 'no-cache' : 'public, max-age=86400';
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': st.size }).end(); return; }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { // byte ranges, which iPhone Safari needs for audio
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    if (COMPRESS.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- tours made on the spot ---------- */
// POST /api/tour {lat, lng, minutes, mode, interests[], note, lang} answers with newline-separated
// JSON: progress lines {step}, then {tour} or {error}. Needs ANTHROPIC_API_KEY; GET /api/status says
// whether it is available. Each phone may make MAKE_PER_HOUR tours an hour, the server
// TOUR_DAILY_LIMIT a day (default 200), and the same request within 6 hours is answered from memory.
const MAKE_PER_HOUR = 6, CACHE_MS = 6 * 3600e3;
// recorded voices of made tours: kept on disk for a week (phones keep their own copy offline)
const GEN_AUDIO = path.join(require('node:os').tmpdir(), 'tour-audio'), AUDIO_DAYS = 7;
async function saveAudio(tourId, name, buf) {
  const dir = path.join(GEN_AUDIO, tourId.replace(/[^\w-]/g, ''));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name.replace(/[^\w.-]/g, '')), buf);
  return `/gen/audio/${path.basename(dir)}/${name}`;
}
function sweepAudio() {
  fs.readdir(GEN_AUDIO, (err, dirs) => { if (err) return;
    for (const d of dirs) fs.stat(path.join(GEN_AUDIO, d), (e, st) => { if (!e && Date.now() - st.mtimeMs > AUDIO_DAYS * 864e5) fs.rm(path.join(GEN_AUDIO, d), { recursive: true, force: true }, () => {}); });
  });
}
setInterval(sweepAudio, 6 * 3600e3).unref();
const made = new Map(), cache = new Map(); let today = { day: '', count: 0 };
function makerFromEnv() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ timeout: 180e3, maxRetries: 1 });
  const { generateTour } = require('./lib/generate');
  return (req, onStep) => generateTour(req, { anthropic, onStep, saveAudio });
}
function readBody(req, max) {
  return new Promise((ok, fail) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > max) { fail(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}
const INTEREST_KEYS = ['history', 'war', 'architecture', 'art', 'famous', 'hidden', 'religion', 'local'];
function tourRequest(raw) {
  let b; try { b = JSON.parse(raw); } catch { return null; }
  const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180), minutes = num(b.minutes, 15, 240);
  if (lat == null || lng == null || minutes == null) return null;
  return { lat: +lat.toFixed(5), lng: +lng.toFixed(5), minutes: Math.round(minutes), mode: b.mode === 'bike' ? 'bike' : 'walk',
    interests: (Array.isArray(b.interests) ? b.interests : []).filter(i => INTEREST_KEYS.includes(i)).slice(0, 8),
    note: clean(b.note, 200) || null, lang: ['en', 'nl', 'de'].includes(b.lang) ? b.lang : 'en' };
}
async function makeTour(req, res, maker) {
  res.setHeader('Cache-Control', 'no-store');
  if (!maker) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not-configured' })); return; }
  let body; try { body = tourRequest(await readBody(req, 4096)); } catch { body = null; }
  if (!body) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad-request' })); return; }
  const key = JSON.stringify({ ...body, lat: body.lat.toFixed(3), lng: body.lng.toFixed(3), interests: [...body.interests].sort() });
  const hit = cache.get(key);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  const line = o => res.write(JSON.stringify(o) + '\n');
  if (hit && Date.now() - hit.at < CACHE_MS) { line({ tour: hit.tour }); res.end(); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), mine = (made.get(ip) || []).filter(t => now - t < 3600e3);
  const day = new Date().toISOString().slice(0, 10); if (today.day !== day) today = { day, count: 0 };
  if (mine.length >= MAKE_PER_HOUR) { line({ error: 'rate-limit' }); res.end(); return; }
  if (today.count >= (+process.env.TOUR_DAILY_LIMIT || 200)) { line({ error: 'busy' }); res.end(); return; }
  made.set(ip, [...mine, now]); today.count++;
  const beat = setInterval(() => line({ step: 'wait' }), 10e3); // keeps proxies from closing a quiet connection
  try {
    const tour = await maker(body, step => line({ step }));
    cache.set(key, { at: Date.now(), tour });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    line({ tour });
  } catch (e) {
    console.error('make tour:', e.stack || e.message);
    line({ error: e.code || 'failed', detail: String(e.message || e).slice(0, 200) });
  } finally { clearInterval(beat); res.end(); }
}

/* ---------- group rides ---------- */
// A group: one leader whose story playback everyone follows, and members who share their position.
// State lives in memory only; groups disappear after 12 hours without activity.
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L or O: easy to read out loud
const MAX_GROUPS = 2000, MAX_MEMBERS = 30, IDLE_MS = 12 * 3600e3;
const groups = new Map();

function newCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from(crypto.randomBytes(4), b => LETTERS[b % LETTERS.length]).join('');
    if (!groups.has(code)) return code;
  }
  throw new Error('no free group code');
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null);
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...msg, now: Date.now() })); }
function roster(g) {
  return [...g.members.values()].map(m => ({ id: m.id, name: m.name, lat: m.lat, lng: m.lng, leader: m.id === g.leaderId, online: !!m.ws }));
}
function broadcast(g, msg, except) { for (const m of g.members.values()) if (m.ws && m.ws !== except) send(m.ws, msg); }
function sweep() {
  const now = Date.now();
  for (const [code, g] of groups) if (now - g.touched > IDLE_MS) groups.delete(code);
}
setInterval(sweep, 10 * 60e3).unref();

function onSocket(ws) {
  let g = null, me = null, lastPos = 0;
  ws.on('message', raw => {
    if (raw.length > 4096) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const id = clean(msg.member, 40);
    if (msg.t === 'create' || msg.t === 'join') {
      if (!id) return send(ws, { t: 'error', error: 'bad-member' });
      if (msg.t === 'create') {
        sweep();
        if (groups.size >= MAX_GROUPS) return send(ws, { t: 'error', error: 'full' });
        const code = newCode();
        g = { code, tour: clean(msg.tour, 80) || null, leaderId: id, leaderKey: crypto.randomBytes(16).toString('hex'), members: new Map(), state: null, touched: Date.now() };
        groups.set(code, g);
      } else {
        g = groups.get(clean(msg.code, 8).toUpperCase());
        if (!g) return send(ws, { t: 'error', error: 'no-group' });
        if (!g.members.has(id) && g.members.size >= MAX_MEMBERS) return send(ws, { t: 'error', error: 'group-full' });
        if (msg.leaderKey && msg.leaderKey === g.leaderKey) g.leaderId = id; // the leader coming back
      }
      const old = g.members.get(id);
      if (old && old.ws && old.ws !== ws) old.ws.close(4000, 'replaced');
      me = { id, name: clean(msg.name, 24) || 'Rider', lat: old ? old.lat : null, lng: old ? old.lng : null, ws };
      g.members.set(id, me); g.touched = Date.now();
      const leader = g.leaderId === id;
      send(ws, { t: 'joined', code: g.code, tour: g.tour, leader, leaderKey: leader ? g.leaderKey : undefined, state: g.state, members: roster(g) });
      broadcast(g, { t: 'members', members: roster(g) }, ws);
      return;
    }
    if (!g || !me) return;
    g.touched = Date.now();
    if (msg.t === 'pos') {
      const lat = num(msg.lat, -90, 90), lng = num(msg.lng, -180, 180);
      if (lat == null || lng == null || Date.now() - lastPos < 900) return;
      lastPos = Date.now(); me.lat = lat; me.lng = lng;
      broadcast(g, { t: 'members', members: roster(g) });
    } else if (msg.t === 'state' && me.id === g.leaderId) {
      // what the leader is playing: track id, playing or paused, position in seconds, and when (server clock)
      g.state = { track: clean(msg.track, 60) || null, playing: !!msg.playing, time: num(msg.time, 0, 36000) || 0, at: Date.now() };
      broadcast(g, { t: 'state', state: g.state }, ws);
    } else if (msg.t === 'leave') {
      g.members.delete(me.id);
      if (!g.members.size) groups.delete(g.code); else broadcast(g, { t: 'members', members: roster(g) });
      g = null; me = null;
    }
  });
  ws.on('close', () => {
    if (g && me && g.members.get(me.id) === me) { me.ws = null; broadcast(g, { t: 'members', members: roster(g) }); }
  });
  ws.on('error', () => {});
}

function createServer({ maker = makerFromEnv() } = {}) {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/api/tour' && req.method === 'POST') { makeTour(req, res, maker); return; }
    if (pathname.startsWith('/gen/audio/') && (req.method === 'GET' || req.method === 'HEAD')) { serveFile(req, res, GEN_AUDIO, '/gen/audio'); return; }
    if (pathname === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ make: !!maker })); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveFile(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/group', maxPayload: 4096 });
  wss.on('connection', onSocket);
  // keep connections alive through proxies, and drop dead ones
  const beat = setInterval(() => wss.clients.forEach(ws => { if (ws.dead) return ws.terminate(); ws.dead = true; ws.ping(); }), 30e3);
  wss.on('connection', ws => { ws.on('pong', () => { ws.dead = false; }); });
  server.on('close', () => clearInterval(beat));
  return server;
}

module.exports = { createServer, groups };

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  createServer().listen(port, '0.0.0.0', () => console.log(`Audio tours on http://localhost:${port}`));
}
