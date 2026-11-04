// Ride Finder: app state, views and wiring. See FEATURES.md for what each feature must do.
import { CURVE_CLASSES, CORNER_ABOUT, SPEED_BINS, HILLS, FUEL_STATUS, SURFACE, GEN, RAMP_TIERS, RAMP_ABOUT, WEATHER, ROAD_TYPES, HIGHWAYS, tiersFor } from './config.js';
import { miles, fmtDuration, spotOnLine, headingOnPath, pad, boundsOf, intersects, km } from './geo.js';
import { visible, stretchOf, bestInView, clusterRoads, summarize, roadNear, roadAlong } from './roads.js';
import * as T from './trip.js';
import * as P from './plan.js';
import { localResults, photonResults } from './search.js';
import { fetchRoute, routeRefs, routerTrouble } from './routing.js';
import { profile } from './elevation.js';
import * as W from './weather.js';
import { Fly } from './fly.js';
import { store, initData, onRoadsChanged, loadTiles, loadTilesAlong, tilesSettled, loadingCount, coverageBox, loadSignals } from './store.js';
import { MapView } from './mapview.js';
import { icon, h, elevationChart, Sheet, toast, menu, closeMenu } from './ui.js';

const HOME = [39.0997, -94.5786];
const SETTINGS_KEY = 'rf2-settings', TRIP_KEY = 'rf2-trip';
const $ = s => document.querySelector(s);
const load = key => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

// ---------- state ----------

const settings = Object.assign({
  mode: 'ride', roadType: 'all', minSpeed: 45, minHills: 0, hideUnpaved: true, showBlind: true, showFuel: false,
  classes: [0, 1, 2, 3, 4], speedBins: SPEED_BINS.map((_, i) => i), rampTiers: RAMP_TIERS.map((_, i) => i),
  basemap: 'dark', hillshade: true, genHours: 3, genShape: 'loop', genExtra: 1,
}, load(SETTINGS_KEY));
// Settings saved before the highway tiers existed list only the ramp tiers: show the new ones too.
if (!settings.highwayTiers) {
  settings.rampTiers = [...new Set([...settings.rampTiers, ...RAMP_TIERS.flatMap((t, i) => t.highway ? [i] : [])])];
  settings.highwayTiers = true;
}
// Interchanges mode became Best rides with the Highways road type.
if (settings.mode === 'ramps') Object.assign(settings, { mode: 'ride', roadType: 'highway' });

let trip = T.newTrip();
let route = null;            // { path, meters, seconds, maneuvers, fallback }
let info = null;             // what's along the route: { curvy, blind, fuel, profile }
let selected = null;         // { group, piece, at }: the road picked on the map or in a list
let view = 'home', viewArg = null;
let place = null;            // the place last picked in search, { label, sub, at }: its pin opens its card
let picking = null;          // 'start' | 'stop' | 'road' while waiting for a map tap
let dragging = false;        // a stop row is being dragged: hold re-renders until it's dropped
let showKey = false;         // the map key's explanations are open
let fixing = '';             // status while trying roads the other way to stop doubling back
let gen = { options: [], index: -1, running: false, status: '' };
let showGoogleParts = false;
let leaveAt = null;          // when the rider leaves (ms), for the weather; null: soon (next quarter hour)
let weather = null;          // { route, points, hourly, at, loading, error }: the forecast along the route
let tilted = false;
let fly = null;               // the fly-through playing, if any

const MODES = { ride: 'Best rides', curvy: 'All curvy roads', speed: 'Speed limits' };
const highwaysOnly = () => settings.mode !== 'speed' && settings.roadType === 'highway';

function filters() {
  return { ...settings, classes: new Set(settings.classes), speedBins: new Set(settings.speedBins),
    rampTiers: new Set(settings.rampTiers || RAMP_TIERS.map((_, i) => i)), zoom: mapView.zoom() };
}
function saveSettings() { save(SETTINGS_KEY, settings); }

// ---------- setup ----------

const sheet = new Sheet($('#sheet'), $('#grab'), () => setTimeout(() => mapView.updateInsets(), 300));
const mapView = new MapView('map', {
  center: HOME, zoom: 9,
  insets: () => {
    const c = sheet.covered();
    return { top: Sheet.wide() ? 0 : $('#topbar').getBoundingClientRect().bottom, right: 0, bottom: c.bottom, left: c.left };
  },
});
window.RF = { store, mapView, go: (v, arg) => go(v, arg), get trip() { return trip; }, get route() { return route; }, get info() { return info; }, get gen() { return gen; }, get weather() { return weather; }, get fly() { return fly; }, setRoute: r => { routeSeq++; clearTimeout(routeTimer); setRoute(r); }, settings };

async function start() {
  // The side panel starts below the top bar, whose height depends on how the chips wrap.
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${$('#topbar').offsetHeight}px`)).observe($('#topbar'));
  // The height the browser actually shows (phones hide part of 100vh under toolbars).
  const setAppHeight = () => document.documentElement.style.setProperty('--app-h', `${innerHeight}px`);
  setAppHeight();
  addEventListener('resize', setAppHeight);
  render();
  renderChips();
  await initData();
  store.fuel.forEach((s, k) => { s.k = k; });
  // Road tiles start loading now; the map may still be fetching its basemap and terrain.
  onRoadsChanged(async () => {
    await mapView.ready;
    mapView.setRoads(store.roads);
    if (route) refreshInfo(false);
    if (view === 'home') renderSoon();
  });
  loadView();
  await mapView.ready;
  mapView.updateInsets();
  addEventListener('resize', () => mapView.updateInsets());
  mapView.setStations(store.fuel);
  applySettings();
  loadSavedTrip();
  let lastZoom = mapView.zoom();
  mapView.on('move', () => {
    loadView();
    if (settings.mode === 'speed' && (lastZoom < 11) !== (mapView.zoom() < 11)) mapView.setFilters(filters());
    lastZoom = mapView.zoom();
    if (view === 'home') renderSoon();
  });
  mapView.on('road', onRoadTap);
  mapView.on('station', k => { if (!usePick(null)) go('station', store.fuel[k]); });
  mapView.on('pin', () => { if (place && !usePick(place.at)) go('place', place); });
  mapView.on('stop', () => { if (!picking) go('trip'); });
  mapView.on('empty', at => { if (!usePick(at)) { clearSelection(); speedAt(at); } });
  mapView.on('hover', onHover);
  mapView.on('menu', spotMenu);
  mapView.map.on('movestart', closeMenu);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
}

// Roads for what's on screen. None when zoomed out past where the list says "Zoom in": that
// loaded whole states and crashed phones. Speed-only roads just in Speed limits mode, from zoom 9.
const LOAD_ZOOM = 7, SPEED_ZOOM = 9;
function loadView() {
  const z = mapView.zoom();
  if (z < LOAD_ZOOM) return;
  loadTiles(pad(mapView.view(), 0.1), { speed: settings.mode === 'speed' && z >= SPEED_ZOOM });
}

function applySettings() {
  mapView.setFilters(filters());
  mapView.showStations(settings.showFuel);
  mapView.setBasemap(settings.basemap);
  mapView.showHillshade(settings.hillshade);
  renderChips();
}

function setSetting(patch) {
  Object.assign(settings, patch);
  saveSettings();
  applySettings();
  loadView();
  renderSoon();
}

// ---------- trip ----------

function loadSavedTrip() {
  const fromLink = location.hash.match(/trip=([\w-]+)/);
  try {
    if (fromLink) {
      trip = T.decodeTrip(fromLink[1]);
      history.replaceState(null, '', location.pathname + location.search);
      go('trip');
      const pts = trip.items.flatMap(it => it.pts);
      if (pts.length) mapView.fit(boundsOf(pts), 12);
    } else {
      const saved = localStorage.getItem(TRIP_KEY) || localStorage.getItem('ride-finder-trip');  // the old app's key
      if (saved) trip = T.decodeTrip(saved);
    }
  } catch (e) {
    console.warn('Could not load trip', e);
  }
  tripChanged();
}

let routeTimer = null, routeSeq = 0;
function tripChanged({ reroute = true } = {}) {
  save(TRIP_KEY, T.encodeTrip(trip));
  mapView.setStops(trip.items.map((it, i) => ({ p: it.pts[0], label: it.label, n: i + 1, draggable: it.type === 'point', index: i })),
    (i, p) => { trip.items[i].pts[0] = [+p[0].toFixed(5), +p[1].toFixed(5)]; tripChanged(); });
  mapView.showTripRoads(trip.items.flatMap(it => it.ids || []));
  showGoogleParts = false;
  if (reroute) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(computeRoute, 350);
  }
  renderSoon();
}

async function computeRoute() {
  const seq = ++routeSeq, pts = T.routablePoints(trip);
  if (pts.length < 2) return setRoute(null);
  info = { loading: true };
  renderSoon();
  const r = await fetchRoute(pts, +trip.pref);
  if (seq !== routeSeq) return;
  if (!r) {
    info = { error: routerTrouble() };
    return renderSoon();
  }
  setRoute(r);
}

function setRoute(r) {
  route = r;
  const labels = (r && r.maneuvers || []).filter(m => m.km >= 1 && routeRefs(m).length)
    .map(m => ({ geom: r.path.slice(m.at, m.end + 1), ref: routeRefs(m).slice(0, 2).join(' / ') }));
  mapView.setRoute(r, labels);
  refreshInfo(true);
}

// Curvy miles, blind crests, fuel and the elevation profile along the route.
function refreshInfo(withProfile) {
  if (!route) {
    info = null;
    mapView.setRouteStations([]);
    mapView.setRetrace([]);
    mapView.setLights([]);
    return renderSoon();
  }
  loadTiles(boundsOf(route.path));
  const r = route, fuel = P.planFuel(r.path, store.fuel, trip.range, trip.need90);
  info = {
    ...(withProfile ? {} : { profile: info && info.profile }),
    curvy: P.curvyMetersOn(r.path, store.roads), highway: P.highwayMetersOn(r.path, store.roads),
    blind: P.blindCrestsOn(r.path, store.roads).length, fuel,
    back: P.retrace(r.path), turns: P.turnarounds(r.path, store.roads), lights: P.stoplightsOn(r.path, store.signals),
  };
  if (!store.signals) loadSignals().then(() => { if (route === r && info) { info.lights = P.stoplightsOn(r.path, store.signals); mapView.setLights(info.lights); renderSoon(); } });
  mapView.setRetrace(info.back.lines);
  mapView.setLights(info.lights);
  mapView.setRouteStations(fuel.along.map(a => ({ k: a.item.k, status: a.item.status, pick: fuel.picks.includes(a) })));
  if (withProfile) profile(r.path).then(p => { if (route === r && info) { info.profile = p; renderSoon(); } });
  renderSoon();
}

// Added where it fits best in the ride, entered from the end that makes sense; the toast offers
// the other end.
function addRoad(g, extra) {
  const it = trip.items[T.insertRoad(trip, g)];
  tripChanged();
  roadToast(it, 'Added', extra);
  return it;
}

// A stop dropped on a colored road rides that road end to end; the toast can make it just a stop.
function addStopOn(at, g) {
  const it = addRoad(g, { label: 'Just a stop', run: () => {
    const i = trip.items.indexOf(it);
    if (i >= 0) T.removeStop(trip, i);
    T.addPoint(trip, at, 'Stop');
    tripChanged();
  } });
}

// The stretch of colored road (as the map shows it now) a spot is on, or null.
function desiredRoadAt(at) {
  const f = filters();
  const r = roadNear(store.roads, at, r => (r.cls >= 0 || r.rampTier >= 0) && visible(r, f));
  return r && stretchOf(store.roads, r, f);
}

function roadToast(it, verb, extra) {
  const i = trip.items.indexOf(it);
  if (i < 0) return;
  const where = it.oneway ? '' : `, in at the ${T.ends(it).entry} end`;
  toast(`${verb} ${it.label} as stop ${i + 1}${where}`, [
    it.oneway ? null : { label: 'Switch ends', run: () => flipRoad(it) },
    view === 'trip' ? null : { label: 'View ride', run: () => go('trip') },
    extra,
  ].filter(Boolean));
}

// A pinned stop that sits on a colored road becomes that road, ridden end to end.
function stopToRoad(i, g) {
  const it = T.replaceWithRoad(trip, i, g);
  tripChanged();
  roadToast(it, 'Riding');
}

function flipRoad(it) {
  const i = trip.items.indexOf(it);
  if (i < 0) return;
  T.flipStop(trip, i);
  tripChanged();
  roadToast(it, 'Riding');
}

// Make this road a must-include and open the planner.
function planAround(g) {
  const inTrip = trip.items.some(it => it.ids && it.ids.some(id => g.ids.includes(id)) && !it.gen);
  if (!inTrip) {
    T.addRoad(trip, g);
    tripChanged();
  }
  gen = { options: [], index: -1, running: false, status: T.startOf(trip) ? '' : 'Now set a start: your location or a spot on the map.' };
  go('plan');
}

// A point as a stop where the route passes it (else last), never after the end of a one-way ride.
function addPlace(p, label, name = label) {
  const stop = { type: 'point', label, pts: [[+p[0].toFixed(5), +p[1].toFixed(5)]] }, last = trip.items.length - (T.endOf(trip) ? 1 : 0);
  const at = Math.min(last, route ? T.indexAlongRoute(trip, stop.pts[0], route.path) : last);
  trip.items.splice(at, 0, stop);
  tripChanged();
  toast(`Added ${name} as stop ${at + 1}`);
}

const addStation = s => addPlace([s.lat, s.lon], `Gas: ${s.name}`, s.name);

function setStartAt(p, label) {
  T.setStart(trip, p, label);
  tripChanged();
}

// Where a one-way ride finishes; the planner switches to one way.
function setEndAt(p, label) {
  T.setEnd(trip, p, label);
  if (settings.genShape !== 'oneway') setSetting({ genShape: 'oneway' });
  tripChanged();
}

// A quick, rough fix first (or a recent one the phone already has); if that fails for any
// reason other than permission, try once more for a precise GPS fix.
function locate() {
  if (!window.isSecureContext) return Promise.reject({ code: 'insecure' });
  if (!navigator.geolocation) return Promise.reject({ code: 'unsupported' });
  const get = opts => new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(p => resolve([p.coords.latitude, p.coords.longitude]), reject, opts));
  return get({ enableHighAccuracy: false, maximumAge: 5 * 60000, timeout: 10000 })
    .catch(e => e.code === 1 ? Promise.reject(e) : get({ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
}

function locationError(e) {
  const iphone = /iPhone|iPad/.test(navigator.userAgent);
  const messages = {
    insecure: 'Location only works on the https site (nosv1.github.io), not a local address.',
    unsupported: 'This browser can’t share your location. Pick your start on the map instead.',
    1: iphone
      ? 'Location is blocked. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using, then reload.'
      : 'Location is blocked for this site. Tap the lock or settings icon by the address bar, allow Location, then reload.',
    2: 'Your phone couldn’t find a location. Check that Location / GPS is on, then try again.',
    3: 'Finding your location took too long. Try again, or pick your start on the map.',
  };
  toast(messages[e && e.code] || 'Couldn’t get your location. Pick your start on the map instead.');
}

// Ride each road the other way in turn, keeping a flip when it cuts the doubling back without
// making the ride much longer.
async function fixDoubleBack() {
  const roads = trip.items.filter(it => it.type === 'road' && !it.oneway);
  let best = { r: route, back: info.back.meters };
  const flipped = [];
  let failed = false;
  clearTimeout(routeTimer);
  const seq = ++routeSeq;
  for (const it of roads) {
    it.pts.reverse();
    fixing = `Trying ${it.label} the other way…`;
    renderSoon();
    const r = await fetchRoute(T.routablePoints(trip), +trip.pref);
    if (seq !== routeSeq) { it.pts.reverse(); fixing = ''; return; }  // the ride changed meanwhile
    if (!r) failed = true;
    const back = r && !r.fallback ? P.retrace(r.path).meters : Infinity;
    if (back < best.back - 200 && r.meters < best.r.meters * 1.15) {
      best = { r, back };
      flipped.push(it.label);
    } else {
      it.pts.reverse();
    }
  }
  fixing = '';
  if (!flipped.length) {
    toast(failed ? routerTrouble() : 'Riding the roads the other way doesn’t help. Try dragging the stops into another order.');
    return renderSoon();
  }
  tripChanged({ reroute: false });
  setRoute(best.r);
  toast(`Flipped ${flipped.join(', ')}. ${best.back >= 400 ? `Still ${miles(best.back)} mi doubled back.` : 'No more doubling back.'}`);
}

// ---------- generator ----------

// Routes asked for while generating, by their points: loops heading different ways often come out
// the same, and so do their fixes.
let genRoutes = new Map();

async function generate() {
  const oneWay = settings.genShape === 'oneway';
  let hours = settings.genHours;
  genRoutes = new Map();
  let start = T.startOf(trip);
  if (!start) {
    try {
      gen.status = 'Finding your location for the start…';
      renderSoon();
      setStartAt(await locate(), 'Start: my location');
      start = T.startOf(trip);
    } catch (e) {
      locationError(e);
      gen.status = 'Set a start first: use your location or pick a spot on the map.';
      return renderSoon();
    }
  }
  const end = oneWay ? T.endOf(trip) : null;
  if (oneWay && !end) {
    gen = { options: [], index: -1, running: false, status: 'Set where you’re headed first: Pick on map, or right-click (long-press) a spot and choose “End a ride here”.' };
    return renderSoon();
  }
  const required = ownStops(), s = start.pts[0], e = end && end.pts[0];
  const kind = oneWay ? 'ways there' : 'loops';
  gen = { options: [], index: -1, running: true,
    status: required.length ? `Building ${kind} through ${required.map(r => r.label).join(', ')}…` : oneWay ? 'Finding the straight way there…' : 'Loading roads around your start…' };
  renderSoon();
  // One way: the time is the straight way there plus the extra the rider will spend on fun roads.
  if (oneWay) {
    const direct = await fetchRoute([{ p: s, via: false }, { p: e, via: false }], +trip.pref);
    if (!direct) {
      gen = { options: [], index: -1, running: false, status: routerTrouble() };
      return renderSoon();
    }
    hours = direct.seconds / 3600 + settings.genExtra;
  }
  // Roads within reach: around the start, or one way, in an oval around the start and end.
  const reach = P.reachKm(hours), c = e ? [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2] : s;
  const dLat = reach / 111, dLon = reach / (111 * Math.cos(c[0] * Math.PI / 180));
  loadTiles([c[0] - dLat, c[1] - dLon, c[0] + dLat, c[1] + dLon]);
  await Promise.all([tilesSettled(), loadSignals()]);  // the lights, to rank loops by stoplights
  // The roads the map shows, by road type: curvy roads, highway sweeps or both (ramps aren't stops, yet).
  const f = filters(), worthy = r => visible(r, { ...f, mode: f.mode === 'curvy' ? 'curvy' : 'ride' }) && (!r.oneway || r.highway);
  const options = P.buildOptions(P.candidateGroups(store.roads, s, reach, worthy, e), s, hours, required, e);
  if (!options.length) {
    gen = { options: [], index: -1, running: false, status: oneWay ? 'No good roads on the way. Try more extra time, or loosen the filters.'
      : 'No good roads within reach. Try a longer ride, or loosen the filters.' };
    return renderSoon();
  }
  options.forEach(o => { o.oneWay = oneWay; });
  // Two at a time: about twice as fast, and still gentle on the public router.
  let next = 0, done = 0;
  const progress = () => { gen.status = `Routing ${kind}: ${done} of ${options.length} done…`; renderSoon(); };
  const worker = async () => {
    while (next < options.length) {
      await routeOption(options[next++], start, hours, end);
      done++;
      progress();
    }
  };
  progress();
  await Promise.all([worker(), worker()]);
  if (!options.some(o => o.route)) {
    gen = { options: [], index: -1, running: false, status: routerTrouble() };
    return renderSoon();
  }
  // Only loops within 80–120% of the chosen time; if none came out that close, the nearest.
  const worth = o => o.route ? o.worth : -1, twice = o => o.route && o.back > GEN.hideBack * o.route.meters;
  const target = hours * 3600, fits = o => o.route && o.route.seconds >= GEN.under * target && o.route.seconds <= GEN.overrun * target;
  let shown = options.filter(fits), status = '';
  if (!shown.length && options.some(o => o.route)) {
    const off = o => Math.abs(Math.log(o.route.seconds / target));
    shown = options.filter(o => o.route).sort((a, b) => off(a) - off(b)).slice(0, 3);
    status = oneWay ? `Couldn’t fit a way there close to ${fmtDuration(hours * 3600)}, so these are the nearest. Try another extra time or loosen the filters.`
      : `Couldn’t fit a loop close to ${hours === 1.5 ? '1½' : hours} h here, so these are the nearest. Try another time or loosen the filters.`;
  }
  // The same loop can come out of two directions once fixed: keep one.
  const sigs = new Set(), sig = o => o.items.slice(1).map(it => (it.ids || [it.label]).join(',')).sort().join('|');
  shown = shown.filter(o => !o.route || !sigs.has(sig(o)) && sigs.add(sig(o)));
  // Leave out loops that ride a fifth of the way twice, when there are a couple without.
  const clean = shown.filter(o => !twice(o));
  if (clean.length >= 2) shown = clean;
  // Say which ways have nothing, so an all-north list doesn't look like a bug.
  const sides = ['north', 'east', 'south', 'west'], has = new Set(shown.filter(o => o.route).map(o => Math.floor(((o.dir + 45) % 360) / 90)));
  const none = sides.filter((_, q) => !has.has(q));
  if (!oneWay && !required.length && shown.length && none.length && none.length < 4) {
    status = `${status ? status + ' ' : ''}No loops to the ${none.join(none.length > 2 ? ', ' : ' or ').replace(/, (\w+)$/, ', or $1')}: not enough good roads that way with your filters.`;
  }
  gen = { options: (shown.length ? shown : options).sort((a, b) => worth(b) - worth(a)), index: -1, running: false, status };
  if (gen.options[0].route) selectOption(0);
  else renderSoon();
}

// How good a routed loop is: miles on curvy roads plus highway sweeps and fast ramps, scaled by the
// share of the ride they make up, cut by the share it rides twice (10% doubled back costs 40%, 20% nearly two thirds),
// by each turnaround (off the highway, round through the lights, back on: 40% each) and by each
// stoplight (3%, a left turn at one twice that: getting stopped is the lame part). Best first.
function rate(r) {
  if (!r) return null;
  const curvy = P.curvyMetersOn(r.path, store.roads), highway = P.highwayMetersOn(r.path, store.roads);
  const back = P.retrace(r.path).meters, turns = P.turnarounds(r.path, store.roads), fun = curvy + highway;
  const lights = P.stoplightsOn(r.path, store.signals), lefts = lights.filter(l => l.turn === 'left');
  return { route: r, curvy, highway, back, turns, lights, lefts, blind: P.blindCrestsOn(r.path, store.roads).length,
    worth: fun * fun / r.meters * Math.exp(-GEN.backCost * back / r.meters) * GEN.turnKeep ** turns.length
      * GEN.lightKeep ** (lights.length + lefts.length) };
}

// Route a loop for real. Under 80% of the time, fill it again aiming that much longer (the
// estimate ran fast), up to twice; over 120%, drop its weakest road, up to twice. While it
// then doubles back (up to backTries times), try each of: another way home, a road near the
// stretch ridden twice (short ones too) if the time allows; a spot off to either side of that
// stretch to ride through instead; and the loop without the generated road most to blame (the
// one the doubled-back miles are on, like a lake road that dead-ends, or else the one nearest
// them). The best is kept if the loop ranks higher and stays in 80–120%.
// One way (with an `end`), the same, riding on to the end instead of home.
async function routeOption(opt, start, hours, end = null) {
  let items = [start, ...opt.stops];
  const e = end && end.pts[0], finish = list => end ? [...list, end] : list;
  const copy = list => list.map(it => ({ ...it, pts: it.pts.map(p => [...p]) }));
  // With road g added where it fits best, marked as the generator's.
  const withRoad = (list, g) => {
    const t = { items: finish(copy(list)), loop: !end };
    t.items[T.insertRoad(t, g)].gen = true;
    return end ? t.items.slice(0, -1) : t.items;
  };
  const routeOf = list => {
    P.orientStops(start.pts[0], list.slice(1), !end, e);
    const pts = T.routablePoints({ ...trip, items: finish(list), loop: !end }), key = JSON.stringify([pts, trip.pref]);
    if (!genRoutes.has(key)) genRoutes.set(key, fetchRoute(pts, +trip.pref));
    return genRoutes.get(key);
  };
  let r = await routeOf(items);
  for (let tries = 0; r && r.seconds < hours * 3600 * GEN.under && tries < 2; tries++) {
    const estHours = P.estimate(start.pts[0], items.slice(1), e).hours;
    const more = P.fillLoop(start.pts[0], opt.pool, opt.dir, hours * estHours / (r.seconds / 3600), opt.chosen, opt.maxRoads + 2, e);
    if (more.chosen.length === opt.chosen.length) break;  // nothing more fits this way
    opt.chosen = more.chosen;
    items = [start, ...more.stops];
    r = await routeOf(items);
  }
  for (let tries = 0; r && r.seconds > hours * 3600 * GEN.overrun && tries < 2; tries++) {
    const added = items.filter(it => it.gen);
    if (!added.length) break;  // only the rider's own stops left: keep them even if it runs long
    items.splice(items.indexOf(added.reduce((a, b) => b.score < a.score ? b : a)), 1);
    r = await routeOf(items);
  }
  let best = rate(r);
  for (let tries = 0; tries < GEN.backTries && best && best.back > GEN.maxBack * best.route.meters; tries++) {
    const twice = P.retrace(best.route.path), lines = twice.lines, spots = lines.flat(), attempts = [];
    // Another way home: the best road near the stretch ridden twice that fits the time left.
    const estOf = list => P.estimate(start.pts[0], list.slice(1), e).hours;
    const scale = best.route.seconds / 3600 / estOf(items), room = hours * GEN.overrun - best.route.seconds / 3600;
    for (const g of P.wayHomeRoads(opt.free, items, lines)) {
      const more = withRoad(items, g);
      if ((estOf(more) - estOf(items)) * scale <= room) { attempts.push(more); break; }
    }
    // Or through a spot off to one side of it, so the second pass is on another road.
    for (const d of P.detours(twice)) {
      const list = copy(items);
      list.splice(P.stopIndexAt(best.route.path, items, d.m), 0, { type: 'point', label: end ? 'Another way' : 'Another way back', pts: [d.p], gen: true });
      attempts.push(list);
    }
    // Or without the generated road most to blame.
    const added = items.filter(it => it.gen);
    if (added.length && items.length > 2) {
      const geoms = it => (it.ids || []).map(id => store.byId.get(id)).filter(Boolean).map(x => x.geom);
      const onIt = it => spots.filter(q => geoms(it).some(g => g.some(p => km(p, q) < 0.15))).length;
      const near = it => Math.min(...it.pts.flatMap(p => spots.map(q => km(p, q))));
      const blame = added.map(it => ({ it, on: onIt(it), near: near(it) }))
        .sort((a, b) => b.on - a.on || a.near - b.near)[0].it;
      attempts.push(copy(items.filter(it => it !== blame)));
    }
    let better = null;
    for (const list of attempts) {
      const other = rate(await routeOf(list));
      const hrs = other && other.route.seconds / 3600;
      if (other && other.worth > (better || best).worth && hrs >= hours * GEN.under && hrs <= hours * GEN.overrun) better = { list, worth: other.worth, other };
    }
    if (!better) break;
    items = better.list;
    best = better.other;
  }
  // From here on a change is kept only if the loop ranks higher, stays in 80–120%, and rides no more twice
  // than it did (or maxBack of it), so a road picked up on the way doesn't undo the work above.
  const keeps = other => { const hrs = other && other.route.seconds / 3600;
    return other && other.worth > best.worth && hrs >= hours * GEN.under && hrs <= hours * GEN.overrun
      && other.back <= Math.max(best.back, GEN.maxBack * other.route.meters); };
  // Turnarounds and left turns at stoplights (up to 2 tries): without the generated road nearest the first
  // of them. Usually a highway sweep: ridden away from home then back the other way, or left off the highway
  // at the lights at its end.
  const trouble = b => [...b.turns, ...b.lefts.map(l => l.p)];
  for (let tries = 0; tries < 2 && best && trouble(best).length; tries++) {
    const at = trouble(best)[0], added = items.filter(it => it.gen);
    if (!added.length || items.length <= 2) break;
    const dist = it => Math.min(...it.pts.map(p => km(p, at)));
    const blame = added.reduce((a, b) => dist(b) < dist(a) ? b : a);
    const list = copy(items.filter(it => it !== blame));
    const other = rate(await routeOf(list));
    if (!keeps(other)) break;
    items = list;
    best = other;
  }
  // Roads it rides right past (up to 2 tries).
  const tried = new Set();
  for (let tries = 0; tries < 2 && best; tries++) {
    const g = P.onTheWay(opt.free, items, best.route.path).find(x => !tried.has(x));
    if (!g) break;
    tried.add(g);
    const more = withRoad(items, g);
    const other = rate(await routeOf(more));
    if (keeps(other)) {
      items = more;
      best = other;
    }
  }
  Object.assign(opt, { items: finish(items), route: best && best.route }, best ? { curvy: best.curvy, highway: best.highway, blind: best.blind, back: best.back, turns: best.turns.length,
    lights: best.lights.length, lefts: best.lefts.length, worth: best.worth } : {});
}

function selectOption(i) {
  const opt = gen.options[i];
  gen.index = i;
  trip.items = opt.items.map(it => ({ ...it, pts: it.pts.map(p => [...p]) }));
  trip.loop = !opt.oneWay;
  routeSeq++;
  clearTimeout(routeTimer);
  tripChanged({ reroute: false });
  setRoute(opt.route);
  mapView.setPreview(null);
  mapView.fit(boundsOf(opt.route.path), 12);
}

// ---------- map interactions ----------

// A tap on the map: a tag right there with the road's name and speed limit. Roads the map isn't coloring
// (MO 7, a highway) come from that spot's speed-limit tile, loaded for the tap, with a tag saying so while
// it loads. Zoomed out past 10 only roads already loaded count: one tile is up to a few MB.
let speedTap = 0, tagTimer = null;
function showTag(at, text, ms = 5000) {
  clearTimeout(tagTimer);
  mapView.setTapTag(at && text ? at : null, text);
  if (at && ms) tagTimer = setTimeout(() => mapView.setTapTag(null), ms);
}

function speedText(r) {
  const name = (r.ref || r.name || 'Unnamed road').replace(/;/g, ' / ');
  // The estimate is a rule of thumb for ordinary roads (30 in town): none on highways or ramps.
  const guess = /^(motorway|trunk)|_link$/.test(r.hw) ? null : r.estMph;
  return r.mph != null ? `${name} · ${r.mph} mph` : guess != null ? `${name} · about ${guess} mph (not posted)` : `${name} · no posted limit`;
}

async function speedAt(at) {
  const z = mapView.zoom(), tap = ++speedTap;
  if (z >= 10) {
    loadTiles([at[0], at[1], at[0], at[1]], { speed: true });
    if (loadingCount()) {
      showTag(at, 'Checking the speed limit…', 0);
      await tilesSettled(20000);
      if (tap !== speedTap || fly) return;
    }
  }
  // About 14 px of the screen either side of the finger. Highway sweeps repeat pieces of the speed tiles, so
  // they're only a fallback for when those aren't loaded.
  const reach = Math.min(400, Math.max(20, 14 * 78272 * Math.cos(at[0] * Math.PI / 180) / 2 ** z));
  const r = roadNear(store.roads, at, x => !x.highway, reach) || roadNear(store.roads, at, () => true, reach);
  showTag(at, r && speedText(r));
}

function onRoadTap(id, at) {
  if (usePick(at, id)) return;
  const piece = store.byId.get(id);
  speedTap++;
  showTag(at, speedText(piece));
  select(stretchOf(store.roads, piece, filters()), piece, at);
}

function select(group, piece, at, fit = false) {
  selected = { group, piece, at };
  mapView.highlight(group.ids);
  if (fit) mapView.fit(group.bounds);
  go('road');
}

function selectGroup(g) {
  const piece = g.roads.reduce((a, b) => b.length > a.length ? b : a);
  select(g, piece, piece.geom[Math.floor(piece.geom.length / 2)], true);
}

function clearSelection() {
  selected = null;
  mapView.highlight(null);
  if (view === 'road' || view === 'station' || view === 'place') go('home');
}

function onHover(id) {
  if (id == null) return mapView.highlight(selected && selected.group.ids);
  const r = store.byId.get(id);
  if (r) mapView.highlight(stretchOf(store.roads, r, filters()).ids);
}

function spotMenu(at, pt) {
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${at[0].toFixed(6)},${at[1].toFixed(6)}`;
  const g = desiredRoadAt(at);
  menu([
    { heading: `${at[0].toFixed(4)}, ${at[1].toFixed(4)}` },
    { label: 'Start a ride here', icon: icon.pin, run: () => { setStartAt(at, 'Start'); go('plan'); } },
    { label: 'End a ride here', icon: icon.flag, run: () => { setEndAt(at, 'End'); go('plan'); } },
    g ? { label: `Ride ${g.key} end to end`, icon: icon.route, run: () => addRoad(g) } : null,
    { label: 'Add a stop here', icon: icon.plus, run: () => { T.addPoint(trip, at, 'Stop'); tripChanged(); toast('Stop added. Drag its pin to adjust.'); } },
    { label: 'Street View here', icon: icon.person, run: () => window.open(sv, '_blank', 'noopener') },
  ].filter(Boolean), { x: pt.x, y: pt.y });
}

// While picking a spot for the start or a stop, or a road, the next map tap is used for that.
function usePick(at, roadId = null) {
  if (!picking || !at) return false;
  if (picking === 'road' && roadId == null) {
    toast('Tap one of the colored roads to add it.');
    return true;
  }
  const kind = picking;
  stopPicking();
  if (kind === 'start') setStartAt(at, 'Start');
  else if (kind === 'end') setEndAt(at, 'End');
  else if (roadId != null) {
    const g = stretchOf(store.roads, store.byId.get(roadId), filters());
    kind === 'road' ? addRoad(g) : addStopOn(at, g);
  } else { T.addPoint(trip, at, 'Stop'); tripChanged(); }
  renderSoon();
  return true;
}

const PICK_PROMPTS = { start: 'Tap the map to set your start', end: 'Tap the map where you’re headed', stop: 'Tap the map to add a stop', road: 'Tap a road to add it to your ride' };
function startPicking(kind) {
  picking = kind;
  const banner = $('#pickBanner');
  banner.replaceChildren(h('span', {}, PICK_PROMPTS[kind]), h('button', { onclick: stopPicking }, 'Cancel'));
  banner.hidden = false;
  if (!Sheet.wide()) sheet.set('peek');
}

function stopPicking() {
  picking = null;
  $('#pickBanner').hidden = true;
}

// ---------- views ----------

function go(v, arg = null) {
  const changed = v !== view;
  view = v;
  viewArg = arg;
  if (v === 'station' || v === 'place') selected = null;
  if (v === 'home' || v === 'station' || v === 'place') mapView.highlight(selected && v === 'home' ? selected.group.ids : null);
  render();
  if (changed) $('#sheetBody').scrollTop = 0;
  if (!Sheet.wide() && sheet.snap === 'peek') sheet.set('half');
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (dragging) return;
  const views = { home: homeView, road: roadView, station: stationView, place: placeView, plan: planView, trip: tripView, about: aboutView };
  $('#sheetBody').replaceChildren(...[(views[view] || homeView)()].flat(Infinity).filter(Boolean));
}

const iconEl = (svg, cls = 'i') => h(`span.${cls}`, { html: svg });
const backBar = (title, sub) => h('div.view-head', {},
  h('button.icon-btn', { title: 'Back', onclick: () => go('home'), html: icon.back }),
  h('div', {}, h('h2', {}, title), sub ? h('div.muted', {}, sub) : ''));
const cap = s => s[0].toUpperCase() + s.slice(1);
const stat = (value, label) => h('div.stat', {}, h('b', {}, value), h('span', {}, label));
const hillWord = hill => hill == null ? null : HILLS[Math.max(0, HILLS.reduce((l, c, i) => hill >= c.min ? i : l, 0))].label;

function homeView() {
  const speedMode = settings.mode === 'speed';
  const groups = speedMode || !store.roads.length || mapView.zoom() < LOAD_ZOOM ? [] : bestInView(store.roads, mapView.view(), filters());
  return [
    route ? rideBar() : null,
    h('div.section-head', {}, h('h2', {}, speedMode ? 'Posted speed limits' : highwaysOnly() ? 'Fast ramps and highways in view' : 'Best roads in view'),
      loadingCount() ? h('span.muted', {}, 'Loading…') : ''),
    legend(),
    speedMode
      ? h('p.muted', {}, mapView.zoom() < SPEED_ZOOM ? 'Zoom in to see speed limits.' : 'From OpenStreetMap. County roads and side streets appear as you zoom in.')
      : groups.length
        ? h('div.cards', {}, groups.map(roadCard))
        : h('p.empty', {}, !store.roads.length || mapView.zoom() < LOAD_ZOOM ? 'Zoom in to see roads.'
          : highwaysOnly() ? 'No fast ramps or highway sweeps here. Try a big interchange, like where I-435 meets I-470.' : 'Nothing matches here. Pan around or loosen the filters.'),
    h('button.cta.sticky', { onclick: () => go('plan') }, iconEl(icon.route), 'Plan a ride'),
    h('p.fineprint', {}, 'Road data © OpenStreetMap contributors. Many rural speed limits are estimated. Always check conditions before you ride.'),
    h('div.foot-links', {},
      h('button.link', { onclick: () => go('about') }, 'About, credits and riding safe'),
      canInstall() ? h('button.link', { onclick: install }, iconEl(icon.download), 'Install app') : ''),
  ];
}

// ---------- about & installing ----------

// Chrome, Edge and Android offer an install prompt (beforeinstallprompt), kept for the Install button; iPhones
// have none, only Share → Add to Home Screen. Installed and opened from the icon, there's nothing to offer.
let installPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iPhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !standalone() && (!!installPrompt || iPhone());
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderSoon(); });
addEventListener('appinstalled', () => { installPrompt = null; toast('Installed. Open Ride Finder from its icon from now on.'); renderSoon(); });

async function install() {
  if (!installPrompt) return toast('On iPhone: tap Share (the square with the arrow), then Add to Home Screen.');
  const p = installPrompt;
  installPrompt = null;  // a prompt can only be shown once
  await p.prompt();
  renderSoon();
}

function aboutView() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const credit = (what, ...who) => h('li', {}, h('b', {}, what), ': ', ...who);
  return [
    backBar('About Ride Finder'),
    h('p', {}, 'A map for finding motorcycle roads worth riding (curvy roads, fast sweepers and hills) and planning a ride on them for the time you have. Free, with no account and no ads.'),
    h('div.section', {}, h('h3', {}, iconEl(icon.warn), 'Ride safe'),
      h('p.small', {}, 'Everything here comes from open map data and free services, and it can be wrong or out of date. Roads close, surfaces change, gravel and leaves wash onto curves, and many of the rural speed limits shown are estimates, not posted limits. A road marked Twisty is a description, not a dare.'),
      h('p.small', {}, h('b', {}, 'Always check conditions before you ride'), ', go by the posted signs and limits, and ride within your ability. Plan before you leave, not on the move. How and where you ride is up to you.')),
    canInstall() || standalone() ? h('div.section', {}, h('h3', {}, iconEl(icon.download), 'Install it'),
      standalone() ? h('p.small', {}, 'Installed. It opens full screen from its icon and works offline on the roads you’ve looked at.')
        : [h('p.small', {}, 'Put it on your home screen or apps list to open it like an app, full screen, and to use it offline on roads you’ve looked at.'),
          h('button.btn', { onclick: install }, iconEl(icon.download), installPrompt ? 'Install Ride Finder' : 'How to install on iPhone')]) : '',
    h('div.section', {}, h('h3', {}, iconEl(icon.globe), 'Credits'),
      h('ul.credits', {},
        credit('Road data', '© ', link('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'), ', under the Open Database License'),
        credit('Basemap and imagery', '© Esri and its data providers'),
        credit('Elevation and 3D terrain', link('https://registry.opendata.aws/terrain-tiles/', 'AWS Terrain Tiles'), ', from USGS and other public sources'),
        credit('Routing', link('https://valhalla.github.io/valhalla/', 'Valhalla'), ' on the free ', link('https://www.fossgis.de/', 'FOSSGIS'), ' server, with ', link('https://project-osrm.org/', 'OSRM'), '’s demo server as a backup'),
        credit('Place search', link('https://photon.komoot.io/', 'Photon'), ' by Komoot'),
        credit('Weather', link('https://open-meteo.com/', 'Weather data by Open-Meteo.com'), ' (CC BY 4.0)'),
        credit('Map', link('https://maplibre.org/', 'MapLibre GL JS'), ', with fonts from ', link('https://openfreemap.org/', 'OpenFreeMap')))),
    h('div.section', {}, h('h3', {}, iconEl(icon.person), 'Your data'),
      h('p.small', {}, 'No account and no analytics. Your rides and settings stay in this browser. To plan, a ride’s stops go to the routing server, searches to Photon and points along the ride to Open-Meteo for the weather. Your location is used only when you ask for it (My location, or generating a ride with no start set). A share link carries the ride in the link itself.')),
    h('p.fineprint', {}, 'Ride Finder is open source: ', link('https://github.com/nosv1/claudes-ride-finder', 'github.com/nosv1/claudes-ride-finder'), '.'),
  ];
}

// The map key: tap a class to hide or show it; "What's this?" explains what puts a road in each.
function legend() {
  if (settings.mode === 'speed') {
    return h('div.legend', {}, SPEED_BINS.map((b, i) => legendChip(b, settings.speedBins.includes(i), () => toggleIn('speedBins', i))));
  }
  // Highways: the ramp and highway tiers. All roads: the curve classes, plus one chip for every highway and ramp.
  const ramps = highwaysOnly(), classes = ramps ? RAMP_TIERS : CURVE_CLASSES;
  const on = ramps ? settings.rampTiers : settings.classes, allTiers = RAMP_TIERS.map((_, i) => i);
  const anyHighways = tiersFor('all', settings.rampTiers).length > 0;
  return [
    h('div.legend', {},
      classes.map((c, i) => legendChip(c, on.includes(i), () => toggleIn(ramps ? 'rampTiers' : 'classes', i))),
      settings.roadType === 'all' ? legendChip(HIGHWAYS, anyHighways, () => setSetting({ rampTiers: anyHighways ? [] : allTiers })) : null,
      h(`button.legend-chip.key-btn${showKey ? '.on' : ''}`, { title: 'What do these mean?', 'aria-expanded': showKey ? 'true' : 'false',
        onclick: () => { showKey = !showKey; render(); } }, iconEl(icon.help), showKey ? 'Hide' : 'What’s this?')),
    showKey ? keyHelp(classes, ramps, settings.roadType === 'all') : null,
  ];
}

function keyHelp(classes, ramps, withHighways) {
  const row = (swatch, label, about) => h('div.key-row', {}, swatch, h('div', {}, h('b', {}, label), ' ', about));
  const sw = color => h('span.swatch', { style: `background:${color}` });
  return h('div.key-help', {},
    h('p', {}, ramps ? RAMP_ABOUT : CORNER_ABOUT),
    classes.map(c => row(sw(c.color), c.label, c.about)),
    withHighways ? row(sw(HIGHWAYS.color), HIGHWAYS.label, HIGHWAYS.about) : '',
    ramps ? '' : [
      row(h('span.swatch.dashed'), 'Dashed', 'Surface not recorded, so it could be gravel.'),
      row(h('span.key-icon', {}, '⚠'), 'Blind crest', 'A tight turn at or just past the top of a rise, so you can’t see through it.'),
      row(iconEl(icon.mountain, 'key-icon'), 'Hills', `Feet of up and down per mile: ${HILLS.slice(1).map(l => `${l.label.toLowerCase()} ${l.ft}+`).join(', ')}. Around KC is about 95, the Ozarks about 160.`),
    ]);
}
const groupColor = g => g.rampTier >= 0 ? (highwaysOnly() ? RAMP_TIERS[g.rampTier].color : HIGHWAYS.color) : CURVE_CLASSES[Math.max(0, g.cls)].color;
const legendChip = (c, on, onclick) => h(`button.legend-chip${on ? '' : '.off'}`, {
  onclick, title: `${c.about ? `${c.label}: ${c.about}\n` : ''}Tap to ${on ? 'hide' : 'show'} these`,
}, h('span.swatch', { style: `background:${c.color}` }), c.label);
function toggleIn(key, v) {
  const list = settings[key] || RAMP_TIERS.map((_, i) => i);
  setSetting({ [key]: list.includes(v) ? list.filter(x => x !== v) : [...list, v] });
}

function roadCard(g) {
  const hill = hillWord(g.hill);
  return h('div.card.road-card', {
    onclick: () => selectGroup(g),
    onmouseenter: () => mapView.highlight(g.ids),
    onmouseleave: () => mapView.highlight(selected && selected.group.ids),
  },
  h('span.bar', { style: `background:${groupColor(g)}` }),
  h('div.card-main', {},
    h('div.card-title', {}, g.key),
    g.oneway ? h('div.card-sub', {}, rampFacts(g).join(' · ')) : h('div.card-sub', {}, `${miles(g.curvy)} mi of curves`, hill && hill !== 'Flat' ? ` · ${hill.toLowerCase()}` : '',
      g.blind ? h('span.warn', {}, ` · ⚠ ${g.blind}`) : '')),
  h('button.icon-btn.add', { title: 'Add to ride', onclick: e => { e.stopPropagation(); addRoad(g); }, html: icon.plus }));
}

function rideBar() {
  return h('div.ride-bar', {},
    h('div', { onclick: () => go('trip'), style: 'cursor:pointer;flex:1' },
      h('div.muted', {}, 'Your ride'),
      h('div.ride-stats', {}, `${miles(route.meters)} mi · ${fmtDuration(route.seconds)}`,
        info && info.curvy != null ? ` · ${miles(info.curvy)} curvy` : '', info && info.blind ? ` · ⚠ ${info.blind}` : '')),
    h('button.btn.primary', { onclick: openGoogle }, iconEl(icon.go), 'Go'));
}

// Sweep, lanes and speed for a ramp (posted only: the town estimate means nothing on a ramp).
function rampFacts(g) {
  const lanes = Math.max(0, ...g.roads.map(r => r.lanes || 0)), mph = g.roads.map(r => r.mph).find(v => v != null);
  return [`${miles(g.roads.reduce((s, r) => s + r.sweep, 0))} mi of sweep`, lanes ? `${lanes} lane${lanes > 1 ? 's' : ''}` : '',
    mph ? `${mph} mph` : ''].filter(Boolean);
}

function rampView(g, r, links) {
  const tier = RAMP_TIERS[Math.max(0, g.rampTier)], lanes = Math.max(0, ...g.roads.map(x => x.lanes || 0));
  const mph = g.roads.map(x => x.mph).find(v => v != null), highway = g.roads.some(x => x.highway);
  return [
    backBar(g.key, highway ? 'One direction of a 65+ mph highway' : 'One-way interchange ramp'),
    h('div.tag', { style: `--c:${tier.color}` }, tier.label),
    h('p.about', {}, tier.about),
    h('div.stats', {},
      stat(`${miles(g.roads.reduce((s, x) => s + x.sweep, 0))} mi`, 'of sweeping curve'),
      stat(lanes ? `${lanes}` : '—', lanes === 1 ? 'lane' : 'lanes'),
      stat(mph ? `${mph} mph` : '—', mph ? 'posted limit' : 'no posted limit'),
      stat(`${miles(g.roads.reduce((s, x) => s + x.length, 0))} mi`, 'long')),
    h('div.actions', {},
      h('button.btn.primary.wide', { onclick: () => addRoad(g) }, iconEl(icon.plus), 'Add to ride'),
      h('button.btn.wide', { onclick: () => planAround(g) }, iconEl(icon.route), highway ? 'Plan a loop with this highway' : 'Plan a loop with this ramp'),
      ...links),
    h('p.fineprint', {}, `OSM way ${r.id} · ${r.hw.replace('_', ' ')}. Rides are routed the legal way round.`),
  ];
}

function roadView() {
  if (!selected) return homeView();
  const { group: g, piece: r, at } = selected;
  const spot = spotOnLine(r.geom, at), [lat, lon] = spot.p.map(v => +v.toFixed(6));
  const gm = 'https://www.google.com/maps/@?api=1&map_action=';
  // Street View faces the way the ride goes here when the route uses this road; otherwise the way
  // the road is drawn in OSM (the direction of travel on a ramp, arbitrary on a two-way road),
  // with a button for the other way.
  const heading = (route && headingOnPath(route.path, spot.p)) ?? spot.heading;
  const sv = hd => `${gm}pano&viewpoint=${lat},${lon}&heading=${Math.round((hd + 360) % 360)}`;
  const links = [
    h('div.sv-pair', {},
      h('a.btn.grow', { href: sv(heading), target: '_blank', rel: 'noopener' }, iconEl(icon.person), 'Street View'),
      g.oneway ? '' : h('a.btn', { href: sv(heading + 180), target: '_blank', rel: 'noopener', title: 'Street View facing the other way',
        'aria-label': 'Street View facing the other way', html: icon.swap })),
    h('a.btn', { href: `${gm}map&center=${lat},${lon}&zoom=17&basemap=satellite`, target: '_blank', rel: 'noopener' }, iconEl(icon.globe), 'Satellite'),
  ];
  if (g.oneway) return rampView(g, r, links);
  const cls = CURVE_CLASSES[Math.max(0, g.cls)];
  const prof = h('div.profile-slot', {}, h('div.muted.small', {}, 'Loading elevation…'));
  profile(r.geom, 160).then(p => prof.replaceChildren(p
    ? h('div', {}, h('div.chart-head', {}, h('span', {}, 'Elevation · this section'), h('span', {}, `${Math.round(p.lo).toLocaleString()}–${Math.round(p.hi).toLocaleString()} ft`)),
      elevationChart(p, s => mapView.setDot(s && s.p)))
    : h('div.muted.small', {}, 'Elevation unavailable right now.')));
  return [
    backBar(g.key, r.name && r.name !== g.key ? r.name : (r.ref && r.ref !== g.key ? r.ref : null)),
    h('div.tag', { style: `--c:${cls.color}` }, g.cls >= 0 ? cls.label : 'Mostly straight'),
    g.cls >= 0 ? h('p.about', {}, cls.about) : '',
    h('div.stats', {},
      stat(`${miles(g.curvy)} mi`, 'of curves'),
      stat(hillWord(g.hill) || '—', g.hill != null ? `${Math.round(g.hill * 5.28)} ft/mi up & down` : 'hills'),
      stat(r.mph != null ? `${r.mph} mph` : `~${r.estMph} mph`, r.mph != null ? 'posted limit' : 'estimated limit'),
      stat(g.blind ? `⚠ ${g.blind}` : 'None', 'blind crest corners')),
    h('div.surface', { class: r.surface ? 'surface warn' : 'surface' }, `Surface: ${SURFACE[r.surface]}`),
    prof,
    h('div.actions', {},
      h('button.btn.primary.wide', { onclick: () => addRoad(g) }, iconEl(icon.plus), 'Add to ride'),
      h('button.btn.wide', { onclick: () => planAround(g) }, iconEl(icon.route), 'Plan a loop with this road'),
      ...links),
    h('p.fineprint', {}, `OSM way ${r.id} · ${r.hw.replace('_', ' ')} road`),
  ];
}

function stationView() {
  const s = viewArg;
  if (!s) return homeView();
  const st = FUEL_STATUS[s.status];
  return [
    backBar(s.name, s.city || null),
    h('div.tag', { style: `--c:${st.color}` }, st.label),
    s.hours ? h('p.muted', {}, `Hours: ${s.hours}`) : '',
    s.status === 1 ? h('p.muted.small', {}, '“Likely” is a guess from the brand; few stations list their grades.') : '',
    h('div.actions', {},
      h('button.btn.primary.wide', { onclick: () => addStation(s) }, iconEl(icon.plus), 'Add to ride'),
      h('a.btn', { href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`, target: '_blank', rel: 'noopener' }, iconEl(icon.go), 'Directions')),
  ];
}

// A place found in search: ride to it, from it, or through it.
function placeView() {
  const p = viewArg;
  if (!p) return homeView();
  const [lat, lon] = p.at.map(v => +v.toFixed(6)), gm = 'https://www.google.com/maps/';
  return [
    backBar(p.label, p.sub || null),
    h('div.actions', {},
      h('button.btn.primary.wide', { onclick: () => addPlace(p.at, p.label) }, iconEl(icon.plus), 'Add to ride as a stop'),
      h('button.btn', { onclick: () => { setStartAt(p.at, `Start: ${p.label}`); go('plan'); } }, iconEl(icon.pin), 'Start here'),
      h('button.btn', { onclick: () => { setEndAt(p.at, `End: ${p.label}`); go('plan'); } }, iconEl(icon.flag), 'End here'),
      h('a.btn', { href: `${gm}@?api=1&map_action=pano&viewpoint=${lat},${lon}`, target: '_blank', rel: 'noopener' }, iconEl(icon.person), 'Street View'),
      h('a.btn', { href: `${gm}dir/?api=1&destination=${lat},${lon}`, target: '_blank', rel: 'noopener' }, iconEl(icon.go), 'Directions')),
    h('p.muted.small', {}, 'Start here or End here opens Plan a ride: with an end, it finds fun ways there.'),
  ];
}

function planView() {
  const start = T.startOf(trip), oneWay = settings.genShape === 'oneway', end = oneWay && T.endOf(trip);
  const place = it => it ? it.label.replace(/^(Start|End):?\s*/, '') || 'Pinned on the map' : 'Not set yet';
  return [
    backBar('Plan a ride', oneWay ? 'From your start to where you’re headed, the fun way' : 'A loop from your start through the best roads'),
    h('div.seg.shape', {}, [['loop', 'Loop'], ['oneway', 'One way']].map(([v, l]) =>
      h(`button${settings.genShape === v ? '.on' : ''}`, { onclick: () => setSetting({ genShape: v }) }, l))),
    h('div.field', {}, h('label', {}, 'Start'),
      h('div.start-row', {}, iconEl(icon.pin), h('span.grow', {}, place(start)))),
    h('div.btn-row', {},
      h('button.btn', { onclick: async () => {
        try { setStartAt(await locate(), 'Start: my location'); } catch (e) { locationError(e); }
      } }, iconEl(icon.locate), 'My location'),
      h('button.btn', { onclick: () => startPicking('start') }, iconEl(icon.pin), 'Pick on map')),
    oneWay ? h('div.field', {}, h('label', {}, 'End'),
      h('div.start-row', {}, iconEl(icon.flag), h('span.grow', {}, place(end))),
      h('div.btn-row', {}, h('button.btn', { onclick: () => startPicking('end') }, iconEl(icon.pin), 'Pick on map'))) : '',
    mustInclude(),
    oneWay ? extraTime() : rideTime(),
    h('button.cta', { onclick: generate, disabled: gen.running }, iconEl(icon.route), gen.running ? 'Working…' : oneWay ? 'Find fun ways there' : 'Generate loops'),
    gen.status ? h('p.muted', {}, gen.status) : '',
    gen.options.length ? h('div.cards', {}, gen.options.map(optionCard)) : '',
    gen.index >= 0 ? h('button.btn.wide', { onclick: () => go('trip') }, gen.options[gen.index] && gen.options[gen.index].oneWay ? 'Ride this way →' : 'Ride this loop →') : '',
    h('p.fineprint', {}, 'Uses the filters at the top (speed, hills, paved). Riding time doesn’t include stops. Or build your own: tap roads on the map and Add to ride.'),
  ];
}

const rideTime = (label = 'Ride time') => h('div.field', {}, h('label', {}, label),
  h('div.seg', {}, [1, 1.5, 2, 3, 4, 5, 6, 8].map(t => h(`button${settings.genHours === t ? '.on' : ''}`,
    { onclick: () => setSetting({ genHours: t }) }, t === 1.5 ? '1½ h' : `${t} h`))));

// One way: how much longer than the straight way there to spend on fun roads.
const extraTime = () => h('div.field', {}, h('label', {}, 'Extra time for fun roads'),
  h('div.seg', {}, [0.5, 1, 1.5, 2, 3, 4].map(t => h(`button${settings.genExtra === t ? '.on' : ''}`,
    { onclick: () => setSetting({ genExtra: t }) }, t === 0.5 ? '+30 min' : t === 1.5 ? '+1½ h' : `+${t} h`))));

// The rider's own stops: every generated loop goes through them.
const ownStops = () => trip.items.filter((it, i) => !(i === 0 && T.startOf(trip)) && !it.gen && !it.end);

function mustInclude() {
  const own = ownStops();
  return h('div.field', {}, h('label', {}, 'Must include'),
    own.length
      ? h('div', {}, own.map(it => h('div.start-row.must', {},
          iconEl(it.type === 'road' ? icon.route : icon.pin),
          h('span.grow', {}, it.label, it.type === 'road' && it.curvy ? h('span.muted.small', {}, ` · ${miles(it.curvy)} mi of curves`) : ''),
          h('button.icon-btn', { title: 'Remove', html: icon.x, onclick: () => { T.removeStop(trip, trip.items.indexOf(it)); tripChanged(); } }))),
        h('p.muted.small', {}, 'Loops will go through these and fill the rest of your time with the best roads nearby.'))
      : h('p.muted.small', {}, 'Nothing yet. To build a ride around a road, tap it on the map and choose “Plan a loop with this road”.'));
}

// "Northeast", or one way: "North side", "Near the straight way", "Best roads, any side".
function optionName(o) {
  const compass = P.heading(o.dir)[0].toUpperCase() + P.heading(o.dir).slice(1);
  return o.way === 'near' ? 'Near the straight way' : o.way === 'any' ? 'Best roads, any side' : o.way ? `${compass} side` : compass;
}

function optionCard(o, i) {
  if (!o.route) return h('div.card.option.failed', {}, `${optionName(o)}: couldn’t route right now`);
  const pct = Math.round(100 * o.curvy / o.route.meters);
  return h(`div.card.option${i === gen.index ? '.on' : ''}`, {
    onclick: () => selectOption(i),
    onmouseenter: () => mapView.setPreview(o.route.path),
    onmouseleave: () => mapView.setPreview(null),
  },
  h('div.option-head', {}, h('span.num', {}, i + 1), h('b', {}, optionName(o)),
    h('span.muted.push', {}, fmtDuration(o.route.seconds))),
  h('div.option-stats', {}, `${miles(o.route.meters)} mi · `, h('b', {}, `${miles(o.curvy)} mi curvy`), ` (${pct}%)`,
    o.highway >= 200 ? ` · ${miles(o.highway)} mi highway sweeps` : '',
    o.blind ? h('span.warn', {}, ` · ⚠ ${o.blind}`) : '', o.back >= 400 ? h('span.warn', {}, ` · ↩ ${miles(o.back)} mi twice`) : '',
    o.turns ? h('span.warn', {}, ` · ↺ turns around${o.turns > 1 ? ` ${o.turns}×` : ''}`) : '',
    o.lights ? ` · 🚦 ${o.lights}${o.lefts ? ` (${o.lefts} left)` : ''}` : ''),
  h('div.muted.small', {}, o.items.slice(1).filter(it => !it.end).flatMap((it, k) => [k ? ', ' : '', it.gen ? it.label : h('b.own', {}, it.label)])));
}

function tripView() {
  if (!trip.items.length) {
    return [
      backBar('Your ride'),
      h('p.muted', {}, 'Nothing planned yet. Generate a loop, or tap roads on the map and Add to ride.'),
      h('div.btn-row', {},
        h('button.btn.primary', { onclick: () => go('plan') }, iconEl(icon.route), 'Plan a ride'),
        h('button.btn', { onclick: () => startPicking('start') }, iconEl(icon.pin), 'Pick a start')),
    ];
  }
  // Stops first: nothing above them changes height as the route is worked out again, so after
  // removing one, the next ✕ is under the same finger.
  return [
    backBar('Your ride', P.tripName(trip).replace(/^Ride: /, '')),
    h('div.section-head', {}, h('h3', {}, `Stops (${trip.items.length})`),
      h('button.btn.small', { onclick: clearRide }, iconEl(icon.trash), 'Clear all')),
    stopList(),
    h('div.btn-row', {},
      h('button.btn', { onclick: () => startPicking('road') }, iconEl(icon.route), 'Add road'),
      h('button.btn', { onclick: () => startPicking('stop') }, iconEl(icon.plus), 'Add stop'),
      h('button.btn', { onclick: async () => {
        try { setStartAt(await locate(), 'Start: my location'); } catch (e) { locationError(e); }
      } }, iconEl(icon.locate), 'Start from me')),
    h('div.section', {}, routeSummary()),
    weatherSection(),
    h('div.section', {},
      rideTime('Generate a loop'),
      h('button.btn.primary.wide', { onclick: () => { go('plan'); generate(); }, disabled: gen.running },
        iconEl(icon.route), gen.running ? 'Working…' : ownStops().length ? 'Generate loops through these stops' : 'Generate loops from this start'),
      h('p.muted.small', {}, `Keeps your own stops and fills the time with the best ${{ all: 'roads nearby, sweeping highways included', back: 'back roads nearby', highway: 'highway sweeps nearby' }[settings.roadType] || 'roads nearby'}. The road type on the map decides which.`)),
    h('div.field', {}, h('label.switch', {},
      h('input', { type: 'checkbox', checked: trip.loop, onchange: e => { trip.loop = e.target.checked; tripChanged(); } }),
      h('span', {}, 'Return to start'))),
    h('div.field', {}, h('label', {}, 'Between roads'),
      h('div.seg', {}, [['1', 'Fastest'], ['0.5', 'Balanced'], ['0', 'Back roads']].map(([v, l]) =>
        h(`button${trip.pref === v ? '.on' : ''}`, { onclick: () => { trip.pref = v; tripChanged(); } }, l)))),
    fuelSection(),
    exportSection(),
  ];
}

// No "are you sure": an Undo in the toast instead.
function clearRide() {
  const was = trip.items;
  trip.items = [];
  gen.index = -1;
  tripChanged();
  toast('Ride cleared', { label: 'Undo', run: () => { trip.items = was; tripChanged(); } });
}

function routeSummary() {
  if (info && info.loading) return h('p.muted', {}, 'Finding a route…');
  if (info && info.error) return h('p.error', {}, info.error);
  if (!route) return h('p.muted', {}, 'Add a start and at least one more stop to get a route.');
  const p = info && info.profile;
  return h('div', {},
    h('div.stats', {},
      stat(`${miles(route.meters)} mi`, 'total'),
      stat(fmtDuration(route.seconds), 'riding'),
      stat(info && info.curvy != null ? `${miles(info.curvy)} mi` : '…', 'on curvy roads'),
      stat(info && info.blind != null ? (info.blind ? `⚠ ${info.blind}` : 'None') : '…', 'blind crests')),
    info && info.highway >= 200 ? h('p.muted.small', {}, `Plus ${miles(info.highway)} mi of highway sweeps and fast ramps.`) : '',
    info && info.lights && info.lights.length ? h('p.muted.small', {}, lightsNote(info.lights)) : '',
    route.fallback ? h('p.muted.small', {}, 'The back-roads router is busy, so this is the plain fastest route.') : '',
    doubleBack(),
    p ? h('div', {},
      h('div.chart-head', {}, h('span', {}, h('b', {}, `${Math.round(p.climbFt).toLocaleString()} ft`), ' of climbing'),
        h('span', {}, `${Math.round(p.lo).toLocaleString()}–${Math.round(p.hi).toLocaleString()} ft`)),
      elevationChart(p, s => mapView.setDot(s && s.p))) : '',
    h('button.btn.wide', { onclick: flyRide }, iconEl(icon.play), 'Fly through the ride in 3D'));
}

// Watch the ride from just behind the rider, at a multiple of its riding time.
function flyRide() {
  if (!route || fly) return;
  closeMenu();
  speedTap++;
  showTag(null);
  const r = route;
  mapView.setBasemap('satellite');  // the dark map is bleak from the seat
  loadTilesAlong(r.path, { speed: true });  // speed limits for every road on it, not just the curvy ones
  const roadAt = (p, heading) => {
    const x = roadAlong(store.roads, p, heading);
    // The estimate is a rule of thumb for ordinary roads (30 in town): none on highways or ramps.
    const guess = /^(motorway|trunk)|_link$/.test(x && x.hw) ? null : x && x.estMph;
    return x && { ref: (x.ref || '').replace(/;/g, ' / '), name: x.name, curvy: x.cls >= 0, limit: x.mph ?? guess, posted: x.mph != null };
  };
  loadWeather();
  // The forecast at the weather point nearest m, for the hour you'd pass: leaving time + s.
  const weatherAt = (m, s) => {
    const w = weather && weather.route === r && weather.hourly ? weather : null;
    if (!w) return null;
    const i = w.points.reduce((best, x, k) => Math.abs(x.m - m) < Math.abs(w.points[best].m - m) ? k : best, 0);
    return W.atPassing([{ ...w.points[i], s }], [w.hourly[i]], leaveTime())[0];
  };
  fly = new Fly(mapView, { route: r, profile: info && info.profile, crests: P.blindCrestsOn(r.path, store.roads), roadAt, weatherAt,
    onClose: () => { fly = null; mapView.setBasemap(settings.basemap); mapView.updateInsets(); mapView.fit(boundsOf(r.path)); } });
}

function lightsNote(lights) {
  const lefts = lights.filter(l => l.turn === 'left').length;
  return `🚦 ${lights.length} stoplight${lights.length > 1 ? 's' : ''}${lefts ? `, ${lefts} of them turning left` : ''}.`;
}

function doubleBack() {
  const back = info && info.back, turns = info && info.turns ? info.turns.length : 0;
  const turnNote = turns ? h('p.warn.small', {}, `↺ Turns around ${turns === 1 ? 'once' : `${turns} times`} off the curvy roads: off the highway and back on the other way, or round a block.`) : '';
  if (!back || back.meters < 400) return turnNote;
  const canFlip = trip.items.some(it => it.type === 'road' && !it.oneway);
  return [h('div.back-note', {},
    h('div.grow', {}, h('b', {}, `↩ ${miles(back.meters)} mi doubled back`),
      h('div.muted.small', {}, fixing || 'Roads ridden twice are dashed orange on the map.')),
    canFlip ? h('button.btn.small', { onclick: fixDoubleBack, disabled: !!fixing }, fixing ? 'Working…' : 'Try fixing') : ''), turnNote];
}

// ---------- weather ----------

const QUARTER = 15 * 60000;
const leaveTime = () => leaveAt && leaveAt > Date.now() - QUARTER ? leaveAt : Math.ceil(Date.now() / QUARTER) * QUARTER;
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
function clock(ms) {
  const d = new Date(ms), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

// Fetched once per route (again after an hour, or a minute after failing); changing the leave
// time just reads other hours.
function loadWeather() {
  const fresh = w => w.loading || Date.now() - w.at < (w.error ? 60000 : 3600000);
  if (!route || (weather && weather.route === route && fresh(weather))) return;
  const r = route, points = W.weatherPoints(r);
  weather = { route: r, points, loading: true, at: Date.now() };
  W.fetchForecast(points)
    .then(hourly => { if (weather.route === r) weather = { ...weather, hourly, loading: false }; })
    .catch(e => { console.warn(e); if (weather.route === r) weather = { ...weather, loading: false, error: true, at: Date.now() }; })
    .finally(renderSoon);
}

function weatherSection() {
  if (!route) return '';
  setTimeout(loadWeather, 0);
  const leave = leaveTime(), w = weather && weather.route === route ? weather : null;
  const rows = w && w.hourly ? W.atPassing(w.points, w.hourly, leave) : null;
  const judged = rows && W.rideWeather(rows);
  const where = r => `mile ${Math.round(r.m / 1609.34)}, ${clock(r.when)}`;
  const dot = r => ({ onmouseenter: () => mapView.setDot(r.p), onmouseleave: () => mapView.setDot(null), onclick: () => mapView.setDot(r.p) });
  return h('div.section', {},
    h('h3', {}, iconEl(icon.cloud), 'Weather'),
    h('div.btn-row', {},
      h('label.inline', {}, 'Leaving ',
        h('input.leave', { type: 'datetime-local', value: localInput(leave), min: localInput(Date.now()), max: localInput(Date.now() + 6.5 * 86400000),
          onchange: e => { const t = new Date(e.target.value).getTime(); leaveAt = Number.isFinite(t) ? t : null; renderSoon(); } })),
      leaveAt ? h('button.btn.small', { onclick: () => { leaveAt = null; renderSoon(); } }, 'Now') : ''),
    !w || w.loading ? h('p.muted.small', {}, 'Getting the forecast…')
      : w.error ? h('p.muted.small', {}, 'Couldn’t get the forecast right now.')
      : !judged.summary ? h('p.muted.small', {}, 'That’s past the end of the forecast (about a week out).')
      : h('div', {},
          judged.warnings.length
            ? judged.warnings.map(x => h('p.warn.small.wx-warn', dot(x.at), `⚠ ${x.text} around ${where(x.at)}`))
            : h('p.small.wx-ok', {}, `Looks good: ${judged.summary}.`),
          judged.warnings.length ? h('p.muted.small', {}, judged.summary[0].toUpperCase() + judged.summary.slice(1) + '.') : '',
          h('div.wx', {},
            h('div.wx-row.wx-head', {}, ['When', 'Mile', '', 'Temp', 'Rain', 'Gusts'].map(t => h('span', {}, t))),
            rows.map(r => r.none
              ? h('div.wx-row', dot(r), h('span', {}, clock(r.when)), h('span', {}, Math.round(r.m / 1609.34)), h('span.muted.wx-none', {}, 'past the forecast'))
              : h('div.wx-row', dot(r),
                  h('span', {}, clock(r.when)), h('span', {}, Math.round(r.m / 1609.34)),
                  h('span', { title: W.sky(r.code)[1] }, W.sky(r.code)[2]),
                  h('b', {}, `${Math.round(r.temp)}°`),
                  h(`span${r.rain >= WEATHER.rainPct ? '.warn' : ''}`, {}, r.rain == null ? '–' : `${r.rain}%`),
                  h(`span${r.gust >= WEATHER.gustMph ? '.warn' : ''}`, {}, `${Math.round(r.gust)} mph`)))),
          judged.partial ? h('p.muted.small', {}, 'The end of the ride is past the forecast.') : ''),
    h('p.fineprint', {}, 'Forecast from Open-Meteo for when you’ll pass each point (riding time, not counting stops). Tap a row to see where.'));
}

function stopList() {
  const list = h('ol.stops', {}, trip.items.map((it, i) => {
    const on = it.type === 'point' && i > 0 ? desiredRoadAt(it.pts[0]) : null;
    return h('li', {},
    h('span.grip', { html: icon.grip, title: 'Drag to reorder' }),
    h('span.num', {}, i + 1),
    h('div.grow', { onclick: () => mapView.fit(boundsOf(it.pts), 13) },
      h('div', {}, it.label),
      h('div.muted.small', {}, it.type !== 'road' ? (on ? `Stop on ${on.key} · drag its pin to move` : 'Stop · drag its pin to move')
        : `${it.oneway ? 'One way' : `${cap(T.ends(it).entry)} end → ${T.ends(it).exit} end`} · ${miles(it.curvy || 0)} mi of curves`)),
    it.type === 'road' && !it.oneway ? h('button.icon-btn', { title: 'Switch ends: ride it the other way', html: icon.swap,
      onclick: () => flipRoad(it) }) : '',
    on ? h('button.icon-btn', { title: `Ride ${on.key} end to end`, html: icon.route, onclick: () => stopToRoad(i, on) }) : '',
    h('button.icon-btn', { title: 'Remove', html: icon.x, onclick: () => { T.removeStop(trip, i); tripChanged(); } }));
  }));
  sortable(list, (from, to) => { T.moveStop(trip, from, to); tripChanged(); });
  return list;
}

// Drag rows by their grip to reorder (works with touch too). The move and the drop are watched
// on the whole window: moving the row in the list drops the grip's pointer capture, so the grip
// alone loses the drag after the first step.
function sortable(list, onMove) {
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || e.button > 0) return;
    e.preventDefault();
    const item = grip.closest('li'), from = [...list.children].indexOf(item), body = $('#sheetBody');
    let y = e.clientY;
    dragging = true;
    item.classList.add('lifting');
    const place = () => {
      const before = [...list.children].find(o => o !== item && y < o.getBoundingClientRect().top + o.offsetHeight / 2) || null;
      if (before !== item.nextElementSibling) list.insertBefore(item, before);
    };
    // Held near the sheet's top or bottom edge, the list scrolls.
    const scroller = setInterval(() => {
      const box = body.getBoundingClientRect(), dy = y < box.top + 40 ? -8 : y > box.bottom - 40 ? 8 : 0;
      if (dy) { body.scrollTop += dy; place(); }
    }, 16);
    const move = ev => { if (ev.pointerId === e.pointerId) { y = ev.clientY; place(); } };
    const drop = ev => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', drop);
      removeEventListener('pointercancel', drop);
      clearInterval(scroller);
      item.classList.remove('lifting');
      dragging = false;
      const to = [...list.children].indexOf(item);
      if (to !== from) onMove(from, to);
      else renderSoon();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', drop);
    addEventListener('pointercancel', drop);
  });
}

function fuelSection() {
  const f = info && info.fuel;
  return h('div.section', {},
    h('h3', {}, iconEl(icon.fuel), 'Fuel'),
    h('div.btn-row', {},
      h('label.inline', {}, 'Tank range ',
        h('select', { onchange: e => { trip.range = +e.target.value; tripChanged({ reroute: false }); refreshInfo(false); } },
          [80, 100, 120, 150, 200, 250].map(v => h('option', { value: v, selected: trip.range === v }, `${v} mi`)))),
      h('label.switch', {}, h('input', { type: 'checkbox', checked: trip.need90,
        onchange: e => { trip.need90 = e.target.checked; tripChanged({ reroute: false }); refreshInfo(false); } }), h('span', {}, '90+ only'))),
    !f ? h('p.muted.small', {}, 'Gas stops appear once there’s a route.') : h('div', {},
      h('p.muted.small', {}, `${f.ok.length} ${trip.need90 ? '90+ ' : ''}stations on the route · longest stretch without one: ${Math.round(f.longest)} mi`),
      f.gaps.map(([a, b]) => h('p.warn.small', {}, `⚠ No ${trip.need90 ? '90+ ' : ''}gas from mile ${Math.round(a)} to ${Math.round(b)}, more than your range.`)),
      f.picks.length ? f.picks.map(a => h('div.fuel-stop', {},
        h('span.dot', { style: `background:${FUEL_STATUS[a.item.status].color}` }),
        h('div.grow', { onclick: () => mapView.flyTo([a.item.lat, a.item.lon], 14) },
          h('div', {}, `Mile ${Math.round(a.mile)} · ${a.item.name}`),
          h('div.muted.small', {}, [a.item.city, FUEL_STATUS[a.item.status].label].filter(Boolean).join(' · '))),
        h('button.icon-btn', { title: 'Add as a stop', html: icon.plus, onclick: () => addStation(a.item) })))
        : h('p.muted.small', {}, `No fuel stop needed with a ${trip.range} mi range.`)));
}

function exportSection() {
  if (!route) return '';
  const links = P.googleLinks(P.googlePoints(route, trip));
  return h('div.section', {},
    h('h3', {}, iconEl(icon.go), 'Ride it'),
    h('button.cta', { onclick: openGoogle }, iconEl(icon.go), links.length > 1 ? `Open in Google Maps (${links.length} parts)` : 'Open in Google Maps'),
    showGoogleParts && links.length > 1 ? h('div.parts', {}, links.map((l, i) =>
      h('a.btn', { href: l, target: '_blank', rel: 'noopener' }, `Part ${i + 1} of ${links.length}`))) : '',
    h('div.btn-row', {},
      h('button.btn', { onclick: downloadGpx }, iconEl(icon.download), 'GPX file'),
      h('button.btn', { onclick: shareTrip }, iconEl(icon.share), 'Share')),
    h('p.fineprint', {}, 'Google Maps gets extra stops just past key turns so it sticks to this route. GPX keeps the exact route for riding apps (OsmAnd is free).'));
}

function openGoogle() {
  const links = P.googleLinks(P.googlePoints(route, trip));
  if (links.length === 1) return window.open(links[0], '_blank', 'noopener');
  showGoogleParts = true;
  go('trip');
}

function downloadGpx() {
  const a = h('a', { href: URL.createObjectURL(new Blob([P.gpx(trip, route)], { type: 'application/gpx+xml' })),
    download: P.tripName(trip).replace(/[^\w ,-]+/g, '').trim().replace(/\s+/g, '-') + '.gpx' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function shareTrip() {
  const url = location.href.split('#')[0] + '#trip=' + T.encodeTrip(trip);
  try {
    if (navigator.share) await navigator.share({ title: P.tripName(trip), url });
    else { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with it can open this ride.'); }
  } catch (e) {
    if (e.name !== 'AbortError') prompt('Copy this link:', url);
  }
}

// ---------- top bar: search & chips ----------

function renderChips() {
  const chip = (label, { on, menuItems, onclick, title } = {}) => h(`button.chip${on ? '.on' : ''}`, {
    title, onclick: menuItems ? e => menu(menuItems, e.currentTarget) : onclick,
  }, label, menuItems ? iconEl(icon.chevron, 'chev') : '');
  const s = settings, chips = [
    chip(MODES[s.mode], { menuItems: Object.entries(MODES).map(([k, l]) => ({ label: l, on: s.mode === k, run: () => setSetting({ mode: k }) })) }),
  ];
  if (s.mode !== 'speed') {
    chips.push(chip(ROAD_TYPES[s.roadType], { on: s.roadType !== 'all', menuItems: [{ heading: 'Road type' },
      ...Object.entries(ROAD_TYPES).map(([k, l]) => ({ label: l, on: s.roadType === k, run: () =>
        setSetting({ roadType: k, ...(k === 'highway' && !s.rampTiers.length ? { rampTiers: RAMP_TIERS.map((_, i) => i) } : {}) }) }))] }));
  }
  if (s.mode === 'ride' && s.roadType !== 'highway') {
    chips.push(chip(`${s.minSpeed}+ mph`, { menuItems: [{ heading: 'Speed limit at least' },
      ...[35, 40, 45, 50, 55].map(v => ({ label: `${v} mph`, on: s.minSpeed === v, run: () => setSetting({ minSpeed: v }) }))] }));
  }
  if ((s.mode === 'ride' || s.mode === 'curvy') && s.roadType !== 'highway') {
    chips.push(chip(s.minHills ? `${HILLS[s.minHills].label}+` : 'Any hills', { on: s.minHills > 0, menuItems: [{ heading: 'Hills' },
      ...['Any', 'Rolling or more', 'Hilly or more', 'Very hilly'].map((l, v) => ({
        label: v ? `${l} (${HILLS[v].ft}+ ft/mi)` : l, on: s.minHills === v, run: () => setSetting({ minHills: v }) }))] }));
  }
  chips.push(
    chip('Paved', { on: s.hideUnpaved, title: 'Hide gravel and dirt roads', onclick: () => setSetting({ hideUnpaved: !s.hideUnpaved }) }),
    chip('⚠ Blind crests', { on: s.showBlind, title: 'Tight turns at the top of a rise', onclick: () => setSetting({ showBlind: !s.showBlind }) }),
    chip('Gas', { on: s.showFuel, title: 'Gas stations (green = 90+ octane)', onclick: () => setSetting({ showFuel: !s.showFuel }) }));
  $('#chips').replaceChildren(...chips);
}

const q = $('#q'), results = $('#results');
let searchSeq = 0, photonTimer = null, shown = [];

function runSearch() {
  const text = q.value.trim(), seq = ++searchSeq;
  clearTimeout(photonTimer);
  $('#qClear').hidden = !text;
  if (!text) { results.hidden = true; return; }
  const local = localResults(text, store.search);
  showResults(local, text.length >= 3);
  if (text.length < 3) return;
  photonTimer = setTimeout(async () => {
    try {
      const remote = await photonResults(text, mapView.center(), store.index ? coverageBox() : '');
      if (seq === searchSeq) showResults([...local, ...remote].slice(0, 12), false);
    } catch (e) {
      if (seq === searchSeq && !local.length) showResults([], false);
    }
  }, 350);
}

function showResults(list, waiting) {
  shown = list;
  results.hidden = false;
  results.replaceChildren(...(list.length ? list.map((r, i) => h(`div.result${i === 0 ? '.active' : ''}`, { onclick: () => pickResult(r) },
    iconEl(r.kind === 'road' ? icon.route : icon.pin),
    h('div.grow', {}, h('div', {}, r.label), h('div.muted.small', {}, r.sub)),
    r.at ? h('button.btn.small', { onclick: e => { e.stopPropagation(); closeSearch(); setStartAt(r.at, `Start: ${r.label}`); mapView.flyTo(r.at, 11); go('plan'); } }, 'Start') : ''))
    : [h('div.result.muted', {}, waiting ? 'Searching…' : 'No matches.')]));
}

// Also drops online results still on their way, so they don't reopen the list.
function closeSearch() {
  searchSeq++;
  clearTimeout(photonTimer);
  results.hidden = true;
  q.blur();
}

async function pickResult(r) {
  closeSearch();
  q.value = r.label;
  $('#qClear').hidden = false;
  if (r.at) {
    place = { label: r.label, sub: r.sub, at: r.at };
    mapView.setPin(r.at);
    mapView.flyTo(r.at, r.kind === 'town' ? 12 : 14);
    go('place', place);
    return;
  }
  place = null;
  mapView.setPin(null);
  mapView.fit(r.bounds);
  loadTiles(pad(r.bounds, 0.05));
  await tilesSettled();
  const pieces = store.roads.filter(x => x.key === r.key && x.cls >= 0 && intersects(pad(r.bounds, 0.02), x.bounds));
  if (!pieces.length) return;
  const g = summarize(clusterRoads(pieces).sort((a, b) => b.roads.length - a.roads.length)[0], r.key);
  const piece = g.roads.reduce((a, b) => b.length > a.length ? b : a);
  select(g, piece, piece.geom[Math.floor(piece.geom.length / 2)]);
}

q.addEventListener('input', runSearch);
q.addEventListener('focus', () => { if (q.value.trim()) runSearch(); });
q.addEventListener('keydown', e => {
  if (e.key === 'Escape') { q.value = ''; runSearch(); q.blur(); }
  if (e.key === 'Enter' && shown.length) pickResult(shown[0]);
});
$('#qClear').addEventListener('click', () => {
  q.value = '';
  runSearch();
  place = null;
  mapView.setPin(null);
  if (view === 'place') go('home');
  q.focus();
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  if (e.key === 'Escape') closeMenu();
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#topbar')) results.hidden = true; });

// ---------- map buttons ----------

$('#locateBtn').addEventListener('click', async () => {
  try { mapView.flyTo(await locate(), 11); } catch (e) { locationError(e); }
});
$('#tiltBtn').addEventListener('click', () => {
  tilted = !tilted;
  mapView.set3D(tilted);
  document.body.classList.toggle('tilted', tilted);
  $('#tiltBtn').classList.toggle('on', tilted);
  if (tilted) toast('3D terrain on. Drag with two fingers (or right-click drag) to tilt and turn.');
});
$('#layersBtn').addEventListener('click', e => menu([
  { heading: 'Map' },
  { label: 'Dark', on: settings.basemap === 'dark', run: () => setSetting({ basemap: 'dark' }) },
  { label: 'Satellite', on: settings.basemap === 'satellite', run: () => setSetting({ basemap: 'satellite' }) },
  { heading: 'Show' },
  { label: 'Terrain shading', on: settings.hillshade, run: () => setSetting({ hillshade: !settings.hillshade }) },
], e.currentTarget));
$('#q').placeholder = matchMedia('(hover: hover)').matches ? 'Search roads, towns, places   ( / )' : 'Search roads, towns, places';

start();
