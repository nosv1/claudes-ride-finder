// Roads: decoding tile rows, classifying them, filtering, and grouping pieces into stretches.
// Pure: no DOM, no map library.
import { CURVE_CLASSES, SPEED_BINS, HILLS, MINOR_TYPES } from './config.js';
import { decodeDeltas, boundsOf, extend, pad, intersects } from './geo.js';

// Row: [id, highway, name, ref, mph, estMph, surface, score, curvy, sweep, length, coords, hill, blind]
export function decodeRow(row) {
  const [id, hw, name, ref, mph, estMph, surface, score, curvy, sweep, length, coords, hill, blind] = row;
  const geom = decodeDeltas(coords);
  const blindPts = [];
  for (let i = 0; i < blind.length; i += 2) blindPts.push([blind[i] / 1e5, blind[i + 1] / 1e5]);
  const r = { id, hw, name, ref, mph, estMph, surface, score, curvy, sweep, length, hill, blind: blindPts, geom, bounds: boundsOf(geom) };
  r.key = ref || name || '';
  r.cls = curveClass(r);
  r.speed = mph ?? estMph;
  r.hillLevel = hillLevel(hill);
  return r;
}

// Sweepers: a good run of wide curves, or a short road that's mostly curve.
export const isSweeper = r => r.sweep >= 800 || (r.sweep >= 400 && r.sweep / r.length >= 0.5);

// -1 not curvy, 0 sweeper, 1..4 tight-curve bins (see CURVE_CLASSES).
export function curveClass(r) {
  let cls = -1;
  CURVE_CLASSES.forEach((c, i) => { if (i && r.score && r.score / r.length >= c.min) cls = i; });
  return cls < 0 && isSweeper(r) ? 0 : cls;
}

export const hillLevel = h => h == null ? -1 : HILLS.reduce((lvl, c, i) => h >= c.min ? i : lvl, 0);
export const speedBin = mph => mph == null ? -1 : SPEED_BINS.findIndex(b => mph <= b.max);
export const roadName = r => r.name || r.ref || 'Unnamed road';
export const curveMeters = r => r.curvy + r.sweep;
export const isMinor = r => MINOR_TYPES.has(r.hw.replace('_link', ''));

// Whether a road shows under the current filters (the map's layer filters mirror this).
// f: { mode: 'ride'|'curvy'|'speed', minSpeed, minHills, hideUnpaved, classes: Set, speedBins: Set, zoom }
export function visible(r, f) {
  if (f.hideUnpaved && r.surface === 1) return false;
  if (f.mode === 'speed') {
    return r.mph != null && f.speedBins.has(speedBin(r.mph)) && (!isMinor(r) || f.zoom >= 11);
  }
  if (r.cls < 0 || !f.classes.has(r.cls) || (f.minHills > 0 && r.hillLevel < f.minHills)) return false;
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
  g.score = c.roads.reduce((s, r) => s + (r.score + 0.5 * r.sweep) * (1 + (r.hill || 0) / 30), 0);
  g.curvy = c.roads.reduce((s, r) => s + curveMeters(r), 0);
  const measured = c.roads.filter(r => r.hill != null), len = measured.reduce((s, r) => s + r.length, 0);
  g.hill = len ? measured.reduce((s, r) => s + r.hill * r.length, 0) / len : null;
  g.cls = Math.max(...c.roads.map(r => r.cls));  // sweepers (0) rank below the tight-curve bins
  g.blind = c.roads.reduce((s, r) => s + r.blind.length, 0);
  g.ids = c.roads.map(r => r.id);
  return g;
}

// The stretch a piece belongs to (just the piece if it has no name).
export function stretchOf(roads, r) {
  if (!r.key) return summarize({ roads: [r], bounds: r.bounds }, 'Unnamed road');
  const same = roads.filter(x => x === r || (x.key === r.key && x.cls >= 0));
  return summarize(clusterRoads(same).find(c => c.roads.includes(r)), r.key);
}

// The best named stretches among visible roads in view.
export function bestInView(roads, view, filters, limit = 8) {
  const byKey = new Map();
  for (const r of roads) {
    if (!r.key || !intersects(view, r.bounds) || !visible(r, filters)) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const groups = [];
  byKey.forEach((list, key) => clusterRoads(list).forEach(c => groups.push(summarize(c, key))));
  return groups.sort((a, b) => b.score - a.score).slice(0, limit);
}
