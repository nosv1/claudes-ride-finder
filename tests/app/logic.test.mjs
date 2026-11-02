// Tests for the app's logic modules. Run from the repo root:  node --test tests/app/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { distance, decodePolyline, spotOnLine, headingOnPath, alongRoute, nearestIndex } from '../../js/geo.js';
import { decodeRow, visible, clusterRoads, stretchOf, bestInView, hillLevel, roadNear, roadAlong } from '../../js/roads.js';
import { newTrip, addRoad, insertRoad, replaceWithRoad, ends, flipStop, addPoint, setStart, tripPoints, encodeTrip, decodeTrip, indexAlongRoute, moveStop } from '../../js/trip.js';
import { planFuel, googlePoints, googleLinks, buildOptions, candidateGroups, estimate, gpx, orientStops, retrace, wayHomeRoads } from '../../js/plan.js';
import { normWords, matchesAll, localResults } from '../../js/search.js';
import { timesAlong, weatherPoints, atPassing, rideWeather, sky } from '../../js/weather.js';
import { flight, turn, nextTurn, gradeAt } from '../../js/fly.js';

const TILES = new URL('../../tiles/', import.meta.url);
const haveTiles = existsSync(new URL('index.js', TILES));
const loadTile = key => {
  const s = readFileSync(new URL(`${key}.js`, TILES), 'utf8');
  return JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')'))).map(decodeRow);
};
const loadSearch = () => {
  const s = readFileSync(new URL('search.js', TILES), 'utf8');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
};

const FILTERS = { mode: 'ride', minSpeed: 45, minHills: 0, hideUnpaved: true, classes: new Set([0, 1, 2, 3, 4]), speedBins: new Set([...Array(9).keys()]), zoom: 12 };

// A fake road row along a line of [lat, lon] points.
function row({ id = 1, hw = 'secondary', name = '', ref = '', mph = null, est = 55, surface = 0, score = 0, curvy = 0, sweep = 0, length = 1000, pts = east(38, -93), hill = null }) {
  const coords = [];
  let plat = 0, plon = 0;
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    coords.push(a - plat, b - plon);
    plat = a; plon = b;
  }
  return decodeRow([id, hw, name, ref, mph, est, surface, score, curvy, sweep, length, coords, hill, []]);
}
const east = (lat, lon0, n = 10, step = 0.001) => Array.from({ length: n }, (_, i) => [lat, lon0 + i * step]);

// ---------- geometry ----------

test('Street View faces the way the route goes', () => {
  const north = Array.from({ length: 20 }, (_, i) => [38 + i * 0.001, -94]);
  assert.ok(Math.abs(headingOnPath(north, [38.005, -94.0001])) < 1, 'heading north');
  const south = [...north].reverse();
  assert.ok(Math.abs(headingOnPath(south, [38.005, -94.0001]) - 180) < 1, 'heading south');
  assert.equal(headingOnPath(north, [38.005, -93.9]), null, 'not on the route');
});

test('distance and polyline decoding', () => {
  assert.ok(Math.abs(distance([38, -94], [39, -94]) - 111195) < 200);
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('the spot on a road nearest a click, facing along it', () => {
  const { p, heading } = spotOnLine([[38, -94], [38, -93.9]], [38.001, -93.95]);
  assert.ok(Math.abs(p[0] - 38) < 1e-9 && Math.abs(p[1] + 93.95) < 1e-9);
  assert.ok(Math.abs(heading - 90) < 0.5, 'road runs east');
});

// ---------- roads ----------

test('curve classes, sweepers and the Best rides filter', () => {
  const twisty = row({ score: 1000, length: 1000 });
  const sweeper = row({ sweep: 900, length: 3000 });
  const slow = row({ score: 1000, length: 1000, est: 30 });
  const gravel = row({ score: 1000, length: 1000, surface: 1 });
  assert.equal(twisty.cls, 4);
  assert.equal(sweeper.cls, 0);
  assert.equal(row({ sweep: 500, length: 2000 }).cls, -1, 'too little sweep for its length');
  assert.ok(visible(twisty, FILTERS) && visible(sweeper, FILTERS));
  assert.ok(!visible(slow, FILTERS), 'under the speed floor');
  assert.ok(visible(slow, { ...FILTERS, mode: 'curvy' }), 'Curvy mode ignores speed');
  assert.ok(!visible(gravel, FILTERS));
  assert.equal(hillLevel(11), 0);
  assert.equal(hillLevel(22), 2);
});

test('fast ramps: sweeping ones count, cloverleaf loops don’t, and they stay out of the curvy modes', () => {
  const flyover = row({ hw: 'motorway_link', name: 'Ramp to I 435 North', sweep: 700, curvy: 50, length: 800 });
  const loop = row({ hw: 'motorway_link', name: 'Ramp', sweep: 300, curvy: 400, length: 450 });
  assert.equal(flyover.rampTier, 1);
  assert.equal(flyover.cls, -1, 'not a curvy-road class');
  assert.equal(loop.rampTier, -1);
  const f = { ...FILTERS, mode: 'ramps', rampTiers: new Set([0, 1, 2]) };
  assert.ok(visible(flyover, f) && !visible(loop, f));
  assert.ok(!visible(flyover, FILTERS), 'hidden in Best rides');
  // One-way: ridden in its own direction even when the trip ends near its far end.
  const g = stretchOf([flyover], flyover), trip = newTrip();
  addPoint(trip, flyover.geom.at(-1), 'Near the exit end');
  addRoad(trip, g);
  assert.deepEqual(trip.items[1].pts[0], flyover.geom[0].map(v => +v.toFixed(5)));
});

test('same-named pieces form stretches only when close', () => {
  const a = row({ id: 1, ref: 'MO Y', score: 600, pts: east(38, -93) });
  const b = row({ id: 2, ref: 'MO Y', score: 600, pts: east(38, -92.985) });
  const far = row({ id: 3, ref: 'MO Y', score: 600, pts: east(38, -91) });
  assert.equal(clusterRoads([a, b, far]).length, 2);
  assert.deepEqual(stretchOf([a, b, far], a).ids.sort(), [1, 2]);
});

test('MO-150 east of Lee\'s Summit is a 55 mph sweeper and ranks in view', { skip: !haveTiles }, () => {
  const roads = loadTile('-189_77');
  const mo150 = roads.find(r => r.id === 18518688);
  assert.equal(mo150.cls, 0);
  assert.equal(mo150.speed, 55);
  const best = bestInView(roads, [38.8, -94.4, 38.88, -94.25], FILTERS);
  assert.ok(best.some(g => g.key === 'MO 150'));
});

// ---------- trip ----------

test('trip points loop back, and roads are ridden from the nearer end', () => {
  const road = row({ ref: 'MO Y', score: 600, pts: east(38, -93) }), g = stretchOf([road], road);
  const trip = newTrip();
  setStart(trip, [38, -92.99], 'Start');  // east of the road, so ride it westward
  addRoad(trip, g);
  const pts = tripPoints(trip);
  assert.deepEqual(pts[pts.length - 1].p, pts[0].p);
  assert.ok(trip.items[1].pts[0][1] > trip.items[1].pts.at(-1)[1], 'entry is the east end');
  moveStop(trip, 1, 0);
  assert.equal(trip.items[0].type, 'road');
});

test('an added road goes where it fits best, entered from the sensible end, and can be switched', () => {
  // A loop from home west to road A, then north; road B sits between them.
  const trip = newTrip();
  setStart(trip, [38, -94], 'Start');
  const a = row({ id: 1, ref: 'A', score: 600, pts: east(38, -94.5, 10, 0.01) });     // runs west to east, 0.5° west of home
  addRoad(trip, stretchOf([a], a));
  const north = row({ id: 2, ref: 'N', score: 600, pts: east(38.5, -94.3, 10, 0.01) });
  addRoad(trip, stretchOf([north], north));
  const between = row({ id: 3, ref: 'B', score: 600, pts: Array.from({ length: 10 }, (_, i) => [38.05 + i * 0.03, -94.45]) });  // runs north
  const at = insertRoad(trip, stretchOf([between], between));
  assert.equal(at, 2, 'between A and N');
  assert.deepEqual(trip.items.map(i => i.label), ['Start', 'A', 'B', 'N']);
  assert.deepEqual(ends(trip.items[2]), { entry: 'south', exit: 'north' });
  flipStop(trip, 2);
  assert.deepEqual(ends(trip.items[2]), { entry: 'north', exit: 'south' });
  // Never before the start, and onto an empty trip it just goes in.
  const empty = newTrip();
  assert.equal(insertRoad(empty, stretchOf([a], a)), 0);
});

test('a stop pinned on a road can become that road, ridden end to end in its place', () => {
  const trip = newTrip();
  setStart(trip, [38, -94], 'Start');
  const b = row({ id: 3, ref: 'B', score: 600, pts: Array.from({ length: 10 }, (_, i) => [38.05 + i * 0.03, -94.45]) });  // runs north
  const other = row({ id: 4, ref: 'C', score: 600, pts: east(38.2, -94.3, 10, 0.01) });
  addPoint(trip, [38.2, -94.4501], 'Stop');                    // about 10 m off B
  addPoint(trip, [38.3, -94], 'Lunch');
  assert.equal(roadNear([b, other], [38.2, -94.4501]), b);
  assert.equal(roadNear([b, other], [38.2, -94.44]), null, 'nearly 900 m off: not on it');
  assert.equal(roadNear([b, other], [38.2, -94.4501], r => r !== b), null, 'only roads that are shown');
  replaceWithRoad(trip, 1, stretchOf([b], b));
  assert.deepEqual(trip.items.map(i => i.label), ['Start', 'B', 'Lunch']);
  assert.equal(trip.items[1].type, 'road');
  assert.deepEqual(ends(trip.items[1]), { entry: 'south', exit: 'north' }, 'in from the start side, out toward Lunch');
});

test('loop roads are turned so the rides between them are shortest overall', () => {
  // Road E runs east from near the start; road N runs north from just by E's west end.
  // Nearest-end-first would ride N from its south end and finish 30 km out; turned around, N
  // is ridden south, back toward home.
  const start = [38, -94];
  const first = { type: 'road', label: 'E', pts: [[38.1, -93.98], [38.1, -93.85]] };
  const second = { type: 'road', label: 'N', pts: [[38.12, -93.99], [38.3, -93.99]] };
  orientStops(start, [first, second]);
  assert.deepEqual(first.pts[0], [38.1, -93.98], 'enters E at its west end');
  assert.deepEqual(second.pts[0], [38.3, -93.99], 'enters N at its north end');
  const ramp = { type: 'road', oneway: true, label: 'R', pts: [[38.2, -94], [38.1, -94]] };
  orientStops(start, [ramp]);
  assert.deepEqual(ramp.pts[0], [38.2, -94], 'a ramp keeps its direction');
});

test('doubling back is measured, crossings and the ride home are not', () => {
  const out = east(38.5, -94, 301, 0.0002);                 // ~5 km east
  const outAndBack = [...out, ...[...out].reverse().slice(1, 151)];  // back half of the way
  const r = retrace(outAndBack, 0);
  assert.ok(r.meters > 2300 && r.meters < 2800, `about 2.6 km ridden twice, got ${r.meters}`);
  assert.equal(r.lines.length, 1);
  // A plus-shaped crossing isn't doubling back.
  const cross = [...east(38.5, -94, 101, 0.0002), ...Array.from({ length: 100 }, (_, i) => [38.49 + i * 0.0002, -93.99])];
  assert.equal(retrace(cross, 0).meters, 0);
  // Leaving home and coming back the same last mile isn't counted by default.
  const home = [...east(38.5, -94, 51, 0.0002), ...Array.from({ length: 200 }, (_, i) => [38.5 + i * 0.0002, -93.99]),
    ...Array.from({ length: 50 }, (_, i) => [38.54, -93.99 - i * 0.0002]), ...Array.from({ length: 200 }, (_, i) => [38.54 - i * 0.0002, -94]),
  ];
  assert.equal(retrace([...home, ...east(38.5, -94, 51, 0.0002).reverse()]).meters, 0);
});

test('share links round-trip and read v1 links', () => {
  const trip = newTrip();
  setStart(trip, [38.85, -94.34], 'Start: Greenwood');
  addPoint(trip, [38.9, -94.3], 'Gas: Casey\'s');
  trip.items.push({ type: 'road', label: 'MO 150', curvy: 1100, ids: [18518688], pts: [[38.83, -94.36], [38.85, -94.3]] });
  trip.range = 80; trip.need90 = true; trip.loop = false;
  const back = decodeTrip(encodeTrip(trip));
  assert.deepEqual(back.items.map(i => [i.type, i.label, i.pts]), trip.items.map(i => [i.type, i.label, i.pts]));
  assert.deepEqual([back.range, back.need90, back.loop, back.items[2].ids], [80, true, false, [18518688]]);
  assert.ok(back.items[0].start, 'the start stays the start');
  // A link made by v1 (no ids, ASCII only).
  const v1 = Buffer.from(JSON.stringify({ l: 1, p: '0.5', r: '120', n: 0, s: [['p', 'Start', 0, [[38.85, -94.34]]], ['r', 'MO 7', 5000, [[38.8, -94.2], [38.9, -94.1]]]] })).toString('base64');
  const old = decodeTrip(v1);
  assert.equal(old.items.length, 2);
  assert.equal(old.items[1].type, 'road');
});

test('a gas stop goes where the route passes it', () => {
  const path = east(38.5, -94, 101, 0.01);
  const trip = newTrip();
  addPoint(trip, path[0], 'A');
  addPoint(trip, path[100], 'B');
  assert.equal(indexAlongRoute(trip, path[50], path), 1);
});

// ---------- planning ----------

test('fuel plan picks stops within range and flags long gaps', () => {
  const path = east(38.5, -95, 401, 0.01);  // ~350 km due east
  const stations = [40, 120, 200, 220].map((i, n) => ({ lat: 38.5, lon: -95 + i * 0.01, status: n === 1 ? 0 : 2 }));
  const plan = planFuel(path, stations, 80, false);
  assert.equal(plan.along.length, 4);
  assert.ok(plan.picks.length >= 2);
  assert.ok(plan.gaps.length >= 1, 'the last ~110 mi have no station');
  const only90 = planFuel(path, stations, 80, true);
  assert.ok(!only90.ok.some(a => a.item.status < 1));
});

test('Google Maps export: a stop just past each turn, no stretch over 25 km without one', () => {
  const path = east(38.5, -94, 1001, 0.00115);
  const trip = { ...newTrip(), loop: false, items: [{ type: 'point', label: 'A', pts: [path[0]] }, { type: 'point', label: 'B', pts: [path[1000]] }] };
  const route = { path, maneuvers: [{ type: 15, at: 300, end: 600, km: 30, names: [] }] };
  const idx = googlePoints(route, trip).map(p => nearestIndex(path, p)).sort((a, b) => a - b);
  assert.ok(idx.some(i => i > 300 && i <= 303));
  for (let k = 1; k < idx.length; k++) assert.ok(distance(path[idx[k - 1]], path[idx[k]]) <= 25000);
  assert.equal(googleLinks(Array(25).fill([38, -94])).length, 3, '9 stops per link');
});

test('generator builds loops that fit the time', () => {
  const start = [38.5, -94];
  const groups = [0, 1, 2, 3, 4, 5].map(i => {
    const a = [38.5 + 0.3 * Math.cos(i), -94 + 0.3 * Math.sin(i)], b = [a[0] + 0.03, a[1] + 0.03];
    return { key: `R${i}`, score: 1000 + i, curvy: 5000, stop: { type: 'road', label: `R${i}`, pts: [a, b] }, center: a };
  });
  const options = buildOptions(groups, start, 2);
  assert.ok(options.length > 0);
  options.forEach(o => assert.ok(estimate(start, o.stops).hours <= 2));
});

test('a long ride fills its time instead of stopping at a few roads by the start', () => {
  // Good roads all around, from 10 to 150 km out; nearby ones score as well as far ones.
  const start = [38.5, -94];
  const groups = [];
  for (let ring = 1; ring <= 10; ring++) {
    for (let k = 0; k < 12; k++) {
      const ang = (k * 30 + ring * 7) * Math.PI / 180, d = ring * 0.135;
      const a = [38.5 + d * Math.cos(ang), -94 + d * Math.sin(ang) / 0.78], b = [a[0] + 0.05, a[1] + 0.05];
      groups.push({ key: `R${ring}-${k}`, score: 3000 + (k * 37 + ring * 53) % 400, curvy: 8000, ids: [ring * 100 + k], stop: { type: 'road', label: `R${ring}-${k}`, pts: [a, b] }, center: a });
    }
  }
  for (const hours of [3, 6, 8]) {
    const est = buildOptions(groups, start, hours).map(o => estimate(start, o.stops).hours);
    assert.ok(est.length > 0);
    assert.ok(est[0] >= 0.8 * hours, `best ${hours} h loop estimated at ${est[0].toFixed(2)} h`);
    est.forEach(h => assert.ok(h >= 0.7 * hours && h <= hours, `${hours} h loop estimated at ${h.toFixed(2)} h`));
  }
});

test('generator builds every loop through the rider’s own road', () => {
  const start = [38.5, -94];
  const groups = [0, 1, 2, 3, 4, 5].map(i => {
    const a = [38.5 + 0.3 * Math.cos(i), -94 + 0.3 * Math.sin(i)], b = [a[0] + 0.03, a[1] + 0.03];
    return { key: `R${i}`, score: 1000 + i, curvy: 5000, ids: [i], stop: { type: 'road', label: `R${i}`, pts: [a, b] }, center: a };
  });
  const mine = { type: 'road', label: 'MO 150', ids: [99], pts: [[38.2, -94.2], [38.22, -94.15]] };
  const options = buildOptions(groups, start, 3, [mine]);
  assert.ok(options.length > 0);
  for (const o of options) {
    const own = o.stops.filter(s => s.label === 'MO 150');
    assert.equal(own.length, 1, 'includes MO 150 exactly once');
    assert.ok(!own[0].gen, 'the rider’s road is not marked as generated');
    assert.ok(o.stops.filter(s => s.label !== 'MO 150').every(s => s.gen), 'added roads are marked');
  }
  // The rider's road is used even when nothing else fits the time.
  const tight = buildOptions(groups, start, 0.1, [mine]);
  assert.ok(tight.every(o => o.stops.length === 1 && o.stops[0].label === 'MO 150'));
});

test('a decent loop to one side makes the list even when the other side has more', () => {
  const start = [38.5, -94];
  const road = (i, ang, score) => {
    const a = [38.5 + 0.25 * Math.cos(ang * Math.PI / 180), -94 + 0.32 * Math.sin(ang * Math.PI / 180)], b = [a[0] + 0.03, a[1] + 0.03];
    return { key: `R${i}`, score, curvy: 5000, ids: [i], stop: { type: 'road', label: `R${i}`, pts: [a, b] }, center: a };
  };
  const groups = [...Array.from({ length: 36 }, (_, i) => road(i, -90 + i * 5, 5000 + (i * 37) % 500)), road(97, 170, 3000), road(98, 180, 3000), road(99, 190, 3000)];
  const opts = buildOptions(groups, start, 1.5);
  assert.ok(opts.some(o => o.stops.some(s => s.label === 'R98')), 'the south loop is among the options');
  assert.ok(opts[0].stops.every(s => s.label !== 'R98'), 'but still ranked by value');
});

test('short curvy roads are kept only as another way home, never as the main roads', () => {
  const start = [38.5, -94];
  const roads = [
    row({ id: 1, ref: 'MO F', score: 900, curvy: 1100, pts: east(38.6, -93.9) }),
    row({ id: 2, hw: 'unclassified', name: 'Farm Lane', score: 900, curvy: 1100, pts: east(38.6, -93.8) }),
    row({ id: 3, ref: 'MO TT', score: 4000, curvy: 3500, pts: east(38.7, -93.9) }),
  ];
  const groups = candidateGroups(roads, start, 100, () => true);
  assert.deepEqual(groups.map(g => [g.key, !!g.small]).sort(), [['MO F', true], ['MO TT', false]]);
  const opts = buildOptions(groups, start, 1.5);
  assert.ok(opts.length && opts.every(o => o.stops.every(s => s.label === 'MO TT')), 'loops are built from the main roads');
  assert.equal(buildOptions(groups.filter(g => g.small), start, 1.5).length, 0);
});

test('another way home: roads near the stretch ridden twice, not on it, not already in the loop', () => {
  const line = Array.from({ length: 1000 }, (_, i) => [38.5, -94 + i * 0.0002]);  // ridden twice, 15–20 m apart like retrace's
  const g = (id, score, pts) => ({ key: `R${id}`, ids: [id], score, roads: [{ geom: pts }], stop: { pts: [pts[0], pts[pts.length - 1]] } });
  const beside = g(1, 500, east(38.515, -93.95, 30)), better = g(2, 900, east(38.52, -93.9, 30));
  const on = g(3, 2000, east(38.5, -93.95, 30)), far = g(4, 3000, east(38.8, -93.95, 30)), used = g(5, 4000, east(38.51, -93.95, 30));
  const picks = wayHomeRoads([beside, better, on, far, used], [{ ids: [5] }], [line]);
  assert.deepEqual(picks.map(p => p.key), ['R2', 'R1']);
  assert.deepEqual(wayHomeRoads([beside], [], []), []);
});

test('weather: points along the ride, timed by the router, read for the hour you pass them', () => {
  // 100 km due east; the first half takes 1 h (slow), the second half 0.5 h.
  const path = Array.from({ length: 101 }, (_, i) => [38.5, -94 + i * 0.01148]);
  const route = { path, meters: 100000, seconds: 5400, maneuvers: [{ at: 0, end: 50, s: 3600 }, { at: 50, end: 100, s: 1800 }] };
  const t = timesAlong(route);
  assert.equal(t[0], 0);
  assert.ok(Math.abs(t[50] - 3600) < 1 && Math.abs(t[100] - 5400) < 1, `${t[50]} ${t[100]}`);
  assert.ok(Math.abs(timesAlong({ ...route, maneuvers: null })[50] - 2700) < 30, 'by distance without maneuver times');
  const pts = weatherPoints(route, 25);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0].p, path[0]);
  assert.deepEqual(pts.at(-1).p, path[100]);
  assert.ok(weatherPoints(route, 1, 12).length === 12, 'capped');

  const t0 = 1800000000, hour = k => t0 + k * 3600;
  const hourly = {
    time: Array.from({ length: 6 }, (_, k) => hour(k)),
    temperature_2m: [60, 62, 64, 66, 68, 70], precipitation_probability: [0, 10, 70, 20, 0, 0],
    wind_gusts_10m: [10, 12, 40, 14, 10, 10], weather_code: [0, 2, 95, 3, 1, 0],
  };
  const two = [{ p: [0, 0], m: 0, s: 0 }, { p: [0, 1], m: 50000, s: 3600 }, { p: [0, 2], m: 100000, s: 7200 * 3 }];
  const rows = atPassing(two, [hourly, hourly, hourly], (t0 + 3600) * 1000);
  assert.deepEqual(rows.map(r => r.temp), [62, 64, undefined]);
  assert.ok(rows[2].none, 'past the forecast');
  const judged = rideWeather(rows);
  assert.deepEqual(judged.warnings.map(w => w.text), ['Thunderstorms', 'Rain likely (70%)', 'Gusts to 40 mph']);
  assert.equal(judged.warnings[1].at.m, 50000);
  assert.ok(judged.partial);
  const calm = rideWeather(atPassing(two.slice(0, 1), [hourly], (t0 + 4 * 3600) * 1000));
  assert.deepEqual(calm.warnings, []);
  assert.equal(calm.summary, '68°F, rain chance up to 0%, gusts to 10 mph');
  assert.equal(rideWeather([{ none: true }]).summary, null);
  assert.equal(sky(63)[1], 'Rain');
  assert.equal(sky(96)[1], 'Thunderstorms');
  assert.equal(sky(2)[1], 'Partly cloudy');
});

test('GPX has waypoints, a route and the track', () => {
  const trip = { ...newTrip(), items: [{ type: 'point', label: 'Start & go', pts: [[38, -94]] }, { type: 'point', label: 'B', pts: [[38.1, -94]] }] };
  const out = gpx(trip, { path: [[38, -94], [38.05, -94], [38.1, -94]] });
  assert.match(out, /<wpt lat="38.000000" lon="-94.000000"><name>1. Start &amp; go<\/name>/);
  assert.equal((out.match(/<trkpt/g) || []).length, 3);
});

// ---------- search ----------

test('search words normalise like riders type', () => {
  assert.deepEqual(normWords('K-10'), ['k', '10']);
  assert.deepEqual(normWords('k10'), ['k', '10']);
  assert.ok(matchesAll(normWords('lees summit'), "Lee's Summit"));
  assert.ok(!matchesAll(['y'], 'York'));
});

test('search finds routes, roads near towns, and towns', { skip: !haveTiles }, () => {
  const index = loadSearch(), keys = q => localResults(q, index).filter(r => r.kind === 'road').map(r => r.key);
  assert.equal(keys('hwy 7')[0], 'MO 7');
  assert.ok(keys('MO Y camdenton').includes('MO Y'));
  assert.ok(localResults('lees summit', index).some(r => r.label === "Lee's Summit"));
});

test('fly-through: plays a route by its riding time, slower where the riding is slower, and looks down the road', () => {
  // 20 km east then 2 km north; the first 10 km take 10 min (60 km/h), the rest 5 min (144 km/h).
  const path = [...Array.from({ length: 21 }, (_, i) => [38, -94 + i * 0.0115]), [38.009, -93.77], [38.018, -93.77]];
  const f0 = flight({ path, seconds: 900 });
  const route = { path, seconds: 900, maneuvers: [{ at: 0, end: 10, s: 600 }, { at: 10, end: path.length - 1, s: 300 }] };
  const f = flight(route);
  assert.ok(Math.abs(f.seconds - 900) < 1e-6);
  assert.ok(Math.abs(f.secondsAt(f.metersAt(123)) - 123) < 1e-6);
  assert.ok(f.metersAt(300) < f0.metersAt(300), 'the slow first part plays slower than by distance');
  assert.ok(Math.abs(f.pointAt(f.metersAt(600))[1] - (-94 + 10 * 0.0115)) < 1e-9, '10 min in: the end of the slow part');
  assert.ok(Math.abs(f.lookFrom(1000, 250) - 90) < 1, 'looking east on the straight');
  assert.ok(Math.abs(f.lookFrom(f.total, 250)) < 1 || Math.abs(f.lookFrom(f.total, 250) - 360) < 1, 'at the end: along the last stretch (north)');
  assert.deepEqual(f.pointAt(-5), path[0]);
  assert.deepEqual(f.pointAt(1e9), path.at(-1));
  // Turning eases the short way around.
  assert.equal(turn(350, 10, 0.5), 0);
  assert.equal(turn(10, 350, 0.5), 0);
  assert.equal(turn(90, 180, 1), 180);
});

test('elevation: smoothing evens out grid noise; climbing ignores small wiggles but keeps real hills', async () => {
  const { smooth, climbOf } = await import('../../js/elevation.js');
  assert.deepEqual(smooth([0, 10, 0, 10, 0], 1), [5, 10 / 3, 20 / 3, 10 / 3, 5]);
  // A 40 m hill with ±4 m of noise on top: smoothing takes most of the noise's false climbing out.
  const hill = Array.from({ length: 200 }, (_, i) => 300 + 40 * Math.sin(i / 199 * Math.PI) + (i % 2 ? 4 : -4));
  assert.ok(climbOf(hill) > 300, 'raw noise counts as climbing');
  assert.ok(Math.abs(climbOf(smooth(hill)) - 40) < 6, `about the hill's 40 m: ${climbOf(smooth(hill))}`);
});

test('fly-through: the road under the rider runs their way; the next real turn; the grade', () => {
  const ew = row({ id: 1, ref: 'EW', score: 600, pts: east(38, -94, 10, 0.001) });
  const ns = row({ id: 2, ref: 'NS', score: 600, pts: Array.from({ length: 10 }, (_, i) => [37.996 + i * 0.001, -93.995]) });
  assert.equal(roadAlong([ew, ns], [38, -93.995], 90), ew, 'heading east: the east-west road, not the one crossing');
  assert.equal(roadAlong([ew, ns], [38, -93.995], 180), ns);
  assert.equal(roadAlong([ew, ns], [38, -93.995], 45), null, 'neither runs northeast');
  const ms = [{ type: 1, at: 0, text: 'Drive east.' }, { type: 8, at: 5, text: 'Continue on A.' },
    { type: 4, at: 9, text: 'You have arrived.' }, { type: 15, at: 12, text: 'Turn left onto B.' }];
  assert.equal(nextTurn(ms, 0).text, 'Turn left onto B.', 'skips continue and arrivals at stops');
  assert.equal(nextTurn(ms, 12), null);
  // 1,000 m rising 50 m: a 5% grade.
  const profile = { meters: 1000, samples: Array.from({ length: 11 }, (_, i) => ({ m: i * 100, ft: i * 5 * 3.281 })) };
  assert.ok(Math.abs(gradeAt(profile, 500) - 5) < 1e-9);
  assert.equal(gradeAt(null, 500), null);
});
