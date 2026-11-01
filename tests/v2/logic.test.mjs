// Tests for v2's pure modules. Run from the repo root:  node --test tests/v2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { distance, decodePolyline, spotOnLine, alongRoute, nearestIndex } from '../../v2/js/geo.js';
import { decodeRow, visible, clusterRoads, stretchOf, bestInView, hillLevel } from '../../v2/js/roads.js';
import { newTrip, addRoad, addPoint, setStart, tripPoints, encodeTrip, decodeTrip, indexAlongRoute, moveStop } from '../../v2/js/trip.js';
import { planFuel, googlePoints, googleLinks, buildOptions, estimate, gpx } from '../../v2/js/plan.js';
import { normWords, matchesAll, localResults } from '../../v2/js/search.js';

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
