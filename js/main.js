// Ride Finder: app state, views and wiring. See FEATURES.md for what each feature must do.
import { CURVE_CLASSES, CORNER_ABOUT, SPEED_BINS, HILLS, FUEL_STATUS, SURFACE, GEN, RAMP_TIERS, RAMP_ABOUT } from './config.js';
import { miles, fmtDuration, spotOnLine, pad, boundsOf, intersects, km } from './geo.js';
import { visible, stretchOf, bestInView, clusterRoads, summarize } from './roads.js';
import * as T from './trip.js';
import * as P from './plan.js';
import { localResults, photonResults } from './search.js';
import { fetchRoute, routeRefs } from './routing.js';
import { profile } from './elevation.js';
import { store, initData, onRoadsChanged, loadTiles, tilesSettled, loadingCount, coverageBox } from './store.js';
import { MapView } from './mapview.js';
import { icon, h, elevationChart, Sheet, toast, menu, closeMenu } from './ui.js';

const HOME = [39.0997, -94.5786];
const SETTINGS_KEY = 'rf2-settings', TRIP_KEY = 'rf2-trip';
const $ = s => document.querySelector(s);
const load = key => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

// ---------- state ----------

const settings = Object.assign({
  mode: 'ride', minSpeed: 45, minHills: 0, hideUnpaved: true, showBlind: true, showFuel: false,
  classes: [0, 1, 2, 3, 4], speedBins: SPEED_BINS.map((_, i) => i), rampTiers: RAMP_TIERS.map((_, i) => i),
  basemap: 'dark', hillshade: true, genHours: 3,
}, load(SETTINGS_KEY));

let trip = T.newTrip();
let route = null;            // { path, meters, seconds, maneuvers, fallback }
let info = null;             // what's along the route: { curvy, blind, fuel, profile }
let selected = null;         // { group, piece, at }: the road picked on the map or in a list
let view = 'home', viewArg = null;
let picking = null;          // 'start' | 'stop' | 'road' while waiting for a map tap
let dragging = false;        // a stop row is being dragged: hold re-renders until it's dropped
let showKey = false;         // the map key's explanations are open
let fixing = '';             // status while trying roads the other way to stop doubling back
let gen = { options: [], index: -1, running: false, status: '' };
let showGoogleParts = false;
let tilted = false;

const MODES = { ride: 'Best rides', curvy: 'All curvy roads', ramps: 'Interchanges', speed: 'Speed limits' };

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
window.RF = { store, mapView, go: (v, arg) => go(v, arg), get trip() { return trip; }, get route() { return route; }, get info() { return info; }, get gen() { return gen; }, settings };

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
  mapView.on('empty', at => { if (!usePick(at)) clearSelection(); });
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
    info = { error: 'Couldn’t reach the routing servers. Try again in a minute.' };
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
    return renderSoon();
  }
  loadTiles(boundsOf(route.path));
  const r = route, fuel = P.planFuel(r.path, store.fuel, trip.range, trip.need90);
  info = {
    ...(withProfile ? {} : { profile: info && info.profile }),
    curvy: P.curvyMetersOn(r.path, store.roads), blind: P.blindCrestsOn(r.path, store.roads).length, fuel,
    back: P.retrace(r.path),
  };
  mapView.setRetrace(info.back.lines);
  mapView.setRouteStations(fuel.along.map(a => ({ k: a.item.k, status: a.item.status, pick: fuel.picks.includes(a) })));
  if (withProfile) profile(r.path).then(p => { if (route === r && info) { info.profile = p; renderSoon(); } });
  renderSoon();
}

// Added where it fits best in the ride, entered from the end that makes sense; the toast offers
// the other end.
function addRoad(g) {
  const it = trip.items[T.insertRoad(trip, g)];
  tripChanged();
  roadToast(it, 'Added');
}

function roadToast(it, verb) {
  const i = trip.items.indexOf(it);
  if (i < 0) return;
  const where = it.oneway ? '' : `, in at the ${T.ends(it).entry} end`;
  toast(`${verb} ${it.label} as stop ${i + 1}${where}`, [
    it.oneway ? null : { label: 'Switch ends', run: () => flipRoad(it) },
    view === 'trip' ? null : { label: 'View ride', run: () => go('trip') },
  ].filter(Boolean));
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

function addStation(s) {
  const stop = { type: 'point', label: `Gas: ${s.name}`, pts: [[s.lat, s.lon]] };
  const at = route ? T.indexAlongRoute(trip, stop.pts[0], route.path) : trip.items.length;
  trip.items.splice(at, 0, stop);
  tripChanged();
  toast(`Added ${s.name} as stop ${at + 1}`);
}

function setStartAt(p, label) {
  T.setStart(trip, p, label);
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
  clearTimeout(routeTimer);
  const seq = ++routeSeq;
  for (const it of roads) {
    it.pts.reverse();
    fixing = `Trying ${it.label} the other way…`;
    renderSoon();
    const r = await fetchRoute(T.routablePoints(trip), +trip.pref);
    if (seq !== routeSeq) { it.pts.reverse(); fixing = ''; return; }  // the ride changed meanwhile
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
    toast('Riding the roads the other way doesn’t help. Try dragging the stops into another order.');
    return renderSoon();
  }
  tripChanged({ reroute: false });
  setRoute(best.r);
  toast(`Flipped ${flipped.join(', ')}. ${best.back >= 400 ? `Still ${miles(best.back)} mi doubled back.` : 'No more doubling back.'}`);
}

// ---------- generator ----------

async function generate() {
  const hours = settings.genHours;
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
  const required = ownStops();
  const s = start.pts[0], reach = P.reachKm(hours);
  const dLat = reach / 111, dLon = reach / (111 * Math.cos(s[0] * Math.PI / 180));
  gen = { options: [], index: -1, running: true,
    status: required.length ? `Building loops through ${required.map(r => r.label).join(', ')}…` : 'Loading roads around your start…' };
  renderSoon();
  loadTiles([s[0] - dLat, s[1] - dLon, s[0] + dLat, s[1] + dLon]);
  await tilesSettled();
  const f = filters(), worthy = r => visible(r, { ...f, mode: f.mode === 'curvy' ? 'curvy' : 'ride' });
  const options = P.buildOptions(P.candidateGroups(store.roads, s, reach, worthy), s, hours, required);
  if (!options.length) {
    gen = { options: [], index: -1, running: false, status: 'No good roads within reach. Try a longer ride, or loosen the filters.' };
    return renderSoon();
  }
  for (let i = 0; i < options.length; i++) {
    gen.status = `Routing loop ${i + 1} of ${options.length}…`;
    renderSoon();
    await routeOption(options[i], start, hours);
  }
  // Only loops within 80–120% of the chosen time; if none came out that close, the nearest.
  const worth = o => o.route ? o.worth : -1, twice = o => o.route && o.back > GEN.hideBack * o.route.meters;
  const target = hours * 3600, fits = o => o.route && o.route.seconds >= GEN.under * target && o.route.seconds <= GEN.overrun * target;
  let shown = options.filter(fits), status = '';
  if (!shown.length && options.some(o => o.route)) {
    const off = o => Math.abs(Math.log(o.route.seconds / target));
    shown = options.filter(o => o.route).sort((a, b) => off(a) - off(b)).slice(0, 3);
    status = `Couldn’t fit a loop close to ${hours === 1.5 ? '1½' : hours} h here, so these are the nearest. Try another time or loosen the filters.`;
  }
  // Leave out loops that ride a fifth of the way twice, when there are enough without.
  const clean = shown.filter(o => !twice(o));
  if (clean.length >= 3) shown = clean;
  gen = { options: (shown.length ? shown : options).sort((a, b) => worth(b) - worth(a)), index: -1, running: false, status };
  if (gen.options[0].route) selectOption(0);
  else renderSoon();
}

// How good a routed loop is: curvy miles, scaled by the share of the ride they make up, and
// cut by the share it rides twice (each 10% doubled back costs 30%). Best first.
function rate(r) {
  if (!r) return null;
  const curvy = P.curvyMetersOn(r.path, store.roads), back = P.retrace(r.path).meters;
  return { route: r, curvy, back, blind: P.blindCrestsOn(r.path, store.roads).length,
    worth: curvy * curvy / r.meters * Math.max(0.1, 1 - 3 * back / r.meters) };
}

// Route a loop for real. Under 80% of the time, fill it again aiming that much longer (the
// estimate ran fast), up to twice; over 120%, drop its weakest road, up to twice. While it
// then doubles back, try it without the generated road most to blame (up to twice): the one the
// doubled-back miles are on, like a lake road that dead-ends, or else the one nearest them.
async function routeOption(opt, start, hours) {
  let items = [start, ...opt.stops];
  const routeOf = list => {
    P.orientStops(start.pts[0], list.slice(1));
    return fetchRoute(T.routablePoints({ ...trip, items: list, loop: true }), +trip.pref);
  };
  let r = await routeOf(items);
  for (let tries = 0; r && r.seconds < hours * 3600 * GEN.under && tries < 2; tries++) {
    const estHours = P.estimate(start.pts[0], items.slice(1)).hours;
    const more = P.fillLoop(start.pts[0], opt.pool, opt.dir, hours * estHours / (r.seconds / 3600), opt.chosen, opt.maxRoads + 2);
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
  for (let tries = 0; tries < 2 && best && best.back > GEN.maxBack * best.route.meters; tries++) {
    const added = items.filter(it => it.gen);
    if (!added.length || items.length <= 2) break;
    const spots = P.retrace(best.route.path).lines.flat();
    const geoms = it => (it.ids || []).map(id => store.byId.get(id)).filter(Boolean).map(x => x.geom);
    const onIt = it => spots.filter(q => geoms(it).some(g => g.some(p => km(p, q) < 0.15))).length;
    const near = it => Math.min(...it.pts.flatMap(p => spots.map(q => km(p, q))));
    const blame = added.map(it => ({ it, on: onIt(it), near: near(it) }))
      .sort((a, b) => b.on - a.on || a.near - b.near)[0].it;
    const fewer = items.filter(it => it !== blame).map(it => ({ ...it, pts: it.pts.map(p => [...p]) }));
    const other = rate(await routeOf(fewer));
    if (!other || other.worth <= best.worth || other.route.seconds < hours * 3600 * GEN.under) break;
    items = fewer;
    best = other;
  }
  Object.assign(opt, { items, route: best && best.route }, best ? { curvy: best.curvy, blind: best.blind, back: best.back, worth: best.worth } : {});
}

function selectOption(i) {
  const opt = gen.options[i];
  gen.index = i;
  trip.items = opt.items.map(it => ({ ...it, pts: it.pts.map(p => [...p]) }));
  trip.loop = true;
  routeSeq++;
  clearTimeout(routeTimer);
  tripChanged({ reroute: false });
  setRoute(opt.route);
  mapView.setPreview(null);
  mapView.fit(boundsOf(opt.route.path), 12);
}

// ---------- map interactions ----------

function onRoadTap(id, at) {
  if (usePick(at, id)) return;
  const piece = store.byId.get(id);
  select(stretchOf(store.roads, piece), piece, at);
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
  if (view === 'road' || view === 'station') go('home');
}

function onHover(id) {
  if (id == null) return mapView.highlight(selected && selected.group.ids);
  const r = store.byId.get(id);
  if (r) mapView.highlight(stretchOf(store.roads, r).ids);
}

function spotMenu(at, pt) {
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${at[0].toFixed(6)},${at[1].toFixed(6)}`;
  menu([
    { heading: `${at[0].toFixed(4)}, ${at[1].toFixed(4)}` },
    { label: 'Start a ride here', icon: icon.pin, run: () => { setStartAt(at, 'Start'); go('plan'); } },
    { label: 'Add a stop here', icon: icon.plus, run: () => { T.addPoint(trip, at, 'Stop'); tripChanged(); toast('Stop added. Drag its pin to adjust.'); } },
    { label: 'Street View here', icon: icon.person, run: () => window.open(sv, '_blank', 'noopener') },
  ], { x: pt.x, y: pt.y });
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
  else if (kind === 'road') addRoad(stretchOf(store.roads, store.byId.get(roadId)));
  else { T.addPoint(trip, at, 'Stop'); tripChanged(); }
  renderSoon();
  return true;
}

const PICK_PROMPTS = { start: 'Tap the map to set your start', stop: 'Tap the map to add a stop', road: 'Tap a road to add it to your ride' };
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
  if (v === 'station') selected = null;
  if (v === 'home' || v === 'station') mapView.highlight(selected && v !== 'station' ? selected.group.ids : null);
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
  const views = { home: homeView, road: roadView, station: stationView, plan: planView, trip: tripView };
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
    h('div.section-head', {}, h('h2', {}, speedMode ? 'Posted speed limits' : settings.mode === 'ramps' ? 'Fast ramps in view' : 'Best roads in view'),
      loadingCount() ? h('span.muted', {}, 'Loading…') : ''),
    legend(),
    speedMode
      ? h('p.muted', {}, mapView.zoom() < SPEED_ZOOM ? 'Zoom in to see speed limits.' : 'From OpenStreetMap. County roads and side streets appear as you zoom in.')
      : groups.length
        ? h('div.cards', {}, groups.map(roadCard))
        : h('p.empty', {}, !store.roads.length || mapView.zoom() < LOAD_ZOOM ? 'Zoom in to see roads.'
          : settings.mode === 'ramps' ? 'No fast ramps here. Try a big interchange, like where I-435 meets I-470.' : 'Nothing matches here. Pan around or loosen the filters.'),
    h('button.cta.sticky', { onclick: () => go('plan') }, iconEl(icon.route), 'Plan a ride'),
    h('p.fineprint', {}, 'Road data © OpenStreetMap contributors. Many rural speed limits are estimated. Always check conditions before you ride.'),
  ];
}

// The map key: tap a class to hide or show it; "What's this?" explains what puts a road in each.
function legend() {
  if (settings.mode === 'speed') {
    return h('div.legend', {}, SPEED_BINS.map((b, i) => legendChip(b, settings.speedBins.includes(i), () => toggleIn('speedBins', i))));
  }
  const ramps = settings.mode === 'ramps', classes = ramps ? RAMP_TIERS : CURVE_CLASSES;
  const on = ramps ? settings.rampTiers || RAMP_TIERS.map((_, i) => i) : settings.classes;
  return [
    h('div.legend', {},
      classes.map((c, i) => legendChip(c, on.includes(i), () => toggleIn(ramps ? 'rampTiers' : 'classes', i))),
      h(`button.legend-chip.key-btn${showKey ? '.on' : ''}`, { title: 'What do these mean?', 'aria-expanded': showKey ? 'true' : 'false',
        onclick: () => { showKey = !showKey; render(); } }, iconEl(icon.help), showKey ? 'Hide' : 'What’s this?')),
    showKey ? keyHelp(classes, ramps) : null,
  ];
}

function keyHelp(classes, ramps) {
  const row = (swatch, label, about) => h('div.key-row', {}, swatch, h('div', {}, h('b', {}, label), ' ', about));
  const sw = color => h('span.swatch', { style: `background:${color}` });
  return h('div.key-help', {},
    h('p', {}, ramps ? RAMP_ABOUT : CORNER_ABOUT),
    classes.map(c => row(sw(c.color), c.label, c.about)),
    ramps ? '' : [
      row(h('span.swatch.dashed'), 'Dashed', 'Surface not recorded, so it could be gravel.'),
      row(h('span.key-icon', {}, '⚠'), 'Blind crest', 'A tight turn at or just past the top of a rise, so you can’t see through it.'),
      row(iconEl(icon.mountain, 'key-icon'), 'Hills', `Feet of up and down per mile: ${HILLS.slice(1).map(l => `${l.label.toLowerCase()} ${l.ft}+`).join(', ')}. Around KC is about 95, the Ozarks about 160.`),
    ]);
}
const groupColor = g => g.rampTier >= 0 ? RAMP_TIERS[g.rampTier].color : CURVE_CLASSES[Math.max(0, g.cls)].color;
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
  const mph = g.roads.map(x => x.mph).find(v => v != null);
  return [
    backBar(g.key, 'One-way interchange ramp'),
    h('div.tag', { style: `--c:${tier.color}` }, tier.label),
    h('p.about', {}, tier.about),
    h('div.stats', {},
      stat(`${miles(g.roads.reduce((s, x) => s + x.sweep, 0))} mi`, 'of sweeping curve'),
      stat(lanes ? `${lanes}` : '—', lanes === 1 ? 'lane' : 'lanes'),
      stat(mph ? `${mph} mph` : '—', mph ? 'posted limit' : 'no posted limit'),
      stat(`${miles(g.roads.reduce((s, x) => s + x.length, 0))} mi`, 'long')),
    h('div.actions', {},
      h('button.btn.primary.wide', { onclick: () => addRoad(g) }, iconEl(icon.plus), 'Add to ride'),
      h('button.btn.wide', { onclick: () => planAround(g) }, iconEl(icon.route), 'Plan a loop with this ramp'),
      ...links),
    h('p.fineprint', {}, `OSM way ${r.id} · ${r.hw.replace('_', ' ')}. Rides are routed the legal way round.`),
  ];
}

function roadView() {
  if (!selected) return homeView();
  const { group: g, piece: r, at } = selected;
  const spot = spotOnLine(r.geom, at), [lat, lon] = spot.p.map(v => +v.toFixed(6));
  const gm = 'https://www.google.com/maps/@?api=1&map_action=';
  const links = [
    h('a.btn', { href: `${gm}pano&viewpoint=${lat},${lon}&heading=${Math.round(spot.heading)}`, target: '_blank', rel: 'noopener' }, iconEl(icon.person), 'Street View'),
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

function planView() {
  const start = T.startOf(trip);
  return [
    backBar('Plan a ride', 'A loop from your start through the best roads'),
    h('div.field', {}, h('label', {}, 'Start'),
      h('div.start-row', {}, iconEl(icon.pin), h('span.grow', {}, start ? start.label.replace(/^Start:?\s*/, '') || 'Pinned on the map' : 'Not set yet'))),
    h('div.btn-row', {},
      h('button.btn', { onclick: async () => {
        try { setStartAt(await locate(), 'Start: my location'); } catch (e) { locationError(e); }
      } }, iconEl(icon.locate), 'My location'),
      h('button.btn', { onclick: () => startPicking('start') }, iconEl(icon.pin), 'Pick on map')),
    mustInclude(),
    h('div.field', {}, h('label', {}, 'Ride time'),
      h('div.seg', {}, [1, 1.5, 2, 3, 4, 5, 6, 8].map(t => h(`button${settings.genHours === t ? '.on' : ''}`,
        { onclick: () => setSetting({ genHours: t }) }, t === 1.5 ? '1½ h' : `${t} h`)))),
    h('button.cta', { onclick: generate, disabled: gen.running }, iconEl(icon.route), gen.running ? 'Working…' : 'Generate loops'),
    gen.status ? h('p.muted', {}, gen.status) : '',
    gen.options.length ? h('div.cards', {}, gen.options.map(optionCard)) : '',
    gen.index >= 0 ? h('button.btn.wide', { onclick: () => go('trip') }, 'Ride this loop →') : '',
    h('p.fineprint', {}, 'Uses the filters at the top (speed, hills, paved). Riding time doesn’t include stops. Or build your own: tap roads on the map and Add to ride.'),
  ];
}

// The rider's own stops: every generated loop goes through them.
const ownStops = () => trip.items.filter((it, i) => !(i === 0 && T.startOf(trip)) && !it.gen);

function mustInclude() {
  const own = ownStops();
  return h('div.field', {}, h('label', {}, 'Must include'),
    own.length
      ? h('div', {}, own.map(it => h('div.start-row.must', {},
          iconEl(it.type === 'road' ? icon.route : icon.pin),
          h('span.grow', {}, it.label, it.type === 'road' && it.curvy ? h('span.muted.small', {}, ` · ${miles(it.curvy)} mi of curves`) : ''),
          h('button.icon-btn', { title: 'Remove', html: icon.x, onclick: () => { T.removeStop(trip, trip.items.indexOf(it)); tripChanged(); } }))),
        h('p.muted.small', {}, 'Loops will go through these and fill the rest of your time with the best roads nearby.'))
      : h('p.muted.small', {}, 'Nothing yet. To build a loop around a road, tap it on the map and choose “Plan a loop with this road”.'));
}

function optionCard(o, i) {
  if (!o.route) return h('div.card.option.failed', {}, `${P.heading(o.dir)}: couldn’t route right now`);
  const pct = Math.round(100 * o.curvy / o.route.meters);
  return h(`div.card.option${i === gen.index ? '.on' : ''}`, {
    onclick: () => selectOption(i),
    onmouseenter: () => mapView.setPreview(o.route.path),
    onmouseleave: () => mapView.setPreview(null),
  },
  h('div.option-head', {}, h('span.num', {}, i + 1), h('b', {}, P.heading(o.dir)[0].toUpperCase() + P.heading(o.dir).slice(1)),
    h('span.muted.push', {}, fmtDuration(o.route.seconds))),
  h('div.option-stats', {}, `${miles(o.route.meters)} mi · `, h('b', {}, `${miles(o.curvy)} mi curvy`), ` (${pct}%)`,
    o.blind ? h('span.warn', {}, ` · ⚠ ${o.blind}`) : '', o.back >= 400 ? h('span.warn', {}, ` · ↩ ${miles(o.back)} mi twice`) : ''),
  h('div.muted.small', {}, o.items.slice(1).flatMap((it, k) => [k ? ', ' : '', it.gen ? it.label : h('b.own', {}, it.label)])));
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
    route.fallback ? h('p.muted.small', {}, 'The back-roads router is busy, so this is the plain fastest route.') : '',
    doubleBack(),
    p ? h('div', {},
      h('div.chart-head', {}, h('span', {}, h('b', {}, `${Math.round(p.climbFt).toLocaleString()} ft`), ' of climbing'),
        h('span', {}, `${Math.round(p.lo).toLocaleString()}–${Math.round(p.hi).toLocaleString()} ft`)),
      elevationChart(p, s => mapView.setDot(s && s.p))) : '');
}

function doubleBack() {
  const back = info && info.back;
  if (!back || back.meters < 400) return '';
  const canFlip = trip.items.some(it => it.type === 'road' && !it.oneway);
  return h('div.back-note', {},
    h('div.grow', {}, h('b', {}, `↩ ${miles(back.meters)} mi doubled back`),
      h('div.muted.small', {}, fixing || 'Roads ridden twice are dashed orange on the map.')),
    canFlip ? h('button.btn.small', { onclick: fixDoubleBack, disabled: !!fixing }, fixing ? 'Working…' : 'Try fixing') : '');
}

function stopList() {
  const list = h('ol.stops', {}, trip.items.map((it, i) => h('li', {},
    h('span.grip', { html: icon.grip, title: 'Drag to reorder' }),
    h('span.num', {}, i + 1),
    h('div.grow', { onclick: () => mapView.fit(boundsOf(it.pts), 13) },
      h('div', {}, it.label),
      h('div.muted.small', {}, it.type !== 'road' ? 'Stop · drag its pin to move'
        : `${it.oneway ? 'One way' : `${cap(T.ends(it).entry)} end → ${T.ends(it).exit} end`} · ${miles(it.curvy || 0)} mi of curves`)),
    it.type === 'road' && !it.oneway ? h('button.icon-btn', { title: 'Switch ends: ride it the other way', html: icon.swap,
      onclick: () => flipRoad(it) }) : '',
    h('button.icon-btn', { title: 'Remove', html: icon.x, onclick: () => { T.removeStop(trip, i); tripChanged(); } }))));
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
  if (s.mode === 'ride') {
    chips.push(chip(`${s.minSpeed}+ mph`, { menuItems: [{ heading: 'Speed limit at least' },
      ...[35, 40, 45, 50, 55].map(v => ({ label: `${v} mph`, on: s.minSpeed === v, run: () => setSetting({ minSpeed: v }) }))] }));
  }
  if (s.mode === 'ride' || s.mode === 'curvy') {
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
  if (r.at) {
    mapView.setPin(r.at);
    mapView.flyTo(r.at, r.kind === 'town' ? 12 : 14);
    return;
  }
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
$('#qClear').addEventListener('click', () => { q.value = ''; runSearch(); mapView.setPin(null); q.focus(); });
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
