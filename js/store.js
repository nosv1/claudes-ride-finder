// Road data: the prebuilt tiles from build_tiles.py, loaded as script tags (each tile calls
// window.addTile), plus the gas station and search indexes.
import { DATA_URL } from './config.js';
import { decodeRow } from './roads.js';

export const store = {
  roads: [], byId: new Map(), version: 0, signals: null,
  index: null, available: new Set(), speedAvailable: new Set(), fuel: [], search: { places: [], roads: [] },
};

const tileState = new Map();   // "x_y" -> 'loading' | 'done' | 'failed'
const listeners = new Set();
let notifyTimer = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

window.addTile = (key, rows) => {
  for (const row of rows) {
    const r = decodeRow(row);
    if (store.byId.has(r.id)) continue;
    store.byId.set(r.id, r);
    store.roads.push(r);
  }
  tileState.set(key, 'done');
  store.version++;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => listeners.forEach(fn => fn()), 120);
};

export async function initData() {
  await Promise.all(['index.js', 'fuel.js', 'search.js'].map(f => loadScript(DATA_URL + f)));
  store.index = window.TILE_INDEX;
  store.available = new Set(store.index.tiles);
  store.speedAvailable = new Set(store.index.speed || []);
  store.fuel = (window.FUEL || []).map(([lat, lon, name, city, status, hours, oct]) => ({ lat, lon, name, city, status, hours, oct: oct ?? null }));
  store.search = window.SEARCH || store.search;
}

export const onRoadsChanged = fn => listeners.add(fn);

// Every traffic light (tiles/signals.js, ~1 MB), loaded the first time a route needs them. Until the file
// exists (it's built from the state files) there are none, and routes just don't count stoplights.
let signalsLoad = null;
export function loadSignals() {
  signalsLoad = signalsLoad || loadScript(DATA_URL + 'signals.js').then(() => {
    const d = window.SIGNALS || [], out = [];
    let lat = 0, lon = 0;
    for (let i = 0; i < d.length; i += 2) {
      lat += d[i]; lon += d[i + 1];
      out.push({ lat: lat / 1e5, lon: lon / 1e5 });
    }
    store.signals = out;
  }, () => { store.signals = []; });
  return signalsLoad;
}

// Load every tile overlapping bounds [s, w, n, e]: its curvy roads and ramps, and with speed,
// its roads kept only for their speed limit too (the bulk of the data, as "x_y.s").
export function loadTiles([s, w, n, e], { speed = false } = {}) {
  const size = store.index.size;
  for (let x = Math.floor(w / size); x <= Math.floor(e / size); x++) {
    for (let y = Math.floor(s / size); y <= Math.floor(n / size); y++) {
      const xy = `${x}_${y}`;
      for (const [key, has] of [[xy, store.available.has(xy)], [`${xy}.s`, speed && store.speedAvailable.has(xy)]]) {
        if (!has || tileState.has(key)) continue;
        tileState.set(key, 'loading');
        loadScript(`${DATA_URL}${key}.js`).catch(() => tileState.set(key, 'failed'));
      }
    }
  }
}

// Every tile a path passes through (with speed: their speed-only roads too).
export function loadTilesAlong(path, opts) {
  const size = store.index.size, seen = new Set();
  for (let i = 0; i < path.length; i += 5) {
    const [lat, lon] = path[i], x = Math.floor(lon / size), y = Math.floor(lat / size), k = `${x}_${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    loadTiles([y * size + 0.01, x * size + 0.01, (y + 1) * size - 0.01, (x + 1) * size - 0.01], opts);
  }
}

export const loadingCount = () => [...tileState.values()].filter(s => s === 'loading').length;

export function tilesSettled(timeout = 20000) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const check = () => loadingCount() && Date.now() - t0 < timeout ? setTimeout(check, 150) : resolve();
    check();
  });
}

// Where the data covers, as Photon's "w,s,e,n" box with a 1° margin.
export function coverageBox() {
  const size = store.index.size, xy = [...store.available].map(k => k.split('_').map(Number));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  return [Math.min(...xs) * size - 1, Math.min(...ys) * size - 1, (Math.max(...xs) + 1) * size + 1, (Math.max(...ys) + 1) * size + 1].join(',');
}
