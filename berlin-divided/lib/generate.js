// Tours made on the spot: real places near the traveller from OpenStreetMap, their Wikipedia
// summaries as the facts, Claude to choose, order and write the stops, OSRM for the route.
// The stories are read by the phone's own voice, so a tour is ready as soon as it is written.
'use strict';
const crypto = require('node:crypto');
const { dist, applyRoute } = require('./directions');

const MODEL = 'claude-opus-5-5';
const UA = 'audio-tours/1.0 (https://github.com/etzy123/toursjelle)';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OSRM = 'https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true';

const INTERESTS = {
  history: 'history in general', war: 'war, occupation and resistance', architecture: 'architecture and buildings',
  art: 'art and artists', famous: 'the famous sights', hidden: 'hidden gems and odd stories',
  religion: 'churches, faith and religious life', local: 'local life, trade and ordinary people',
};
const LANG_NAME = { en: 'English', nl: 'Dutch', de: 'German' };
const TEXT = {
  en: { intro: 'Before you start', outro: 'End of the tour' },
  nl: { intro: 'Voordat je begint', outro: 'Einde van de tour' },
  de: { intro: 'Bevor es losgeht', outro: 'Ende der Tour' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// how many stops, how long each story and how far to look, for the time and travel mode asked
function plan(minutes, mode) {
  const bike = mode === 'bike', speed = bike ? 14 : 4.5; // km/h
  const stops = clamp(Math.round(minutes / (bike ? 12 : 14)), 3, 10);
  const words = minutes <= 45 ? 130 : 180;
  const listen = stops * (words / 150 + 1.5); // minutes spent listening and looking
  const km = Math.max(1, (Math.max(10, minutes - listen) / 60) * speed);
  return { stops, words, km: Math.round(km * 10) / 10, radius: Math.round(clamp((km * 1000) / 2.2, 500, bike ? 5000 : 2000)) };
}

async function getJSON(fetchImpl, url, opts = {}) {
  const r = await fetchImpl(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 25000) });
  if (!r.ok) throw new Error(`${new URL(url).host}: ${r.status}`);
  return r.json();
}

// named places worth a story, best first: those with a Wikipedia article, then attractions
async function places(fetchImpl, lat, lng, radius) {
  const a = `(around:${radius},${lat},${lng})`;
  const q = `[out:json][timeout:25];(nwr${a}["historic"]["name"];nwr${a}["tourism"~"^(attraction|museum|artwork|viewpoint|gallery)$"]["name"];`
    + `nwr${a}["memorial"]["name"];nwr${a}["amenity"="place_of_worship"]["name"]["wikidata"];nwr${a}["building"~"^(church|cathedral|castle|palace)$"]["name"]["wikidata"];);out center tags 400;`;
  const data = await getJSON(fetchImpl, OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 40000 });
  const seen = new Map();
  for (const el of data.elements || []) {
    const t = el.tags || {}, p = el.lat != null ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null;
    if (!p || !t.name) continue;
    const key = t.name.toLowerCase();
    const score = (t.wikipedia ? 4 : 0) + (t.wikidata ? 2 : 0) + (/^(attraction|museum)$/.test(t.tourism || '') ? 2 : 0) + (t.historic ? 1 : 0) - dist([lat, lng], p) / radius;
    const kind = t.historic || t.tourism || t.memorial || t.amenity || t.building || '';
    const prev = seen.get(key);
    if (!prev || prev.score < score) seen.set(key, { name: t.name, lat: p[0], lng: p[1], kind, wikipedia: t.wikipedia || null, score });
  }
  return [...seen.values()].sort((x, y) => y.score - x.score).slice(0, 40);
}

// the Wikipedia summary of each place that has an article, a few requests at a time
async function summaries(fetchImpl, list) {
  const todo = list.filter(p => p.wikipedia).slice(0, 30);
  const one = async p => {
    const m = /^(\w+):(.+)$/.exec(p.wikipedia);
    if (!m) return;
    try {
      const s = await getJSON(fetchImpl, `https://${m[1]}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(m[2].replace(/ /g, '_'))}`, { timeout: 10000 });
      if (s.extract) { p.summary = s.extract.slice(0, 1400); p.url = s.content_urls && s.content_urls.desktop && s.content_urls.desktop.page; }
    } catch (e) { /* a place without a summary can still be chosen */ }
  };
  for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one));
  return list;
}

async function cityName(fetchImpl, lat, lng, lang) {
  try {
    const r = await getJSON(fetchImpl, `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lng}&accept-language=${lang}`, { timeout: 10000 });
    const a = r.address || {};
    return a.city || a.town || a.village || a.municipality || a.county || null;
  } catch (e) { return null; }
}

const SYSTEM = `You write short self-guided audio tours. A phone reads them aloud while someone walks or cycles through a city, so everything you write is heard, not read.

You get the traveller's start point, how long they have, how they travel, what interests them, and a numbered list of real places near them from OpenStreetMap, most with a Wikipedia summary. Choose the stops and write the tour.

Choosing stops:
- Use only places from the list, by number. Never invent a place.
- Prefer places that fit the interests and have a summary. If the list is thin, choose fewer stops rather than weak ones.
- Order them as a route: the first stop is one of the closest to the start, each next stop is near the previous one, and there is no doubling back.

Writing:
- Plain spoken language with short sentences. No lists, headings, parentheses, emojis or em dashes.
- Each stop story first says what the listener is looking at, then tells the story of the place: specific names, dates and what happened on this spot. It ends with one short sentence that names the next stop. The last stop ends by saying the tour is nearly over.
- Facts come from the summary given for each place, plus only well-established general knowledge. Leave out any detail you are unsure of. Never make up quotes, numbers or dates.
- Be warm and curious, and respectful and careful when the story is about war, persecution, slavery or violence.
- The intro welcomes the listener, says what the tour is about and how long it takes, and names the first stop. The outro thanks them and suggests one thing to do nearby.
- title: 2 to 5 words, specific to the theme and the area. subtitle: under 10 words. short: a 1 to 3 word place name for a map label.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'subtitle', 'intro', 'outro', 'stops'],
  properties: {
    title: { type: 'string' }, subtitle: { type: 'string' }, intro: { type: 'string' }, outro: { type: 'string' },
    stops: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['place', 'title', 'short', 'script'],
        properties: { place: { type: 'integer' }, title: { type: 'string' }, short: { type: 'string' }, script: { type: 'string' } },
      },
    },
  },
};

async function write(anthropic, req, p, list, city) {
  const context = {
    start: { lat: req.lat, lng: req.lng, city }, minutes: req.minutes, travel: req.mode === 'bike' ? 'cycling' : 'walking',
    language: LANG_NAME[req.lang] || 'English', stops_wanted: p.stops, words_per_stop: p.words, intro_words: 60, outro_words: 40,
    route_length_km: p.km, interests: (req.interests || []).map(i => INTERESTS[i]).filter(Boolean), wish: req.note || null,
    places: list.map((x, i) => ({ number: i, name: x.name, kind: x.kind, metres_from_start: Math.round(dist([req.lat, req.lng], [x.lat, x.lng])), lat: +x.lat.toFixed(5), lng: +x.lng.toFixed(5), summary: x.summary || null })),
  };
  const params = {
    model: MODEL, max_tokens: 32000, system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  };
  let msg;
  try {
    msg = await anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage();
  } catch (e) {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    msg = await anthropic.messages.stream(params).finalMessage(); // the same request without the fallback option
  }
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { code: 'refused' });
  if (msg.stop_reason === 'max_tokens') throw new Error('the tour text was cut off');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

const clean = s => String(s || '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
const words = s => (s.match(/\S+/g) || []).length;

// the whole pipeline; onStep(name) reports progress: places, writing, route
async function generateTour(req, { fetch: fetchImpl = fetch, anthropic, onStep = () => {} } = {}) {
  const p = plan(req.minutes, req.mode);
  const step = async (name, fn) => { try { return await fn(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
  onStep('places');
  const [found, city] = await step('places', () => Promise.all([places(fetchImpl, req.lat, req.lng, p.radius), cityName(fetchImpl, req.lat, req.lng, req.lang || 'en')]));
  if (found.length < 2) throw Object.assign(new Error('too few places'), { code: 'no-places' });
  await summaries(fetchImpl, found);
  onStep('writing');
  const out = await step('writing', () => write(anthropic, req, p, found, city));
  const used = new Set();
  const stops = (out.stops || []).filter(s => found[s.place] && !used.has(s.place) && used.add(s.place) && clean(s.script)).map((s, i) => {
    const pl = found[s.place];
    return { id: `s${i + 1}`, title: clean(s.title) || pl.name, short: clean(s.short) || pl.name, lat: pl.lat, lng: pl.lng, script: clean(s.script),
      sources: [pl.url || null, 'OpenStreetMap contributors'].filter(Boolean) };
  });
  if (stops.length < 2) throw Object.assign(new Error('too few stops'), { code: 'no-places' });
  onStep('route');
  const profile = req.mode === 'bike' ? 'bike' : 'foot';
  const coords = stops.map(s => `${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join(';');
  const osrm = await step('route', () => getJSON(fetchImpl, OSRM.replace('{profile}', profile).replace('{coords}', coords), { timeout: 30000 }));
  if (osrm.code !== 'Ok') throw new Error(`routing: ${osrm.code}`);
  const lang = TEXT[req.lang] ? req.lang : 'en';
  const citySlug = (city || 'nearby').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nearby';
  const tour = {
    id: 'gen-' + crypto.randomBytes(5).toString('hex'), city: citySlug, city_name: city, generated: true, created: new Date().toISOString(),
    title: clean(out.title), subtitle: clean(out.subtitle), mode: req.mode === 'bike' ? 'bike' : 'walk', lang,
    intro: { id: 'intro', title: TEXT[lang].intro, script: clean(out.intro) },
    outro: { id: 'outro', title: TEXT[lang].outro, script: clean(out.outro) },
    stops,
    turnaround: { text: req.mode === 'bike' ? 'Turn around when it is safe, then ride back to the route.' : 'Turn around when it is safe, then walk back to the route.' },
    offroute: { text: 'You seem to be off the route. Follow the arrow on the screen back to it.' },
    sources: ['Places: OpenStreetMap contributors (ODbL)', 'Facts: Wikipedia (CC BY-SA)', `Written by AI (${MODEL}) from those sources`],
  };
  applyRoute(tour, osrm);
  const storyMin = [tour.intro, tour.outro, ...tour.stops].reduce((t, x) => t + words(x.script) / 150, 0);
  tour.duration_min = Math.round(tour.ride_min * 1.2 + storyMin + 2 * tour.stops.length);
  return tour;
}

module.exports = { generateTour, plan, places, INTERESTS, SYSTEM, SCHEMA };
