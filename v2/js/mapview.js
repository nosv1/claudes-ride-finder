// The map: MapLibre with Esri raster basemaps, hillshade and 3D terrain from AWS Terrain Tiles,
// and GeoJSON sources for roads, the route, gas stations and blind crests. Everything here
// works in [lat, lon]; MapLibre's [lon, lat] stays inside this file.
/* global maplibregl */
import { CURVE_CLASSES, SPEED_BINS, FUEL_STATUS, SHIELD_TYPES, DEM_URL } from './config.js';
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
    all.push(['==', ['get', 'posted'], 1], ['in', ['get', 'sbin'], ['literal', [...f.speedBins]]]);
    if (f.zoom < 11) all.push(['==', ['get', 'minor'], 0]);
  } else {
    all.push(['in', ['get', 'cls'], ['literal', [...f.classes]]]);
    if (f.minHills > 0) all.push(['>=', ['get', 'hill'], f.minHills]);
    if (f.mode === 'ride') all.push(['>=', ['get', 'spd'], f.minSpeed]);
  }
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
          routeLabels: { type: 'geojson', data: EMPTY },
          preview: { type: 'geojson', data: EMPTY },
          fuel: { type: 'geojson', data: EMPTY },
          routeFuel: { type: 'geojson', data: EMPTY },
        },
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
          { id: 'roads-solid', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: {} },
          { id: 'roads-dashed', type: 'line', source: 'roads', layout: { 'line-join': 'round' }, paint: { 'line-dasharray': [2, 1.5] } },
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
          { id: 'blind', type: 'symbol', source: 'blind', minzoom: 11, layout: {
            'icon-image': 'blind', 'icon-size': 0.85, 'icon-allow-overlap': true, 'icon-pitch-alignment': 'viewport' } },
          { id: 'fuel', type: 'circle', source: 'fuel', minzoom: 9, layout: { visibility: 'none' }, paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7], 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5,
            'circle-color': ['match', ['get', 'status'], 2, FUEL_STATUS[2].color, 1, FUEL_STATUS[1].color, -1, FUEL_STATUS['-1'].color, FUEL_STATUS[0].color] } },
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
    });
    this.bindEvents();
  }

  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...args) { if (this.handlers[name]) this.handlers[name](...args); }

  // ---------- roads ----------

  setRoads(roads) {
    const features = roads.map(r => r.feature || (r.feature = line(r.geom, {
      i: r.id, cls: r.cls, spd: r.speed ?? -1, posted: r.mph != null ? 1 : 0, sbin: speedBin(r.mph), hill: r.hillLevel,
      surf: r.surface, minor: isMinor(r) ? 1 : 0, ...(r.ref && SHIELD_TYPES.has(r.hw) ? { ref: r.ref } : {}),
    })));
    this.map.getSource('roads').setData(fc(features));
    const crests = [];
    for (const r of roads) {
      for (const p of r.blind) crests.push(point(p, { i: r.id, cls: r.cls, spd: r.speed ?? -1, hill: r.hillLevel, surf: r.surface }));
    }
    this.map.getSource('blind').setData(fc(crests));
  }

  setFilters(f) {
    const base = roadFilter(f), curvyModes = f.mode !== 'speed';
    this.map.setFilter('roads-solid', ['all', base, ['!=', ['get', 'surf'], 2]]);
    this.map.setFilter('roads-dashed', ['all', base, ['==', ['get', 'surf'], 2]]);
    this.map.setFilter('shields', ['all', base, ['has', 'ref']]);
    this.map.setFilter('blind', curvyModes ? base : ['==', 1, 0]);
    this.map.setLayoutProperty('blind', 'visibility', f.showBlind ? 'visible' : 'none');
    const color = curvyModes
      ? ['match', ['get', 'cls'], ...CURVE_CLASSES.flatMap((c, i) => [i, c.color]), '#888']
      : ['match', ['get', 'sbin'], ...SPEED_BINS.flatMap((b, i) => [i, b.color]), '#888'];
    const width = curvyModes
      ? zoomWidth(['match', ['get', 'cls'], ...CURVE_CLASSES.flatMap((c, i) => [i, c.width]), 2.5])
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

  set3D(on) {
    this.map.setTerrain(on ? { source: 'dem', exaggeration: 1.5 } : null);
    this.map.easeTo({ pitch: on ? 60 : 0, bearing: on ? this.map.getBearing() : 0, duration: 800 });
  }

  // ---------- markers ----------

  // stops: [{ p, label, n, draggable }]
  setStops(stops, onDrag) {
    this.markers.forEach(m => m.remove());
    this.markers = stops.map(s => {
      const el = document.createElement('div');
      el.className = 'stop-marker';
      el.textContent = s.n;
      el.title = s.label;
      const m = new maplibregl.Marker({ element: el, draggable: s.draggable }).setLngLat(ll(s.p)).addTo(this.map);
      if (s.draggable) m.on('dragend', () => { const { lat, lng } = m.getLngLat(); onDrag(s.index, [lat, lng]); });
      return m;
    });
  }

  setPin(p) {
    if (!this.pin) {
      const el = document.createElement('div');
      el.className = 'search-pin';
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
