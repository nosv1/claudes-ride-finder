// Tests for the app's logic modules. Run from the repo root:  node --test tests/app/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { boundsOf, distance, decodePolyline, spotOnLine, headingOnPath, alongRoute, nearestIndex } from '../../js/geo.js';
import { decodeRow, visible, clusterRoads, stretchOf, bestInView, rollersInView, hillLevel, roadNear, roadAlong, setMyMph, limitOf } from '../../js/roads.js';
import { RAMP_TIERS } from '../../js/config.js';
import { newTrip, addRoad, insertRoad, setEnd, endOf, startOf, replaceWithRoad, ends, flipStop, addPoint, setStart, tripPoints, encodeTrip, decodeTrip, indexAlongRoute, moveStop } from '../../js/trip.js';
import { rideMix, rideFocus, planFuel, googlePoints, googleLinks, buildOptions, alongLine, candidateGroups, estimate, gpx, orientStops, retrace, detours, stopIndexAt, wayHomeRoads, onTheWay, curvyMetersOn, highwayMetersOn, turnarounds, stoplightsOn } from '../../js/plan.js';
import { normWords, matchesAll, localResults } from '../../js/search.js';
import { timesAlong, weatherPoints, atPassing, rideWeather, sky } from '../../js/weather.js';
import { flight, turn, nextTurn, gradeAt, turnOnto, turnArrow } from '../../js/fly.js';
import { fetchRoute, routerTrouble } from '../../js/routing.js';

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

const FILTERS = { mode: 'ride', roadType: 'all', rampTiers: new Set(RAMP_TIERS.map((_, i) => i)), minSpeed: 45, minHills: 0, hideUnpaved: true, classes: new Set([0, 1, 2, 3, 4]), speedBins: new Set([...Array(9).keys()]), zoom: 12 };

// A fake road row along a line of [lat, lon] points.
function row({ id = 1, hw = 'secondary', name = '', ref = '', mph = null, est = 55, surface = 0, score = 0, curvy = 0, sweep = 0, length = 1000, pts = east(38, -93), hill = null, lanes = null }) {
  const coords = [];
  let plat = 0, plon = 0;
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    coords.push(a - plat, b - plon);
    plat = a; plon = b;
  }
  return decodeRow([id, hw, name, ref, mph, est, surface, score, curvy, sweep, length, coords, hill, [], lanes]);
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
  const f = { ...FILTERS, roadType: 'highway', rampTiers: new Set([0, 1, 2]) };
  assert.ok(visible(flyover, f) && !visible(loop, f));
  assert.ok(!visible(flyover, FILTERS), 'All roads shows only the big flyovers (city ramps are confetti there)');
  const big = row({ hw: 'motorway_link', name: 'Ramp to I 470 East', sweep: 1100, curvy: 50, length: 1200 });
  assert.ok(visible(big, FILTERS), 'a Flyover shows with All roads');
  assert.ok(!visible(big, { ...FILTERS, roadType: 'back' }), 'hidden with Back roads');
  assert.ok(!visible(row({ score: 1000, length: 1000 }), f), 'Highways hides the curvy roads');
  // One-way: ridden in its own direction even when the trip ends near its far end.
  const g = stretchOf([flyover], flyover), trip = newTrip();
  addPoint(trip, flyover.geom.at(-1), 'Near the exit end');
  addRoad(trip, g);
  assert.deepEqual(trip.items[1].pts[0], flyover.geom[0].map(v => +v.toFixed(5)));
});

test('highway sweeps: their own tiers in Interchanges, a bonus for 3+ lanes, one way, never twice in Speed limits', () => {
  const hwy = (sweep, lanes, id = -1) => row({ id, hw: 'motorway', ref: 'I 435;US 50', mph: 70, est: null, sweep, lanes, length: sweep + 400 });
  const tier = label => RAMP_TIERS.findIndex(t => t.label === label);
  assert.equal(hwy(700, 2).rampTier, tier('Highway sweep'));
  assert.equal(hwy(1000, 2).rampTier, tier('Highway sweep'));
  assert.equal(hwy(1000, 3).rampTier, tier('Big highway sweep'), '3 lanes count a quarter extra');
  assert.equal(hwy(500, 3).rampTier, tier('Highway sweep'));
  assert.equal(hwy(500, 2).rampTier, -1);
  const h = hwy(800, 3);
  assert.ok(h.highway && h.oneway);
  assert.equal(h.cls, -1, 'not in the curvy modes');
  assert.equal(h.key, 'I 435 heading east', 'named for the way it heads');
  const all = { ...FILTERS, roadType: 'highway' };
  assert.ok(visible(h, all));
  assert.ok(!visible(h, { ...all, rampTiers: new Set([0, 1, 2]) }), 'its tier can be turned off');
  // The speed-limit tiles have the plain highway pieces; the sweep would draw over them.
  const speed = { ...FILTERS, mode: 'speed' }, piece = row({ id: 2, hw: 'motorway', ref: 'I 435', mph: 70, est: null, lanes: 3 });
  assert.ok(!visible(h, speed) && visible(piece, speed));
  assert.equal(piece.rampTier, -1, 'a plain highway piece is not a sweep');
  // The two directions are separate stretches.
  const back = row({ id: -3, hw: 'motorway', ref: 'I 435', mph: 70, est: null, sweep: 800, lanes: 3, pts: east(38.0003, -93).reverse() });
  assert.equal(back.key, 'I 435 heading west');
  assert.deepEqual(stretchOf([h, back], h).ids, [-1]);
});

test('the I-435 bend in Lenexa is a highway sweep both ways', { skip: !haveTiles }, () => {
  const near = [38.946, -94.768];
  const found = loadTile('-190_77').filter(r => r.highway && r.key.startsWith('I 435') && roadNear([r], near, () => true, 300));
  assert.ok(found.length >= 2, `found ${found.map(r => r.key).join(', ')}`);
  assert.ok(found.every(r => r.rampTier >= 0 && r.mph >= 65 && r.lanes >= 3));
  assert.ok(new Set(found.map(r => r.key)).size >= 2, 'one per direction');
});

test('same-named pieces form stretches only when close', () => {
  const a = row({ id: 1, ref: 'MO Y', score: 600, pts: east(38, -93) });
  const b = row({ id: 2, ref: 'MO Y', score: 600, pts: east(38, -92.985) });
  const far = row({ id: 3, ref: 'MO Y', score: 600, pts: east(38, -91) });
  assert.equal(clusterRoads([a, b, far]).length, 2);
  assert.deepEqual(stretchOf([a, b, far], a).ids.sort(), [1, 2]);
});

test('a tapped stretch leaves out pieces the filters hide', () => {
  // Little Blue Road: the tapped piece is drawn; the next piece is too slow for Ride and drawn
  // without color, so it shouldn't light up (or count) with it.
  const a = row({ id: 1, name: 'Little Blue Road', score: 600, pts: east(38, -93) });
  const slow = row({ id: 2, name: 'Little Blue Road', score: 600, est: 30, pts: east(38, -92.985) });
  assert.deepEqual(stretchOf([a, slow], a).ids.sort(), [1, 2], 'without filters, every piece');
  assert.deepEqual(stretchOf([a, slow], a, FILTERS).ids, [1]);
  assert.deepEqual(stretchOf([a, slow], a, { ...FILTERS, mode: 'curvy' }).ids.sort(), [1, 2], 'shown in Curvy mode');
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

test('a stretch ridden twice gets a spot to either side to ride through, in that part of the loop', () => {
  const out = east(38.5, -94, 301, 0.0002);                   // ~5 km east and straight back
  const path = [...out, ...[...out].reverse().slice(1)];
  const twice = retrace(path, 0), spots = detours(twice);
  assert.equal(twice.spans.length, twice.lines.length);
  assert.ok(twice.spans[0][0] > 5000, 'the second pass is on the way back');
  assert.equal(spots.length, 2);
  // North and south of the road, about a third of its length out (but at least 2 km).
  const lats = spots.map(d => d.p[0]).sort();
  assert.ok(lats[0] < 38.485 && lats[1] > 38.515, `either side, got ${lats}`);
  spots.forEach(d => assert.ok(Math.abs(d.p[1] - -93.97) < 0.01, 'off the middle'));
  // Out to a road at the far end and back: the spot goes after it, on the ride home.
  const items = [{ type: 'point', pts: [path[0]] }, { type: 'road', pts: [path[290], path[300]] }];
  assert.equal(stopIndexAt(path, items, spots[0].m), 2);
  assert.equal(stopIndexAt(path, items, 100), 1);
  assert.deepEqual(detours(retrace(out, 0)), []);
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
  // Accents and curly quotes in labels, a generated one-way road, a pinned end, and the Fastest setting.
  trip.items.push({ type: 'road', label: 'Route de l’Église', curvy: 0, ids: [1373218700, 13105698], pts: [[29.62049, -98.79487]], gen: true, oneway: true });
  setEnd(trip, [38.7, -94.1], 'End: Café');
  trip.pref = '1';
  assert.deepEqual(decodeTrip(encodeTrip(trip)), { ...trip, items: trip.items.map(it => ({ ...it, curvy: Math.round(it.curvy || 0) })) });
  // Links made before the packed format (base64 JSON) still open.
  const json = Buffer.from(JSON.stringify({ l: 0, p: '0', r: 150, n: 1, s: [['p', 'Start: Café', 0, [[38.85, -94.34]], 0, 0, 0], ['r', 'MO 150', 1100, [[38.83, -94.36], [38.85, -94.3]], [18518688], 1, 0]] })).toString('base64url');
  const before = decodeTrip(json);
  assert.deepEqual([before.items[0].label, before.items[0].start, before.items[1].ids, before.items[1].gen, before.range, before.pref], ['Start: Café', true, [18518688], true, 150, '0']);
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

test('one way: ways there that keep left, right or near the straight line, ending at the end', () => {
  // 100 km east. Roads either side of the line, near it, and some behind the start or past the end.
  const start = [38.5, -94], end = [38.5, -92.85];
  const along = alongLine(start, end, [38.6, -93.425]);
  assert.ok(Math.abs(along.t - 0.5) < 0.01 && Math.abs(along.off + 11.1) < 0.2, `halfway, 11 km left: ${JSON.stringify(along)}`);
  const road = (key, lat, lon) => ({ key, score: 2000, curvy: 5000, ids: [key], stop: { type: 'road', label: key, pts: [[lat, lon], [lat, lon + 0.03]] }, center: [lat, lon + 0.015] });
  const groups = [road('N1', 38.65, -93.7), road('N2', 38.7, -93.3), road('S1', 38.35, -93.6), road('S2', 38.3, -93.2),
    road('M1', 38.5, -93.5), road('BEHIND', 38.5, -94.6)];
  const options = buildOptions(groups, start, 2.5, [], end);
  const by = Object.fromEntries(options.map(o => [o.way, o]));
  const keys = o => o.chosen.map(g => g.key);
  assert.ok(keys(by.left).every(k => k.startsWith('N')), `left (north going east): ${keys(by.left)}`);
  assert.ok(keys(by.right).every(k => k.startsWith('S')), `right: ${keys(by.right)}`);
  assert.equal(by.left.dir, 0, 'the left side heading east is north');
  options.forEach(o => {
    assert.ok(!keys(o).includes('BEHIND'));
    assert.ok(estimate(start, o.stops, end).hours <= 2.5);
    // Ordered along the way.
    const ts = o.stops.map(st => alongLine(start, end, st.pts[0]).t);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  });
  // An end set before the start stays the end.
  const early = setEnd(newTrip(), end, 'End: Warsaw');
  assert.equal(startOf(early), null);
  assert.equal(endOf(early).label, 'End: Warsaw');
  setStart(early, start, 'Start');
  assert.deepEqual(early.items.map(it => it.label), ['Start', 'End: Warsaw']);
  // A one-way trip keeps its end last.
  const trip = newTrip();
  setStart(trip, start, 'Start');
  setEnd(trip, end, 'End: Warsaw');
  assert.equal(trip.loop, false);
  assert.equal(endOf(trip).label, 'End: Warsaw');
  addPoint(trip, [38.6, -93.4], 'Stop');
  insertRoad(trip, { key: 'R', curvy: 1, score: 1, ids: [9], roads: [{ geom: [[38.5, -93], [38.51, -92.99]] }] });
  assert.equal(trip.items[trip.items.length - 1].label, 'End: Warsaw');
  setEnd(trip, [38.4, -92.9], 'End');
  assert.equal(trip.items.filter(it => it.end).length, 1);
  assert.deepEqual(endOf(trip).pts[0], [38.4, -92.9]);
  assert.deepEqual(decodeTrip(encodeTrip(trip)).items.map(it => !!it.end), trip.items.map(it => !!it.end));
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

test('sweeping highways count toward a ride, and the generator can ride to one', () => {
  const start = [38.5, -94];
  const sweep = row({ id: -1, hw: 'motorway', ref: 'I 435', mph: 70, est: null, sweep: 1000, lanes: 3, length: 1400, pts: east(38.6, -93.9, 15) });
  const plain = row({ id: 2, hw: 'motorway', ref: 'I 435', mph: 70, est: null, lanes: 3, length: 1400, pts: east(38.7, -93.9, 15) });
  const curvy = row({ id: 3, ref: 'MO TT', score: 4000, curvy: 3500, length: 1400, pts: east(38.8, -93.9, 15) });
  const along = pts => pts.map(([la, lo]) => [la + 0.00005, lo]);
  assert.ok(highwayMetersOn(along(sweep.geom), [sweep, plain, curvy]) > 1000, 'riding the sweep counts');
  assert.equal(highwayMetersOn(along(plain.geom), [sweep, plain, curvy]), 0, 'straight interstate doesn’t');
  assert.equal(curvyMetersOn(along(sweep.geom), [sweep, plain, curvy]), 0, 'and it isn’t a curvy road');
  // Short as it is, a highway sweep is a stop of its own, not just another way home.
  const groups = candidateGroups([sweep, curvy], start, 100, () => true);
  const g = groups.find(x => x.key.startsWith('I 435'));
  assert.ok(g && !g.small && g.oneway);
  assert.ok(buildOptions([g], start, 1.5).some(o => o.stops.some(st => st.label === g.key && st.oneway)));
  assert.deepEqual(wayHomeRoads([g], [], [along(sweep.geom)]), [], 'a one-way highway isn’t a way home');

  // The hills and mph chips are hidden with Highways, and a setting left over from All roads doesn't apply: the
  // generator's candidates (main.js: the map's filters, as visible() reads them) still have the sweep. Highways aren't
  // held to hills or mph with All roads either; the curvy road is (its hills weren't measured, so not Very hilly).
  const worthy = f => r => !r.roller && visible(r, { ...f, mode: 'ride' }) && (!r.oneway || r.highway);
  for (const roadType of ['highway', 'all']) {
    const keys = candidateGroups([sweep, curvy], start, 100, worthy({ ...FILTERS, roadType, minHills: 3, minSpeed: 55 })).map(x => x.key);
    assert.ok(keys.some(k => k.startsWith('I 435')), `${roadType}: the sweep counts whatever the hills setting`);
    assert.ok(!keys.includes('MO TT'), `${roadType}: the curvy road doesn't`);
  }
});

test('turnarounds: off the highway and back the other way counts; cloverleaf loops, hairpins and plain loops don’t', () => {
  const line = (lat0, lon0, dlat, dlon, km) => Array.from({ length: Math.round(km * 20) + 1 }, (_, i) => [lat0 + dlat * i / 20 / 111, lon0 + dlon * i / 20 / 87]);
  // 6 km east, cross over 40 m north, 6 km back west: one turnaround, at the far end.
  const out = line(38.5, -94, 0, 1, 6), back = line(38.50036, out.at(-1)[1], 0, -1, 6);
  const spots = turnarounds([...out, ...back]);
  assert.equal(spots.length, 1);
  assert.ok(spots[0][1] > -94 + 5.5 / 87, 'at the far end');
  // A cloverleaf loop (70 m radius, 270°) in the middle of a straight ride.
  const c = out.at(-1), loop = Array.from({ length: 28 }, (_, i) => { const a = -Math.PI / 2 + i * (1.5 * Math.PI) / 27; return [c[0] + 0.07 / 111 * (1 + Math.sin(a)), c[1] + 0.07 / 87 * Math.cos(a)]; });
  const on = line(loop.at(-1)[0], loop.at(-1)[1], 1, 0, 6);
  assert.equal(turnarounds([...out, ...loop, ...on]).length, 0);
  // A hairpin: legs 60 m apart. On a curvy road it's the ride; anywhere else it reads as turning back.
  const leg2 = line(38.50054, out.at(-1)[1], 0, -1, 0.6), after = line(leg2.at(-1)[0], leg2.at(-1)[1], 1, 0, 5);
  const hairpin = [...out, ...leg2, ...after];
  const curvy = row({ id: 9, ref: 'MO W', score: 900, length: 2000, pts: [...out.slice(-30), ...leg2] });
  assert.equal(turnarounds(hairpin, [curvy]).length, 0);
  assert.equal(turnarounds(hairpin).length, 1);
  // A plain loop: 4 km a side.
  const sq = [...line(38.5, -94, 0, 1, 4), ...line(38.5, -94 + 4 / 87, 1, 0, 4).slice(1), ...line(38.5 + 4 / 111, -94 + 4 / 87, 0, -1, 4).slice(1), ...line(38.5 + 4 / 111, -94, -1, 0, 4).slice(1)];
  assert.equal(turnarounds(sq).length, 0);
});

test('stoplights on a route: one per intersection, and which way it turns there', () => {
  const line = (lat0, lon0, dlat, dlon, km) => Array.from({ length: Math.round(km * 20) + 1 }, (_, i) => [lat0 + dlat * i / 20 / 111, lon0 + dlon * i / 20 / 87]);
  // 3 km east, then left (north) 3 km.
  const east3 = line(38.5, -94, 0, 1, 3), corner = east3.at(-1), north3 = line(corner[0], corner[1], 1, 0, 3).slice(1);
  const path = [...east3, ...north3];
  const L = (lat, lon) => ({ lat, lon });
  const lights = [
    L(38.5, -94 + 1 / 87),                                  // straight through, 1 km in
    L(corner[0] + 0.0001, corner[1]), L(corner[0], corner[1] - 0.0002),  // the corner: two nodes, one intersection
    L(38.5 + 0.0004, -94 + 2 / 87),                         // 45 m off the route: a side street
    L(39.5, -93),                                           // nowhere near
  ];
  const found = stoplightsOn(path, lights);
  assert.deepEqual(found.map(f => f.turn), ['straight', 'left']);
  // The same corner ridden the other way is a right.
  assert.deepEqual(stoplightsOn([...path].reverse(), lights).map(f => f.turn), ['right', 'straight']);
  // A straight road mapped with points 150 m apart, the light at one of them: straight through, not a left.
  const sparse = Array.from({ length: 20 }, (_, i) => [39.0048, -94.1 - i * 0.00175]);
  assert.deepEqual(stoplightsOn(sparse, [{ lat: 39.0048, lon: -94.1 - 10 * 0.00175 }]).map(f => f.turn), ['straight']);
  assert.deepEqual(stoplightsOn(path, []), [], 'no light data yet: nothing counted');
  assert.deepEqual(stoplightsOn(path, null), []);
});

test('roads on the way: the loop rides past an end of them, but not along them', () => {
  const route = Array.from({ length: 400 }, (_, i) => [38.5 + i * 0.0005, -94]);  // 22 km north
  const g = (id, score, pts, extra = {}) => ({ key: `R${id}`, ids: [id], score, roads: [{ geom: pts }], stop: { pts: [pts[0], pts[pts.length - 1]] }, ...extra });
  const ff = g(1, 900, east(38.55, -93.9995, 40));        // starts at the route, runs off east (MO FF off MO 7)
  const better = g(2, 2000, east(38.6, -93.999, 40).reverse());  // ends at it
  const along = g(3, 3000, Array.from({ length: 40 }, (_, i) => [38.52 + i * 0.001, -94.0005]));  // the route's own road
  const far = g(4, 4000, east(38.55, -93.9, 40)), used = g(5, 5000, east(38.56, -93.999, 40));
  const oneway = g(6, 6000, east(38.57, -93.999, 40), { oneway: true });
  assert.deepEqual(onTheWay([ff, better, along, far, used, oneway], [{ ids: [5] }], route).map(x => x.key), ['R2', 'R1']);
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

test('a short closed loop (a roundabout, a circle drive) is not a curvy road; a long loop road still is', () => {
  const ring = (n, rDeg) => Array.from({ length: n + 1 }, (_, i) => [38 + rDeg * Math.sin(i / n * 2 * Math.PI), -94 + rDeg * Math.cos(i / n * 2 * Math.PI)]);
  const roundabout = row({ id: 1, hw: 'secondary', score: 250, curvy: 125, length: 160, pts: ring(16, 0.0002) });
  assert.equal(roundabout.loop, true);
  assert.equal(roundabout.cls, -1);
  const parkLoop = row({ id: 2, hw: 'tertiary', name: 'Park Loop', score: 2000, curvy: 1500, length: 4000, pts: ring(60, 0.005) });
  assert.equal(parkLoop.loop, false);
  assert.ok(parkLoop.cls >= 0);
});

test('fly-through: the turn tag names the road turned onto, with an arrow the right way', () => {
  assert.equal(turnOnto({ names: ['MO 350', 'Blue Parkway'], text: 'Turn left onto MO 350/Blue Parkway.' }), 'MO 350 / Blue Parkway');
  assert.equal(turnOnto({ names: [], text: 'Turn right.' }), 'Turn right.');
  assert.equal(turnArrow(15), '↰');
  assert.equal(turnArrow(10), '↱');
  assert.equal(turnArrow(22), '↑');
});

// The routers stubbed: Valhalla answers with status `valhalla` (an HTML error page, as a busy server sends), OSRM with `osrm`.
async function routeWith(valhalla, osrm) {
  const asked = { valhalla: 0, osrm: 0 }, real = globalThis.fetch, warn = console.warn;
  globalThis.fetch = async url => {
    const which = String(url).includes('osrm') ? 'osrm' : 'valhalla';
    asked[which]++;
    return new Response('<html>error</html>', { status: which === 'osrm' ? osrm : valhalla });
  };
  console.warn = () => {};
  try {
    // Fresh points each time, so the answer cache doesn't hide a request.
    const r = await fetchRoute([{ p: [38.9, -94.3 + Math.random()], via: false }, { p: [38.95, -94.2], via: false }], 0.5);
    return { r, asked };
  } finally {
    globalThis.fetch = real;
    console.warn = warn;
  }
}

test('a busy router gets a friendly message, and isn\'t asked again allowing U-turns', async () => {
  const busy = await routeWith(503, 429);
  assert.equal(busy.r, null);
  assert.equal(busy.asked.valhalla, 1);
  assert.match(routerTrouble(), /busy right now/);
  const tooMany = await routeWith(429, 429);
  assert.equal(tooMany.asked.valhalla, 1);
  assert.match(routerTrouble(), /busy right now/);
  // No route without a U-turn (Valhalla says 400): asked again allowing one. Any other failure is just a failure.
  const noRoute = await routeWith(400, 500);
  assert.equal(noRoute.asked.valhalla, 2);
  assert.match(routerTrouble(), /Couldn’t reach the routing servers/);
});

test('roller coasters: straight hilly back roads, shown only when asked for, and never in Best rides', () => {
  const roller = row({ id: 5, ref: 'MO Y', length: 2000, hill: 30 });
  assert.ok(roller.roller && roller.cls === -1);
  assert.ok(!row({ length: 2000, hill: 15 }).roller, 'rolling is not enough');
  assert.ok(!row({ length: 600, hill: 30 }).roller, 'too short');
  assert.ok(!row({ score: 1000, length: 2000, hill: 30 }).roller, 'a curvy road is its curve class');
  assert.ok(!row({ hw: 'motorway', length: 2000, hill: 30, mph: 70 }).roller, 'back roads only');
  assert.ok(!visible(roller, FILTERS), 'off unless turned on');
  const on = { ...FILTERS, rollers: true };
  assert.ok(visible(roller, on));
  assert.ok(!visible(roller, { ...on, minHills: 3 }), 'the hills filter still applies (30 is Hilly, not Very hilly)');
  assert.ok(!visible(roller, { ...on, roadType: 'highway' }));
  const twisty = row({ id: 6, ref: 'MO 7', score: 1000, length: 1000, pts: east(38, -92.99) });
  const view = [37.9, -93.1, 38.1, -92.9];
  assert.deepEqual(bestInView([roller, twisty], view, on).map(g => g.key), ['MO 7']);
  const [g] = rollersInView([roller, twisty], view, on);
  assert.ok(g.key === 'MO Y' && g.roller && g.length === 2000);
  assert.deepEqual(rollersInView([roller], view, FILTERS), [], 'none while the layer is off');
});

test('a ride says what it rides, in the filters’ words, and which roads fit the filters', () => {
  const road = (key, cls, hill, lon0, n, extra = {}) => {
    const geom = east(38.5, lon0, n, 0.001);
    return { key, name: key, cls, hill, hillLevel: hill == null ? -1 : hill >= 35 ? 3 : hill >= 22 ? 2 : hill >= 12 ? 1 : 0,
      rampTier: -1, roller: false, surface: 0, speed: 55, geom, bounds: boundsOf(geom), ...extra };
  };
  const sweeper = road('MO 150', 0, 40, -94, 30), curvy = road('MO Y', 2, 15, -93.97, 20), gravel = road('CR 5', 4, 40, -93.95, 10, { surface: 1 });
  const path = east(38.5, -94, 70, 0.001);  // ~6 km: 2.6 km sweeper, 1.7 km curvy, 0.9 km gravel, then nothing
  const mix = rideMix(path, [sweeper, curvy, gravel], r => r.hill >= 35);
  assert.ok(mix.byClass[0] > 2400 && mix.byClass[2] > 1500 && mix.byClass[4] === 0, 'gravel never counts');
  assert.deepEqual(mix.roads.map(g => [g.key, g.cls]), [['MO 150', 0], ['MO Y', 2]], 'in ride order');
  assert.ok(Math.abs(mix.fits - mix.roads[0].m) < 1 && mix.roads[1].fitM === 0, 'only the very hilly sweeper fits');
  assert.deepEqual(rideFocus(mix).map(f => f.label), ['Sweepers', 'Curvy', 'Hilly']);
  assert.deepEqual(rideFocus(rideMix(path, [])), [], 'nothing to say about a ride on no fun roads');
});

test('the app says the same version as version.json (tools/bump_version.mjs sets both)', async () => {
  const { APP_VERSION } = await import('../../js/config.js');
  const { version } = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, version);
  assert.match(version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

// ---------- Ride mode (nav.js) and road tags (tags.js) ----------
import { Track, Guide, rejoinTarget, turnsOf, callout, spoken, shown, turnClips, distanceClip } from '../../js/nav.js';
import { setTags, setSpeed, speedFixes, tagOf, weightOf, avoidedIds, restoreTags, allTags, thin, tagsForMap } from '../../js/tags.js';
import { sayable } from '../../js/voice.js';

// An L: ~2.2 km north, then ~2.2 km east, with a stop at the corner (the router ends a leg there and starts the next
// with "head east", which is really a right turn).
const ell = () => {
  const path = [];
  for (let i = 0; i <= 100; i++) path.push([39 + i * 0.0002, -94]);
  for (let i = 1; i <= 100; i++) path.push([39.02, -94 + i * 0.00026]);
  return { path, meters: 4400, seconds: 300, maneuvers: [
    { type: 1, at: 0, names: ['MO D'], text: 'Head north on MO D.' },
    { type: 4, at: 100, names: [], text: 'You have arrived at your stop.' },
    { type: 1, at: 100, names: ['MO Y'], text: 'Head east on MO Y.' },
    { type: 4, at: 200, names: [], text: 'You have arrived.' },
  ] };
};
const fixAt = (p, heading, speed = 20) => ({ p, heading, speed, accuracy: 5 });

test('Ride mode: a stop where the road turns is a turn; the arrival is called only at the end', () => {
  const turns = turnsOf(ell());
  assert.deepEqual(turns.map(t => [t.type, t.text]), [[10, 'Turn right onto MO Y'], [4, 'You have arrived.']]);
  assert.ok(Math.abs(turns[0].m - 2224) < 20);
  assert.deepEqual(turnsOf(ell(), false).map(t => t.type), [10], 'a way back onto the ride doesn’t arrive anywhere');
});

test('Ride mode: following the ride, leaving it, and picking it up again further on', () => {
  const t = new Track(ell().path);
  t.update(fixAt([39.004, -94.0001], 0));
  assert.ok(t.on && Math.abs(t.m - 445) < 15, `${t.m}`);
  // A stretch away from the line: off after three fixes, not one.
  t.update(fixAt([39.006, -93.995], 90));
  assert.equal(t.on, true);
  t.update(fixAt([39.007, -93.995], 0));
  t.update(fixAt([39.008, -93.995], 0));
  assert.equal(t.on, false);
  assert.ok(Math.abs(t.m - 445) < 15, 'where you left it stays put');
  // Back on it on the east leg, going east: picked up there, skipping the rest of the north leg.
  t.update(fixAt([39.02, -93.98], 90));
  assert.ok(t.on && t.jumped > 2000 && Math.abs(t.m - 2224 - 1730) < 30, `${t.m}`);
  // The same spot going the other way isn't the ride.
  const back = new Track(ell().path);
  back.update(fixAt([39.004, -94.0001], 0));
  for (let i = 0; i < 3; i++) back.update(fixAt([39.008, -93.995], 0));
  back.update(fixAt([39.02, -93.98], 270));
  assert.equal(back.on, false);
});

test('Ride mode: the way back goes on ahead, never back to where you left', () => {
  const t = new Track(ell().path);
  t.update(fixAt([39.004, -94], 0));
  // Just off to the side near where you left: back on a little past it.
  const near = rejoinTarget(t, [39.005, -93.999], 0, t.m);
  assert.ok(near.m >= t.m + 300 && near.m < t.m + 700, `${near.m}`);
  // Off east, nearer the far leg: onto that leg near you, not back down the north one.
  const far = rejoinTarget(t, [39.017, -93.985], 90, t.m);
  assert.ok(far.m > 2224 + 1000, `${far.m}`);
});

test('Ride mode: off the ride it asks for a way back, follows it, and says when you’re back on', async () => {
  let asked = null, now = 0;
  const g = new Guide(ell(), { now: () => now, reroute: async (p, heading, to) => {
    asked = { p, heading, to };
    return { path: [p, [39.012, -93.996], to.p], maneuvers: [] };
  } });
  assert.equal(g.fix(fixAt([39.004, -94], 0)), null);
  assert.equal(g.state, 'on');
  const next = g.upcoming(1)[0];
  assert.equal(next.turn.type, 10);
  assert.ok(Math.abs(next.inM - (2224 - 445)) < 20);
  let event;
  for (const lat of [39.006, 39.007, 39.008]) { now += 1000; event = g.fix(fixAt([lat, -93.996], 0)) || event; }
  assert.equal(event, 'off');
  assert.equal(g.state, 'off');
  await g.asking;
  assert.ok(asked && asked.to.m > 445 + 300 && asked.heading === 0);
  assert.equal(g.state, 'detour');
  // No asking again a moment later.
  const first = asked;
  now += 1000;
  g.fix(fixAt([39.0085, -93.996], 0));
  assert.equal(asked, first);
  // Back on the line, going its way.
  now += 1000;
  assert.equal(g.fix(fixAt([39.012, -94], 0)), 'back');
  assert.equal(g.state, 'on');
  // Skip ahead while off asks for a spot further on.
  for (const lat of [39.013, 39.0135, 39.014]) { now += 20000; g.fix(fixAt([lat, -93.99], 0)); }
  await g.asking;
  const before = asked.to.m;
  now += 1000;
  g.skip();
  await g.asking;
  assert.ok(asked.to.m > before + 2500, `${before} → ${asked.to.m}`);
});

test('Ride mode: a loop’s last stretch isn’t where you are at the start', () => {
  const path = [...ell().path, [39.01, -93.974], [39.0001, -93.98], [39.0001, -93.999]];
  const t = new Track(path);
  for (let i = 0; i < 3; i++) t.update(fixAt([39.0001, -93.99], 270));  // on the way home's line, at the very start
  assert.equal(t.on, false, 'not picked up at the end');
  t.update(fixAt([39.004, -94], 0));
  assert.ok(t.on && t.m < 500);
});

test('Ride mode: the end of the ride is the end', () => {
  const g = new Guide(ell(), { reroute: async () => null });
  g.fix(fixAt([39.02, -93.99], 90));
  assert.equal(g.fix(fixAt([39.02, -93.9741], 90)), 'done');
  assert.equal(g.state, 'done');
});

test('Ride mode: a heads-up, then the call, each once, in words and in recorded clips', () => {
  const turn = { type: 10, names: ['MO Y'], text: 'Turn right onto MO Y', alert: 'Turn right onto Missouri Y.', pre: 'Turn right onto Missouri Y. Then turn left.' };
  assert.equal(callout(turn, 3000, 20), null, 'too far yet');
  // name: the road, for a natural voice to say after the clips ("onto Missouri Y.").
  assert.deepEqual(callout(turn, 650, 20), { text: 'In half a mile, turn right onto Missouri Y.', clips: ['dhalf', 'right'], name: 'MO Y' });
  assert.equal(callout(turn, 600, 20), null);
  assert.deepEqual(callout(turn, 170, 20), { text: 'Turn right onto Missouri Y. Then turn left.', clips: ['right'], name: 'MO Y' });
  assert.equal(callout({ type: 12, names: ['MO Y'], text: 'Make a U-turn' }, 100, 10).name, null, 'no name on a U-turn');
  assert.deepEqual(['MO 150', 'I-70', 'US 50', 'FM 1431', 'Northeast Strother Road'].map(sayable),
    ['Missouri 150', 'Interstate 70', 'U.S. 50', 'Farm to Market 1431', 'Northeast Strother Road']);
  assert.equal(callout(turn, 100, 20), null);
  assert.deepEqual(callout({ type: 26, exit: 2, text: 'Enter the roundabout' }, 100, 10).clips, ['roundabout', 'exit2']);
  assert.equal(callout({ type: 4, text: 'You have arrived.' }, 100, 10), null, 'the end of the ride says that');
  assert.deepEqual([spoken(100), spoken(1609), spoken(5000), spoken(20000)], ['300 feet', '1 mile', '3 miles', '12 miles']);
  assert.deepEqual([shown(90), shown(800), shown(30000)], ['300 ft', '0.5 mi', '19 mi']);
});

test('Ride mode: every clip it can ask for is recorded, in every voice', async () => {
  const { readdirSync } = await import('node:fs');
  const phrases = JSON.parse(readFileSync(new URL('../../voice/phrases.json', import.meta.url), 'utf8'));
  const voices = JSON.parse(readFileSync(new URL('../../voice/voices.json', import.meta.url), 'utf8'));
  const asked = new Set(['continue', 'arrive', 'arriveloop', 'start', 'off', 'detour', 'back', 'skipped', 'skipahead', 'crest', 'voiceon',
    ...[9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 37, 38].flatMap(type => turnClips({ type })),
    ...[1, 2, 3, 4].map(exit => `exit${exit}`), ...[100, 400, 800, 1200, 1500].map(distanceClip)]);
  for (const k of asked) assert.ok(phrases[k], `a phrase for ${k}`);
  assert.ok(voices.length >= 1);
  for (const v of voices) {
    const files = new Set(readdirSync(new URL(`../../voice/${v.id}/`, import.meta.url)));
    for (const k of Object.keys(phrases)) assert.ok(files.has(`${k}.${v.ext}`), `${v.id}/${k}.${v.ext}`);
    if (v.chime) assert.ok(existsSync(new URL('../../voice/chime.wav', import.meta.url)), 'the beep-boop');
  }
});

test('road tags: a stretch tagged, found by any of its pieces, left out or ranked by its tags, and undone', () => {
  const geom = east(38, -93, 40, 0.0001);
  const g = { key: 'MO D', roads: [{ id: 1, geom }, { id: 2, geom: east(38, -92.996, 10) }] };
  assert.ok(thin(geom).length < geom.length / 2, 'the kept line is thinned');
  const was = setTags(g, ['rough']);
  assert.equal(tagOf([2]).key, 'MO D');
  assert.equal(weightOf([1]), 0.5);
  assert.equal(avoidedIds().size, 0);
  // Tagging part of it again replaces the tag but keeps the other piece.
  setTags({ key: 'MO D', roads: [g.roads[0]] }, ['avoid', 'rough']);
  assert.equal(allTags().length, 1);
  assert.deepEqual([...avoidedIds()].sort(), [1, 2]);
  assert.equal(weightOf([2]), 0);
  assert.deepEqual(tagsForMap().map(t => [t.main, t.label, t.geoms.length]), [['avoid', 'Don’t ride · Rough', 2]]);
  setTags(g, []);
  assert.equal(tagOf([1]), null, 'no tags left: no record');
  restoreTags(was);
  assert.equal(allTags().length, 0);
});

test('your speed limit: kept with the tags, used for the whole stretch, and back to the map’s when cleared', () => {
  const geom = east(38, -93, 40, 0.0001);
  const g = { key: 'MO D', roads: [{ id: 1, geom }, { id: 2, geom: east(38, -92.996, 10) }] };
  const was = setTags(g, ['great'], 'nice');
  setSpeed(g, 45);
  assert.deepEqual([tagOf([2]).tags, tagOf([2]).note, tagOf([2]).mph], [['great'], 'nice', 45], 'tags and note kept');
  assert.deepEqual([...speedFixes()], [[1, 45], [2, 45]]);
  // Changing the tags keeps the speed; clearing the tags keeps the record for the speed.
  setTags(g, []);
  assert.equal(tagOf([1]).mph, 45);
  assert.equal(tagsForMap().length, 0, 'no tag to draw');
  setSpeed(g, null);
  assert.equal(tagOf([1]), null, 'nothing left: no record');
  restoreTags(was);
});

test('your speed limit on a road: Best rides’ speed chip and the Speed limits mode use it', () => {
  // A sweeper guessed at 30 (town), like NE Strother Rd by Lee's Summit.
  const r = row({ hw: 'tertiary', est: 30, sweep: 800, length: 2400 });
  assert.equal(visible(r, FILTERS), false, 'hidden at 45+');
  assert.equal(visible(r, { ...FILTERS, mode: 'speed' }), false, 'no limit to color by');
  assert.equal(setMyMph(r, 45), true);
  assert.equal(setMyMph(r, 45), false, 'no change');
  assert.deepEqual([r.speed, limitOf(r)], [45, 45]);
  assert.equal(visible(r, FILTERS), true);
  assert.equal(visible(r, { ...FILTERS, mode: 'speed' }), true);
  setMyMph(r, null);
  assert.deepEqual([r.speed, limitOf(r)], [30, null]);
  // Yours wins over a posted one too (signs change).
  const posted = row({ mph: 55, sweep: 800 });
  setMyMph(posted, 40);
  assert.equal(visible(posted, FILTERS), false);
});

