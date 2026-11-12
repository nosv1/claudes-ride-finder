// Ride planning on top of a routed trip: fuel stops, the loop generator, curvy miles and blind
// crests along a route, and exports (Google Maps links, GPX). Pure: no DOM, no map library.
import { FUEL, GEN, GOOGLE, DECISION_TURNS, CURVE_CLASSES, HILLS, HIGHWAYS, ROLLER } from './config.js';
import { distance, km, bearing, relAngle, cumulative, nearestIndex, alongRoute, boundsOf, pad, intersects, center } from './geo.js';
import { clusterRoads, summarize, hillLevel } from './roads.js';
import { tripPoints, roadStop } from './trip.js';

// ---------- along a route ----------

// The ~200 m grid cells that roads `ok` accepts pass through, near a path, and a test for a point.
const CELL = 0.002, cellKey = (la, lo) => Math.round(la / CELL) + ',' + Math.round(lo / CELL);
function eachCell(r, fn) {
  for (let i = 1; i < r.geom.length; i++) {
    const [a0, a1] = r.geom[i - 1], [b0, b1] = r.geom[i];
    const n = Math.ceil(Math.max(Math.abs(b0 - a0), Math.abs(b1 - a1)) / CELL) || 1;
    for (let k = 0; k <= n; k++) fn(cellKey(a0 + (b0 - a0) * k / n, a1 + (b1 - a1) * k / n));
  }
}
function roadCells(path, roads, ok) {
  const cells = new Set(), area = pad(boundsOf(path), 0.02);
  for (const r of roads) if (ok(r) && intersects(area, r.bounds)) eachCell(r, c => cells.add(c));
  return cells;
}

// Metres of the route that follow roads `ok` accepts, by matching on the grid.
export function metersOn(path, roads, ok) {
  const cells = roadCells(path, roads, ok), key = cellKey;
  let m = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (cells.has(key((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))) m += distance(a, b);
  }
  return m;
}

// What a route rides, in the filters' words: metres on each curve class (byClass, Sweepers to Twisty), on highway
// sweeps and fast ramps, on roller coasters, and the hills of those roads (length-weighted, m/km; null if none
// measured). A spot on two kinds of road counts as the curvier one. Unpaved roads don't count, as for curvy miles.
// `roads` lists the named roads ridden, in ride order: { key, cls (-1 highway, -2 roller coaster), hill, m, fitM, road
// (its most-ridden piece) },
// fitM being the metres on pieces `fits` accepts (the map's filters), fits the metres of the whole ride that do.
// `pieces` are the runs of the route on one road and kind, { k, key, hill, pts }, to light up on the map.
export function rideMix(path, roads, fits = () => true) {
  const kind = r => r.surface === 1 ? null : r.cls >= 0 ? r.cls : r.rampTier >= 0 ? -1 : r.roller ? -2 : null;
  const cells = new Map(), area = pad(boundsOf(path), 0.02);
  for (const r of roads) {
    const k = kind(r);
    if (k == null || !intersects(area, r.bounds)) continue;
    eachCell(r, c => { const was = cells.get(c); if (!was || k > was.k) cells.set(c, { k, r }); });
  }
  const mix = { byClass: CURVE_CLASSES.map(() => 0), highway: 0, roller: 0, meters: 0, hill: null, fits: 0, roads: [], pieces: [] };
  let run = null;
  const byKey = new Map(), fitsOf = new Map();
  let hillM = 0, hillSum = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = distance(a, b), on = cells.get(cellKey((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
    mix.meters += d;
    if (!on) { run = null; continue; }
    const { k, r } = on;
    if (k === -1) mix.highway += d;
    else if (k === -2) mix.roller += d;
    else mix.byClass[k] += d;
    if (r.hill != null && k !== -1) { hillM += d; hillSum += r.hill * d; }
    if (!fitsOf.has(r)) fitsOf.set(r, fits(r));
    const ok = fitsOf.get(r);
    if (ok) mix.fits += d;
    const key = r.key || r.name || 'Unnamed road';
    if (run && run.k === k && run.key === key) run.pts.push(b);
    else mix.pieces.push(run = { k, key, hill: r.hill, pts: [a, b] });
    if (!byKey.has(key)) byKey.set(key, { key, byKind: new Map(), pieces: new Map(), hillM: 0, hillSum: 0, m: 0, fitM: 0 });
    const g = byKey.get(key);
    g.m += d;
    if (ok) g.fitM += d;
    g.byKind.set(k, (g.byKind.get(k) || 0) + d);
    g.pieces.set(r, (g.pieces.get(r) || 0) + d);
    if (r.hill != null) { g.hillM += d; g.hillSum += r.hill * d; }
  }
  if (hillM) mix.hill = hillSum / hillM;
  mix.roads = [...byKey.values()].map(g => ({ key: g.key, m: g.m, fitM: g.fitM, hill: g.hillM ? g.hillSum / g.hillM : null,
    cls: [...g.byKind].reduce((best, kv) => kv[1] > best[1] ? kv : best)[0],
    road: [...g.pieces].reduce((best, kv) => kv[1] > best[1] ? kv : best)[0] }));
  return mix;
}

const HILL_COLOR = '#adb5bd';
export const kindIs = k => p => p.k === k;
// What a ride is about, as the key's labels in its colors, most first: the curve classes that make up a fifth or
// more of its curvy miles (a very curvy or twisty half mile counts anyway), highway sweeps if they're a fifth of the
// fun, roller coasters if they're a fifth of what it rides (country loops cross plenty), and how hilly its roads are.
// [{ label, color, pick }], pick telling which of mix.pieces it's about.
export function rideFocus(mix) {
  const curvy = mix.byClass.reduce((a, b) => a + b, 0), out = [];
  if (curvy >= 800) {
    mix.byClass.map((m, c) => ({ m, c })).filter(({ m, c }) => m >= 0.2 * curvy || (c >= 3 && m >= 800))
      .sort((a, b) => b.m - a.m).slice(0, 3)
      .forEach(({ c }) => out.push({ label: CURVE_CLASSES[c].label, color: CURVE_CLASSES[c].color, pick: kindIs(c) }));
  }
  if (mix.highway >= 3000 && mix.highway >= 0.2 * (curvy + mix.highway)) {
    const hw = { label: 'Highway sweeps', color: HIGHWAYS.color, pick: kindIs(-1) };
    mix.highway > curvy ? out.unshift(hw) : out.push(hw);
  }
  if (mix.roller >= 1500 && mix.roller >= 0.2 * (curvy + mix.highway + mix.roller)) out.push({ label: ROLLER.label, color: ROLLER.color, pick: kindIs(-2) });
  if (out.length && mix.hill != null) {
    const level = hillLevel(mix.hill);
    out.push({ label: HILLS[level].label, color: HILL_COLOR, pick: p => p.k !== -1 && hillLevel(p.hill) >= level });
  }
  return out;
}

export const curvyMetersOn = (path, roads) => metersOn(path, roads, r => r.cls >= 0 && r.surface !== 1);
// The interesting parts of the interstates: highway sweeps and fast ramps. (The grid can't tell a
// highway's two directions apart, but they nearly always sweep alike.)
export const highwayMetersOn = (path, roads) => metersOn(path, roads, r => r.rampTier >= 0);

// Where a route turns back the way it came off the curvy roads: off a highway, left twice through the lights
// and back on the other way, or round a block. A spot the route comes back past, within 120 m and heading the
// other way, after 400 m to 3 km of riding (a cloverleaf loop is shorter; on a curvy road it's a hairpin, and
// riding a dead end out and back is retrace's job). Not in the first or last `ends` metres. Spots, in order.
export function turnarounds(path, roads = [], ends = 1500) {
  const cum = cumulative(path), total = cum[cum.length - 1], curvy = roadCells(path, roads, r => r.cls >= 0);
  const ahead = (i, m) => { let k = i; while (k < path.length - 1 && cum[k] - cum[i] < m) k++; return k; };
  const spots = [];
  for (let i = 0, next = 0; i < path.length - 1; i++) {
    if (cum[i] < next || cum[i] < ends || total - cum[i] < ends) continue;
    next = cum[i] + 50;  // look every 50 m
    if (curvy.has(cellKey(path[i][0], path[i][1]))) continue;
    const h = bearing(path[i], path[ahead(i, 60)]);
    for (let j = ahead(i, 400); j < path.length - 1 && cum[j] - cum[i] <= 3000; j++) {
      if (total - cum[j] < ends) break;
      if (distance(path[i], path[j]) > 120) continue;
      if (Math.abs(relAngle(bearing(path[j], path[ahead(j, 60)]), h)) < 150) continue;
      spots.push(path[Math.floor((i + j) / 2)]);
      next = cum[j] + 50;
      break;
    }
  }
  return spots;
}

// The stoplights a route goes through, one per intersection (a big one has a light node on each approach),
// and which way it turns there: { p, m, turn: 'left' | 'right' | 'straight' }. A light within 15 m of the
// route counts.
export function stoplightsOn(path, lights) {
  if (!lights || !lights.length || path.length < 2) return [];
  const [s, w, n, e] = pad(boundsOf(path), 0.001);
  const near = lights.filter(l => l.lat >= s && l.lat <= n && l.lon >= w && l.lon <= e);
  const cum = cumulative(path), total = cum[cum.length - 1], out = [];
  // The spot d metres along, between the path's points: a straight road can be mapped with points far apart.
  const at = d => {
    const i = cum.findIndex(c => c >= d);
    if (i <= 0) return path[i < 0 ? path.length - 1 : 0];
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), a = path[i - 1], b = path[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  for (const { item, mile } of alongRoute(path, near, 15, 10).hits) {
    const m = mile * 1609.34;
    if (out.length && m - out[out.length - 1].m < 80) continue;
    const before = bearing(at(Math.max(0, m - 60)), at(m)), after = bearing(at(m), at(Math.min(total, m + 60)));
    const t = relAngle(after, before);
    out.push({ p: [item.lat, item.lon], m, turn: t < -50 ? 'left' : t > 50 ? 'right' : 'straight' });
  }
  return out;
}

export function blindCrestsOn(path, roads) {
  const area = pad(boundsOf(path), 0.02), crests = [];
  for (const r of roads) {
    if (r.blind.length && intersects(area, r.bounds)) r.blind.forEach(([lat, lon]) => crests.push({ lat, lon }));
  }
  return alongRoute(path, crests, 40, 25).hits;
}

// Your spots (a bump, a pothole) the route passes within 30 m of, in order: [{ spot, mile }].
export function spotsOn(path, spots) {
  return alongRoute(path, spots.map(s => ({ lat: s.spot[0], lon: s.spot[1], s })), 30, 10).hits.map(x => ({ spot: x.item.s, mile: x.mile }));
}

// Metres of a route ridden a second time, back down the same road or along it again (crossing
// an earlier pass doesn't count), those stretches as lines for the map, and where along the route
// each second pass starts and ends (metres, in `spans`). The first and last
// `ends` metres from the start and finish are left out: leaving home and coming back the same
// way isn't what spoils a ride.
export function retrace(path, ends = 1500) {
  const CELL = 0.0006, STEP = 15, RAD = Math.PI / 180, seen = new Map(), lines = [], spans = [];
  const first = path[0], last = path[path.length - 1];
  let meters = 0, at = 0, line = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], d = distance(a, b);
    if (!d) continue;
    const hd = bearing(a, b), n = Math.ceil(d / STEP);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], m = at + d * t;
      const key = Math.round(p[0] / CELL) + ',' + Math.round(p[1] / CELL);
      const visits = seen.get(key) || [];
      // Along or against an earlier pass (not across it), and not just the same pass a moment ago.
      const again = visits.some(v => m - v.m > 400 && Math.abs(Math.cos((hd - v.hd) * RAD)) > 0.8)
        && distance(p, first) > ends && distance(p, last) > ends;
      if (visits.length < 4) seen.set(key, [...visits, { m, hd }]);
      if (again) {
        meters += d / n;
        if (!line) { lines.push(line = []); spans.push([m, m]); }
        line.push(p);
        spans[spans.length - 1][1] = m;
      } else {
        line = null;
      }
    }
    at += d;
  }
  const keep = lines.map(l => l.length > 1);
  return { meters, lines: lines.filter((_, i) => keep[i]), spans: spans.filter((_, i) => keep[i]) };
}

// Spots to send a loop through instead of riding a stretch twice: either side of the middle of the
// longest one ridden twice, square to it and a third of its length out (2–10 km), each with the
// metres along the route where the second pass goes by (to put the spot in that part of the loop).
export function detours({ lines, spans }) {
  if (!lines.length) return [];
  const len = l => l.reduce((s, p, i) => i ? s + km(l[i - 1], p) : 0, 0);
  const i = lines.reduce((b, l, k) => len(l) > len(lines[b]) ? k : b, 0), l = lines[i];
  const mid = l[Math.floor(l.length / 2)], off = Math.min(10, Math.max(2, len(l) / 3)), dir = bearing(l[0], l[l.length - 1]);
  const m = (spans[i][0] + spans[i][1]) / 2;
  return [dir + 90, dir - 90].map(d => ({ p: offset(mid, d, off), m }));
}

// A point `dist` km from p heading `deg`.
function offset([lat, lon], deg, dist) {
  const r = deg * Math.PI / 180, dLat = dist * Math.cos(r) / 111.2;
  return [lat + dLat, lon + dist * Math.sin(r) / (111.2 * Math.cos(lat * Math.PI / 180))].map(v => +v.toFixed(5));
}

// Where a stop belongs in a loop so the route goes there at `m` metres along: the index of the first
// stop after it (items[0] is the start), or the end (the ride home).
export function stopIndexAt(path, items, m) {
  const cum = cumulative(path);
  let from = 0;
  for (let k = 1; k < items.length; k++) {
    from = nearestIndex(path, items[k].pts[0], from);
    if (cum[from] > m) return k;
  }
  return items.length;
}

// ---------- fuel ----------

// Assume a full tank at the start; refuel at the farthest usable station before the reserve.
// leftMi: what's in the tank at the start (a full tank if left out); the first stop is planned from that.
export function planFuel(path, stations, rangeMi, need90, leftMi = rangeMi) {
  const { hits: along, totalMiles } = alongRoute(path, stations, FUEL.nearRoute, 300);
  const usable = rangeMi * FUEL.reserve;
  const ok = along.filter(a => !need90 || a.item.status >= 1);
  const picks = [], gaps = [];
  // Starting with less than a full tank is starting "behind": the first stop has to come within what's left.
  let pos = Math.min(0, (Math.max(0, leftMi) - rangeMi) * FUEL.reserve);
  while (totalMiles - pos > usable) {
    const reach = ok.filter(a => a.mile > pos + 2 && a.mile <= pos + usable);
    const next = reach.length ? reach[reach.length - 1] : ok.find(a => a.mile > pos + 2);
    if (!reach.length) gaps.push([Math.max(0, pos), next ? next.mile : totalMiles]);
    if (!next) break;
    picks.push(next);
    pos = next.mile;
  }
  let longest = 0, prev = 0;
  [...ok.map(a => a.mile), totalMiles].forEach(m => { longest = Math.max(longest, m - prev); prev = m; });
  return { along, ok, picks, gaps, longest, totalMiles };
}

// ---------- loop generator ----------
// For each direction, add roads one at a time, each time taking the most fun per extra hour of
// riding, so a great road an hour of highway away loses to a good one just down the road.
// Roads are ordered by angle across the direction so the loop goes out one side, back the other.
// One way (with an `end`): the same, but roads come from an oval around the start and end, are
// ordered along the way, and the options keep to one side of the straight line there, or near it.

// Within maxKm of the start, or with an end, within 2 × maxKm there and on to the end.
const inReach = (p, start, maxKm, end) => end ? km(start, p) + km(p, end) <= 2 * maxKm : km(start, p) <= maxKm;

export function candidateGroups(roads, start, maxKm, isWorthy, end = null) {
  const byKey = new Map();
  for (const r of roads) {
    if (!r.key || !isWorthy(r) || !inReach(r.geom[0], start, maxKm, end)) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const groups = [];
  byKey.forEach((list, key) => clusterRoads(list).forEach(c => {
    const g = summarize(c, key);
    if (g.curvy < GEN.wayHomeM) return;
    if (g.curvy < GEN.minCurveM && g.roads.every(r => r.hw === 'unclassified')) return;
    // Only as another way home (see routeOption). A highway sweep is short but worth riding to.
    if (g.curvy < GEN.minCurveM && !g.roads.every(r => r.highway)) g.small = true;
    g.stop = roadStop(g);
    g.center = center(boundsOf([g.stop.pts[0], g.stop.pts[g.stop.pts.length - 1]]));
    groups.push(g);
  }));
  return groups;
}

// How far along the straight line from start to end p is (0 at the start, 1 at the end), and how
// far off it in km (+ to the right going that way).
export function alongLine(start, end, p) {
  const k = Math.cos(start[0] * Math.PI / 180), ex = (end[1] - start[1]) * k, ey = end[0] - start[0];
  const px = (p[1] - start[1]) * k, py = p[0] - start[0], len2 = ex * ex + ey * ey || 1e-12;
  return { t: (px * ex + py * ey) / len2, off: (px * ey - py * ex) / Math.sqrt(len2) * 111.2 };
}

// Stops the generator added are marked `gen`, so the next generate swaps them out but keeps the
// rider's own.
export function orderLoop(start, groups, dir, end = null) {
  const key = end ? g => alongLine(start, end, g.center).t : g => relAngle(bearing(start, g.center), dir);
  const stops = [...groups]
    .sort((a, b) => key(a) - key(b))
    .map(g => ({ ...g.stop, pts: g.stop.pts.map(p => [...p]), ...(g.required ? {} : { gen: true }) }));
  return orientStops(start, stops, !end, end);
}

// Turn road stops end for end so the rides between them (and back to the start) are as short as
// possible, looking at the whole loop rather than one stop at a time, so a road isn't entered at
// the end that leaves you riding back down it. With an end, the ride finishes there. Changes the
// stops in place.
export function orientStops(start, stops, loop = true, end = null) {
  const ends = s => [s.pts[0], s.pts[s.pts.length - 1]];
  let best = [{ cost: 0, at: start, flips: [] }];
  for (const s of stops) {
    const ways = s.type === 'road' && !s.oneway ? [ends(s), ends(s).reverse()] : [ends(s)];
    best = ways.map(([entry, exit], flip) => {
      const from = best.reduce((a, b) => b.cost + km(b.at, entry) < a.cost + km(a.at, entry) ? b : a);
      return { cost: from.cost + km(from.at, entry), at: exit, flips: [...from.flips, flip] };
    });
  }
  const home = end || (loop ? start : null), tail = b => b.cost + (home ? km(b.at, home) : 0);
  const last = best.reduce((a, b) => tail(b) < tail(a) ? b : a);
  last.flips.forEach((flip, i) => { if (flip) stops[i].pts.reverse(); });
  return stops;
}

// Rough riding hours for a loop (or a ride on to `end`), and how many of them are on the chosen roads.
export function estimate(start, stops, end = null) {
  let link = 0, road = 0, prev = start;
  for (const s of stops) {
    link += km(prev, s.pts[0]) * GEN.roadFactor / GEN.linkKmh;
    for (let i = 1; i < s.pts.length; i++) road += km(s.pts[i - 1], s.pts[i]) * GEN.roadFactor / GEN.roadKmh;
    prev = s.pts[s.pts.length - 1];
  }
  link += km(prev, end || start) * GEN.roadFactor / GEN.linkKmh;
  return { hours: link + road, roadHours: road };
}

// The other direction of the same highway bend: both one-way, centered within twinKm. A loop rides one.
const twins = (a, b) => a.oneway && b.oneway && km(a.center, b.center) < GEN.twinKm;

export const reachKm = hours => hours * GEN.linkKmh / (2 * GEN.roadFactor);

// Up to 4 roads for short rides, more for long ones: a 6 h loop needs about 9 to fill its time.
export const maxRoadsFor = hours => Math.min(GEN.maxRoadsCap, Math.max(GEN.maxRoads, Math.round(hours * 1.5)));

// Fill a loop heading `dir` with roads from the pool, up to `hours` of estimated riding. Each
// pick is the most score per extra hour, but every road is charged at least its share of the
// time still to fill, so a long ride reaches out to good roads farther away instead of
// stacking up short ones by the start and coming home early.
export function fillLoop(start, pool, dir, hours, chosen, maxRoads, end = null) {
  chosen = [...chosen];
  let stops = orderLoop(start, chosen, dir, end), est = estimate(start, stops, end);
  while (chosen.length < maxRoads) {
    const share = (hours - est.hours) / (maxRoads - chosen.length);
    let best = null;
    for (const g of pool) {
      if (chosen.includes(g) || g.small || chosen.some(c => twins(c, g))) continue;
      const trial = orderLoop(start, [...chosen, g], dir, end);
      const e = estimate(start, trial, end);
      if (e.hours > hours) continue;
      const extra = e.hours - est.hours, gain = g.score / Math.max(extra, share, 0.05);
      // Near ties go to the road that uses more of the time.
      if (!best || gain > best.gain * 1.02 || (gain > best.gain * 0.98 && extra > best.extra)) best = { g, trial, e, gain, extra };
    }
    if (!best) break;
    chosen.push(best.g);
    stops = best.trial;
    est = best.e;
  }
  return { chosen, stops, est };
}

// required: the rider's own stops (roads or points) every loop must include. With some, loops
// head their way (straight at them, or swinging out to either side) and fill the remaining time.
// Each option keeps its direction, road pool and chosen roads so it can be filled again.
// With an end, the options are ways there: keeping left of the straight line, right of it, near it
// (within a quarter of its length), or anywhere; `dir` is the compass way of that side.
export function buildOptions(groups, start, hours, required = [], end = null) {
  const req = required.map(stop => ({
    key: stop.label, score: stop.score || 0, stop, required: true,
    center: center(boundsOf([stop.pts[0], stop.pts[stop.pts.length - 1]])),
  }));
  const taken = new Set(req.flatMap(r => r.stop.ids || []));
  const free = groups.filter(g => !(g.ids || []).some(id => taken.has(id)));
  let dirs = Array.from({ length: 12 }, (_, i) => i * 30);
  let ways = null;
  if (end) {
    const axis = bearing(start, end), len = km(start, end), off = g => alongLine(start, end, g.center).off;
    ways = [[(axis + 270) % 360, g => off(g) < 0, 'left'], [(axis + 90) % 360, g => off(g) > 0, 'right'],
      [axis, g => Math.abs(off(g)) <= len / 4, 'near'], [axis, () => true, 'any']];
    dirs = ways.map(w => w[0]);
  } else if (req.length) {
    const mid = [req.reduce((s, r) => s + r.center[0], 0) / req.length, req.reduce((s, r) => s + r.center[1], 0) / req.length];
    const toward = bearing(start, mid);
    dirs = [0, -35, 35, -70, 70].map(d => (toward + d + 360) % 360);
  }
  const maxRoads = req.length + Math.max(1, maxRoadsFor(hours) - req.length);
  const options = [], seen = new Set();
  for (const [i, dir] of dirs.entries()) {
    const pool = free.filter(ways ? ways[i][1] : g => Math.abs(relAngle(bearing(start, g.center), dir)) <= GEN.spread);
    const { chosen, stops, est } = fillLoop(start, pool, dir, hours, req, maxRoads, end);
    const sig = chosen.map(g => g.key + g.center).sort().join('|');
    if (!chosen.length || seen.has(sig)) continue;
    seen.add(sig);
    const fun = chosen.reduce((s, g) => s + g.score, 0);
    // Loops short of the time rank lower: one filling 3/4 of it counts about half.
    const fit = Math.min(1, est.hours / hours) ** 2;
    options.push({ dir, pool, free, chosen, stops, maxRoads, value: fun * est.roadHours / (est.hours || 1) * fit, required: req.length,
      ...(ways ? { way: ways[i][2] } : {}) });
  }
  if (end) return options.sort((a, b) => b.value - a.value);
  // The best few, but each side of the start (N, E, S, W) gets its best loop in when that's at
  // least sideMin as good as the best, so the choice isn't all one way.
  options.sort((a, b) => b.value - a.value);
  const side = o => Math.floor(((o.dir + 45) % 360) / 90), picked = [];
  for (const q of [0, 1, 2, 3]) {
    const o = options.find(o => side(o) === q);
    if (o && o.value >= GEN.sideMin * options[0].value) picked.push(o);
  }
  for (const o of options) if (!picked.includes(o)) picked.push(o);
  return picked.slice(0, GEN.maxOptions).sort((a, b) => b.value - a.value);
}

// Whether most of a group's road lies within 200 m of these spots.
function mostlyOn(g, spots) {
  const pts = g.roads.flatMap(r => r.geom.filter((_, i) => i % 5 === 0));
  return pts.filter(p => spots.some(q => km(p, q) < 0.2)).length > pts.length / 2;
}

// Roads that could give a loop another way home where it rides the same road twice: an end or a
// midpoint within wayHomeKm of the doubled-back stretch, not already in the loop, and not mostly
// on that stretch itself. Best first.
export function wayHomeRoads(groups, items, lines) {
  const spots = lines.flat().filter((_, i) => i % 10 === 0);
  if (!spots.length) return [];
  const used = new Set(items.flatMap(it => it.ids || []));
  const near = p => spots.some(q => km(p, q) < GEN.wayHomeKm);
  return groups.filter(g => !g.oneway && !g.ids.some(id => used.has(id)) && g.stop.pts.some(near) && !mostlyOn(g, spots))
    .sort((a, b) => b.score - a.score);
}

// Roads a routed loop rides right past without taking: an end within onWayKm of the route, not
// already in the loop, and mostly off the route. Short ones too: from Lee's Summit, a loop up MO 7
// passed the end of MO FF, a sweeper running the same way. Best first.
export function onTheWay(groups, items, path) {
  const spots = path.filter((_, i) => i % 5 === 0);
  if (!spots.length) return [];
  const used = new Set(items.flatMap(it => it.ids || []));
  const near = p => spots.some(q => km(p, q) < GEN.onWayKm);
  return groups.filter(g => !g.oneway && !g.ids.some(id => used.has(id))
      && (near(g.stop.pts[0]) || near(g.stop.pts[g.stop.pts.length - 1])) && !mostlyOn(g, spots))
    .sort((a, b) => b.score - a.score);
}

export { COMPASS, heading } from './geo.js';

// ---------- Google Maps ----------
// Google re-plans between stops, so give it extra ones: the trip's own stops, then the middle
// of any long stretch with nothing holding it to our route, then just past the turns onto the
// longest roads (from the router's maneuver list).

export function googlePoints(route, trip) {
  if (!route || !route.maneuvers) return tripPoints(trip).map(x => x.p);
  const path = route.path, cum = cumulative(path);
  const stops = tripPoints(trip, false).map(x => x.p), picked = [];
  let from = 0;
  stops.forEach((p, n) => {
    const i = n === stops.length - 1 ? path.length - 1 : nearestIndex(path, p, from);
    picked.push({ i, p });
    from = i;
  });

  const cap = GOOGLE.parts * (GOOGLE.perPart + 1) + 1;
  while (picked.length < cap) {
    picked.sort((a, b) => a.i - b.i);
    let gap = 0, at = 0;
    for (let k = 1; k < picked.length; k++) {
      const g = cum[picked[k].i] - cum[picked[k - 1].i];
      if (g > gap) { gap = g; at = k; }
    }
    if (gap < GOOGLE.maxGap) break;
    const target = (cum[picked[at - 1].i] + cum[picked[at].i]) / 2;
    const i = cum.findIndex(c => c >= target);
    picked.push({ i, p: path[i] });
  }

  const crowded = i => picked.some(q => Math.abs(cum[q.i] - cum[i]) < GOOGLE.minSpacing);
  route.maneuvers
    .filter(m => DECISION_TURNS.has(m.type) && m.km > 0.5)
    .sort((a, b) => b.km - a.km)
    .forEach(m => {
      if (picked.length >= cap) return;
      let i = m.at;
      while (i < m.end && cum[i] - cum[m.at] < GOOGLE.pastTurn) i++;
      if (!crowded(i)) picked.push({ i, p: path[i] });
    });
  return picked.sort((a, b) => a.i - b.i).map(q => q.p);
}

// Google allows 9 stops between start and end, so long rides become several links.
export function googleLinks(points) {
  const f = p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`, links = [];
  for (let i = 0; i < points.length - 1; i += GOOGLE.perPart + 1) {
    const part = points.slice(i, i + GOOGLE.perPart + 2), waypoints = part.slice(1, -1).map(f).join('|');
    links.push('https://www.google.com/maps/dir/?api=1&travelmode=driving' +
      `&origin=${f(part[0])}&destination=${f(part[part.length - 1])}` +
      (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''));
  }
  return links;
}

// ---------- GPX ----------

const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export function tripName(trip) {
  const roads = trip.items.filter(it => it.type === 'road').map(it => it.label);
  return roads.length ? `Ride: ${roads.slice(0, 3).join(', ')}${roads.length > 3 ? '…' : ''}` : 'Ride Finder trip';
}

export function gpx(trip, route) {
  const f = ([la, lo]) => `lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"`, name = xml(tripName(trip));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Ride Finder" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${name}</name></metadata>`,
    ...trip.items.map((it, i) => `  <wpt ${f(it.pts[0])}><name>${i + 1}. ${xml(it.label)}</name></wpt>`),
    `  <rte><name>${name}</name>`,
    ...tripPoints(trip).map(({ p }) => `    <rtept ${f(p)}/>`),
    '  </rte>',
    ...(route ? [`  <trk><name>${name}</name><trkseg>`, ...route.path.map(p => `    <trkpt ${f(p)}/>`), '  </trkseg></trk>'] : []),
    '</gpx>',
  ].join('\n');
}
