// Geometry on [lat, lon] pairs. Pure: no DOM, no map library.

const RAD = Math.PI / 180;

export function distance(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const km = (a, b) => distance(a, b) / 1000;

// Squared flat distance in degrees, for comparing which point is nearer.
export function d2(a, b) {
  const dx = (a[1] - b[1]) * Math.cos(a[0] * RAD), dy = a[0] - b[0];
  return dx * dx + dy * dy;
}

export function bearing(a, b) {
  return (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) / RAD + 360) % 360;
}

// Angle of b relative to dir, in -180..180.
export const relAngle = (b, dir) => ((b - dir + 540) % 360) - 180;

export function decodeDeltas(deltas) {
  const pts = [];
  let lat = 0, lon = 0;
  for (let i = 0; i < deltas.length; i += 2) {
    lat += deltas[i];
    lon += deltas[i + 1];
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision, out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

// Bounds as [south, west, north, east].
export function boundsOf(points) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lon] of points) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return [s, w, n, e];
}
export const extend = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const pad = (b, deg) => [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];
export const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const contains = (b, p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
export const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

// The point on a polyline nearest `at`, and the direction the line runs there.
export function spotOnLine(geom, at) {
  const k = Math.cos(at[0] * RAD);
  let best = { p: geom[0], heading: 0 }, bd = Infinity;
  for (let i = 1; i < geom.length; i++) {
    const [a0, a1] = geom[i - 1], [b0, b1] = geom[i];
    const dx = (b1 - a1) * k, dy = b0 - a0, len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((at[1] - a1) * k * dx + (at[0] - a0) * dy) / len));
    const p = [a0 + (b0 - a0) * t, a1 + (b1 - a1) * t];
    const d = ((p[1] - at[1]) * k) ** 2 + (p[0] - at[0]) ** 2;
    if (d < bd) { bd = d; best = { p, heading: (Math.atan2(dx, dy) / RAD + 360) % 360 }; }
  }
  return best;
}

export function cumulative(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  return cum;
}

export function nearestIndex(path, p, from = 0) {
  let best = from, bd = Infinity;
  for (let i = from; i < path.length; i++) {
    const d = d2(p, path[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Points (with .lat/.lon) within maxM of the path, each with the mile it's passed at.
export function alongRoute(path, points, maxM, spacing) {
  const pts = [];
  let total = 0;
  path.forEach((p, i) => {
    if (!i) { pts.push({ lat: p[0], lon: p[1], m: 0 }); return; }
    const prev = path[i - 1], d = distance(prev, p), n = Math.ceil(d / spacing);
    for (let k = 1; k <= n; k++) {
      pts.push({ lat: prev[0] + (p[0] - prev[0]) * k / n, lon: prev[1] + (p[1] - prev[1]) * k / n, m: total + d * k / n });
    }
    total += d;
  });
  const CELL = 0.02, grid = new Map(), key = (la, lo) => `${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`;
  pts.forEach(p => {
    const k = key(p.lat, p.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  });
  const found = [];
  points.forEach(s => {
    let best = null, bd = maxM;
    const cy = Math.floor(s.lat / CELL), cx = Math.floor(s.lon / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const p of grid.get(`${cy + dy},${cx + dx}`) || []) {
        const d = distance([s.lat, s.lon], [p.lat, p.lon]);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (best) found.push({ item: s, mile: best.m / 1609.34 });
  });
  return { hits: found.sort((a, b) => a.mile - b.mile), totalMiles: total / 1609.34 };
}

export const miles = m => (m / 1609.34).toFixed(m < 1609.34 ? 2 : 1);

export function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
