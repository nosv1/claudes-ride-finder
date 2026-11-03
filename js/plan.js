// Ride planning on top of a routed trip: fuel stops, the loop generator, curvy miles and blind
// crests along a route, and exports (Google Maps links, GPX). Pure: no DOM, no map library.
import { FUEL, GEN, GOOGLE, DECISION_TURNS } from './config.js';
import { distance, km, bearing, relAngle, cumulative, nearestIndex, alongRoute, boundsOf, pad, intersects, center } from './geo.js';
import { clusterRoads, summarize } from './roads.js';
import { tripPoints, roadStop } from './trip.js';

// ---------- along a route ----------

// Metres of the route that follow roads `ok` accepts, by matching on a ~200 m grid.
export function metersOn(path, roads, ok) {
  const CELL = 0.002, cells = new Set(), area = pad(boundsOf(path), 0.02);
  const key = (la, lo) => Math.round(la / CELL) + ',' + Math.round(lo / CELL);
  for (const r of roads) {
    if (!ok(r) || !intersects(area, r.bounds)) continue;
    for (let i = 1; i < r.geom.length; i++) {
      const [a0, a1] = r.geom[i - 1], [b0, b1] = r.geom[i];
      const n = Math.ceil(Math.max(Math.abs(b0 - a0), Math.abs(b1 - a1)) / CELL) || 1;
      for (let k = 0; k <= n; k++) cells.add(key(a0 + (b0 - a0) * k / n, a1 + (b1 - a1) * k / n));
    }
  }
  let m = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (cells.has(key((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))) m += distance(a, b);
  }
  return m;
}

export const curvyMetersOn = (path, roads) => metersOn(path, roads, r => r.cls >= 0 && r.surface !== 1);
// The interesting parts of the interstates: highway sweeps and fast ramps. (The grid can't tell a
// highway's two directions apart, but they nearly always sweep alike.)
export const highwayMetersOn = (path, roads) => metersOn(path, roads, r => r.rampTier >= 0);

export function blindCrestsOn(path, roads) {
  const area = pad(boundsOf(path), 0.02), crests = [];
  for (const r of roads) {
    if (r.blind.length && intersects(area, r.bounds)) r.blind.forEach(([lat, lon]) => crests.push({ lat, lon }));
  }
  return alongRoute(path, crests, 40, 25).hits;
}

// Metres of a route ridden a second time, back down the same road or along it again (crossing
// an earlier pass doesn't count), and those stretches as lines for the map. The first and last
// `ends` metres from the start and finish are left out: leaving home and coming back the same
// way isn't what spoils a ride.
export function retrace(path, ends = 1500) {
  const CELL = 0.0006, STEP = 15, RAD = Math.PI / 180, seen = new Map(), lines = [];
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
        if (!line) lines.push(line = []);
        line.push(p);
      } else {
        line = null;
      }
    }
    at += d;
  }
  return { meters, lines: lines.filter(l => l.length > 1) };
}

// ---------- fuel ----------

// Assume a full tank at the start; refuel at the farthest usable station before the reserve.
export function planFuel(path, stations, rangeMi, need90) {
  const { hits: along, totalMiles } = alongRoute(path, stations, FUEL.nearRoute, 300);
  const usable = rangeMi * FUEL.reserve;
  const ok = along.filter(a => !need90 || a.item.status >= 1);
  const picks = [], gaps = [];
  let pos = 0;
  while (totalMiles - pos > usable) {
    const reach = ok.filter(a => a.mile > pos + 2 && a.mile <= pos + usable);
    const next = reach.length ? reach[reach.length - 1] : ok.find(a => a.mile > pos + 2);
    if (!reach.length) gaps.push([pos, next ? next.mile : totalMiles]);
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

export function candidateGroups(roads, start, maxKm, isWorthy) {
  const byKey = new Map();
  for (const r of roads) {
    if (!r.key || !isWorthy(r) || km(start, r.geom[0]) > maxKm) continue;
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

// Stops the generator added are marked `gen`, so the next generate swaps them out but keeps the
// rider's own.
export function orderLoop(start, groups, dir) {
  const stops = [...groups]
    .sort((a, b) => relAngle(bearing(start, a.center), dir) - relAngle(bearing(start, b.center), dir))
    .map(g => ({ ...g.stop, pts: g.stop.pts.map(p => [...p]), ...(g.required ? {} : { gen: true }) }));
  return orientStops(start, stops);
}

// Turn road stops end for end so the rides between them (and back to the start) are as short as
// possible, looking at the whole loop rather than one stop at a time, so a road isn't entered at
// the end that leaves you riding back down it. Changes the stops in place.
export function orientStops(start, stops, loop = true) {
  const ends = s => [s.pts[0], s.pts[s.pts.length - 1]];
  let best = [{ cost: 0, at: start, flips: [] }];
  for (const s of stops) {
    const ways = s.type === 'road' && !s.oneway ? [ends(s), ends(s).reverse()] : [ends(s)];
    best = ways.map(([entry, exit], flip) => {
      const from = best.reduce((a, b) => b.cost + km(b.at, entry) < a.cost + km(a.at, entry) ? b : a);
      return { cost: from.cost + km(from.at, entry), at: exit, flips: [...from.flips, flip] };
    });
  }
  const last = best.reduce((a, b) => b.cost + (loop ? km(b.at, start) : 0) < a.cost + (loop ? km(a.at, start) : 0) ? b : a);
  last.flips.forEach((flip, i) => { if (flip) stops[i].pts.reverse(); });
  return stops;
}

// Rough riding hours for a loop, and how many of them are on the chosen roads.
export function estimate(start, stops) {
  let link = 0, road = 0, prev = start;
  for (const s of stops) {
    link += km(prev, s.pts[0]) * GEN.roadFactor / GEN.linkKmh;
    for (let i = 1; i < s.pts.length; i++) road += km(s.pts[i - 1], s.pts[i]) * GEN.roadFactor / GEN.roadKmh;
    prev = s.pts[s.pts.length - 1];
  }
  link += km(prev, start) * GEN.roadFactor / GEN.linkKmh;
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
export function fillLoop(start, pool, dir, hours, chosen, maxRoads) {
  chosen = [...chosen];
  let stops = orderLoop(start, chosen, dir), est = estimate(start, stops);
  while (chosen.length < maxRoads) {
    const share = (hours - est.hours) / (maxRoads - chosen.length);
    let best = null;
    for (const g of pool) {
      if (chosen.includes(g) || g.small || chosen.some(c => twins(c, g))) continue;
      const trial = orderLoop(start, [...chosen, g], dir);
      const e = estimate(start, trial);
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
export function buildOptions(groups, start, hours, required = []) {
  const req = required.map(stop => ({
    key: stop.label, score: stop.score || 0, stop, required: true,
    center: center(boundsOf([stop.pts[0], stop.pts[stop.pts.length - 1]])),
  }));
  const taken = new Set(req.flatMap(r => r.stop.ids || []));
  const free = groups.filter(g => !(g.ids || []).some(id => taken.has(id)));
  let dirs = Array.from({ length: 12 }, (_, i) => i * 30);
  if (req.length) {
    const mid = [req.reduce((s, r) => s + r.center[0], 0) / req.length, req.reduce((s, r) => s + r.center[1], 0) / req.length];
    const toward = bearing(start, mid);
    dirs = [0, -35, 35, -70, 70].map(d => (toward + d + 360) % 360);
  }
  const maxRoads = req.length + Math.max(1, maxRoadsFor(hours) - req.length);
  const options = [], seen = new Set();
  for (const dir of dirs) {
    const pool = free.filter(g => Math.abs(relAngle(bearing(start, g.center), dir)) <= GEN.spread);
    const { chosen, stops, est } = fillLoop(start, pool, dir, hours, req, maxRoads);
    const sig = chosen.map(g => g.key + g.center).sort().join('|');
    if (!chosen.length || seen.has(sig)) continue;
    seen.add(sig);
    const fun = chosen.reduce((s, g) => s + g.score, 0);
    // Loops short of the time rank lower: one filling 3/4 of it counts about half.
    const fit = Math.min(1, est.hours / hours) ** 2;
    options.push({ dir, pool, free, chosen, stops, maxRoads, value: fun * est.roadHours / (est.hours || 1) * fit, required: req.length });
  }
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
