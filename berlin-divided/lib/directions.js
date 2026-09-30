// Turn-by-turn text from an OSRM route, for tours made on the fly. Same rules as
// scripts/build_tour.py (keep the two in step): drop "arrive" and straight "new name" /
// "continue", speak maneuvers less than 30 m apart as one, add "and stay on it for about N"
// when the next one is more than 450 m away, start every leg with "Directions to the next stop.".
'use strict';

const MERGE_BELOW = 30, STAY_ON_ABOVE = 450, STOP_TOLERANCE = 20, MAX_SNAP = 150, PRE_DISTANCE = 150;
const LEG_INTRO = 'Directions to the next stop. ';
const FERRY_NAME = /(veer|ferry|fähre|traghetto|ferri)\b/i;

function dist(a, b) {
  const r = x => x * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// [distance in m, [lat, lng]] of the point on the polyline nearest to p
function nearestOnRoute(p, route) {
  const k = Math.cos(p[0] * Math.PI / 180), xy = q => [(q[1] - p[1]) * k * 111320, (q[0] - p[0]) * 110540];
  let best = [Infinity, null];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], [ax, ay] = xy(a), [bx, by] = xy(b), dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L)) : 0, d = Math.hypot(ax + u * dx, ay + u * dy);
    if (d < best[0]) best = [d, [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]];
  }
  return best;
}

const cardinal = b => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8];
const ordinal = n => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][Math.max(1, Math.min(8, n || 1)) - 1];
function about(m) {
  if (m < 950) return `about ${Math.round(m / 100) * 100} metres`;
  const km = Math.round(m / 100) / 10;
  return `about ${km} kilometre${km === 1 ? '' : 's'}`;
}
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

function maneuverText(step) {
  const m = step.maneuver, t = m.type, mod = m.modifier, name = step.name || '';
  const onto = name ? ` onto ${name}` : '';
  const side = mod && mod.includes('left') ? 'left' : mod && mod.includes('right') ? 'right' : null;
  if (t === 'arrive' || t === 'exit roundabout' || t === 'exit rotary') return null;
  if (['new name', 'continue', 'notification', 'use lane'].includes(t) && (!mod || mod === 'straight')) return null;
  if (t === 'depart') return `Head ${cardinal(m.bearing_after || 0)}${name ? ` on ${name}` : ''}`;
  if (['roundabout', 'rotary', 'roundabout turn'].includes(t)) return `At the roundabout, take the ${ordinal(m.exit)} exit${onto}`;
  if (t === 'fork') return side ? `Keep ${side}${onto}` : `Keep straight on${onto}`;
  if (t === 'end of road') return `At the end of the road, turn ${side || 'left'}${onto}`;
  if (t === 'merge') return side ? `Merge ${side}${onto}` : `Merge${onto}`;
  if (t === 'on ramp' || t === 'off ramp') return side ? `Take the ramp on the ${side}${onto}` : `Take the ramp${onto}`;
  if (mod === 'uturn') return `Make a U-turn${name ? ` onto ${name}` : ''}`;
  if (mod === 'straight') return name ? `Continue onto ${name}` : 'Go straight on';
  if (mod === 'slight left' || mod === 'slight right') return `Bear ${side}${onto}`;
  if (mod === 'sharp left' || mod === 'sharp right') return `Turn sharp ${side}${onto}`;
  if (side) return `Turn ${side}${onto}`;
  return null;
}

// spoken steps for one stop-to-stop leg, made of one or more OSRM legs
function legDirections(osrmLegs) {
  const kept = []; let pos = 0, mode = false;
  const total = osrmLegs.reduce((t, l) => t + l.distance, 0);
  osrmLegs.forEach((leg, li) => {
    for (const step of leg.steps) {
      if (li > 0 && step.maneuver.type === 'depart') { pos += step.distance; continue; }
      const onFerry = step.mode === 'ferry' || FERRY_NAME.test(step.name || '');
      const text = onFerry && !mode ? 'Take the ferry' : maneuverText(step);
      mode = onFerry;
      if (text) {
        const [lng, lat] = step.maneuver.location;
        kept.push({ pos, lat: +lat.toFixed(6), lng: +lng.toFixed(6), text, ferry: onFerry && text === 'Take the ferry' ? step.distance : 0 });
      }
      pos += step.distance;
    }
  });
  const groups = [];
  for (const k of kept) {
    const g = groups[groups.length - 1];
    if (g && k.pos - g[g.length - 1].pos < MERGE_BELOW) g.push(k); else groups.push([k]);
  }
  return groups.map((g, i) => {
    let text = g[0].text + g.slice(1).map(x => ', then ' + lowerFirst(x.text)).join('');
    const next = i + 1 < groups.length ? groups[i + 1][0].pos : total, gap = next - g[g.length - 1].pos;
    const crossing = g.reduce((t, x) => t + x.ferry, 0);
    if (crossing) text += `. The crossing is ${about(crossing)}`;
    else if (gap > STAY_ON_ABOVE) text += `, and stay on it for ${about(gap)}`;
    text += '.';
    if (i === 0) text = LEG_INTRO + text;
    const st = { lat: g[0].lat, lng: g[0].lng, text };
    if (i) st.pre = { text: `In ${PRE_DISTANCE} metres, ${lowerFirst(text)}` };
    return st;
  });
}

// route, legs and distances from an OSRM reply through the tour's stops (in order, no via points);
// stops further than STOP_TOLERANCE from the route move onto it, up to MAX_SNAP
function applyRoute(tour, osrm) {
  const r = osrm.routes[0];
  const route = r.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]);
  tour.stops.forEach((s, i) => {
    const [d, pt] = nearestOnRoute([s.lat, s.lng], route);
    const snapped = osrm.waypoints && osrm.waypoints[i] ? osrm.waypoints[i].distance : d;
    if (d > STOP_TOLERANCE && snapped <= MAX_SNAP) { s.lat = +pt[0].toFixed(6); s.lng = +pt[1].toFixed(6); }
  });
  tour.route = route;
  tour.legs = r.legs.slice(0, tour.stops.length - 1).map(l => ({ distance: Math.round(l.distance), steps: legDirections([l]) }));
  tour.distance_km = Math.round(r.distance / 100) / 10;
  tour.ride_min = Math.round(r.duration / 60);
  return tour;
}

module.exports = { dist, nearestOnRoute, about, maneuverText, legDirections, applyRoute, LEG_INTRO };
