// Your own tags on roads ("Rough", "Don't ride"), kept on this device and in your account if you sign in. One
// record per stretch tagged: { key: its name, tags: [TAGS keys], note, mph?, at: ms, pieces: [{ id: OSM way id, g: [[lat, lon]…] }] },
// each piece's line kept so the map shows the tag before that part of the map's roads has loaded. mph is your own
// speed limit for the stretch, used in place of the map's (posted or guessed) everywhere in the app.
import { distance } from './geo.js';

// Worst first: a road's main tag (its color on the map) is the first of its tags here. weight: what a loop made for
// you counts the road at (0: left out).
export const TAGS = [
  { k: 'avoid', label: 'Don’t ride', color: '#ff6b6b', weight: 0 },
  { k: 'rough', label: 'Rough', color: '#ffa94d', weight: 0.5 },
  { k: 'gravel', label: 'Gravel', color: '#d8b48a', weight: 0.6 },
  { k: 'busy', label: 'Busy', color: '#a5d8ff', weight: 0.7 },
  { k: 'great', label: 'Great', color: '#69db7c', weight: 1.3 },
];
export const TAG = Object.fromEntries(TAGS.map(t => [t.k, t]));

const KEY = 'rf2-tags';
let list = [];
try { list = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { /* no storage: tags last until the page closes */ }
const listeners = new Set();
function saved() {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
  listeners.forEach(fn => fn());
}
export const onTagsChanged = fn => listeners.add(fn);
export const allTags = () => list;

// A line with points at least ~25 m apart, to 5 decimals (about a metre): plenty to draw, a fraction of the size.
export function thin(g) {
  const out = [];
  g.forEach((p, i) => {
    if (i && i < g.length - 1 && distance(out[out.length - 1], p) < 25) return;
    out.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
  });
  return out;
}

const idsOf = t => t.pieces.map(x => x.id);
// The record tagging any of these way ids, or null.
export function tagOf(ids) {
  const want = new Set(ids);
  return list.find(t => t.pieces.some(x => want.has(x.id))) || null;
}

// Tag a stretch ({ key, roads: [{ id, geom }] }) with these tags, note and speed limit (mph: a number, null for none,
// or left out to keep the one it has); none of the three removes its record. A record that overlaps it is replaced,
// keeping the pieces it had beyond this stretch. Returns the list as it was, for undo.
export function setTags(g, tags, note = '', mph) {
  const was = list, ids = new Set(g.roads.map(r => r.id)), old = list.filter(t => t.pieces.some(x => ids.has(x.id)));
  if (mph === undefined) mph = old.find(t => t.mph != null)?.mph ?? null;
  list = list.filter(t => !old.includes(t));
  if (tags.length || note.trim() || mph != null) {
    const pieces = [...g.roads.map(r => ({ id: r.id, g: thin(r.geom) })), ...old.flatMap(t => t.pieces.filter(x => !ids.has(x.id)))];
    list = [...list, { key: g.key, tags: TAGS.map(t => t.k).filter(k => tags.includes(k)), note: note.trim(),
      ...(mph != null ? { mph } : {}), at: Date.now(), pieces }];
  }
  saved();
  return was;
}

// Your speed limit for a stretch (null: use the map's), keeping its tags and note.
export function setSpeed(g, mph) {
  const t = tagOf(g.roads.map(r => r.id));
  return setTags(g, t ? t.tags : [], t ? t.note : '', mph);
}
// Way id -> your speed limit, for every piece you've set one on.
export const speedFixes = () => new Map(list.filter(t => t.mph != null).flatMap(t => t.pieces.map(x => [x.id, t.mph])));
export function restoreTags(was) { list = was; saved(); }

// Way ids tagged Don't ride, and what a stretch counts for in a loop made for you (the product of its tags' weights).
export const avoidedIds = () => new Set(list.filter(t => t.tags.includes('avoid')).flatMap(idsOf));
export function weightOf(ids) {
  const t = tagOf(ids);
  return t ? t.tags.reduce((w, k) => w * TAG[k].weight, 1) : 1;
}
export const tagWords = t => t.tags.map(k => TAG[k].label).join(' · ');

// ---------- spots ----------
// A tag on one spot (a bump, a pothole), not a stretch of road. Kept in the same list as road tags, so they follow the
// account and an older copy of the app passes them on untouched: { id, spot: [lat, lon], kind, note, at, key: 'Spot',
// tags: [], pieces: [] } (no tags or pieces, so nothing above counts them). kind null: marked in Ride mode with one
// tap, to label after the ride. say: what Ride mode says coming up on one (a clip in voice/phrases.json).
export const SPOT_KINDS = [
  { k: 'bump', label: 'Bump', color: '#ffa94d', say: 'spotbump' },
  { k: 'pothole', label: 'Pothole', color: '#ff6b6b', say: 'spotpothole' },
  { k: 'gravel', label: 'Gravel', color: '#d8b48a', say: 'spotgravel' },
  { k: 'hazard', label: 'Watch out', color: '#ffd43b', say: 'spothazard' },
  { k: 'view', label: 'Nice view', color: '#69db7c', say: null },
];
const UNLABELLED = { k: null, label: 'Marked spot', color: '#e9ecef', say: 'spotmarked' };
export const spotKind = s => SPOT_KINDS.find(x => x.k === s.kind) || UNLABELLED;
export const spots = () => list.filter(t => t.spot);
export const spotById = id => list.find(t => t.spot && t.id === id) || null;

export function addSpot(p, kind = null) {
  const s = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, key: 'Spot',
    spot: [+p[0].toFixed(5), +p[1].toFixed(5)], kind, note: '', at: Date.now(), made: Date.now(), tags: [], pieces: [] };
  list = [...list, s];
  saved();
  return s;
}
// Change a spot's kind or note ({ kind } or { note }).
export function setSpot(id, patch) {
  list = list.map(t => t.spot && t.id === id ? { ...t, ...patch, at: Date.now() } : t);
  saved();
}
// Returns the list as it was, for undo.
export function removeSpot(id) {
  const was = list;
  list = list.filter(t => !(t.spot && t.id === id));
  saved();
  return was;
}
export const spotsForMap = () => spots().map(s => ({ id: s.id, p: s.spot, color: spotKind(s).color, label: spotKind(s).label }));

// For the map: each record's lines, its main tag and its label.
export const tagsForMap = () => list.filter(t => t.tags.length).map(t => ({ geoms: t.pieces.map(x => x.g), main: t.tags[0], label: tagWords(t) }));
