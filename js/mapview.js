// The map: MapLibre with Esri raster basemaps, hillshade and 3D terrain from AWS Terrain Tiles,
// and GeoJSON sources for roads, the route, gas stations and blind crests. Everything here
// works in [lat, lon]; MapLibre's [lon, lat] stays inside this file.
/* global maplibregl */
import { CURVE_CLASSES, SPEED_BINS, FUEL_STATUS, SHIELD_TYPES, DEM_URL, RAMP_TIERS, TERRAIN, HIGHWAYS, ROLLER, tiersFor } from './config.js';
import { speedBin, isMinor } from './roads.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const raster = (service, maxzoom, attribution) => ({
  type: 'raster', tiles: [`${ESRI}${service}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom, ...(attribution ? { attribution } : {}),
});
const EMPTY = { type: 'FeatureCollection', features: [] };
const ll = ([lat, lon]) => [lon, lat];
const line = (geom, properties = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: geom.map(ll) }, properties });
const point = (p, properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(p) }, properties });
const fc = features => ({ type: 'FeatureCollection', features });

const ROAD_LAYERS = ['roads-solid', 'roads-dashed'];
const zoomWidth = base => ['interpolate', ['linear'], ['zoom'], 7, ['*', base, 0.45], 12, base, 16, ['*', base, 2.2]];

// Mirrors roads.visible() as a MapLibre filter.
function roadFilter(f) {
  const all = ['all'];
  if (f.hideUnpaved) all.push(['!=', ['get', 'surf'], 1]);
  if (f.mode === 'speed') {
    all.push(['==', ['get', 'posted'], 1], ['!=', ['get', 'hwy'], 1], ['in', ['get', 'sbin'], ['literal', [...f.speedBins]]]);
    if (f.zoom < 11) all.push(['==', ['get', 'minor'], 0]);
    return all;
  }
  const highways = ['in', ['get', 'rt'], ['literal', tiersFor(f.roadType, f.rampTiers)]];
  const classes = ['in', ['get', 'cls'], ['literal', [...f.classes]]];
  const curvy = ['all', f.rollers ? ['any', classes, ['==', ['get', 'rc'], 1]] : classes];
  if (f.minHills > 0) curvy.push(['>=', ['get', 'hill'], f.minHills]);
  if (f.mode === 'ride') curvy.push(['>=', ['get', 'spd'], f.minSpeed]);
  all.push(f.roadType === 'highway' ? highways : f.roadType === 'back' ? curvy : ['any', highways, curvy]);
  return all;
}

// Small images drawn on a canvas: road shields and the blind-crest warning.
function canvasImage(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  return c.getContext('2d').getImageData(0, 0, w, h);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function shieldImage(border) {
  return canvasImage(48, 32, ctx => {
    roundRect(ctx, 2, 2, 44, 28, 7);
    ctx.fillStyle = '#f1f3f5'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = border; ctx.stroke();
  });
}
const SHIELD_OPTS = { pixelRatio: 2, stretchX: [[14, 34]], stretchY: [[12, 20]], content: [8, 6, 40, 26] };
const blindImage = () => canvasImage(40, 36, ctx => {
  ctx.beginPath(); ctx.moveTo(20, 2); ctx.lineTo(38, 34); ctx.lineTo(2, 34); ctx.closePath();
  ctx.fillStyle = '#111'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(20, 8); ctx.lineTo(33, 31); ctx.lineTo(7, 31); ctx.closePath();
  ctx.fillStyle = '#ffd43b'; ctx.fill();
  ctx.fillStyle = '#111'; ctx.fillRect(18.5, 15, 3, 9); ctx.fillRect(18.5, 26, 3, 3);
});
// A chevron pointing along the line (east is "forward" for line-placed icons).
const arrowImage = () => canvasImage(24, 24, ctx => {
  ctx.beginPath(); ctx.moveTo(8, 5); ctx.lineTo(16, 12); ctx.lineTo(8, 19);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = 6; ctx.strokeStyle = '#0b1d33'; ctx.stroke();
  ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
});
// A stoplight: red, yellow and green in a dark box. Where the route turns left at it, an orange ring.
const lightImage = left => canvasImage(28, 44, ctx => {
  if (left) { roundRect(ctx, 1, 1, 26, 42, 8); ctx.fillStyle = '#ff922b'; ctx.fill(); }
  roundRect(ctx, 5, 5, 18, 34, 5);
  ctx.fillStyle = '#111'; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  ['#ff6b6b', '#ffd43b', '#51cf66'].forEach((c, i) => {
    ctx.beginPath(); ctx.arc(14, 12 + i * 10, 3.6, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.fill();
  });
});

export class MapView {
  constructor(container, { center, zoom, insets }) {
    this.insets = insets;   // () => { top, right, bottom, left } in px, the parts covered by the UI
    this.handlers = {};
    this.markers = [];
    this.map = new maplibregl.Map({
      container, center: ll(center), zoom, maxPitch: 75, attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
          dark: raster('Canvas/World_Dark_Gray_Base', 16, 'Basemap © Esri'),
          darkLabels: raster('Canvas/World_Dark_Gray_Reference', 16),
          sat: raster('World_Imagery', 18, 'Imagery © Esri'),
          satLabels: raster('Reference/World_Boundaries_and_Places', 18),
          dem: { type: 'raster-dem', tiles: [`${DEM_URL}/{z}/{x}/{y}.png`], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Terrain: AWS Terrain Tiles' },
          roads: { type: 'geojson', data: EMPTY, attribution: 'Roads © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Routing FOSSGIS Valhalla' },
          blind: { type: 'geojson', data: EMPTY },
          route: { type: 'geojson', data: EMPTY },
          retrace: { type: 'geojson', data: EMPTY },
          lights: { type: 'geojson', data: EMPTY },
          routeLabels: { type: 'geojson', data: EMPTY },
          preview: { type: 'geojson', data: EMPTY },
          focus: { type: 'geojson', data: EMPTY },
          fuel: { type: 'geojson', data: EMPTY },
          routeFuel: { type: 'geojson', data: EMPTY },
          rider: { type: 'geojson', data: EMPTY },
        },
        // Only seen when tilted: a hazy horizon instead of black.
        sky: { 'sky-color': '#3d5a80', 'horizon-color': '#9db4c8', 'fog-color': '#6f8296',
          'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0 },
        layers: [
          { id: 'dark', type: 'raster', source: 'dark' },
          { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
          { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
            'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': 'rgba(0,0,0,0.55)',
            'hillshade-highlight-color': 'rgba(255,255,255,0.22)', 'hillshade-accent-color': 'rgba(0,0,0,0.3)' } },
          { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#0b1d33', 'line-opacity': 0.75, 'line-width': zoomWidth(13) } },
          { id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#4dabf7', 'line-opacity': 0.6, 'line-width': zoomWidth(8) } },
          { id: 'trip-roads', type: 'line', source: 'roads', filter: ['in', ['get', 'i'], ['literal', []]],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#4dabf7', 'line-opacity': 0.55, 'line-width': zoomWidth(12), 'line-blur': 2 } },
          { id: 'highlight', type: 'line', source: 'roads', filter: ['in', ['get', 'i'], ['literal', []]],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#ffffff', 'line-opacity': 0.85, 'line-width': zoomWidth(12), 'line-blur': 1 } },
          // Parts of the route lit up from the ride's summary (a tag, the bar, a road in the list).
          { id: 'focus', type: 'line', source: 'focus', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': zoomWidth(14), 'line-blur': 1 } },
          { id: 'roads-solid', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {} },
          { id: 'roads-dashed', type: 'line', source: 'roads', layout: { 'line-join': 'round' }, paint: { 'line-dasharray': [2, 1.5] } },
          { id: 'retrace', type: 'line', source: 'retrace', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#ff922b', 'line-opacity': 0.9, 'line-width': zoomWidth(6), 'line-dasharray': [1.2, 1] } },
          { id: 'route-arrows', type: 'symbol', source: 'route', minzoom: 10, layout: {
            'symbol-placement': 'line', 'symbol-spacing': 110, 'icon-image': 'arrow', 'icon-size': 0.75,
            'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' } },
          { id: 'preview', type: 'line', source: 'preview', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-dasharray': [2, 1.5] } },
          { id: 'darkLabels', type: 'raster', source: 'darkLabels' },
          { id: 'satLabels', type: 'raster', source: 'satLabels', layout: { visibility: 'none' } },
          { id: 'shields', type: 'symbol', source: 'roads', minzoom: 9, layout: {
            'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['get', 'ref'], 'text-font': ['Noto Sans Bold'],
            'text-size': 10, 'icon-image': 'shield', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 3, 1, 3],
            'text-rotation-alignment': 'viewport', 'icon-rotation-alignment': 'viewport', 'text-pitch-alignment': 'viewport',
            'icon-pitch-alignment': 'viewport' }, paint: { 'text-color': '#111' } },
          { id: 'route-shields', type: 'symbol', source: 'routeLabels', layout: {
            'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['get', 'ref'], 'text-font': ['Noto Sans Bold'],
            'text-size': 10, 'icon-image': 'shield-route', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 3, 1, 3],
            'text-rotation-alignment': 'viewport', 'icon-rotation-alignment': 'viewport', 'text-pitch-alignment': 'viewport',
            'icon-pitch-alignment': 'viewport' }, paint: { 'text-color': '#111' } },
          { id: 'lights', type: 'symbol', source: 'lights', minzoom: 10, layout: {
            'icon-image': ['case', ['get', 'left'], 'light-left', 'light'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 0.9],
            'icon-allow-overlap': true, 'icon-pitch-alignment': 'viewport', 'symbol-sort-key': ['case', ['get', 'left'], 1, 0] } },
          { id: 'blind', type: 'symbol', source: 'blind', minzoom: 11, layout: {
            'icon-image': 'blind', 'icon-size': 0.85, 'icon-allow-overlap': true, 'icon-pitch-alignment': 'viewport' } },
          { id: 'fuel', type: 'circle', source: 'fuel', minzoom: 9, layout: { visibility: 'none' }, paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7], 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5,
            'circle-color': ['match', ['get', 'status'], 2, FUEL_STATUS[2].color, 1, FUEL_STATUS[1].color, -1, FUEL_STATUS['-1'].color, FUEL_STATUS[0].color] } },
          // The rider in a fly-through: placed on the ground (so it stays on the road in 3D), but
          // facing the camera, so it doesn't flatten to a sliver when tilted.
          { id: 'rider', type: 'circle', source: 'rider', paint: { 'circle-radius': 9, 'circle-color': '#1c7ed6',
            'circle-stroke-color': '#fff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'viewport' } },
          { id: 'route-fuel', type: 'circle', source: 'routeFuel', paint: {
            'circle-radius': ['case', ['get', 'pick'], 8, 5], 'circle-stroke-color': ['case', ['get', 'pick'], '#fff', '#111'],
            'circle-stroke-width': ['case', ['get', 'pick'], 2.5, 1.5],
            'circle-color': ['match', ['get', 'status'], 2, FUEL_STATUS[2].color, 1, FUEL_STATUS[1].color, -1, FUEL_STATUS['-1'].color, FUEL_STATUS[0].color] } },
        ],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showZoom: false, visualizePitch: true }), 'bottom-right');
    // Ready once the style is in. Not 'load': that waits for every first tile, which on a slow
    // connection (or headless test browser) can take a long time or never come.
    // (No event reliably fires at the moment the style finishes, so poll briefly.)
    this.ready = new Promise(resolve => {
      const timer = setInterval(() => {
        if (!this.map.isStyleLoaded()) return;
        clearInterval(timer);
        resolve();
      }, 50);
    });
    this.ready.then(() => {
      this.map.addImage('shield', shieldImage('#222'), SHIELD_OPTS);
      this.map.addImage('shield-route', shieldImage('#1c7ed6'), SHIELD_OPTS);
      this.map.addImage('blind', blindImage(), { pixelRatio: 2 });
      this.map.addImage('arrow', arrowImage(), { pixelRatio: 2 });
      this.map.addImage('light', lightImage(false), { pixelRatio: 2 });
      this.map.addImage('light-left', lightImage(true), { pixelRatio: 2 });
    });
    this.bindEvents();
  }

  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...args) { if (this.handlers[name]) this.handlers[name](...args); }

  // ---------- roads ----------

  setRoads(roads) {
    const features = roads.map(r => r.feature || (r.feature = line(r.geom, {
      i: r.id, cls: r.cls, spd: r.speed ?? -1, posted: r.mph != null ? 1 : 0, sbin: speedBin(r.mph), hill: r.hillLevel,
      surf: r.surface, minor: isMinor(r) ? 1 : 0, rt: r.rampTier, hwy: r.highway ? 1 : 0, rc: r.roller ? 1 : 0, ...(r.ref && SHIELD_TYPES.has(r.hw) ? { ref: r.ref } : {}),
    })));
    this.map.getSource('roads').setData(fc(features));
    const crests = [];
    for (const r of roads) {
      for (const p of r.blind) crests.push(point(p, { i: r.id, cls: r.cls, spd: r.speed ?? -1, hill: r.hillLevel, surf: r.surface }));
    }
    this.map.getSource('blind').setData(fc(crests));
  }

  setFilters(f) {
    const base = roadFilter(f), curvyModes = f.mode === 'ride' || f.mode === 'curvy';
    this.map.setFilter('roads-solid', ['all', base, ['!=', ['get', 'surf'], 2]]);
    this.map.setFilter('roads-dashed', ['all', base, ['==', ['get', 'surf'], 2]]);
    this.map.setFilter('shields', ['all', base, ['has', 'ref']]);
    this.map.setFilter('blind', curvyModes ? base : ['==', 1, 0]);
    this.map.setLayoutProperty('blind', 'visibility', f.showBlind ? 'visible' : 'none');
    // Highways and ramps: by tier in Highways, one color next to the curvy roads in All.
    const highway = ['>=', ['get', 'rt'], 0];
    const tierColor = f.roadType === 'highway' ? ['match', ['get', 'rt'], ...RAMP_TIERS.flatMap((t, i) => [i, t.color]), '#888'] : HIGHWAYS.color;
    const color = curvyModes ? ['case', highway, tierColor, ['==', ['get', 'rc'], 1], ROLLER.color, ['match', ['get', 'cls'], ...CURVE_CLASSES.flatMap((c, i) => [i, c.color]), '#888']]
      : ['match', ['get', 'sbin'], ...SPEED_BINS.flatMap((b, i) => [i, b.color]), '#888'];
    const width = curvyModes ? zoomWidth(['case', highway, f.roadType === 'highway' ? 4 : 3, ['match', ['get', 'cls'], ...CURVE_CLASSES.flatMap((c, i) => [i, c.width]), 2.5]])
      : zoomWidth(['case', ['==', ['get', 'minor'], 1], 2, 3]);
    for (const id of ROAD_LAYERS) {
      this.map.setPaintProperty(id, 'line-color', color);
      this.map.setPaintProperty(id, 'line-width', width);
    }
  }

  highlight(ids) { this.map.setFilter('highlight', ['in', ['get', 'i'], ['literal', ids || []]]); }
  showTripRoads(ids) { this.map.setFilter('trip-roads', ['in', ['get', 'i'], ['literal', ids]]); }

  // ---------- route & overlays ----------

  setRoute(route, labels) {
    this.map.getSource('route').setData(route ? fc([line(route.path)]) : EMPTY);
    this.map.getSource('routeLabels').setData(fc((labels || []).map(l => line(l.geom, { ref: l.ref }))));
  }
  // Where the route rides a road a second time.
  setRetrace(lines) { this.map.getSource('retrace').setData(fc((lines || []).map(l => line(l)))); }
  // The stoplights on the route: [{ p, turn }].
  setLights(lights) { this.map.getSource('lights').setData(fc((lights || []).map(l => point(l.p, { left: l.turn === 'left' })))); }
  setFocus(paths) {
    const src = this.map.getSource('focus');  // not there until the style has loaded
    if (src) src.setData(paths && paths.length ? fc(paths.map(p => line(p))) : EMPTY);
  }
  setPreview(path) { this.map.getSource('preview').setData(path ? fc([line(path)]) : EMPTY); }

  setStations(stations) {
    this.stationsRef = stations;
    this.map.getSource('fuel').setData(fc(stations.map((s, k) => point([s.lat, s.lon], { k, status: s.status }))));
  }
  showStations(on) { this.map.setLayoutProperty('fuel', 'visibility', on ? 'visible' : 'none'); }
  setRouteStations(list) {
    this.map.getSource('routeFuel').setData(fc(list.map(({ k, status, pick }) => {
      const s = this.stationsRef[k];
      return point([s.lat, s.lon], { k, status, pick });
    })));
  }

  setBasemap(name) {
    const sat = name === 'satellite';
    for (const [id, show] of [['dark', !sat], ['darkLabels', !sat], ['sat', sat], ['satLabels', sat]]) {
      this.map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    }
  }
  showHillshade(on) { this.map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none'); }

  // Taller than life, and free to tilt nearly to the horizon, so it looks the way it rides.
  set3D(on) {
    this.map.setTerrain(on ? { source: 'dem', exaggeration: TERRAIN.exaggeration } : null);
    if (on) this.map.setMaxPitch(TERRAIN.maxPitch);
    this.map.easeTo({ pitch: on ? TERRAIN.pitch : 0, bearing: on ? this.map.getBearing() : 0, duration: 800 });
    if (!on) this.map.once('moveend', () => this.map.setMaxPitch(60));
  }

  // ---------- markers ----------

  // stops: [{ p, label, n, draggable, index }]. Tapping one (not dragging it) emits 'stop' with its index.
  // Stop pins. With a mouse, drag one; on a touchscreen, press and hold to pick it up (it lifts above the finger,
  // like the text cursor), then drag. A quick swipe over a pin still pans the map. onDrop(index, [lat, lon]).
  setStops(stops, onDrop) {
    this.markers.forEach(m => m.remove());
    this.markers = stops.map(s => {
      const el = document.createElement('div');
      el.className = 'stop-marker';
      el.textContent = s.n;
      el.title = s.label;
      const m = new maplibregl.Marker({ element: el }).setLngLat(ll(s.p)).addTo(this.map);
      let press = null, dragged = false;
      const box = () => this.map.getContainer().getBoundingClientRect();
      const lift = () => {
        press.lifted = true;
        el.classList.add('lifted');
        this.map.dragPan.disable();
        if (navigator.vibrate) navigator.vibrate(15);
      };
      const end = drop => {
        clearTimeout(press.timer);
        if (press.lifted) {
          el.classList.remove('lifted');
          this.map.dragPan.enable();
          dragged = true;
          setTimeout(() => { dragged = false; }, 0);  // the click that follows the drop isn't a tap
          if (drop) { const { lat, lng } = m.getLngLat(); onDrop(s.index, [lat, lng]); } else m.setLngLat(ll(s.p));
        }
        press = null;
      };
      el.addEventListener('pointerdown', e => {
        if (!e.isPrimary || e.button > 0) return;
        const touch = e.pointerType !== 'mouse';
        press = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, lifted: false };
        el.setPointerCapture(e.pointerId);
        if (touch) press.timer = setTimeout(() => press && lift(), 350);
        else e.stopPropagation();  // a mouse drag on a pin moves the pin, not the map
      });
      el.addEventListener('pointermove', e => {
        if (!press || e.pointerId !== press.id) return;
        const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
        if (!press.lifted) {
          if (press.touch) { if (moved > 10) end(false); return; }  // a swipe: let the map pan
          if (moved < 4) return;
          lift();
        }
        const b = box(), up = press.touch ? 44 : 0;  // above the finger, so it can be seen
        const { lat, lng } = this.map.unproject([e.clientX - b.left, e.clientY - b.top - up]);
        m.setLngLat([lng, lat]);
      });
      el.addEventListener('pointerup', e => { if (press && e.pointerId === press.id) end(true); });
      el.addEventListener('pointercancel', e => { if (press && e.pointerId === press.id) end(false); });
      el.addEventListener('mousedown', e => e.stopPropagation());  // the map pans on mousedown, not pointerdown
      el.addEventListener('contextmenu', e => e.preventDefault());  // a long press isn't a right-click
      el.addEventListener('click', e => { e.stopPropagation(); if (!dragged) this.emit('stop', s.index); });
      return m;
    });
  }

  setRider(p) { this.map.getSource('rider').setData(p ? fc([point(p)]) : EMPTY); }
  // Route numbers and arrows along the road crowd a low 3D view (a fly-through names the road itself).
  showRoadMarks(on) {
    for (const id of ['shields', 'route-shields', 'route-arrows']) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // A tag standing over a spot on the map (the next turn in a fly-through), on a stem.
  setTurnTag(p, text, arrow) {
    if (!p) { if (this.turnTag) this.turnTag.remove(); return; }
    if (!this.turnTag) {
      const el = document.createElement('div');
      el.className = 'turn-tag';
      const tag = document.createElement('span');
      tag.append(document.createElement('b'), document.createElement('span'));
      el.append(tag);
      this.turnTag = new maplibregl.Marker({ element: el, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' });
    }
    const [a, t] = this.turnTag.getElement().firstChild.children;
    a.textContent = arrow || '';
    t.textContent = text;
    this.turnTag.setLngLat(ll(p)).addTo(this.map);
  }

  // A little tag where the map was tapped (a road's speed limit). Null hides it.
  setTapTag(p, text) {
    if (!p) { if (this.tapTag) this.tapTag.remove(); return; }
    if (!this.tapTag) {
      const el = document.createElement('div');
      el.className = 'tap-tag';
      el.append(document.createElement('span'));
      this.tapTag = new maplibregl.Marker({ element: el, anchor: 'bottom', pitchAlignment: 'viewport', rotationAlignment: 'viewport' });
    }
    this.tapTag.getElement().firstChild.textContent = text;
    this.tapTag.setLngLat(ll(p)).addTo(this.map);
  }

  // The searched-for place. Tapping it emits 'pin'.
  setPin(p) {
    if (!this.pin) {
      const el = document.createElement('div');
      el.className = 'search-pin';
      el.title = 'Tap for this place';
      el.addEventListener('click', e => { e.stopPropagation(); this.emit('pin'); });
      this.pin = new maplibregl.Marker({ element: el });
    }
    p ? this.pin.setLngLat(ll(p)).addTo(this.map) : this.pin.remove();
  }

  setDot(p) {
    if (!this.dot) {
      const el = document.createElement('div');
      el.className = 'profile-dot';
      this.dot = new maplibregl.Marker({ element: el });
    }
    p ? this.dot.setLngLat(ll(p)).addTo(this.map) : this.dot.remove();
  }

  // ---------- camera ----------

  view() {
    const b = this.map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  }
  center() { const c = this.map.getCenter(); return [c.lat, c.lng]; }
  zoom() { return this.map.getZoom(); }

  // Keep the map centred on the part not covered by the UI; fits and flights work within it.
  updateInsets() { this.map.setPadding(this.insets()); }
  fit([s, w, n, e], maxZoom = 13) {
    this.map.fitBounds([[w, s], [e, n]], { padding: 30, maxZoom, duration: 700 });
  }
  flyTo(p, zoom) {
    this.map.easeTo({ center: ll(p), zoom, duration: 700 });
  }

  // ---------- input ----------

  bindEvents() {
    const map = this.map, box = (pt, r) => [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
    const roadAt = (pt, r) => {
      const hits = map.queryRenderedFeatures(box(pt, r), { layers: ROAD_LAYERS });
      return hits.length ? hits[0].properties.i : null;
    };

    map.on('click', e => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      const fuel = map.queryRenderedFeatures(box(e.point, 8), { layers: ['route-fuel', 'fuel'] });
      if (fuel.length) return this.emit('station', fuel[0].properties.k);
      const id = roadAt(e.point, 10);
      if (id != null) return this.emit('road', id, [e.lngLat.lat, e.lngLat.lng]);
      this.emit('empty', [e.lngLat.lat, e.lngLat.lng]);
    });

    if (matchMedia('(hover: hover)').matches) {
      let last = null;
      map.on('mousemove', e => {
        const id = roadAt(e.point, 5);
        map.getCanvas().style.cursor = id != null || map.queryRenderedFeatures(box(e.point, 6), { layers: ['fuel', 'route-fuel'] }).length ? 'pointer' : '';
        if (id !== last) { last = id; this.emit('hover', id); }
      });
    }

    // Long-press (touch) or right-click: a menu for this spot.
    map.on('contextmenu', e => this.emit('menu', [e.lngLat.lat, e.lngLat.lng], e.point));
    let timer = null, start = null;
    map.on('touchstart', e => {
      if (e.originalEvent.touches.length !== 1) return;
      start = e.point;
      timer = setTimeout(() => { this.suppressClick = true; this.emit('menu', [e.lngLat.lat, e.lngLat.lng], e.point); }, 550);
    });
    const cancel = e => { if (!e || !start || Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) clearTimeout(timer); };
    map.on('touchmove', cancel);
    map.on('touchend', () => clearTimeout(timer));
    map.on('movestart', () => clearTimeout(timer));
    map.on('moveend', () => this.emit('move'));
  }
}
