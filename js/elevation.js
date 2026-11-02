// Elevation along a path, read from AWS Terrain Tiles in the browser (they allow cross-origin reads).
import { DEM_URL } from './config.js';
import { cumulative } from './geo.js';

const DEM_Z = 12;            // ~30 m per pixel here
const CLIMB_STEP_M = 3;      // ignore elevation wiggles smaller than this when totalling climb
const STEP_M = 60;           // read the height about this often along the road (up to MAX_READS)
const MAX_READS = 3000;
const SMOOTH = 2;            // and average each with this many either side (~±120 m): the terrain
                             // grid beside a road (a hillside, a road cut) isn't the road's own height
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

// Height at a world pixel (x, y), blended from the four pixels around it.
async function heightAt(x, y) {
  const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), fx = x - 0.5 - x0, fy = y - 0.5 - y0;
  const px = async (px, py) => {
    const tile = await demTile(Math.floor(px / 256), Math.floor(py / 256));
    return tile ? tile[(py % 256) * 256 + (px % 256)] : null;
  };
  const [a, b, c, d] = await Promise.all([px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1)]);
  if ([a, b, c, d].includes(null)) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

async function elevations(points) {
  const n = 256 * 2 ** DEM_Z;
  return Promise.all(points.map(([lat, lon]) =>
    heightAt((lon + 180) / 360 * n, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)));
}

// Each value averaged with up to k neighbours either side.
export function smooth(values, k = SMOOTH) {
  return values.map((_, i) => {
    const part = values.slice(Math.max(0, i - k), i + k + 1);
    return part.reduce((s, v) => s + v, 0) / part.length;
  });
}

// The total climb, ignoring wiggles smaller than CLIMB_STEP_M.
export function climbOf(elev) {
  let climb = 0, ref = elev[0];
  for (const e of elev) {
    if (Math.abs(e - ref) >= CLIMB_STEP_M) {
      if (e > ref) climb += e - ref;
      ref = e;
    }
  }
  return climb;
}

// `count` evenly spaced samples along the path with elevation in feet (for the chart), the total
// climb, and the range. Heights are read every STEP_M and smoothed first.
export async function profile(path, count = 400) {
  const cum = cumulative(path), total = cum[cum.length - 1];
  const n = Math.max(count, Math.min(MAX_READS, Math.round(total / STEP_M))), pts = [];
  for (let k = 0, i = 0; k <= n; k++) {
    const m = total * k / n;
    while (i < cum.length - 2 && cum[i + 1] < m) i++;
    const f = (m - cum[i]) / ((cum[i + 1] - cum[i]) || 1), a = path[i], b = path[i + 1] || a;
    pts.push({ m, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] });
  }
  const raw = await elevations(pts.map(s => s.p));
  if (raw.some(e => e == null)) return null;
  const elev = smooth(raw);
  const samples = Array.from({ length: count + 1 }, (_, k) => {
    const j = Math.round(k * n / count);
    return { ...pts[j], ft: elev[j] * 3.281 };
  });
  const ft = elev.map(e => e * 3.281);
  return { samples, climbFt: climbOf(elev) * 3.281, lo: Math.min(...ft), hi: Math.max(...ft), meters: total };
}
