// Elevation along a path, read from AWS Terrain Tiles in the browser (they allow cross-origin reads).
import { DEM_URL } from './config.js';
import { cumulative } from './geo.js';

const DEM_Z = 11;            // ~60 m per pixel here; plenty for a profile
const CLIMB_STEP_M = 3;      // ignore elevation wiggles smaller than this when totalling climb
const tiles = new Map();     // "x/y" -> Promise of elevations or null

function demTile(x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) tiles.set(key, new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data, out = new Float32Array(256 * 256);
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      resolve(out);
    };
    img.onerror = () => resolve(null);
    img.src = `${DEM_URL}/${DEM_Z}/${x}/${y}.png`;
  }));
  return tiles.get(key);
}

async function elevations(points) {
  const n = 256 * 2 ** DEM_Z;
  return Promise.all(points.map(async ([lat, lon]) => {
    const x = (lon + 180) / 360 * n, y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    const tile = await demTile(Math.floor(x / 256), Math.floor(y / 256));
    return tile ? tile[Math.floor(y % 256) * 256 + Math.floor(x % 256)] : null;
  }));
}

// Evenly spaced samples along the path with elevation in feet, total climb, and the range.
export async function profile(path, count = 400) {
  const cum = cumulative(path), total = cum[cum.length - 1], samples = [];
  for (let k = 0, i = 0; k <= count; k++) {
    const m = total * k / count;
    while (i < cum.length - 2 && cum[i + 1] < m) i++;
    const f = (m - cum[i]) / ((cum[i + 1] - cum[i]) || 1), a = path[i], b = path[i + 1] || a;
    samples.push({ m, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] });
  }
  const elev = await elevations(samples.map(s => s.p));
  if (elev.some(e => e == null)) return null;
  let climb = 0, ref = elev[0];
  for (const e of elev) {
    if (Math.abs(e - ref) >= CLIMB_STEP_M) {
      if (e > ref) climb += e - ref;
      ref = e;
    }
  }
  samples.forEach((s, i) => { s.ft = elev[i] * 3.281; });
  const ft = samples.map(s => s.ft);
  return { samples, climbFt: climb * 3.281, lo: Math.min(...ft), hi: Math.max(...ft), meters: total };
}
