// Shared constants. The thresholds come from FEATURES.md; change them there too.

export const DATA_URL = 'tiles/';

// Accounts (optional sign-in): the API in worker/, and the site's Google sign-in client. The tests point the app at a
// local copy of the API with localStorage 'rf2-api'.
export const API_URL = (() => { try { return localStorage.getItem('rf2-api'); } catch (e) { return null; } })()
  || 'https://ride-finder-api.nosv1.workers.dev';
export const GOOGLE_CLIENT_ID = '103650653312-3hk8lc1uut14bd6n69tghgcgs740a3ip.apps.googleusercontent.com';

// The version this copy of the app is; version.json on the site is the latest. tools/bump_version.mjs sets both.
export const APP_VERSION = '2026.11.04.9';

// Curve classes, indexed by a road's `cls`: 0 sweeper, 1–4 tight-curve bins.
// `about` is the plain-words rule shown in the map key.
export const CURVE_CLASSES = [
  { label: 'Sweepers', min: null, color: '#22d3ee', width: 3,
    about: 'Fast, wide bends (about 500–2,000 ft radius) for half a mile or more, or most of a short road. Made for speed.' },
  { label: 'Some curves', min: 0.15, color: '#e6d52a', width: 3, about: 'Corners on about a tenth of the road, straights between them.' },
  { label: 'Curvy', min: 0.35, color: '#f59f1b', width: 3.5, about: 'Corners on a quarter to a third of the road.' },
  { label: 'Very curvy', min: 0.6, color: '#f2542d', width: 4, about: 'Corners on about half the road.' },
  { label: 'Twisty', min: 0.9, color: '#e040fb', width: 4.5, about: 'Corner after corner for most of the road, many of them tight.' },
];
export const CORNER_ABOUT = 'A corner is a bend tighter than about 575 ft radius; tight ones (under 200 ft) count extra.';

// Fast interchange ramps (Interchanges mode), by metres of sweeping curve.
export const RAMP_TIERS = [
  { label: 'Sweeping ramp', min: 300, color: '#a3e635', about: 'At least 1,000 ft of highway-speed curve.' },
  { label: 'Long sweep', min: 600, color: '#38bdf8', about: 'At least 2,000 ft of it.' },
  { label: 'Flyover', min: 1000, inAll: true, color: '#f472b6', about: 'Two-thirds of a mile or more: usually the big elevated flyovers.' },
  // The highway itself (interstates and divided highways posted 65+), one direction at a time. `min` is metres of
  // sweep, with 3+ lanes counting a quarter extra (HIGHWAY_LANES_BONUS).
  { label: 'Highway sweep', min: 600, highway: true, inAll: true, color: '#fb923c',
    about: 'A 65+ mph highway sweeping for at least 2,000 ft (1,600 ft with 3+ lanes), one direction.' },
  { label: 'Big highway sweep', min: 1200, highway: true, inAll: true, color: '#a78bfa',
    about: 'Three-quarters of a mile or more of it (just over half a mile with 3+ lanes).' },
];
export const RAMP_ABOUT = 'One-way interchange ramps and stretches of 65+ mph highway that sweep at speed (curves of about 500–5,000 ft radius). Tight cloverleaf loops are left out.';
export const RAMP_TYPES = new Set(['motorway_link', 'trunk_link']);
// Road types in the ride modes: All shows the tiers marked inAll in one color (HIGHWAYS) next to the curvy roads
// (every ramp in a city is confetti at that zoom); Highways shows all the tiers, each in its own color.
export const ROAD_TYPES = { all: 'All roads', back: 'Back roads', highway: 'Highways' };
export const HIGHWAYS = { label: 'Highways', color: '#f1f5f9', about: '65+ mph highways that sweep, and the big flyover ramps. Pick the Highways road type for every fast ramp, by kind.' };
// The tiers a road type shows, given the ones turned on.
export const tiersFor = (roadType, on) => [...on].filter(i => roadType === 'highway' || (roadType === 'all' && RAMP_TIERS[i].inAll));
export const HIGHWAY_TYPES = new Set(['motorway', 'trunk']);
export const HIGHWAY_LANES_BONUS = 1.25;  // 3+ lanes: room to pick a line, and it's usually the main road

export const SPEED_BINS = [
  { label: '≤20', max: 20, color: '#9b59d0' },
  { label: '25', max: 25, color: '#4c6ef5' },
  { label: '30', max: 30, color: '#1e9bd7' },
  { label: '35', max: 35, color: '#14b8a6' },
  { label: '40', max: 40, color: '#5cc940' },
  { label: '45', max: 45, color: '#e6d52a' },
  { label: '50–55', max: 55, color: '#f59f1b' },
  { label: '60–65', max: 65, color: '#f2542d' },
  { label: '70+', max: Infinity, color: '#e0245e' },
];

// Metres of climbing + descending per km. Typical curvy roads: W Kansas ~11, KC ~18, Ozarks ~30.
// `ft` is the same threshold in feet of up and down per mile.
export const HILLS = [
  { label: 'Flat', min: 0, ft: 0 },
  { label: 'Rolling', min: 12, ft: 60 },
  { label: 'Hilly', min: 22, ft: 115 },
  { label: 'Very hilly', min: 35, ft: 185 },
];

// Roller coasters: straight back roads that go up and down a lot (Hilly or more, over half a mile). A map layer to be
// aware of, off by default; the generator doesn't ride for them. build_tiles.py's ROLLER_* have the same numbers.
export const ROLLER = {
  label: 'Roller coasters', color: '#c08457', minHill: 22, minM: 1000, types: new Set(['primary', 'secondary', 'tertiary', 'unclassified']),
  about: 'Straight roads that go up and down a lot: 115+ ft of climbing and dropping per mile, for over half a mile. Not curvy, but you feel the hills (and crests hide what’s past them).',
};

export const FUEL_STATUS = {
  2: { label: '90+ listed', color: '#40c057' },
  1: { label: '90+ likely', color: '#c0eb75' },
  0: { label: '90+ unknown', color: '#adb5bd' },
  '-1': { label: 'No 90+', color: '#fa5252' },
};

export const SURFACE = ['Paved', 'Gravel or dirt', 'Not recorded (could be gravel)'];

export const SHIELD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
export const MINOR_TYPES = new Set(['unclassified', 'residential']);

export const ROUTING = {
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  osrm: 'https://router.project-osrm.org/route/v1/driving',
  valhallaMax: 10,     // the public server's per-request location limit
  maxLocations: 40,    // more than this and the through points on roads are dropped
};

export const GEN = {
  roadKmh: 60, linkKmh: 80, roadFactor: 1.3, maxRoads: 4, maxRoadsCap: 9, spread: 60, maxOptions: 6,
  sideMin: 0.15,     // each side of the start gets its best loop routed if it's this good next to the best
  minCurveM: 2000,
  // Shorter curvy roads (down to wayHomeM of curves, not farm lanes) only join a loop that
  // doubles back, as another way home: one within wayHomeKm of the stretch ridden twice.
  wayHomeM: 800, wayHomeKm: 3,
  onWayKm: 0.5,      // a road with an end this close to a routed loop is "on the way": try riding it
  twinKm: 1,         // one-way stretches centered this close are the two directions of one highway bend
  turnKeep: 0.6,     // a loop that turns around (off the highway, round through the lights, back on) keeps this much of its rank
  lightKeep: 0.97,   // each stoplight keeps this much of a loop's rank; a left turn at one counts as two
  backCost: 5,       // a loop keeps e^(-backCost × share ridden twice) of its rank: 10% twice keeps 61%, 20% 37%, 40% 14%
  backTries: 3,      // rounds of trying to fix a loop that doubles back
  under: 0.8, overrun: 1.2,   // loops must route to 80–120% of the chosen time
  maxBack: 0.04,     // share of a loop ridden twice before it tries dropping a road
  hideBack: 0.2,     // loops riding more than this share twice are left out (if 3 others remain)
};

// Weather along a ride (Open-Meteo: free, no key). A point about every everyKm, at most maxPoints;
// warnings at these levels.
export const WEATHER = {
  url: 'https://api.open-meteo.com/v1/forecast', days: 7, everyKm: 30, maxPoints: 12,
  rainPct: 40, likelyPct: 60, gustMph: 35, coldF: 45, hotF: 95,
};

// 3D: hills drawn taller than life (they look flat from above), and a camera that can sit low.
export const TERRAIN = { exaggeration: 2, maxPitch: 85, pitch: 65 };

// Fly-through: plays a ride at a multiple of its riding time, so curvy roads go by slower than
// highways. The camera sits low behind the rider and turns toward the road aheadM on. Terrain is
// drawn `exaggeration` times taller on curvy roads, flatExaggeration elsewhere (highways and
// towns, where bridges and road cuts turn into canyons), easing between them over ~liftS.
// When a hill hides the rider, the camera looks down more steeply, up to maxDip degrees, and
// eases back at dipBack degrees a second once it's clear.
export const FLY = {
  speeds: [5, 10, 20, 40], speed: 10, zoom: 16.2, pitch: 78, pitchTall: 72,
  exaggeration: 2.2, flatExaggeration: 1.2, liftS: 1.5,
  aheadM: 250, turnS: 0.6, crestM: 400, maxDip: 35, dipBack: 6,
};

// Ride mode (js/nav.js): within onM of the ride's line (plus up to slackM of GPS error) is on it; offFixes fixes in a
// row farther off is off it. On it, your spot is looked for from backM behind to aheadM ahead (200 m when stopped, so a
// road ridden out and back doesn't jump to the way back). Off it, you're back on wherever you're within rejoinM of the
// line going its way (within rejoinAngle), anywhere ahead: skip a part and it picks you up there. A way back is asked
// for at most every rerouteS (unless you've moved rerouteMovedM), to the spot on the ride (every stepM, at least skipM
// past where you left, so never back to it) quickest to reach, each metre it skips costing `sooner` metres and a spot
// behind you behindM more. Skip ahead moves that skipAheadM further on. Turns are called out twice: a heads-up about
// headsUpS (at least headsUpM) before, and the call callS (at least callM) before.
export const NAV = {
  onM: 35, slackM: 30, offFixes: 3, backM: 60, aheadM: 2000, stoppedAheadM: 200, movingMps: 3,
  rejoinM: 30, rejoinAngle: 50, finishM: 2000, arriveM: 60,
  rerouteS: 15, rerouteMovedM: 150, stepM: 100, skipM: 300, sooner: 0.2, behindM: 1500, skipAheadM: 3000,
  headsUpS: 35, headsUpM: 700, callS: 9, callM: 120, crestM: 400,
};

export const GOOGLE = { perPart: 9, parts: 2, pastTurn: 200, minSpacing: 800, maxGap: 25000 };
export const DECISION_TURNS = new Set([9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26]);

export const FUEL = { nearRoute: 1200, reserve: 0.85 };

export const PHOTON = 'https://photon.komoot.io/api/';
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
