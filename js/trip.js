// The trip: an ordered list of stops. Pure: no DOM, no map library.
//
// A stop is a pinned point { type: 'point', label, pts: [[lat, lon]] } or a road ridden end to
// end { type: 'road', label, curvy, score, ids, pts: [entry, ...through, exit] }; the "through"
// points keep the router on that road instead of cutting across.
import { ROUTING } from './config.js';
import { d2, nearestIndex, bearing, heading } from './geo.js';

export const newTrip = () => ({ items: [], loop: true, pref: '0.5', range: 120, need90: false });

const round5 = p => [+p[0].toFixed(5), +p[1].toFixed(5)];

// Every point the route must pass, in order; `via` points are pass-through, not stops.
export function tripPoints(trip, withVias = true) {
  const pts = [];
  trip.items.forEach(it => it.pts.forEach((p, j) => {
    const via = it.type === 'road' && j > 0 && j < it.pts.length - 1;
    if (!via || withVias) pts.push({ p, via });
  }));
  if (trip.loop && pts.length > 1) pts.push({ p: pts[0].p, via: false });
  return pts;
}

// Drop pass-through points if there are too many to route.
export function routablePoints(trip) {
  const pts = tripPoints(trip);
  return pts.length > ROUTING.maxLocations ? tripPoints(trip, false) : pts;
}

// A stretch as a stop: entry and exit are its two farthest-apart ends, plus up to two pieces'
// midpoints about a third and two thirds along, so the router follows it.
export function roadStop(g) {
  if (g.oneway) {
    // A ramp only goes one way: ride its longest piece in its own direction.
    const r = g.roads.reduce((a, b) => b.length > a.length ? b : a);
    return { type: 'road', oneway: true, label: g.key, curvy: g.curvy, score: g.score, ids: g.ids,
      pts: [r.geom[0], r.geom[Math.floor(r.geom.length / 2)], r.geom[r.geom.length - 1]].map(round5) };
  }
  const ends = g.roads.flatMap(r => [r.geom[0], r.geom[r.geom.length - 1]]);
  let a = ends[0], b = ends[1], far = -1;
  ends.forEach((p, i) => ends.slice(i + 1).forEach(q => {
    const d = d2(p, q);
    if (d > far) { far = d; a = p; b = q; }
  }));
  const len = d2(a, b) || 1;
  const along = p => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len;
  const mids = g.roads.map(r => r.geom[Math.floor(r.geom.length / 2)]).map(p => [along(p), p])
    .filter(([t]) => t > 0.15 && t < 0.85);
  const vias = [];
  for (const t of [1 / 3, 2 / 3]) {
    const m = mids.reduce((best, m) => !best || Math.abs(m[0] - t) < Math.abs(best[0] - t) ? m : best, null);
    if (m && !vias.includes(m[1])) vias.push(m[1]);
  }
  return { type: 'road', label: g.key, curvy: g.curvy, score: g.score, ids: g.ids, pts: [a, ...vias, b].map(round5) };
}

// Ride a road stop starting from whichever end is nearer `from`.
export function orientFrom(stop, from) {
  if (stop.oneway) return stop;
  if (from && d2(from, stop.pts[stop.pts.length - 1]) < d2(from, stop.pts[0])) stop.pts.reverse();
  return stop;
}

const lastPoint = trip => {
  const last = trip.items[trip.items.length - 1];
  return last && last.pts[last.pts.length - 1];
};

// New stops go last, or just before the end of a one-way ride.
const append = (trip, stop) => { const end = endOf(trip); trip.items.splice(end ? trip.items.length - 1 : trip.items.length, 0, stop); };

export function addRoad(trip, g) {
  const end = endOf(trip), before = end ? { items: trip.items.slice(0, -1) } : trip;
  append(trip, orientFrom(roadStop(g), lastPoint(before)));
  return trip;
}

// Add a road where it fits best: the place in the ride, and the direction, that add the least
// distance (counting the ride back to the start on a loop). Never before the start or after the end.
// Returns its index.
export function insertRoad(trip, g) {
  const stop = roadStop(g), items = trip.items, n = items.length, wrap = trip.loop && n;
  const dist = (a, b) => a && b ? Math.sqrt(d2(a, b)) : 0;
  const entry = it => it.pts[0], exit = it => it.pts[it.pts.length - 1];
  let best = null;
  // From the end backwards, so a tie keeps the old behaviour of adding it last.
  for (let i = endOf(trip) ? n - 1 : n; i >= (startOf(trip) ? 1 : 0); i--) {
    const prev = i > 0 ? exit(items[i - 1]) : wrap ? exit(items[n - 1]) : null;
    const next = i < n ? entry(items[i]) : wrap ? entry(items[0]) : null;
    const nearer = orientFrom({ ...stop, pts: [...stop.pts] }, prev).pts;
    for (const pts of stop.oneway ? [nearer] : [nearer, [...nearer].reverse()]) {
      const cost = dist(prev, pts[0]) + dist(pts[pts.length - 1], next) - dist(prev, next);
      if (!best || cost < best.cost - 1e-9) best = { cost, i, pts };
    }
  }
  stop.pts = best.pts;
  items.splice(best.i, 0, stop);
  return best.i;
}

// Turn stop i into a road ridden end to end, in the same place in the ride, entered from the
// end that adds the least riding.
export function replaceWithRoad(trip, i, g) {
  const stop = roadStop(g), items = trip.items, n = items.length, wrap = trip.loop && n > 1;
  const prev = i > 0 ? items[i - 1] : wrap ? items[n - 1] : null, next = i < n - 1 ? items[i + 1] : wrap ? items[0] : null;
  const dist = (a, b) => a && b ? Math.sqrt(d2(a, b)) : 0;
  const from = prev && prev.pts[prev.pts.length - 1], to = next && next.pts[0];
  const cost = pts => dist(from, pts[0]) + dist(pts[pts.length - 1], to);
  if (!stop.oneway && cost([...stop.pts].reverse()) < cost(stop.pts) - 1e-9) stop.pts.reverse();
  items[i] = stop;
  return stop;
}

// Which end a road stop is entered and left at, as compass words ("north", "southwest").
export const ends = stop => {
  const a = stop.pts[0], b = stop.pts[stop.pts.length - 1];
  return { entry: heading(bearing(b, a)), exit: heading(bearing(a, b)) };
};

export function addPoint(trip, at, label, atStart = false) {
  const stop = { type: 'point', label, pts: [round5(at)] };
  atStart ? trip.items.unshift(stop) : append(trip, stop);
  return trip;
}

// The first stop becomes the start: replaced if it's already a pinned start, else added before.
export function setStart(trip, at, label) {
  const first = trip.items[0];
  if (first && first.type === 'point' && first.start) {
    first.pts = [round5(at)];
    first.label = label;
  } else {
    trip.items.unshift({ type: 'point', start: true, label, pts: [round5(at)] });
  }
  return trip;
}

export const startOf = trip => {
  const first = trip.items[0];
  return first && first.type === 'point' ? first : null;
};

// Where a one-way ride finishes: its last stop, a pinned point marked `end`. Setting it makes the
// ride one way.
export const endOf = trip => {
  const last = trip.items[trip.items.length - 1];
  return !trip.loop && last && last.type === 'point' && last.end && trip.items.length > 1 ? last : null;
};

export function setEnd(trip, at, label) {
  const end = endOf(trip) || trip.items.find(it => it.end);
  if (end) {
    trip.items.splice(trip.items.indexOf(end), 1);
    end.pts = [round5(at)];
    end.label = label;
  }
  trip.items.push(end || { type: 'point', end: true, label, pts: [round5(at)] });
  trip.loop = false;
  return trip;
}

export function moveStop(trip, from, to) {
  const [it] = trip.items.splice(from, 1);
  trip.items.splice(to, 0, it);
  return trip;
}

export const flipStop = (trip, i) => { if (!trip.items[i].oneway) trip.items[i].pts.reverse(); return trip; };
export const removeStop = (trip, i) => { trip.items.splice(i, 1); return trip; };

// Where a new stop at point p belongs: before the first stop the route reaches after it.
export function indexAlongRoute(trip, p, path) {
  const target = nearestIndex(path, p);
  let from = 0;
  const at = trip.items.findIndex(it => (from = nearestIndex(path, it.pts[0], from)) > target);
  return at < 0 ? trip.items.length : at;
}

// Share links: base64 JSON, compatible with v1's #trip= links (v1 ignores the extra ids and gen fields).
export function encodeTrip(trip) {
  const data = {
    l: trip.loop ? 1 : 0, p: trip.pref, r: trip.range, n: trip.need90 ? 1 : 0,
    s: trip.items.map(it => [it.type === 'road' ? 'r' : 'p', it.label, Math.round(it.curvy || 0), it.pts.map(round5), it.ids || 0, it.gen ? 1 : 0, it.oneway ? 1 : 0]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTrip(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  return {
    loop: !!d.l, pref: d.p ?? '0.5', range: +(d.r ?? 120), need90: !!d.n,
    items: d.s.map(([t, label, curvy, pts, ids, gen, oneway], i) => ({
      type: t === 'r' ? 'road' : 'point', label, curvy, pts, ...(ids ? { ids } : {}), ...(gen ? { gen: true } : {}),
      ...(oneway ? { oneway: true } : {}),
      ...(t !== 'r' && i === 0 && /^Start/.test(label) ? { start: true } : {}),
      ...(t !== 'r' && i > 0 && i === d.s.length - 1 && !d.l && /^End/.test(label) ? { end: true } : {}),
    })),
  };
}
