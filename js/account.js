// Signing in, which is optional: your rides, settings and road tags kept in your account so they're the same on
// every device, and short share links (#s=<id>). The API is worker/ on Cloudflare (its header lists the calls);
// Google's own button does the signing in. Without an account everything works as before, on this device only.
import { API_URL, GOOGLE_CLIENT_ID } from './config.js';

const SESSION_KEY = 'rf2-account';  // { token, user: { name, email, picture } }
const RIDE_KEY = 'rf2-ride-id';     // the saved ride the ride on screen is: its changes are saved there
const DATA_AT_KEY = 'rf2-data-at';  // when settings or tags last changed on this device (ms), to tell which copy is newer

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

let session = read(SESSION_KEY);
// rides: [{ id, name, updated }] once loaded; links: the share links you made while signed in; saving: the ride on
// screen has changes on their way; error: the last thing that went wrong, to show where it happened.
export const account = { rides: null, links: [], saving: false, error: '', signingIn: false };
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
  Object.assign(account, { rides: null, links: [], saving: false });
  changed();
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
  await api('DELETE', '/me');
  forget();
}

// Your rides and links, and whichever copy of your settings and tags is newer.
export async function refresh() {
  if (!session) return;
  const me = await api('GET', '/me');
  Object.assign(account, { rides: me.rides, links: me.links });
  if (sync) {
    const localAt = read(DATA_AT_KEY) || 0;
    if (me.data && (firstSync || me.dataAt > localAt)) {
      applying = true;
      try { sync.apply(me.data, { merge: firstSync }); } finally { applying = false; }
      write(DATA_AT_KEY, Math.max(me.dataAt, firstSync ? Date.now() : 0));
      if (firstSync) pushData();
    } else if (!me.data || localAt > me.dataAt) pushData();
    firstSync = false;
  }
  changed();
}

// ---------- settings and road tags ----------

// get() → { settings, tags } to keep; apply(data, { merge }) puts the account's copy in place on this device.
export const syncData = hooks => { sync = hooks; };
let pushTimer = null, applying = false;
export function dataChanged() {
  if (applying) return;
  write(DATA_AT_KEY, Date.now());
  if (!session || !sync) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushData, 2000);
}
async function pushData() {
  try { await api('PUT', '/data', { data: sync.get(), at: read(DATA_AT_KEY) || Date.now() }); } catch (e) { /* sent again on the next change or start */ }
}

// Two lists of road tags as one: where both tag the same road, the newer tag wins.
export function mergeTags(a, b) {
  const out = [], seen = new Set();
  for (const t of [...a, ...b].sort((x, y) => y.at - x.at)) {
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
  const r = await api('POST', '/rides', { name, trip });
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
  if (!id || trip === sent) return;
  clearTimeout(rideTimer);
  account.saving = true;
  rideTimer = setTimeout(async () => {
    sent = trip;
    try {
      const r = await api('PUT', `/rides/${id}`, { trip });
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
  const r = await api('PUT', `/rides/${id}`, { name });
  touch(id, { name: name.trim(), updated: r.updated });
  changed();
}

export async function openRide(id) {
  const r = await api('GET', `/rides/${id}`);
  sent = r.trip;
  setRideId(id);
  return r;
}

// Returns the ride as it was ({ name, trip }), for an undo.
export async function deleteRide(id) {
  const was = await api('GET', `/rides/${id}`);
  await api('DELETE', `/rides/${id}`);
  account.rides = (account.rides || []).filter(r => r.id !== id);
  if (rideId() === id) write(RIDE_KEY, null);
  changed();
  return was;
}

// ---------- share links ----------

// A short link's id, or null when the account service doesn't answer quickly (the caller uses a long link instead).
export async function shortLink(trip, name) {
  try {
    const { id } = await api('POST', '/links', { trip, name }, { timeout: 3000 });
    if (session && !account.links.some(l => l.id === id)) account.links = [{ id, name, created: Date.now() }, ...account.links];
    return id;
  } catch (e) {
    return null;
  }
}

export const openLink = async id => (await api('GET', `/links/${id}`)).trip;

export async function deleteLink(id) {
  await api('DELETE', `/links/${id}`);
  account.links = account.links.filter(l => l.id !== id);
  changed();
}
