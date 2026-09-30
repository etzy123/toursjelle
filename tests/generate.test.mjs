// The tour maker end to end, with OpenStreetMap, Wikipedia, OSRM and Claude replaced by fakes:
// the places and the route are those of the Amsterdam war walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../berlin-divided');
const require = createRequire(import.meta.url);
const { generateTour, plan } = require(path.join(ROOT, 'lib/generate.js'));
const { legDirections, about } = require(path.join(ROOT, 'lib/directions.js'));
const WAR = JSON.parse(fs.readFileSync(path.join(ROOT, 'tours/amsterdam/war/tour.json'), 'utf8'));
const OSRM = JSON.parse(fs.readFileSync(path.join(ROOT, 'tours/amsterdam/war/.osrm.json'), 'utf8'));

function fakes({ refuse = false } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(String(url));
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('overpass')) {
      assert.match(decodeURIComponent(opts.body), /around:\d+,52\.375/);
      return json({ elements: [
        ...WAR.stops.map((s, i) => ({ type: 'node', lat: s.lat, lon: s.lng, tags: { name: s.title, historic: 'memorial', wikipedia: `en:${s.title}` } })),
        { type: 'way', center: { lat: 52.37, lon: 4.89 }, tags: { name: 'A boundary stone', historic: 'boundary_stone' } },
        { type: 'node', lat: 52.3752, lon: 4.884, tags: { name: 'The Anne Frank House', tourism: 'museum' } }, // same name, lower score: dropped
      ] });
    }
    if (url.includes('wikipedia.org')) return json({ extract: `Summary of ${decodeURIComponent(url.split('/').pop())}.`, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } });
    if (url.includes('nominatim')) return json({ address: { city: 'Amsterdam' } });
    if (url.includes('routing.openstreetmap.de')) { assert.match(url, /routed-foot/); return json(OSRM); }
    throw new Error('unexpected ' + url);
  };
  let sent;
  const anthropic = { beta: { messages: { stream(params) {
    sent = params;
    const ctx = JSON.parse(params.messages[0].content);
    const order = WAR.stops.map(s => ctx.places.findIndex(p => p.name === s.title));
    const text = JSON.stringify({ title: 'Amsterdam at war', subtitle: 'Occupation and resistance — on foot', intro: 'Welcome. We start at the Anne Frank House.', outro: 'Thank you for walking.',
      stops: order.map((n, i) => ({ place: n, title: ctx.places[n].name, short: ctx.places[n].name.split(' ').slice(-2).join(' '), script: `Story ${i + 1} — about ${ctx.places[n].name}. Next, stop ${i + 2}.` })) });
    return { finalMessage: async () => (refuse ? { stop_reason: 'refusal', content: [] } : { stop_reason: 'end_turn', content: [{ type: 'text', text }] }) };
  } } } };
  return { fetch, anthropic, calls, sent: () => sent };
}

test('plan: more stops and a wider search for longer tours, and by bike', () => {
  const walk = plan(60, 'walk'), long = plan(120, 'walk'), bike = plan(60, 'bike');
  assert.equal(walk.stops, 4);
  assert.ok(long.stops > walk.stops && long.radius > walk.radius);
  assert.ok(bike.km > walk.km && bike.radius > walk.radius);
  assert.equal(plan(20, 'walk').stops, 3);
});

test('a tour is made from real places, in the order written, with a route and directions', async () => {
  const f = fakes(), steps = [];
  const tour = await generateTour({ lat: 52.3752, lng: 4.884, minutes: 90, mode: 'walk', interests: ['war'], note: null, lang: 'en' }, { ...f, onStep: s => steps.push(s) });
  assert.deepEqual(steps, ['places', 'writing', 'route']);
  assert.equal(f.sent().model, 'claude-opus-5-5');
  assert.equal(f.sent().fallbacks, 'default');
  assert.equal(f.sent().output_config.format.type, 'json_schema');
  const ctx = JSON.parse(f.sent().messages[0].content);
  assert.deepEqual(ctx.interests, ['war, occupation and resistance']);
  assert.ok(ctx.places.every(p => p.name !== 'The Anne Frank House' || p.kind === 'memorial'), 'duplicate names keep the better place');
  assert.equal(tour.city, 'amsterdam');
  assert.equal(tour.city_name, 'Amsterdam');
  assert.equal(tour.mode, 'walk');
  assert.equal(tour.stops.length, WAR.stops.length);
  assert.deepEqual(tour.stops.map(s => s.id), WAR.stops.map((s, i) => `s${i + 1}`));
  assert.equal(tour.legs.length, tour.stops.length - 1);
  assert.equal(tour.distance_km, WAR.distance_km);
  assert.ok(tour.legs.every(l => l.steps[0].text.startsWith('Directions to the next stop.')));
  assert.ok(tour.legs.every(l => l.steps.slice(1).every(s => s.pre && s.pre.text.startsWith('In 150 metres, '))));
  assert.ok(tour.route.length > 50);
  assert.ok(!JSON.stringify(tour).includes('—'), 'em dashes are removed');
  assert.equal(tour.stops[0].sources[0], 'https://en.wikipedia.org/wiki/X');
  assert.ok(tour.duration_min > tour.ride_min);
});

test('the directions match the Python build for the same route', () => {
  const steps = OSRM.routes[0].legs.slice(0, WAR.legs.length).map(l => legDirections([l]).map(s => s.text));
  assert.deepEqual(steps, WAR.legs.map(l => l.steps.map(s => s.text)));
  assert.equal(about(960), 'about 1 kilometre');
});

test('a refusal is reported, not turned into a tour', async () => {
  await assert.rejects(generateTour({ lat: 52.3752, lng: 4.884, minutes: 60, mode: 'walk', lang: 'en' }, fakes({ refuse: true })), /refused/);
});
