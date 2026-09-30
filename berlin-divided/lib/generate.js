// Tours made on the spot: real places near the traveller from Wikipedia (with their intro text as
// the facts) and OpenStreetMap, Claude to choose, order and write the stops, OSRM for the route.
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

const COUNTRY_LANG = { nl: 'nl', be: 'nl', de: 'de', at: 'de', ch: 'de', fr: 'fr', it: 'it', es: 'es', pt: 'pt', pl: 'pl', cz: 'cs', dk: 'da', se: 'sv', no: 'no', hu: 'hu', gr: 'el' };

const AREA = /\b(district|borough|neighbou?rhood|municipality|quarter|city|town|village|province|region|stadsdeel|wijk|buurt|gemeente|stadtteil|ortsteil|gemeinde|bezirk|railway station|metro station|tram stop|bus stop)\b/i;

// Wikipedia articles with coordinates near the start, in a few languages, with their intro text:
// the main source, because every place found this way comes with its facts
async function wikiNearby(fetchImpl, lang, lat, lng, radius) {
  const api = `https://${lang}.wikipedia.org/w/api.php?format=json&formatversion=2&action=query`;
  const geo = await getJSON(fetchImpl, `${api}&list=geosearch&gscoord=${lat}%7C${lng}&gsradius=${Math.min(10000, radius)}&gslimit=150`, { timeout: 12000 });
  const hits = (geo.query && geo.query.geosearch) || [];
  const batches = [];
  for (let i = 0; i < hits.length; i += 20) batches.push(hits.slice(i, i + 20));
  const out = [];
  await Promise.all(batches.map(async batch => { // all at once: a few requests of 20 articles each
    const ex = await getJSON(fetchImpl, `${api}&prop=extracts%7Cdescription&exintro=1&explaintext=1&exlimit=20&titles=${encodeURIComponent(batch.map(h => h.title).join('|'))}`, { timeout: 12000 }).catch(() => ({}));
    const pages = new Map(((ex.query && ex.query.pages) || []).map(pg => [pg.title, pg]));
    for (const h of batch) {
      const pg = pages.get(h.title) || {};
      if (!pg.extract || pg.extract.length < 120) continue; // stubs make poor stories
      if (AREA.test(pg.description || '')) continue; // districts and towns are where you are, not something to look at
      out.push({ name: h.title.replace(/ \([^)]*\)$/, ''), lat: h.lat, lng: h.lon, kind: pg.description || '', summary: pg.extract.slice(0, 1400), size: pg.extract.length,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, wiki: true });
    }
  }));
  return out;
}

// named sights from OpenStreetMap, as an extra: the public Overpass servers are often busy,
// so three mirrors are asked at once, the first answer wins, and after 10 seconds the tour goes ahead without them
const OVERPASS_MIRRORS = [OVERPASS, 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function osmPlaces(fetchImpl, lat, lng, radius) {
  const a = `(around:${Math.min(radius, 3000)},${lat},${lng})`;
  const q = `[out:json][timeout:12];(nwr${a}["tourism"~"^(attraction|museum|artwork|viewpoint|gallery)$"]["name"];nwr${a}["historic"~"^(monument|memorial|castle|building|church|ruins|city_gate|archaeological_site)$"]["name"];);out center tags 200;`;
  const ask = async url => {
    const data = await getJSON(fetchImpl, url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    return (data.elements || []).map(el => {
      const t = el.tags || {}, p = el.lat != null ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null;
      return p && t.name ? { name: t.name, lat: p[0], lng: p[1], kind: t.tourism || t.historic || '' } : null;
    }).filter(Boolean);
  };
  try { return await Promise.any(OVERPASS_MIRRORS.map(ask)); } catch (e) { return []; } // the first mirror to answer wins
}

// every candidate once, best first: with facts, attractions, then by distance
function merge(lat, lng, radius, lists) {
  const all = [];
  for (const x of lists.flat()) {
    const dupe = all.find(y => y.name.toLowerCase() === x.name.toLowerCase() || (dist([x.lat, x.lng], [y.lat, y.lng]) < 40 && (y.summary || !x.summary)));
    if (dupe) { if (x.summary && (!dupe.summary || (x.size || 0) > (dupe.size || 0))) Object.assign(dupe, x); continue; } // keep the fuller article
    all.push({ ...x });
  }
  // a longer article is a fair sign of a more notable place; distance counts, but less, so a long tour gets a spread
  const score = x => (x.summary ? 2 + Math.min(4, (x.size || x.summary.length) / 600) : 0) + (/attraction|museum|monument|church|castle|palace|memorial/i.test(x.kind) ? 1 : 0) - 0.7 * dist([lat, lng], [x.lat, x.lng]) / radius;
  return all.filter(x => dist([lat, lng], [x.lat, x.lng]) <= radius * 1.2).sort((x, y) => score(y) - score(x)).slice(0, 40);
}

async function places(fetchImpl, lat, lng, radius, langs) {
  const lists = await Promise.all([...langs.map(l => wikiNearby(fetchImpl, l, lat, lng, radius).catch(() => [])), osmPlaces(fetchImpl, lat, lng, radius)]);
  return merge(lat, lng, radius, lists);
}

async function locality(fetchImpl, lat, lng, lang) {
  try {
    const r = await getJSON(fetchImpl, `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lng}&accept-language=${lang}`, { timeout: 10000 });
    const a = r.address || {};
    return { city: a.city || a.town || a.village || a.municipality || a.county || null, country: a.country_code || null };
  } catch (e) { return { city: null, country: null }; }
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
  const where = await locality(fetchImpl, req.lat, req.lng, req.lang || 'en'), city = where.city;
  const langs = [...new Set(['en', req.lang, COUNTRY_LANG[where.country]].filter(l => /^[a-z]{2}$/.test(l || '')))];
  const found = await step('places', () => places(fetchImpl, req.lat, req.lng, p.radius, langs));
  if (found.filter(x => x.summary).length < 2) throw Object.assign(new Error('too few places'), { code: 'no-places' });
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

module.exports = { generateTour, plan, places, merge, INTERESTS, SYSTEM, SCHEMA };
