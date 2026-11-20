// Routing: Valhalla's motorcycle profile (the public server, then Stadia Maps), falling back to OSRM's plain fastest route.
import { ROUTING } from './config.js';
import { decodePolyline } from './geo.js';
import { check } from './check.js';
import { countUse } from './usage.js';

// A busy server can answer with an HTML error page, so the status counts even when the body isn't JSON.
async function fetchJson(url, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Why the last route failed: 'offline', 'busy' (too many requests, overloaded or too slow to answer) or 'down'.
let trouble = null;
const BUSY = new Set([429, 502, 503, 504]);
const kindOf = e => globalThis.navigator?.onLine === false ? 'offline' : e.name === 'AbortError' || BUSY.has(e.status) ? 'busy' : 'down';

// What to tell the rider when no route came back.
export function routerTrouble() {
  if (trouble === 'offline') return 'You’re offline. Planning a route needs signal; the map and roads you’ve looked at still work.';
  if (trouble === 'busy') return 'The free route servers are busy right now (they’re shared by everyone who uses them). Give it a minute and try again.';
  return 'Couldn’t reach the routing servers. Try again in a minute.';
}

// Answers by request, so trying a change to one stop of a long trip (the loop generator does, a lot)
// re-asks only for the chunks it changes. The last 100.
const answers = new Map();
async function cachedJson(url, ms) {
  if (!answers.has(url)) {
    answers.set(url, fetchJson(url, ms).catch(e => { answers.delete(url); throw e; }));
    if (answers.size > 100) answers.delete(answers.keys().next().value);
  }
  return answers.get(url);
}

// The public server takes 10 locations per request, so longer trips go in overlapping chunks.
// useHighways: 1 fastest … 0 back roads only. Unless uTurns, the route may not turn around at a
// stop (Valhalla's break_through), so it doesn't ride back down a road it just finished.
async function valhalla(url, pts, useHighways, uTurns) {
  const result = { path: [], meters: 0, seconds: 0, maneuvers: [] };
  for (let i = 0; i < pts.length - 1; i += ROUTING.valhallaMax - 1) {
    const chunk = pts.slice(i, i + ROUTING.valhallaMax);
    const type = (via, j) => {
      if (via && j > 0 && j < chunk.length - 1) return 'through';
      const end = i + j === 0 || i + j === pts.length - 1;
      return end || uTurns ? 'break' : 'break_through';
    };
    const req = {
      // A pin snaps to a street, not the driveway or parking lot nearest it (the route would
      // turn in and out). Through points are on our roads already.
      // A heading (riding, re-routed from where you are) starts the route the way you're going, not with a U-turn.
      locations: chunk.map(({ p, via, heading }, j) => ({ lat: p[0], lon: p[1], type: type(via, j),
        ...(via ? {} : { search_filter: { min_road_class: 'residential' } }),
        ...(heading != null ? { heading: Math.round(heading), heading_tolerance: 60 } : {}) })),
      costing: 'motorcycle',
      costing_options: { motorcycle: { use_highways: useHighways, use_trails: 0 } },
      units: 'miles',
    };
    const data = await cachedJson(`${url}?json=${encodeURIComponent(JSON.stringify(req))}`, 30000);
    for (const leg of data.trip.legs) {
      const offset = result.path.length;
      for (const m of leg.maneuvers) {
        result.maneuvers.push({
          type: m.type, at: offset + m.begin_shape_index, end: offset + m.end_shape_index,
          km: m.length * 1.609, s: m.time, names: m.street_names || [], text: m.instruction || '',
          // What Ride mode says: a heads-up a way off, and the call as the turn comes up.
          alert: m.verbal_transition_alert_instruction || '', pre: m.verbal_pre_transition_instruction || '',
          exit: m.roundabout_exit_count || 0,  // which exit off a roundabout
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

// Valhalla servers that were busy or down lately: server url → when to ask it again. One entry a server at most.
const resting = new Map();

// Forget which servers were busy or down (for the tests).
export function resetRouters() {
  resting.clear();
}

// One Valhalla server's route. If it finds none without turning around at a stop (a dead end, say: it says so with a
// 400), it's asked again allowing that. Not when it's busy: asking again would only add to the load.
async function valhallaRoute(url, pts, useHighways) {
  try {
    return await valhalla(url, pts, useHighways, false);
  } catch (e) {
    if (e.status !== 400) throw e;
    return await valhalla(url, pts, useHighways, true);
  }
}

// Null if no router answers. Each Valhalla server in turn, skipping one that was busy or down in the last restMs, then
// OSRM. A server that finds no route (400) isn't the trouble, and the next would say the same: straight to OSRM.
export async function fetchRoute(pts, useHighways) {
  if (!check(Array.isArray(pts) && pts.length >= 2, 'a route has at least two points')) return null;
  let failed = null;
  for (const { name, use, url } of ROUTING.valhallas) {
    if ((resting.get(url) ?? 0) > Date.now()) continue;
    try {
      const r = await valhallaRoute(url, pts, useHighways);
      resting.delete(url);
      countUse(use);
      return r;
    } catch (e) {
      console.warn(`Valhalla (${name}) failed`, e);
      failed ??= e;
      if (e.status === 400) break;
      resting.set(url, Date.now() + ROUTING.restMs);
    }
  }
  try {
    const r = await osrm(pts);
    countUse('route-osrm');
    return r;
  } catch (e) {
    console.warn('OSRM failed too', e);
    // Valhalla is the one that matters (OSRM is only a stopgap). Every server resting counts as busy.
    trouble = failed ? kindOf(failed) : 'busy';
    countUse('route-none');
    return null;
  }
}

// Route numbers the router reports ("I 49 North", "US 50", "K-10", "MO Y", "FM 1431") → "I 49", "K 10"...
const ROUTE_REF = /^(I|US|MO|K|KS|TX|SH|FM|RM|RR)[ -]?(\d+[A-Z]?|[A-Z]{1,2})\b/;
export function routeRefs(maneuver) {
  return [...new Set(maneuver.names.map(n => (n.match(ROUTE_REF) || [])[0]).filter(Boolean).map(s => s.replace('-', ' ')))];
}
