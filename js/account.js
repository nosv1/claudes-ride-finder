// Signing in, which is optional: your rides, settings and road tags kept in your account so they're the same on
// every device, and short share links (#s=<code>). The API is worker/ on Cloudflare (its header lists the calls);
// Google's own button does the signing in. Without an account everything works as before, on this device only.
//
// Everything sent to the account is locked first (seal.js), with the account's key, which stays on your devices: the
// first device makes it, and each other device gets it from an "add a device" link (#k=<key>). A device signed in
// without it is "locked": it can't read or save anything in the account until it opens that link.
import { check } from './check.js';
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import { lock, unlock, fingerprint, newAccountKey, keyId, newLinkCode, linkParts } from './seal.js';

const SESSION_KEY = 'rf2-account';  // { token, user: { name, email, picture } }
const RIDE_KEY = 'rf2-ride-id';     // the saved ride the ride on screen is: its changes are saved there
const DATA_AT_KEY = 'rf2-data-at';  // when settings or tags last changed on this device (ms), to tell which copy is newer
const KEYS_KEY = 'rf2-keys';        // { [key id]: account key }, kept after signing out so signing back in needs no link
const UNSENT_KEY = 'rf2-unsent';    // { [ride id]: packed trip }: changes to your rides not in the account yet
const BASES_KEY = 'rf2-bases';     // { [ride id]: fingerprints }: each ride's trip in the account, as last known here

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

// Whether this device has any account key at all (rideId asks on every render, so it's kept rather than read).
let hasKey = Object.keys(read(KEYS_KEY) || {}).length > 0;
const writeKeys = keys => { write(KEYS_KEY, keys); hasKey = Object.keys(keys).length > 0; };

let session = read(SESSION_KEY);
// rides: [{ id, name, updated }] once loaded; links: [{ id, code, name, created }], the share links you made while
// signed in; key: the account's key on this device; locked: signed in, but this device doesn't have the key; saving:
// the ride on screen has changes on their way; error: the last thing that went wrong, to show where it happened.
export const account = { rides: null, links: [], key: null, locked: false, saving: false, error: '', signingIn: false };
const listeners = new Set();
export const onAccountChanged = fn => listeners.add(fn);
const changed = () => listeners.forEach(fn => fn());

export const signedIn = () => !!session;
export const user = () => session ? session.user : null;

async function api(method, path, body, { timeout = 10000 } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(API_URL + path, {
      method, signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401 && session) forget({ expired: true });
    if (!res.ok) throw Object.assign(new Error(out.error || 'Your account didn’t answer. Try again in a bit.'), { status: res.status });
    return out;
  } catch (e) {
    if (e.status) throw e;
    throw new Error('Couldn’t reach your account. Check your signal and try again.', { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

// Signed out. expired: the session ran out rather than being ended, so changes not in the account yet are kept, and
// go once you sign in again (to another account they're dropped: its rides aren't theirs).
function forget({ expired = false } = {}) {
  session = null;
  write(SESSION_KEY, null);
  write(RIDE_KEY, null);
  if (!expired) { write(UNSENT_KEY, null); write(BASES_KEY, null); }
  dropPending();
  savedAs.clear();
  Object.assign(account, { rides: null, links: [], key: null, locked: false, saving: false });
  changed();
}

// The account key, or an error saying why there isn't one to use.
function key() {
  if (!account.key) throw new Error('Your rides are locked on this device. Open your account to unlock them.');
  return account.key;
}

// ---------- signing in ----------

let gis = null;
const loadGoogle = () => gis = gis || new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = () => {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: r => finishSignIn(r.credential), ux_mode: 'popup' });
    resolve();
  };
  s.onerror = () => { gis = null; reject(new Error('Google sign-in didn’t load. Check your signal and try again.')); };
  document.head.appendChild(s);
});

// Google's Sign in button, drawn into el (it's Google's, so it looks the same everywhere they're signed in).
export async function signInButton(el) {
  try {
    await loadGoogle();
    google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 260 });
  } catch (e) {
    el.textContent = e.message;
  }
}

let sync = null, firstSync = false;
export async function finishSignIn(credential) {
  account.signingIn = true;
  account.error = '';
  changed();
  try {
    const r = await api('POST', '/login', { credential });
    session = { token: r.token, user: r.user };
    write(SESSION_KEY, session);
    firstSync = true;  // this device's tags join the account's, rather than one replacing the other
    await refresh();
  } catch (e) {
    account.error = e.message;
  }
  account.signingIn = false;
  changed();
}

export async function signOut() {
  // A change still waiting goes first, and saves on their way get there before the sign-out (again, a few times at
  // most, for changes made meanwhile).
  for (let i = 0; i < 5 && (pending || putting > 0); i++) await flushSave();
  await api('POST', '/logout').catch(() => {});
  forget();
}

export async function deleteAccount() {
  const had = account.key;
  await api('DELETE', '/me');
  if (had) {
    const keys = read(KEYS_KEY) || {};
    delete keys[await keyId(had)];
    writeKeys(keys);
  }
  forget();
}

// ---------- the account key ----------

// An "add a device" link's key (from #k=): kept, and used if it's this account's (or the next one signed in to).
export async function addKey(k) {
  if (!/^[\w-]{43}$/.test(k)) throw new Error('That device link was cut short. Copy the whole link and open it again.');
  writeKeys({ ...(read(KEYS_KEY) || {}), [await keyId(k)]: k });
  if (session) await refresh();
}

// The link that gives another device the key: base is the app's address.
export const deviceLink = base => `${base}#k=${key()}`;

// The account's key on this device: the one it says it has, or, for an account that has none yet, a new one.
async function findKey(id) {
  const keys = read(KEYS_KEY) || {};
  if (id) return keys[id] || null;
  const k = newAccountKey(), kid = await keyId(k);
  writeKeys({ ...keys, [kid]: k });
  const r = await api('PUT', '/key', { keyId: kid });
  return r.keyId === kid ? k : (read(KEYS_KEY) || {})[r.keyId] || null;  // another device got there first
}

// Coming back to the app (switching to it, or unlocking the phone): changes made on another device show up. At most
// every 30 s, so flipping between apps doesn't keep asking.
let lastLook = 0;
export function lookAgain() {
  if (!session || Date.now() - lastLook < 30000) return;
  lastLook = Date.now();
  refresh().catch(() => { /* offline: the next look gets it */ });
}

// Your rides and links, and whichever copy of your settings and tags is newer, all unlocked here.
let ridesEdits = 0;  // rides saved, renamed or deleted here: a list asked for before one of them is out of date
export async function refresh() {
  // Asked again (at most twice) when one of those happened while the list was on its way. The last try takes the
  // links, settings and tags anyway, and the rides stay as they are here.
  for (let tries = 1; tries <= 3; tries++) if (await refreshOnce(tries === 3)) return;
}

// false: the rides came back out of date, so nothing was taken (unless it's the last try).
async function refreshOnce(last) {
  lastLook = Date.now();
  const s = session;
  if (!s) return true;
  const edits = ridesEdits;
  const me = await api('GET', '/me');
  if (!check(me && Array.isArray(me.rides) && Array.isArray(me.links), '/me sends rides and links')) return true;
  const k = await findKey(me.keyId);
  if (session !== s) return true;  // signed out meanwhile
  account.key = k;
  account.locked = !k;
  if (!k) return lockedOut();
  const old = [];  // saved before locking existed: their name came back as it is, and they're locked now
  const [rides, links] = await Promise.all([unlockRides(me.rides, k, old), unlockLinks(me.links, k)]);
  const fresh = edits === ridesEdits;
  if (session !== s) return true;
  if (!fresh && !last) return false;
  if (fresh) takeRides(rides, old);
  account.links = links;
  if (sync) await syncFrom(me, k);
  changed();
  return true;
}

// Locked: nothing can be saved to a ride, and whether it's still there can't be told, so none is selected. Changes
// not in the account yet stay kept (UNSENT_KEY), and go once the key is here.
function lockedOut() {
  Object.assign(account, { rides: [], links: [] });
  write(RIDE_KEY, null);
  dropPending();
  changed();
  return true;
}

// Your rides as the account has them. The ride on screen deleted on another device is just a ride on this one now;
// a change not in the account yet goes now (it failed, or the app closed before it went), or is dropped with its ride.
function takeRides(rides, old) {
  const id = rideId();
  if (id && !rides.some(r => r.id === id)) write(RIDE_KEY, null);
  account.rides = newerOf(rides, account.rides);
  sendUnsent(rides);
  for (const r of old) relock(r.id).catch(() => { /* tried again next time */ });
}

// Each change not in the account yet goes, unless its ride is gone. One built on a copy that another device has
// changed since is refused by the account (putRide), so that change stays.
function sendUnsent(rides) {
  for (const [rid, trip] of Object.entries(readUnsent())) {
    if (!rides.some(r => r.id === rid)) forgetRide(rid);
    else if ((!pending || pending.id !== rid) && savedAs.get(rid) !== trip) void sendRide(rid, trip);
  }
}

const unlockRides = (list, k, old) => Promise.all(list.map(async r => {
  const name = await unlock(k, r.name);
  if (name == null) old.push(r);
  return { id: r.id, updated: r.updated, name: name ?? r.name };
}));

const unlockLinks = async (list, k) => (await Promise.all(list.map(async l => {
  const o = l.owner && JSON.parse(await unlock(k, l.owner) || 'null');
  return o && { id: l.id, code: o.code, name: o.name, created: l.created };
}))).filter(Boolean);

// The list from the account, with a ride saved here since it was sent keeping its newer time.
function newerOf(rides, mine) {
  const at = new Map((mine || []).map(r => [r.id, r.updated]));
  return rides.map(r => (at.get(r.id) > r.updated ? { ...r, updated: at.get(r.id) } : r)).sort((a, b) => b.updated - a.updated);
}

// Settings and tags: whichever copy changed last wins.
async function syncFrom(me, k) {
  const localAt = read(DATA_AT_KEY) || 0;
  // Before locking existed, the data came as it was (an object), not locked text: take it, and send it back locked.
  const data = typeof me.data === 'string' ? JSON.parse(await unlock(k, me.data) || 'null') : me.data;
  if (data && (firstSync || me.dataAt > localAt || typeof me.data !== 'string')) {
    applying = true;
    try { sync.apply(data, { merge: firstSync }); } finally { applying = false; }
    write(DATA_AT_KEY, Math.max(me.dataAt, firstSync ? Date.now() : 0));
    if (firstSync || typeof me.data !== 'string') void pushData();  // sent again next time if it fails
  } else if (!data || localAt > me.dataAt) void pushData();
  firstSync = false;
}

async function relock(id) {
  const r = await api('GET', `/rides/${id}`), k = key();
  if (await unlock(k, r.name) != null) return;
  const trip = await lock(k, r.trip);
  await api('PUT', `/rides/${id}`, { name: await lock(k, r.name), trip });
  await setBase(id, [trip]);
}

// ---------- settings and road tags ----------

// get() → { settings, tags } to keep; apply(data, { merge }) puts the account's copy in place on this device.
export const syncData = hooks => { sync = hooks; };
let pushTimer = null, applying = false;
export function dataChanged() {
  if (applying) return;
  write(DATA_AT_KEY, Date.now());
  if (!session || !sync || !account.key) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushData, 2000);
}
async function pushData() {
  try {
    await api('PUT', '/data', { data: await lock(key(), JSON.stringify(sync.get())), at: read(DATA_AT_KEY) || Date.now() });
  } catch (e) { /* sent again on the next change or start */ }
}

// Two lists of road tags as one: where both tag the same road, the newer tag wins (spots: the same spot, by its id).
export function mergeTags(a, b) {
  const out = [], seen = new Set(), spotIds = new Set();
  for (const t of [...a, ...b].sort((x, y) => y.at - x.at)) {
    if (t.spot) {
      if (!spotIds.has(t.id)) { spotIds.add(t.id); out.push(t); }
      continue;
    }
    if (t.pieces.some(p => seen.has(p.id))) continue;
    t.pieces.forEach(p => seen.add(p.id));
    out.push(t);
  }
  return out.sort((x, y) => x.at - y.at);
}

// ---------- rides ----------

// None while signed out or locked, and none on a device with no key at all (it's locked: the account will say so).
export const rideId = () => session && !account.locked && (account.key || hasKey) ? read(RIDE_KEY) : null;
const nameOf = id => (id && (account.rides || []).find(r => r.id === id)?.name) || '';
export const rideName = () => nameOf(rideId());
// The selected saved ride's name, or '' when none is selected. Until Your rides load (with the account's key) a
// selected ride has no name yet; it's still selected, and the next change after they load saves to it.
export const selectedRide = () => { const id = rideId(); return id ? nameOf(id) || 'Your saved ride' : ''; };

// Saving the ride on screen: what each ride was last saved (or opened) as here, so it isn't saved straight back as it
// already is (null: it's not in the account yet, a save failed or the app closed first, so it's sent again); the
// change waiting to be saved ({ id, trip }); how many saves are on their way, and the last one of each ride (onWay);
// and those saves, one after another (queue), so an older copy never lands after a newer one. savedAs keeps the last
// SAVED_KEPT rides (rule 3), and is cleared on signing out, as are UNSENT_KEY (the changes not in the account yet,
// kept so a reload doesn't lose them) and BASES_KEY.
const SAVED_KEPT = 50;
const savedAs = new Map(Object.keys(readUnsent()).map(id => [id, null]));
const onWay = new Map();
let pending = null, rideTimer = null, putting = 0, queue = Promise.resolve();
const savingNow = () => { account.saving = !!pending || putting > 0; };
function remember(id, trip) {
  savedAs.delete(id);
  savedAs.set(id, trip);
  if (savedAs.size > SAVED_KEPT) savedAs.delete(savedAs.keys().next().value);
}

// A kept map of ride id to something, as stored (rule 5: from storage), with only the entries ok takes.
function readMap(k, ok, what) {
  const all = read(k);
  if (all == null || !check(typeof all === 'object' && !Array.isArray(all), what)) return {};
  return Object.fromEntries(Object.entries(all).filter(([, v]) => check(ok(v), what)));
}
function writeMap(k, all) {
  const ids = Object.keys(all);
  if (ids.length > SAVED_KEPT) delete all[ids[0]];
  write(k, ids.length ? all : null);
}

function readUnsent() { return readMap(UNSENT_KEY, v => typeof v === 'string', 'kept changes: a trip per ride'); }
// Ride id's change not in the account yet is trip, or (null) there's none: it's there now, or the ride's gone.
function keepUnsent(id, trip) {
  const all = readUnsent();
  delete all[id];
  if (trip != null) all[id] = trip;
  writeMap(UNSENT_KEY, all);
}

// What a save to ride id builds on: the fingerprints of its locked trip in the account as last known here (from
// opening it, saving it, or this device's last save to it; two when a save's answer never came, so it can't tell
// whether it got there; none once it's known to have changed elsewhere). The account refuses a save built on
// anything else. Unknown (a ride from before this was kept): the save goes as it is.
const readBases = () => readMap(BASES_KEY, v => Array.isArray(v) && v.length <= 2 && v.every(f => typeof f === 'string'),
  'kept bases: fingerprints per ride');
const baseOf = id => readBases()[id];
// Locked trips (prints: false, fingerprints already) as ride id's base; null: none known.
async function setBase(id, trips, { prints = false } = {}) {
  const all = readBases(), fps = trips && (prints ? trips : await Promise.all(trips.map(fingerprint)));
  delete all[id];
  if (fps) all[id] = fps.slice(-2);
  writeMap(BASES_KEY, all);
}

// Ride id is gone (deleted here or on another device): nothing more is saved to it.
function forgetRide(id) {
  savedAs.delete(id);
  dropPending(id);
  keepUnsent(id, null);
  void setBase(id, null);  // storage only: it doesn't fail
  if (read(RIDE_KEY) === id) write(RIDE_KEY, null);
}

// Whether this device knows how ride id stands (saved as something, or not in the account yet): after a reload, only
// a ride with a change that hadn't got there.
export const knowsRide = id => savedAs.has(id);

// A change waiting to be saved (to ride id, or any) is dropped: it's been saved as it is, or the ride is gone.
function dropPending(id = null) {
  if (!pending || (id && pending.id !== id)) return;
  clearTimeout(rideTimer);
  pending = null;
  savingNow();
}

// The ride on screen is saved ride id, or none. trip: as it's saved (just opened or saved), so it isn't saved straight
// back. check: only if it can still be saved to (an Undo: signed in, not locked, still in your rides). A change to the
// ride selected before that's still waiting to be saved goes right away.
export function selectRide(id, { trip = null, check: mustSave = false } = {}) {
  if (!check(id == null || typeof id === 'string', 'selectRide: a ride id or none')) return;
  // Signed out meanwhile (a save or an open that finished late), or an Undo to a ride that can't be saved to now.
  if (!session || (mustSave && !canSaveTo(id))) id = null;
  if (id && trip) {  // what's on screen is what the account has: a change from before (an Undo has it) is superseded
    remember(id, trip);
    dropPending(id);
    keepUnsent(id, null);
  }
  if (pending && pending.id !== id) void flushSave();
  write(RIDE_KEY, id);
  changed();
}

// Signed in, not locked, and still in your rides (as far as they've loaded).
const canSaveTo = id => !!id && !!session && !account.locked && (account.rides == null || account.rides.some(r => r.id === id));

// The change waiting to be saved goes now. Resolves once it, and every save already on its way, is done (or failed:
// putRide says so in account.error).
function flushSave() {
  const p = pending;
  dropPending();
  return p ? sendRide(p.id, p.trip) : queue;
}

// Ride id saved as trip, once the saves before it are done. Resolves when it's done too; putRide handles its own
// failures, and anything else is logged, so one save going wrong never stops the ones after it.
function sendRide(id, trip) {
  remember(id, trip);
  onWay.set(id, trip);
  putting++;
  savingNow();
  queue = queue.then(() => putRide(id, trip)).catch(e => console.error('Save failed', e));
  return queue;
}

async function putRide(id, trip) {
  try {
    if (session && check(typeof trip === 'string' && trip !== '', 'putRide: a packed trip')) await putTrip(id, trip);
  } finally {
    if (onWay.get(id) === trip) onWay.delete(id);
    putting--;
    savingNow();
    changed();
  }
}

// One save, sent with what it builds on (baseOf) so the account can refuse it if another device changed the ride.
async function putTrip(id, trip) {
  const locked = await lock(key(), trip), was = baseOf(id);
  try {
    const r = await api('PUT', `/rides/${id}`, { trip: locked, was });
    touch(id, { updated: r.updated });
    await setBase(id, [locked]);
    if (readUnsent()[id] === trip) keepUnsent(id, null);
    account.error = '';
  } catch (e) {
    account.error = e.message;
    // No answer: it may have got there. Not saved: the next change, or the next look at your rides, sends it.
    if (!e.status && was) await setBase(id, [...was, await fingerprint(locked)], { prints: true });
    if (savedAs.get(id) === trip) {
      remember(id, null);
      if (!pending || pending.id !== id) keepUnsent(id, trip);
    }
    if (e.status === 404) forgetRide(id);
    if (e.status === 409) await changedElsewhere(id);
  }
}

// The account refused a save: ride id changed on another device since this one last saw it, and that change stays.
// This device's changes to it are dropped (the ride on screen keeps them, as just a ride here now), and nothing more
// is saved to it until it's opened again.
let conflictHook = null;
export const onChangedElsewhere = fn => { conflictHook = fn; };
async function changedElsewhere(id) {
  const onScreen = read(RIDE_KEY) === id;
  savedAs.delete(id);
  dropPending(id);
  keepUnsent(id, null);
  await setBase(id, [], { prints: true });
  if (onScreen) write(RIDE_KEY, null);
  account.error = '';
  if (conflictHook) conflictHook({ name: nameOf(id) || 'Your saved ride', onScreen });
}

const touch = (id, patch) => {
  const r = (account.rides || []).find(x => x.id === id);
  if (r) Object.assign(r, patch);
  if (account.rides) account.rides.sort((a, b) => b.updated - a.updated);
};

// Adds it to your rides and returns its id; selectRide makes it the ride on screen.
export async function saveRide(name, trip) {
  const s = session, k = key(), locked = await lock(k, trip);
  const r = await api('POST', '/rides', { name: await lock(k, name), trip: locked });
  ridesEdits++;
  if (session !== s) return r.id;  // signed out meanwhile: it's in the account, and listed there next time
  await setBase(r.id, [locked]);
  // A look at your rides that came back meanwhile may list it already.
  const others = (account.rides || []).filter(x => x.id !== r.id);
  account.rides = [{ id: r.id, name, updated: r.updated }, ...others].sort((a, b) => b.updated - a.updated);
  changed();
  return r.id;
}

// The ride on screen changed: if it's a saved ride, save it there (once the changes settle).
export function rideChanged(trip) {
  const id = rideId();
  if (!id || !check(typeof trip === 'string', 'rideChanged: a packed trip')) return;
  if (!account.key) {
    // Your rides haven't loaded yet. As the app opens with it, it's taken as saved as it is (as an Undo back to it
    // is); a change after that is kept, and goes once they have.
    if (!savedAs.has(id)) remember(id, trip);
    else if (savedAs.get(id) !== trip) { remember(id, null); keepUnsent(id, trip); }
    return;
  }
  if (savedAs.get(id) === trip) {  // back as it's saved: nothing to send (kept until a save of it on its way is done)
    dropPending(id);
    keepUnsent(id, onWay.get(id) === trip ? trip : null);
    changed();
    return;
  }
  if (pending && pending.id !== id) void flushSave();  // another ride's change still waiting goes, not dropped
  clearTimeout(rideTimer);
  pending = { id, trip };
  keepUnsent(id, trip);
  savingNow();
  rideTimer = setTimeout(() => void flushSave(), 1500);
  changed();
}

export async function renameRide(id, name) {
  const r = await api('PUT', `/rides/${id}`, { name: await lock(key(), name.trim()) });
  ridesEdits++;
  touch(id, { name: name.trim(), updated: r.updated });
  changed();
}

// { name, trip } unlocked (a ride saved before locking existed comes as it was). Its trip is what a save to it next
// builds on.
export async function getRide(id) {
  const r = await api('GET', `/rides/${id}`), k = key();
  if (!check(r && typeof r.trip === 'string', 'a ride from the account has a trip')) throw new Error('That ride didn’t come through. Try again.');
  await setBase(id, [r.trip]);
  return { ...r, name: await unlock(k, r.name) ?? r.name, trip: await unlock(k, r.trip) ?? r.trip };
}

// Returns the ride as it was ({ name, trip }), for an undo.
export async function deleteRide(id) {
  await flushSave();  // a change to it still waiting (or on its way) gets there first, so the Undo has it
  const was = await getRide(id);
  await api('DELETE', `/rides/${id}`);
  ridesEdits++;
  forgetRide(id);
  account.rides = (account.rides || []).filter(r => r.id !== id);
  changed();
  return was;
}

// ---------- share links ----------

// A short link's code, or null when the account service doesn't answer quickly (the caller uses a long link instead).
// Signed in, the link also keeps its code and name locked with your key, so it's listed on your account page.
export async function shortLink(trip, name) {
  try {
    const code = newLinkCode(), { id, key: lk } = await linkParts(code);
    const owner = session && account.key ? await lock(account.key, JSON.stringify({ code, name })) : undefined;
    await api('POST', '/links', { id, trip: await lock(lk, trip), owner }, { timeout: 3000 });
    if (owner) account.links = [{ id, code, name, created: Date.now() }, ...account.links];
    return code;
  } catch (e) {
    return null;
  }
}

export async function openLink(code) {
  const { id, key: lk } = await linkParts(code);
  const trip = await unlock(lk, (await api('GET', `/links/${id}`)).trip);
  if (trip == null) throw new Error('That link didn’t open a ride. It may have been cut short when it was copied.');
  return trip;
}

export async function deleteLink(id) {
  await api('DELETE', `/links/${id}`);
  account.links = account.links.filter(l => l.id !== id);
  changed();
}
