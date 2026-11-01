// Shared constants. The thresholds come from FEATURES.md; change them there too.

export const DATA_URL = 'tiles/';

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
  { label: 'Flyover', min: 1000, color: '#f472b6', about: 'Two-thirds of a mile or more: usually the big elevated flyovers.' },
];
export const RAMP_ABOUT = 'One-way interchange ramps that sweep at speed (curves of about 500–5,000 ft radius). Tight cloverleaf loops are left out.';
export const RAMP_TYPES = new Set(['motorway_link', 'trunk_link']);

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
  minCurveM: 2000,
  // Shorter curvy roads (down to wayHomeM of curves, not farm lanes) only join a loop that
  // doubles back, as another way home: one within wayHomeKm of the stretch ridden twice.
  wayHomeM: 800, wayHomeKm: 3,
  under: 0.8, overrun: 1.2,   // loops must route to 80–120% of the chosen time
  maxBack: 0.04,     // share of a loop ridden twice before it tries dropping a road
  hideBack: 0.2,     // loops riding more than this share twice are left out (if 3 others remain)
};

export const GOOGLE = { perPart: 9, parts: 2, pastTurn: 200, minSpacing: 800, maxGap: 25000 };
export const DECISION_TURNS = new Set([9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26]);

export const FUEL = { nearRoute: 1200, reserve: 0.85 };

export const PHOTON = 'https://photon.komoot.io/api/';
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
