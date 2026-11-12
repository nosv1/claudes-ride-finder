// Signing in, which is optional: your rides, settings and road tags kept in your account so they're the same on
// every device, and short share links (#s=<code>). The API is worker/ on Cloudflare (its header lists the calls);
// Google's own button does the signing in. Without an account everything works as before, on this device only.
//
// Everything sent to the account is locked first (seal.js), with the account's key, which stays on your devices: the
// first device makes it, and each other device gets it from an "add a device" link (#k=<key>). A device signed in
// without it is "locked": it can't read or save anything in the account until it opens that link.
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';
import { lock, unlock, newAccountKey, keyId, newLinkCode, linkParts } from './seal.js';

const SESSION_KEY = 'rf2-account';  // { token, user: { name, email, picture } }
const RIDE_KEY = 'rf2-ride-id';     // the saved ride the ride on screen is: its changes are saved there
const DATA_AT_KEY = 'rf2-data-at';  // when settings or tags last changed on this device (ms), to tell which copy is newer
const KEYS_KEY = 'rf2-keys';        // { [key id]: account key }, kept after signing out so signing back in needs no link

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

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
    if (res.status === 401 && session) forget();
    if (!res.ok) throw Object.assign(new Error(out.error || 'Your account didn’t answer. Try again in a bit.'), { status: res.status });
    return out;
  } catch (e) {
    if (e.status) throw e;
    throw new Error('Couldn’t reach your account. Check your signal and try again.');
  } finally {
    clearTimeout(timer);
  }
}

function forget() {
  session = null;
  write(SESSION_KEY, null);
  write(RIDE_KEY, null);
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
  await api('POST', '/logout').catch(() => {});
  forget();
}

export async function deleteAccount() {
  const had = account.key;
  await api('DELETE', '/me');
  if (had) {
    const keys = read(KEYS_KEY) || {};
    delete keys[await keyId(had)];
    write(KEYS_KEY, keys);
  }
  forget();
}

// ---------- the account key ----------

// An "add a device" link's key (from #k=): kept, and used if it's this account's (or the next one signed in to).
export async function addKey(k) {
  if (!/^[\w-]{43}$/.test(k)) throw new Error('That device link was cut short. Copy the whole link and open it again.');
  write(KEYS_KEY, { ...(read(KEYS_KEY) || {}), [await keyId(k)]: k });
  if (session) await refresh();
}

// The link that gives another device the key: base is the app's address.
export const deviceLink = base => `${base}#k=${key()}`;

// The account's key on this device: the one it says it has, or, for an account that has none yet, a new one.
async function findKey(id) {
  const keys = read(KEYS_KEY) || {};
  if (id) return keys[id] || null;
  const k = newAccountKey(), kid = await keyId(k);
  write(KEYS_KEY, { ...keys, [kid]: k });
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
export async function refresh() {
  lastLook = Date.now();
  if (!session) return;
  const me = await api('GET', '/me'), k = await findKey(me.keyId);
  account.key = k;
  account.locked = !k;
  if (!k) {
    Object.assign(account, { rides: [], links: [] });
    return changed();
  }
  // The ride on screen was deleted on another device: it's just a ride on this one now.
  if (rideId() && !me.rides.some(r => r.id === rideId())) write(RIDE_KEY, null);
  const old = [];  // saved before locking existed: their name came back as it is, and they're locked now
  account.rides = await Promise.all(me.rides.map(async r => {
    const name = await unlock(k, r.name);
    if (name == null) old.push(r);
    return { id: r.id, updated: r.updated, name: name ?? r.name };
  }));
  account.links = (await Promise.all(me.links.map(async l => {
    const o = l.owner && JSON.parse(await unlock(k, l.owner) || 'null');
    return o && { id: l.id, code: o.code, name: o.name, created: l.created };
  }))).filter(Boolean);
  if (sync) {
    const localAt = read(DATA_AT_KEY) || 0;
    // Before locking existed, the data came as it was (an object), not locked text: take it, and send it back locked.
    const data = typeof me.data === 'string' ? JSON.parse(await unlock(k, me.data) || 'null') : me.data;
    if (data && (firstSync || me.dataAt > localAt || typeof me.data !== 'string')) {
      applying = true;
      try { sync.apply(data, { merge: firstSync }); } finally { applying = false; }
      write(DATA_AT_KEY, Math.max(me.dataAt, firstSync ? Date.now() : 0));
      if (firstSync || typeof me.data !== 'string') pushData();
    } else if (!data || localAt > me.dataAt) pushData();
    firstSync = false;
  }
  changed();
  for (const r of old) relock(r.id).catch(() => { /* tried again next time */ });
}

async function relock(id) {
  const r = await api('GET', `/rides/${id}`), k = key();
  if (await unlock(k, r.name) != null) return;
  await api('PUT', `/rides/${id}`, { name: await lock(k, r.name), trip: await lock(k, r.trip) });
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

export const rideId = () => session ? read(RIDE_KEY) : null;
export const rideName = () => (account.rides || []).find(r => r.id === rideId())?.name || '';
export function setRideId(id) { write(RIDE_KEY, id); changed(); }
let sent = null;  // the trip last saved or opened, so opening a ride doesn't save it straight back

const touch = (id, patch) => {
  const r = (account.rides || []).find(x => x.id === id);
  if (r) Object.assign(r, patch);
  if (account.rides) account.rides.sort((a, b) => b.updated - a.updated);
};

// open: it's the ride on screen (its changes are saved to it from now on).
export async function saveRide(name, trip, { open = true } = {}) {
  const k = key(), r = await api('POST', '/rides', { name: await lock(k, name), trip: await lock(k, trip) });
  account.rides = [{ id: r.id, name, updated: r.updated }, ...(account.rides || [])].sort((a, b) => b.updated - a.updated);
  if (open) {
    sent = trip;
    write(RIDE_KEY, r.id);
  }
  changed();
  return r.id;
}

// The ride on screen changed: if it's a saved ride, save it there (once the changes settle).
let rideTimer = null;
export function rideChanged(trip) {
  const id = rideId();
  if (!id || !account.key || trip === sent) return;
  clearTimeout(rideTimer);
  account.saving = true;
  rideTimer = setTimeout(async () => {
    sent = trip;
    try {
      const r = await api('PUT', `/rides/${id}`, { trip: await lock(key(), trip) });
      touch(id, { updated: r.updated });
      account.error = '';
    } catch (e) {
      account.error = e.message;
      sent = null;
      if (e.status === 404) setRideId(null);
    }
    account.saving = false;
    changed();
  }, 1500);
  changed();
}

export async function renameRide(id, name) {
  const r = await api('PUT', `/rides/${id}`, { name: await lock(key(), name.trim()) });
  touch(id, { name: name.trim(), updated: r.updated });
  changed();
}

// { name, trip } unlocked (a ride saved before locking existed comes as it was).
async function getRide(id) {
  const r = await api('GET', `/rides/${id}`), k = key();
  return { ...r, name: await unlock(k, r.name) ?? r.name, trip: await unlock(k, r.trip) ?? r.trip };
}

export async function openRide(id) {
  const r = await getRide(id);
  sent = r.trip;
  setRideId(id);
  return r;
}

// Returns the ride as it was ({ name, trip }), for an undo.
export async function deleteRide(id) {
  const was = await getRide(id);
  await api('DELETE', `/rides/${id}`);
  account.rides = (account.rides || []).filter(r => r.id !== id);
  if (rideId() === id) write(RIDE_KEY, null);
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
