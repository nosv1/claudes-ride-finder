// Behaviour tests for index.html, run in a real (headless) browser by run.py.
// They reach into the app's top-level names (map, roads, trip, …); a rewrite that renames
// those only needs the small helpers at the top of this file updated.

const MO150 = 18518688;  // the rider's reference road: 55 mph sweepers east of Lee's Summit
const MO150_VIEW = [38.835, -94.33];

const roadIndex = id => [...lines.keys()].find(k => roads[k].id === id);
const shownLine = id => { const k = roadIndex(id); return k != null && roadLayer.hasLayer(lines.get(k)) ? lines.get(k) : null; };

async function showMo150() {
  map.setView(MO150_VIEW, 13, { animate: false });
  await waitFor(() => shownLine(MO150), 'MO-150 to load and draw');
  return roads[roadIndex(MO150)];
}

function quietTripChange() {
  tripChanged();
  clearTimeout(routeTimer);  // offline tests shouldn't hit the routing server
}

// ---------- loading & modes ----------

test('road tiles load around Kansas City', async () => {
  await waitFor(() => roads.length > 1000, 'roads to load');
  assertEq(legendEl.children.length, 5, 'Best rides legend: sweepers + 4 curve bins');
});

test('MO-150 east of Lee\'s Summit shows as a sweeper in Best rides', async () => {
  const r = await showMo150();
  assertEq(curvyBin(r), SWEEP_BIN);
  assertEq(r.mph ?? r.estMph, 55);
});

test('Speed limits mode swaps the legend and hides the hills filter', async () => {
  const tab = mode => document.querySelector(`#modeTabs button[data-mode="${mode}"]`);
  tab('speed').click();
  assertEq(legendEl.children.length, 9, 'speed bins');
  assertEq(getComputedStyle(document.getElementById('hillsRow')).display, 'none');
  tab('ride').click();
  assertEq(legendEl.children.length, 5);
});

test('hidden panels really are hidden', async () => {
  // .row/.fuel-legend set display:flex, which beats the hidden attribute without the [hidden] rule.
  assert(document.getElementById('showFuel').checked === false);
  assertEq(getComputedStyle(document.getElementById('fuelLegend')).display, 'none');
});

// ---------- interacting with roads ----------

test('clicking a road opens a popup at that spot with Add to trip and Street View', async () => {
  await showMo150();
  const r = roads[roadIndex(MO150)], at = L.latLng(r.geom[2][0] + 0.0001, r.geom[2][1] + 0.0001);
  shownLine(MO150).fire('click', { latlng: at });
  const popup = document.querySelector('.leaflet-popup-content');
  assert(popup && popup.querySelector('.popup-add'), 'popup with Add to trip');
  const sv = [...popup.querySelectorAll('a')].find(a => a.textContent === 'Street View');
  const [lat, lon] = new URL(sv.href).searchParams.get('viewpoint').split(',').map(Number);
  assert(Math.abs(lat - at.lat) < 0.001 && Math.abs(lon - at.lng) < 0.001, `Street View at the click, got ${lat},${lon}`);
  map.closePopup();
  await sleep(400);  // the popup fades out before it leaves the page
});

test('hovering a road outlines its stretch', async () => {
  await showMo150();
  shownLine(MO150).fire('mouseover');
  assert(highlightLayer.getLayers().length > 0, 'outline drawn');
  shownLine(MO150).fire('mouseout');
  assertEq(highlightLayer.getLayers().length, 0);
});

test('nothing drawn above the roads swallows their clicks', async () => {
  // Regression: a canvas renderer in any pane above the roads' canvas eats every road click.
  // Exercise each overlay that has caused it before, then check the stacking.
  await showMo150();
  document.getElementById('showFuel').click();
  previewOption({ route: { path: [[38.8, -94.5], [38.9, -94.2]] } });
  profileMarker.setLatLng(map.getCenter()).addTo(map);
  searchMarker.setLatLng(map.getCenter()).addTo(map);
  try {
    const roadPaneZ = +getComputedStyle(map.getPane('overlayPane')).zIndex;
    document.querySelectorAll('#map canvas').forEach(c => {
      const pane = c.closest('.leaflet-pane');
      const z = +getComputedStyle(pane).zIndex;
      assert(z < roadPaneZ || pane === map.getPane('overlayPane'), `canvas in ${pane.className} (z ${z}) sits above the roads`);
    });
    assertEq(map.getPane('overlayPane').querySelectorAll('canvas').length, 1, 'one canvas in the roads pane');
    const r = roads[roadIndex(MO150)], p = map.latLngToContainerPoint(r.geom[Math.floor(r.geom.length / 2)]);
    const box = document.getElementById('map').getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + p.x, box.top + p.y);
    assert(hit && (hit.closest(".leaflet-overlay-pane") || hit.closest(".leaflet-fuel-pane")),
      `click at ${Math.round(p.x)},${Math.round(p.y)} lands on ${hit && hit.tagName}.${hit && hit.className} in ${hit && hit.parentElement.className}`);
  } finally {
    document.getElementById('showFuel').click();
    previewOption(null);
    map.removeLayer(profileMarker);
    map.removeLayer(searchMarker);
  }
});

// ---------- search ----------

test('search finds route numbers, roads near towns, and towns', async () => {
  const keys = q => localResults(q).filter(r => r.kind === 'road').map(r => r.key);
  assertEq(keys('hwy 7')[0], 'MO 7');
  assert(keys('K-10').every(k => /k 10|k10/i.test(k.replace('-', ' '))), 'K-10 / k10 / K 10 normalize the same');
  assert(keys('MO Y camdenton').includes('MO Y'), 'road + town');
  assert(localResults('lees summit').some(r => r.label === "Lee's Summit"), 'apostrophes ignored');
  assert(!localResults('mo y').some(r => /york/i.test(r.label)), 'one-letter words match whole words only');
});

test('Photon search returns places in the covered area', async () => {
  const res = await photonResults('ha ha tonka', searchSeq);
  assert(res.some(r => /Ha Ha Tonka State Park/.test(r.label)), JSON.stringify(res.map(r => r.label)));
}, { network: true });

// ---------- trip ----------

test('trip: add a start and a road; the share link round-trips', async () => {
  const r = await showMo150();
  trip.items = [];
  quietTripChange();
  addPoint([38.85, -94.34], 'Start');
  addRoad(groupFor(r));
  clearTimeout(routeTimer);
  assertEq(trip.items.length, 2);
  const pts = tripPoints();
  assertEq(JSON.stringify(pts[pts.length - 1].p), JSON.stringify(pts[0].p), 'loop returns to the start');
  const copy = decodeTrip(encodeTrip());
  assertEq(JSON.stringify(copy.items.map(it => [it.type, it.label, it.pts])),
           JSON.stringify(trip.items.map(it => [it.type, it.label, it.pts])));
  trip.items = [];
  quietTripChange();
});

test('Google Maps export adds stops past turns and fills long gaps', async () => {
  // A made-up 100 km route heading east, with one left turn 30 km in.
  const path = [];
  for (let i = 0; i <= 1000; i++) path.push([38.5, -94 + i * 0.00115]);
  trip.items = [{ type: 'point', label: 'A', pts: [path[0]] }, { type: 'point', label: 'B', pts: [path[1000]] }];
  trip.loop = false;
  route = { path, meters: 100000, seconds: 4000, maneuvers: [{ type: 15, at: 300, end: 600, km: 30, names: [] }] };
  try {
    const stops = googlePoints();
    const along = stops.map(p => nearestIndex(path, p)).sort((a, b) => a - b);
    assert(along.some(i => i > 300 && i <= 303), 'a stop ~200 m past the turn');
    for (let k = 1; k < along.length; k++) {
      assert(map.distance(path[along[k - 1]], path[along[k]]) <= 25000, 'no stretch over 25 km without a stop');
    }
  } finally {
    route = null;
    trip.items = [];
    trip.loop = loopEl.checked = true;
    quietTripChange();
  }
});

test('routing uses the motorcycle router, and the fuel plan finds stations', async () => {
  const r = await showMo150();
  trip.items = [];
  addPoint([38.912, -94.376], 'Start');  // downtown Lee's Summit, so the loop passes gas stations
  addRoad(groupFor(r));
  rangeEl.value = '80';
  await computeRoute();
  try {
    assert(route, 'got a route');
    assert(!route.fallback, 'Valhalla answered (no OSRM fallback)');
    assert(route.maneuvers.length > 0, 'turn list for the Google export');
    assert(planFuel().along.length > 0, 'gas stations along the route');
  } finally {
    rangeEl.value = '120';
    trip.items = [];
    quietTripChange();
    showRoute(null);
  }
}, { network: true });

test('generator routes up to 6 loops near the requested time', async () => {
  trip.items = [];
  addPoint([38.852, -94.343], 'Start');
  clearTimeout(routeTimer);
  genHoursEl.value = '3';
  document.getElementById('generate').click();
  await waitFor(() => /loops for about/.test(genStatusEl.textContent), 'loops to be generated', 120000);
  const routed = genOptions.filter(o => o.route);
  assert(routed.length >= 3 && routed.length <= 6, `${routed.length} routed loops`);
  routed.forEach(o => assert(o.route.seconds <= 3 * 3600 * 1.15 || o.items.length <= 2, 'trimmed to fit the time'));
  assert(genListEl.querySelector('.gen-opt.on'), 'best loop selected');
  trip.items = [];
  quietTripChange();
}, { network: true });
