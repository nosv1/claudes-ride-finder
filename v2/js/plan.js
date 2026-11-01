// Ride planning on top of a routed trip: fuel stops, the loop generator, curvy miles and blind
// crests along a route, and exports (Google Maps links, GPX). Pure: no DOM, no map library.
import { FUEL, GEN, GOOGLE, DECISION_TURNS } from './config.js';
import { distance, km, bearing, relAngle, d2, cumulative, nearestIndex, alongRoute, boundsOf, pad, intersects, center } from './geo.js';
import { clusterRoads, summarize } from './roads.js';
import { tripPoints, roadStop } from './trip.js';

// ---------- along a route ----------

// Metres of the route that follow curvy roads, by matching on a ~200 m grid.
export function curvyMetersOn(path, roads) {
  const CELL = 0.002, cells = new Set(), area = pad(boundsOf(path), 0.02);
  const key = (la, lo) => Math.round(la / CELL) + ',' + Math.round(lo / CELL);
  for (const r of roads) {
    if (r.cls < 0 || r.surface === 1 || !intersects(area, r.bounds)) continue;
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

export function blindCrestsOn(path, roads) {
  const area = pad(boundsOf(path), 0.02), crests = [];
  for (const r of roads) {
    if (r.blind.length && intersects(area, r.bounds)) r.blind.forEach(([lat, lon]) => crests.push({ lat, lon }));
  }
  return alongRoute(path, crests, 40, 25).hits;
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
    if (g.curvy < GEN.minCurveM) return;
    g.stop = roadStop(g);
    g.center = center(boundsOf([g.stop.pts[0], g.stop.pts[g.stop.pts.length - 1]]));
    groups.push(g);
  }));
  return groups;
}

export function orderLoop(start, groups, dir) {
  let prev = start;
  return [...groups]
    .sort((a, b) => relAngle(bearing(start, a.center), dir) - relAngle(bearing(start, b.center), dir))
    .map(g => {
      const s = { ...g.stop, pts: g.stop.pts.map(p => [...p]) };
      if (d2(prev, s.pts[s.pts.length - 1]) < d2(prev, s.pts[0])) s.pts.reverse();
      prev = s.pts[s.pts.length - 1];
      return s;
    });
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

export const reachKm = hours => hours * GEN.linkKmh / (2 * GEN.roadFactor);

export function buildOptions(groups, start, hours) {
  const options = [], seen = new Set();
  for (let dir = 0; dir < 360; dir += 30) {
    const pool = groups.filter(g => Math.abs(relAngle(bearing(start, g.center), dir)) <= GEN.spread);
    let chosen = [], stops = [], est = { hours: 0, roadHours: 0 };
    while (chosen.length < GEN.maxRoads) {
      let best = null;
      for (const g of pool) {
        if (chosen.includes(g)) continue;
        const trial = orderLoop(start, [...chosen, g], dir);
        const e = estimate(start, trial);
        if (e.hours > hours) continue;
        const gain = g.score / Math.max(e.hours - est.hours, 0.05);
        if (!best || gain > best.gain) best = { g, trial, e, gain };
      }
      if (!best) break;
      chosen.push(best.g);
      stops = best.trial;
      est = best.e;
    }
    const sig = chosen.map(g => g.key + g.center).sort().join('|');
    if (!chosen.length || seen.has(sig)) continue;
    seen.add(sig);
    const fun = chosen.reduce((s, g) => s + g.score, 0);
    options.push({ dir, stops, value: fun * est.roadHours / est.hours });
  }
  return options.sort((a, b) => b.value - a.value).slice(0, GEN.maxOptions);
}

export const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const heading = dir => COMPASS[Math.round(dir / 45) % 8];

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
