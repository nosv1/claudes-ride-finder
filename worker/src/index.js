// Ride Finder's accounts API on Cloudflare (a Worker with a D1 database): rides, settings and road tags kept per
// Google account, and short share links. Signing in is optional; the app works without it. See FEATURES.md, Accounts.
//
//   POST   /login      { credential: Google ID token }  → { token, user }     a session for the app to keep
//   POST   /logout                                     → {}
//   GET    /me                                         → { rides, links, data, dataAt }
//   DELETE /me                                         → {}                    the account and everything in it
//   POST   /rides      { name, trip }                  → { id, updated }
//   GET    /rides/:id                                  → { id, name, trip, updated }
//   PUT    /rides/:id  { name?, trip? }                → { updated }
//   DELETE /rides/:id                                  → {}
//   PUT    /data       { data, at }                    → {}                    settings and road tags, as one blob
//   POST   /links      { trip, name? }                 → { id }                anyone; owned when signed in
//   GET    /links/:id                                  → { trip, name }
//   DELETE /links/:id                                  → {}                    its owner only
//
// A trip is the app's packed ride (trip.js encodeTrip): letters, digits, - and _. Signed-in calls send
// "Authorization: Bearer <token>"; the database keeps only a hash of the token, and only the Google account's id
// (no email or name).

const SITE_ORIGINS = ['https://nosv1.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;  // the tests, and trying the app on the PC
const MAX_TRIP = 8 * 1024, MAX_NAME = 120, MAX_DATA = 256 * 1024, MAX_RIDES = 300;
const SESSION_DAYS = 365;
// Per day: saves per account, new share links per address, sign-ins per address.
const LIMITS = { save: 1000, link: 200, login: 50 };
const DAY = 86400e3;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = SITE_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
    } : { Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    let res;
    try {
      // Only the app's pages may change anything (a browser always sends Origin on these).
      if (!allowed && req.method !== 'GET') throw new HttpError(403, 'This only works from the Ride Finder site.');
      res = await route(req, env);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e.stack || e);
      res = json({ error: e instanceof HttpError ? e.message : 'Something went wrong on our side.' }, e.status || 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function route(req, env) {
  const { pathname } = new URL(req.url), m = req.method;
  const [, what, id] = pathname.match(/^\/(\w+)(?:\/([\w-]+))?\/?$/) || [];
  const db = env.DB;

  if (what === 'login' && m === 'POST') return login(req, env);
  if (what === 'links' && id && m === 'GET') {
    const row = await db.prepare('SELECT trip, name FROM links WHERE id = ?').bind(id).first();
    if (!row) throw new HttpError(404, 'That ride link was taken down or never existed.');
    return json(row);
  }
  if (what === 'links' && !id && m === 'POST') return makeLink(req, env);

  const user = await signedIn(req, db);
  if (what === 'logout' && m === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE hash = ?').bind(user.session).run();
    return json({});
  }
  if (what === 'me' && m === 'GET') {
    const [rides, links, row] = await Promise.all([
      db.prepare('SELECT id, name, updated FROM rides WHERE user_id = ? ORDER BY updated DESC').bind(user.id).all(),
      db.prepare('SELECT id, name, created FROM links WHERE user_id = ? ORDER BY created DESC').bind(user.id).all(),
      db.prepare('SELECT data, data_at FROM users WHERE id = ?').bind(user.id).first(),
    ]);
    return json({ rides: rides.results, links: links.results, data: row && row.data ? JSON.parse(row.data) : null, dataAt: row ? row.data_at : 0 });
  }
  if (what === 'me' && m === 'DELETE') {
    await db.batch(['rides', 'links', 'sessions'].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id))
      .concat(db.prepare('DELETE FROM users WHERE id = ?').bind(user.id)));
    return json({});
  }
  if (what === 'data' && m === 'PUT') {
    await limit(db, 'save', user.id);
    const body = await readJson(req), data = JSON.stringify(body.data ?? null);
    if (data.length > MAX_DATA) throw new HttpError(413, 'Too many tags to keep in your account.');
    const at = Number.isFinite(body.at) ? Math.min(body.at, Date.now() + DAY) : Date.now();
    await db.prepare('UPDATE users SET data = ?, data_at = ? WHERE id = ?').bind(data, at, user.id).run();
    return json({});
  }
  if (what === 'rides') {
    if (!id && m === 'POST') {
      await limit(db, 'save', user.id);
      const body = await readJson(req), trip = checkTrip(body.trip), name = checkName(body.name);
      const { n } = await db.prepare('SELECT COUNT(*) AS n FROM rides WHERE user_id = ?').bind(user.id).first();
      if (n >= MAX_RIDES) throw new HttpError(409, `You have ${MAX_RIDES} saved rides, the most there's room for. Delete some first.`);
      const rideId = randomId(12), updated = Date.now();
      await db.prepare('INSERT INTO rides (id, user_id, name, trip, updated) VALUES (?, ?, ?, ?, ?)').bind(rideId, user.id, name, trip, updated).run();
      return json({ id: rideId, updated });
    }
    const owned = id && await db.prepare('SELECT id, name, trip, updated FROM rides WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!owned) throw new HttpError(404, 'That ride isn’t in your account any more.');
    if (m === 'GET') return json(owned);
    if (m === 'PUT') {
      await limit(db, 'save', user.id);
      const body = await readJson(req), updated = Date.now();
      const trip = body.trip == null ? owned.trip : checkTrip(body.trip), name = body.name == null ? owned.name : checkName(body.name);
      await db.prepare('UPDATE rides SET name = ?, trip = ?, updated = ? WHERE id = ?').bind(name, trip, updated, id).run();
      return json({ updated });
    }
    if (m === 'DELETE') {
      await db.prepare('DELETE FROM rides WHERE id = ?').bind(id).run();
      return json({});
    }
  }
  if (what === 'links' && id && m === 'DELETE') {
    const r = await db.prepare('DELETE FROM links WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    if (!r.meta.changes) throw new HttpError(404, 'That link isn’t one of yours.');
    return json({});
  }
  throw new HttpError(404, 'No such thing here.');
}

// ---------- share links ----------

// The id is the start of the ride's hash: the same ride always gets the same link, and 10 characters (60 bits) are
// far too many to guess, which matters because a ride's start is often someone's home.
async function makeLink(req, env) {
  const db = env.DB, body = await readJson(req), trip = checkTrip(body.trip), name = body.name == null ? null : checkName(body.name);
  const user = req.headers.get('Authorization') ? await signedIn(req, db) : null;
  const id = (await sha256(trip)).slice(0, 10);
  const had = await db.prepare('SELECT user_id FROM links WHERE id = ?').bind(id).first();
  if (had) {
    if (user && !had.user_id) await db.prepare('UPDATE links SET user_id = ? WHERE id = ?').bind(user.id, id).run();
    return json({ id });
  }
  await limit(db, 'link', user ? user.id : await addressKey(req));
  await db.prepare('INSERT INTO links (id, trip, name, user_id, created) VALUES (?, ?, ?, ?, ?)').bind(id, trip, name, user ? user.id : null, Date.now()).run();
  return json({ id });
}

// ---------- signing in ----------

async function login(req, env) {
  const db = env.DB;
  await limit(db, 'login', await addressKey(req));
  const { credential } = await readJson(req);
  if (typeof credential !== 'string') throw new HttpError(400, 'No Google sign-in came with that.');
  let claims;
  // Local tests only (wrangler dev --var TEST_LOGIN:1): "test:<id>" signs in as that made-up account.
  if (env.TEST_LOGIN === '1' && credential.startsWith('test:')) claims = { sub: credential, name: 'Test Rider', email: 'test@example.com' };
  else claims = await verifyGoogle(credential, env.GOOGLE_CLIENT_ID);
  const token = randomId(32), now = Date.now();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO users (id, created, data_at) VALUES (?, ?, 0)').bind(claims.sub, now),
    db.prepare('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha256(token), claims.sub, now + SESSION_DAYS * DAY),
    db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    db.prepare('DELETE FROM counts WHERE day < ?').bind(Math.floor(now / DAY) - 2),
  ]);
  return json({ token, user: { name: claims.name || '', email: claims.email || '', picture: claims.picture || '' } });
}

async function signedIn(req, db) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const row = token && await db.prepare('SELECT hash, user_id FROM sessions WHERE hash = ? AND expires > ?').bind(await sha256(token), Date.now()).first();
  if (!row) throw new HttpError(401, 'You’re signed out. Sign in again to see your rides.');
  return { id: row.user_id, session: row.hash };
}

// Google's ID token is a JWT signed with one of Google's published keys (they rotate, so they're fetched and kept
// for an hour). Checks the signature, that it's from Google, for this app, unexpired, and for a verified email.
let googleKeys = null, keysAt = 0;
async function verifyGoogle(jwt, clientId) {
  const parts = jwt.split('.');
  let head, claims;
  try { [head, claims] = parts.length === 3 ? parts.slice(0, 2).map(p => JSON.parse(text(p))) : []; } catch (e) { /* not a JWT */ }
  if (!head || !claims) throw new HttpError(401, 'That Google sign-in didn’t look right. Try again.');
  let jwk = null;
  for (const fresh of [false, true]) {
    if (fresh || !googleKeys || Date.now() - keysAt > 3600e3) {
      googleKeys = (await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json()).keys;
      keysAt = Date.now();
    }
    jwk = googleKeys.find(k => k.kid === head.kid);
    if (jwk) break;
  }
  if (!jwk || head.alg !== 'RS256') throw new HttpError(401, 'That Google sign-in didn’t look right. Try again.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const good = ok && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    && claims.aud === clientId && claims.exp * 1000 > Date.now() && claims.email_verified !== false && claims.sub;
  if (!good) throw new HttpError(401, 'Google didn’t confirm that sign-in. Try again.');
  return claims;
}

// ---------- helpers ----------

async function readJson(req) {
  const body = await req.text();
  if (body.length > MAX_DATA + 1024) throw new HttpError(413, 'That’s more than there’s room for.');
  try { return JSON.parse(body || '{}'); } catch (e) { throw new HttpError(400, 'That request didn’t make sense.'); }
}

function checkTrip(trip) {
  if (typeof trip !== 'string' || !/^[\w-]+$/.test(trip)) throw new HttpError(400, 'That ride didn’t come through right.');
  if (trip.length > MAX_TRIP) throw new HttpError(413, 'That ride has too many stops to save. Try splitting it in two.');
  return trip;
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'A ride needs a name.');
  return name.trim().slice(0, MAX_NAME);
}

// A count per kind, who and day; over the limit is a polite no until tomorrow.
async function limit(db, kind, who) {
  const day = Math.floor(Date.now() / DAY);
  const { n } = await db.prepare('INSERT INTO counts (k, n, day) VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(`${kind}:${who}:${day}`, day).first();
  if (n > LIMITS[kind]) throw new HttpError(429, 'That’s a lot for one day. Try again tomorrow.');
}

// Who's asking, for the per-address limits: a hash of the address and the day, so it can't be traced back.
async function addressKey(req) {
  const day = Math.floor(Date.now() / DAY);
  return (await sha256(`${req.headers.get('CF-Connecting-IP') || 'local'}|${day}`)).slice(0, 16);
}

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const text = s => new TextDecoder().decode(bytes(s));
const sha256 = async s => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const randomId = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
