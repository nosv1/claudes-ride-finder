// Routing: Valhalla's motorcycle profile, falling back to OSRM's plain fastest route.
import { ROUTING } from './config.js';
import { decodePolyline } from './geo.js';

async function fetchJson(url, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// The public server takes 10 locations per request, so longer trips go in overlapping chunks.
// useHighways: 1 fastest … 0 back roads only. Unless uTurns, the route may not turn around at a
// stop (Valhalla's break_through), so it doesn't ride back down a road it just finished.
async function valhalla(pts, useHighways, uTurns) {
  const result = { path: [], meters: 0, seconds: 0, maneuvers: [] };
  for (let i = 0; i < pts.length - 1; i += ROUTING.valhallaMax - 1) {
    const chunk = pts.slice(i, i + ROUTING.valhallaMax);
    const type = (via, j) => {
      if (via && j > 0 && j < chunk.length - 1) return 'through';
      const end = i + j === 0 || i + j === pts.length - 1;
      return end || uTurns ? 'break' : 'break_through';
    };
    const req = {
      locations: chunk.map(({ p, via }, j) => ({ lat: p[0], lon: p[1], type: type(via, j) })),
      costing: 'motorcycle',
      costing_options: { motorcycle: { use_highways: useHighways, use_trails: 0 } },
      units: 'miles',
    };
    const data = await fetchJson(`${ROUTING.valhalla}?json=${encodeURIComponent(JSON.stringify(req))}`, 30000);
    for (const leg of data.trip.legs) {
      const offset = result.path.length;
      for (const m of leg.maneuvers) {
        result.maneuvers.push({
          type: m.type, at: offset + m.begin_shape_index, end: offset + m.end_shape_index,
          km: m.length * 1.609, s: m.time, names: m.street_names || [],
        });
      }
      result.path.push(...decodePolyline(leg.shape));
    }
    result.meters += data.trip.summary.length * 1609.34;
    result.seconds += data.trip.summary.time;
  }
  return result;
}

async function osrm(pts) {
  const coords = pts.map(({ p }) => `${p[1]},${p[0]}`).join(';');
  const data = await fetchJson(`${ROUTING.osrm}/${coords}?overview=full&geometries=geojson`, 30000);
  const r = data.routes[0];
  return { path: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: r.distance, seconds: r.duration, fallback: true };
}

// Null if neither router answers. If Valhalla answers but finds no route without turning around
// at a stop (a dead end, say), it's asked again allowing that.
export async function fetchRoute(pts, useHighways) {
  try {
    try {
      return await valhalla(pts, useHighways, false);
    } catch (e) {
      if (!e.status) throw e;
      return await valhalla(pts, useHighways, true);
    }
  } catch (e) {
    console.warn('Valhalla failed, trying OSRM', e);
    try { return await osrm(pts); } catch (e2) { console.warn(e2); return null; }
  }
}

// Route numbers the router reports ("I 49 North", "US 50", "K-10", "MO Y", "FM 1431") → "I 49", "K 10"...
const ROUTE_REF = /^(I|US|MO|K|KS|TX|SH|FM|RM|RR)[ -]?(\d+[A-Z]?|[A-Z]{1,2})\b/;
export function routeRefs(maneuver) {
  return [...new Set(maneuver.names.map(n => (n.match(ROUTE_REF) || [])[0]).filter(Boolean).map(s => s.replace('-', ' ')))];
}
