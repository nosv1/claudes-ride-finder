// Roads: decoding tile rows, classifying them, filtering, and grouping pieces into stretches.
// Pure: no DOM, no map library.
import { CURVE_CLASSES, SPEED_BINS, HILLS, MINOR_TYPES, RAMP_TIERS, RAMP_TYPES, HIGHWAY_TYPES, HIGHWAY_LANES_BONUS, ROLLER, tiersFor } from './config.js';
import { decodeDeltas, boundsOf, extend, pad, intersects, contains, spotOnLine, distance } from './geo.js';

// Row: [id, highway, name, ref, mph, estMph, surface, score, curvy, sweep, length, coords, hill, blind, lanes]
export function decodeRow(row) {
  const [id, hw, name, ref, mph, estMph, surface, score, curvy, sweep, length, coords, hill, blind, lanes] = row;
  const geom = decodeDeltas(coords);
  const blindPts = [];
  for (let i = 0; i < blind.length; i += 2) blindPts.push([blind[i] / 1e5, blind[i + 1] / 1e5]);
  const r = { id, hw, name, ref, mph, estMph, surface, score, curvy, sweep, length, hill, lanes, blind: blindPts, geom, bounds: boundsOf(geom) };
  // A highway sweep is one direction of the highway, so it's named for the way it heads ("I 435 heading south").
  r.highway = isHighwaySweep(r);
  r.key = r.highway ? `${(ref || name || 'Highway').split(';')[0]} heading ${compass(geom[0], geom[geom.length - 1])}` : ref || name || '';
  r.oneway = RAMP_TYPES.has(hw) || r.highway;
  r.rampTier = rampTier(r);
  // A short closed loop is a roundabout or a circle drive: all curve, but not a ride.
  const a = geom[0], b = geom[geom.length - 1];
  r.loop = length < 1000 && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
  r.cls = r.oneway || r.loop ? -1 : curveClass(r);  // ramps are their own thing (Interchanges mode)
  r.speed = mph ?? estMph;
  r.hillLevel = hillLevel(hill);
  r.roller = isRoller(r);
  return r;
}

// A straight back road that goes up and down a lot (see ROLLER).
export const isRoller = r => r.cls < 0 && !r.oneway && !r.loop && ROLLER.types.has(r.hw) && r.length >= ROLLER.minM
  && r.hill != null && r.hill >= ROLLER.minHill;

// Sweepers: a good run of wide curves, or a short road that's mostly curve.
export const isSweeper = r => r.sweep >= 800 || (r.sweep >= 400 && r.sweep / r.length >= 0.5);

// Highway sweeps: rows build_tiles.py made from 65+ mph highways (plain highway pieces have no sweep).
export const isHighwaySweep = r => HIGHWAY_TYPES.has(r.hw) && r.sweep > 0;
// Metres of sweep, with the bonus for 3+ lanes on a highway.
export const highwaySweep = r => r.sweep * (r.lanes >= 3 ? HIGHWAY_LANES_BONUS : 1);

// Fast ramps sweep for a few hundred metres and aren't mostly tight curve (cloverleaf loops are).
// Highway sweeps get the highway tiers. -1 neither, else the RAMP_TIERS index.
export function rampTier(r) {
  if (isHighwaySweep(r)) {
    const s = highwaySweep(r);
    return RAMP_TIERS.reduce((t, tier, i) => tier.highway && s >= tier.min ? i : t, -1);
  }
  if (!RAMP_TYPES.has(r.hw) || r.sweep < RAMP_TIERS[0].min || r.curvy > 0.5 * r.sweep) return -1;
  return RAMP_TIERS.reduce((t, tier, i) => !tier.highway && r.sweep >= tier.min ? i : t, 0);
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
// Which way a line heads overall, from its first point to its last.
export function compass(a, b) {
  const deg = Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  return COMPASS[Math.round(((deg + 360) % 360) / 45) % 8];
}

// -1 not curvy, 0 sweeper, 1..4 tight-curve bins (see CURVE_CLASSES).
export function curveClass(r) {
  let cls = -1;
  CURVE_CLASSES.forEach((c, i) => { if (i && r.score && r.score / r.length >= c.min) cls = i; });
  return cls < 0 && isSweeper(r) ? 0 : cls;
}

export const hillLevel = h => h == null ? -1 : HILLS.reduce((lvl, c, i) => h >= c.min ? i : lvl, 0);
export const speedBin = mph => mph == null ? -1 : SPEED_BINS.findIndex(b => mph <= b.max);
export const curveMeters = r => r.curvy + r.sweep;
export const isMinor = r => MINOR_TYPES.has(r.hw.replace('_link', ''));

// Whether a road shows under the current filters (the map's layer filters mirror this).
// f: { mode: 'ride'|'curvy'|'speed', roadType: 'all'|'back'|'highway', minSpeed, minHills, hideUnpaved, classes: Set,
//      speedBins: Set, rampTiers: Set, rollers, zoom }
export function visible(r, f) {
  if (f.mode !== 'speed' && r.rampTier >= 0) return tiersFor(f.roadType, f.rampTiers).includes(r.rampTier);
  if (f.mode !== 'speed' && f.roadType === 'highway') return false;
  if (f.hideUnpaved && r.surface === 1) return false;
  if (f.mode === 'speed') {
    // Highway sweeps repeat highway pieces from the speed-limit tiles, so they'd draw twice.
    return r.mph != null && !r.highway && f.speedBins.has(speedBin(r.mph)) && (!isMinor(r) || f.zoom >= 11);
  }
  if (r.roller ? !f.rollers : r.cls < 0 || !f.classes.has(r.cls)) return false;
  if (f.minHills > 0 && r.hillLevel < f.minHills) return false;
  return f.mode !== 'ride' || r.speed >= f.minSpeed;
}

// Missouri reuses lettered routes in every county, so "MO Y" in two places is two roads:
// pieces of the same name within `near` degrees (~3 km) form one stretch.
export function clusterRoads(list, near = 0.03) {
  const clusters = [];
  for (const r of list) {
    const reach = pad(r.bounds, near);
    const hits = clusters.filter(c => intersects(reach, c.bounds));
    const c = hits[0] || { roads: [], bounds: r.bounds };
    if (!hits.length) clusters.push(c);
    for (const o of hits.slice(1)) {
      c.roads.push(...o.roads);
      c.bounds = extend(c.bounds, o.bounds);
      clusters.splice(clusters.indexOf(o), 1);
    }
    c.roads.push(r);
    c.bounds = extend(c.bounds, r.bounds);
  }
  return clusters;
}

// Score, curve miles, hills and best curve class for a stretch. Hills make a curvy road
// better: a very hilly one ranks about twice a flat one.
export function summarize(c, key) {
  const g = { ...c, key };
  g.score = c.roads.reduce((s, r) => s + (r.score + 0.5 * (r.highway ? highwaySweep(r) : r.sweep)) * (1 + (r.hill || 0) / 30), 0);
  g.curvy = c.roads.reduce((s, r) => s + curveMeters(r), 0);
  const measured = c.roads.filter(r => r.hill != null), len = measured.reduce((s, r) => s + r.length, 0);
  g.hill = len ? measured.reduce((s, r) => s + r.hill * r.length, 0) / len : null;
  g.cls = Math.max(...c.roads.map(r => r.cls));  // sweepers (0) rank below the tight-curve bins
  g.roller = g.cls < 0 && c.roads.some(r => r.roller);
  g.length = c.roads.reduce((s, r) => s + r.length, 0);
  g.rampTier = Math.max(...c.roads.map(r => r.rampTier));
  g.oneway = c.roads.every(r => r.oneway);
  g.blind = c.roads.reduce((s, r) => s + r.blind.length, 0);
  g.ids = c.roads.map(r => r.id);
  return g;
}

// The stretch a piece belongs to (just the piece if it has no name). With filters, only the
// pieces the map shows count, so a tap doesn't select (and light up) pieces drawn without color.
export function stretchOf(roads, r, filters = null) {
  if (!r.key) return summarize({ roads: [r], bounds: r.bounds }, 'Unnamed road');
  const same = roads.filter(x => x === r || (x.key === r.key && (x.cls >= 0 || x.rampTier >= 0 || x.roller) && x.oneway === r.oneway
    && (!filters || visible(x, filters))));
  return summarize(clusterRoads(same).find(c => c.roads.includes(r)), r.key);
}

// The road (among those `ok` accepts) within maxM meters of a point, nearest first; or null.
export function roadNear(roads, at, ok = () => true, maxM = 30) {
  let best = null, bd = maxM;
  for (const r of roads) {
    if (!contains(pad(r.bounds, 0.0005), at) || !ok(r)) continue;
    const d = distance(spotOnLine(r.geom, at).p, at);
    if (d <= bd) { bd = d; best = r; }
  }
  return best;
}

// The road under someone at `at` heading `heading` (degrees): the nearest within maxM that runs
// that way (either direction), so a road crossing over or under doesn't count. Or null.
export function roadAlong(roads, at, heading, maxM = 25) {
  let best = null, bd = maxM;
  for (const r of roads) {
    if (!contains(pad(r.bounds, 0.0005), at)) continue;
    const s = spotOnLine(r.geom, at), d = distance(s.p, at), off = Math.abs(((s.heading - heading) % 180 + 270) % 180 - 90);
    if (d <= bd && off <= 35) { bd = d; best = r; }
  }
  return best;
}

// Named stretches among visible roads in view that `ok` accepts.
function stretchesInView(roads, view, filters, ok) {
  const byKey = new Map();
  for (const r of roads) {
    if (!r.key || !ok(r) || !intersects(view, r.bounds) || !visible(r, filters)) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const groups = [];
  byKey.forEach((list, key) => clusterRoads(list).forEach(c => groups.push(summarize(c, key))));
  return groups;
}

// The best named stretches among visible roads in view. Roller coasters have their own list.
export function bestInView(roads, view, filters, limit = 8) {
  return stretchesInView(roads, view, filters, r => !r.roller).sort((a, b) => b.score - a.score).slice(0, limit);
}

// The roller coasters in view, the most up and down first (hills × miles).
export function rollersInView(roads, view, filters, limit = 3) {
  const ups = g => g.roads.reduce((s, r) => s + (r.roller ? r.hill * r.length : 0), 0);
  return stretchesInView(roads, view, filters, r => r.roller).sort((a, b) => ups(b) - ups(a)).slice(0, limit);
}
