// Shared constants. The thresholds come from FEATURES.md; change them there too.

export const DATA_URL = 'tiles/';

// Curve classes, indexed by a road's `cls`: 0 sweeper, 1–4 tight-curve bins.
export const CURVE_CLASSES = [
  { label: 'Sweepers', hint: 'fast, wide curves', min: null, color: '#22d3ee', width: 3 },
  { label: 'Some curves', min: 0.15, color: '#e6d52a', width: 3 },
  { label: 'Curvy', min: 0.35, color: '#f59f1b', width: 3.5 },
  { label: 'Very curvy', min: 0.6, color: '#f2542d', width: 4 },
  { label: 'Twisty', min: 0.9, color: '#e040fb', width: 4.5 },
];

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
export const HILLS = [
  { label: 'Flat', min: 0 },
  { label: 'Rolling', min: 12 },
  { label: 'Hilly', min: 22 },
  { label: 'Very hilly', min: 35 },
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
  maxLocations: 25,
};

export const GEN = {
  roadKmh: 60, linkKmh: 80, roadFactor: 1.3, maxRoads: 4, spread: 60, maxOptions: 6,
  minCurveM: 2000, overrun: 1.15,
};

export const GOOGLE = { perPart: 9, parts: 2, pastTurn: 200, minSpacing: 800, maxGap: 25000 };
export const DECISION_TURNS = new Set([9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26]);

export const FUEL = { nearRoute: 1200, reserve: 0.85 };

export const PHOTON = 'https://photon.komoot.io/api/';
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
