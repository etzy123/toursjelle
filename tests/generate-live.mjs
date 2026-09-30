// Smoke test of the tour maker against the real OpenStreetMap, Wikipedia, Nominatim and OSRM,
// with Claude replaced by a stand-in that takes the best-ranked places, nearest first. Needs internet.
//   node tests/generate-live.mjs [lat lng minutes walk|bike]
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../berlin-divided');
const require = createRequire(import.meta.url);
const { generateTour } = require(path.join(ROOT, 'lib/generate.js'));

const [lat = 52.3731, lng = 4.8914, minutes = 60, mode = 'walk'] = process.argv.slice(2).map((x, i) => (i < 3 ? +x : x));
let places = 0, withSummary = 0;
const anthropic = { beta: { messages: { stream(params) {
  const ctx = JSON.parse(params.messages[0].content);
  places = ctx.places.length; withSummary = ctx.places.filter(p => p.summary).length;
  // the best-ranked places, visited nearest-first from the start
  const left = ctx.places.slice(0, ctx.stops_wanted), pick = [];
  let at = [ctx.start.lat, ctx.start.lng];
  while (left.length) { left.sort((a, b) => Math.hypot(a.lat - at[0], a.lng - at[1]) - Math.hypot(b.lat - at[0], b.lng - at[1])); const p = left.shift(); pick.push(p); at = [p.lat, p.lng]; }
  const text = JSON.stringify({ title: 'Smoke test', subtitle: 'Nearest places', intro: 'Hello.', outro: 'Bye.',
    stops: pick.map(p => ({ place: p.number, title: p.name, short: p.name, script: `About ${p.name}.` })) });
  return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) };
} } } };

const t0 = Date.now();
try {
  const tour = await generateTour({ lat, lng, minutes, mode, interests: ['famous'], lang: 'en' }, { anthropic, onStep: s => console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${s}`) });
  console.log(`places ${places} (with a Wikipedia summary: ${withSummary}); city ${tour.city_name}; ${tour.stops.length} stops, ${tour.distance_km} km, ${tour.ride_min} min moving`);
  for (const s of tour.stops) console.log(`  ${s.title}  ${s.sources[0] || ''}`);
  console.log(`  first directions: ${tour.legs[0].steps.map(s => s.text).join(' | ')}`);
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exit(1);
}
