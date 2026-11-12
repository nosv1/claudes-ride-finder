// Search: roads and towns from the built index (instant, offline), plus addresses and places
// from Photon. localResults is pure; photonResults fetches.
import { PHOTON } from './config.js';
import { km, miles } from './geo.js';

const ROUTE_WORDS = new Set(['highway', 'hwy', 'route', 'rte', 'rt', 'road', 'rd', 'state']);
const PLACE_RANK = { city: 0, town: 1, village: 2 };
const TOWN_RADIUS_KM = 30;

// "K-10", "k10" and "K 10" all become "k 10"; "Lee's" matches "lees".
export const normWords = s => s.toLowerCase().replace(/['’]/g, '').replace(/([a-z])(\d)/g, '$1 $2')
  .replace(/[-,.()]/g, ' ').split(/\s+/).filter(Boolean);

// Every query word must match a word in the text; short ones exactly, so "y" doesn't match "york".
export function matchesAll(qWords, text) {
  const words = normWords(text);
  return qWords.every(q => words.some(w => q.length <= 2 ? w === q : w.startsWith(q)));
}

// index: { places: [[name, lat, lon, kind]], roads: [[key, name, s, w, n, e, curveMetres, town]] }
// near: [lat, lon] (the map's center): roads close to it come first, so "hwy 7" from Kansas City is MO 7, not AR 7.
export function localResults(q, index, near = null) {
  let qw = normWords(q).filter(w => !ROUTE_WORDS.has(w));
  if (!qw.length) qw = normWords(q);
  if (!qw.length) return [];
  const found = index.roads.filter(r => matchesAll(qw, `${r[0]} ${r[1]} ${r[7]}`));
  // "MO Y camdenton": the last word(s) may be a town, meaning roads near it.
  for (let k = 1; k < qw.length && found.length < 6; k++) {
    const roadWords = qw.slice(0, -k), townWords = qw.slice(-k);
    for (const t of index.places.filter(p => matchesAll(townWords, p[0])).slice(0, 5)) {
      for (const r of index.roads) {
        if (!found.includes(r) && matchesAll(roadWords, `${r[0]} ${r[1]}`) &&
            km([t[1], t[2]], [(r[2] + r[4]) / 2, (r[3] + r[5]) / 2]) < TOWN_RADIUS_KM) found.push(r);
      }
    }
  }
  // Curvy miles, worth a fifth at 160 km away and a twenty-fifth at 400.
  const rank = r => r[6] / (near ? 1 + (km(near, [(r[2] + r[4]) / 2, (r[3] + r[5]) / 2]) / 80) ** 2 : 1);
  const roads = found.sort((a, b) => rank(b) - rank(a)).slice(0, 6).map(([key, name, s, w, n, e, curves, town]) => ({
    kind: 'road', key, label: key + (name ? ` · ${name}` : ''),
    sub: `${town ? `near ${town} · ` : ''}${miles(curves)} mi of curves`, bounds: [s, w, n, e],
  }));
  // Towns: the nearest first (a city counts as nearer than a village the same distance away), so "greenwood" from
  // Kansas City is Greenwood, Missouri, not Arkansas; with no map to go by, cities first.
  const away = p => km(near, [p[1], p[2]]) * (1 + PLACE_RANK[p[3]] * 0.5);
  const places = index.places.filter(p => matchesAll(qw, p[0]))
    .sort((a, b) => near ? away(a) - away(b) : PLACE_RANK[a[3]] - PLACE_RANK[b[3]] || a[0].length - b[0].length).slice(0, 4)
    .map(([name, lat, lon, kind]) => ({ kind: 'town', label: name, sub: kind[0].toUpperCase() + kind.slice(1), at: [lat, lon] }));
  // Route-looking queries ("150", "mo y") list roads first; names list towns first.
  return qw.some(w => /\d/.test(w) || w.length <= 2) ? [...roads, ...places] : [...places, ...roads];
}

// near: [lat, lon] to bias toward; bbox: "w,s,e,n" to stay inside the covered area.
export async function photonResults(q, near, bbox, signal) {
  const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=5&lat=${near[0].toFixed(3)}&lon=${near[1].toFixed(3)}` +
    (bbox ? `&bbox=${bbox}` : '');
  const res = await fetch(url, { signal });
  const data = await res.json();
  return data.features.map(f => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    return {
      kind: 'place', label: p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || 'Place',
      sub: [p.street && p.name ? p.street : '', p.city, p.state].filter(Boolean).join(', '), at: [lat, lon],
    };
  });
}
