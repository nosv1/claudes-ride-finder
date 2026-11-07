// Ride Finder's accounts API on Cloudflare (a Worker with a D1 database): rides, settings and road tags kept per
// Google account, and short share links. Signing in is optional; the app works without it. See FEATURES.md, Accounts.
//
// Everything a rider saves arrives locked (js/seal.js: AES-GCM in their browser, with a key the service never sees),
// so this only ever stores and hands back locked text: base64url, checked for size and nothing else.
//
//   POST   /login      { credential: Google ID token }  → { token, user }     a session for the app to keep
//   POST   /logout                                     → {}
//   GET    /me                                         → { keyId, rides, links, data, dataAt }
//   DELETE /me                                         → {}                    the account and everything in it
//   PUT    /key        { keyId }                       → { keyId }             the account key's id, set once
//   POST   /rides      { name, trip }                  → { id, updated }       both locked
//   GET    /rides/:id                                  → { id, name, trip, updated }
//   PUT    /rides/:id  { name?, trip? }                → { updated }
//   DELETE /rides/:id                                  → {}
//   PUT    /data       { data, at }                    → {}                    settings and road tags, locked
//   POST   /links      { id, trip, owner? }            → { id }                anyone; owner (locked) when signed in
//   GET    /links/:id                                  → { trip }
//   DELETE /links/:id                                  → {}                    its owner only
//   POST   /speak      { text, voice, format? }        → audio/mpeg (or wav)   anyone: Ride mode's natural voice
//
// A link's id is a hash of the code in the link, which the service never sees (the code also makes the key that
// unlocks it). Signed-in calls send "Authorization: Bearer <token>"; the database keeps only a hash of the token, and
// only the Google account's id (no email or name).
//
// /speak says a short bit of text (a road's name, or one of Ride mode's fixed phrases for tools/make_voice.py) in a
// natural voice: Workers AI, Deepgram Aura-2, as claude-spells does it. Each clip is made once and kept, by voice and
// text alone, so it's shared by everyone and can't be tied to who asked; nothing else about the request is kept. New
// clips stop for the day at SPEAK_CHARS, inside Workers AI's free daily allowance (which claude-spells shares).

const SITE_ORIGINS = ['https://nosv1.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;  // the tests, and trying the app on the PC
// Sizes of the locked text (about 4/3 of what was locked, plus 38 characters).
const MAX_TRIP = 16 * 1024, MAX_NAME = 600, MAX_OWNER = 1024, MAX_DATA = 400 * 1024, MAX_RIDES = 300;
const SESSION_DAYS = 365;
// Per day: saves per account, new share links per address, sign-ins per address.
const LIMITS = { save: 1000, link: 200, login: 50, speak: 400 };
const VOICES = ['pandora', 'draco', 'helena', 'thalia', 'apollo', 'orion', 'luna', 'asteria', 'athena', 'arcas', 'zeus'];
const SPEAK_CHARS = 2000;  // a day; Aura-2 is 2,727 neurons per 1,000 characters, of 10,000 free a day per account
const MAX_SPEAK = 120;
const SPOKEN = /^[\p{L}\p{N} .,'’&!?:;()\/-]+$/u;
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
    const row = await db.prepare('SELECT trip FROM links WHERE id = ?').bind(id).first();
    if (!row) throw new HttpError(404, 'That ride link was taken down or never existed.');
    return json(row);
  }
  if (what === 'links' && !id && m === 'POST') return makeLink(req, env);
  if (what === 'speak' && !id && m === 'POST') return speak(req, env);

  const user = await signedIn(req, db);
  if (what === 'logout' && m === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE hash = ?').bind(user.session).run();
    return json({});
  }
  if (what === 'me' && m === 'GET') {
    const [rides, links, row] = await Promise.all([
      db.prepare('SELECT id, name, updated FROM rides WHERE user_id = ? ORDER BY updated DESC').bind(user.id).all(),
      db.prepare('SELECT id, owner, created FROM links WHERE user_id = ? ORDER BY created DESC').bind(user.id).all(),
      db.prepare('SELECT key_id, data, data_at FROM users WHERE id = ?').bind(user.id).first(),
    ]);
    return json({ keyId: row ? row.key_id : null, rides: rides.results, links: links.results,
      data: row && row.data ? JSON.parse(row.data) : null, dataAt: row ? row.data_at : 0 });
  }
  if (what === 'key' && m === 'PUT') {
    const { keyId } = await readJson(req);
    if (typeof keyId !== 'string' || !/^[\w-]{16}$/.test(keyId)) throw new HttpError(400, 'That key didn’t come through right.');
    await db.prepare('UPDATE users SET key_id = ? WHERE id = ? AND key_id IS NULL').bind(keyId, user.id).run();
    const row = await db.prepare('SELECT key_id FROM users WHERE id = ?').bind(user.id).first();
    return json({ keyId: row.key_id });
  }
  if (what === 'me' && m === 'DELETE') {
    await db.batch(['rides', 'links', 'sessions'].map(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id))
      .concat(db.prepare('DELETE FROM users WHERE id = ?').bind(user.id)));
    return json({});
  }
  if (what === 'data' && m === 'PUT') {
    await limit(db, 'save', user.id);
    const body = await readJson(req), data = JSON.stringify(checkLocked(body.data, MAX_DATA));
    if (data.length > MAX_DATA) throw new HttpError(413, 'Too many tags to keep in your account.');
    const at = Number.isFinite(body.at) ? Math.min(body.at, Date.now() + DAY) : Date.now();
    await db.prepare('UPDATE users SET data = ?, data_at = ? WHERE id = ?').bind(data, at, user.id).run();
    return json({});
  }
  if (what === 'rides') {
    if (!id && m === 'POST') {
      await limit(db, 'save', user.id);
      const body = await readJson(req), trip = checkLocked(body.trip, MAX_TRIP), name = checkLocked(body.name, MAX_NAME);
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
      const trip = body.trip == null ? owned.trip : checkLocked(body.trip, MAX_TRIP);
      const name = body.name == null ? owned.name : checkLocked(body.name, MAX_NAME);
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

// The app makes the id (a hash of the link's code, 16 characters: far too many to guess, which matters because a ride's
// start is often someone's home). The same id twice would be the same code: refused, and the app makes another.
async function makeLink(req, env) {
  const db = env.DB, body = await readJson(req), trip = checkLocked(body.trip, MAX_TRIP);
  if (typeof body.id !== 'string' || !/^[\w-]{16}$/.test(body.id)) throw new HttpError(400, 'That link didn’t come through right.');
  const user = req.headers.get('Authorization') ? await signedIn(req, db) : null;
  const owner = user && body.owner != null ? checkLocked(body.owner, MAX_OWNER) : null;
  await limit(db, 'link', user ? user.id : await addressKey(req));
  const r = await db.prepare('INSERT OR IGNORE INTO links (id, trip, owner, user_id, created) VALUES (?, ?, ?, ?, ?)')
    .bind(body.id, trip, owner, user ? user.id : null, Date.now()).run();
  if (!r.meta.changes) throw new HttpError(409, 'That link is taken. Try sharing again.');
  return json({ id: body.id });
}

// ---------- the natural voice ----------

async function speak(req, env) {
  const db = env.DB, body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  const format = body.format == null ? 'mp3' : body.format;
  if (!text || text.length > MAX_SPEAK || !SPOKEN.test(text) || !VOICES.includes(body.voice) || !['mp3', 'wav'].includes(format)) {
    throw new HttpError(400, 'That can’t be said.');
  }
  const audio = data => new Response(data, { headers: {
    'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  const kept = await db.prepare('SELECT audio FROM clips WHERE voice = ? AND format = ? AND text = ?').bind(body.voice, format, text).first();
  if (kept) return audio(new Uint8Array(kept.audio));

  await limit(db, 'speak', await addressKey(req));
  const day = Math.floor(Date.now() / DAY);
  const { n } = await db.prepare('INSERT INTO counts (k, n, day) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET n = n + excluded.n RETURNING n')
    .bind(`speak-chars:${day}`, text.length, day).first();
  if (n > SPEAK_CHARS) throw new HttpError(503, 'The voice is done making new words for today.');
  let data;
  try {
    const out = await env.AI.run('@cf/deepgram/aura-2-en', { text, speaker: body.voice, encoding: format === 'wav' ? 'linear16' : 'mp3',
      ...(format === 'wav' ? { container: 'wav', sample_rate: 24000 } : {}) });
    data = new Uint8Array(await new Response(out).arrayBuffer());
  } catch (e) {
    console.error('voice service:', e.message);
  }
  if (!data || !data.length) throw new HttpError(502, 'The voice service had a problem.');
  await db.prepare('INSERT OR REPLACE INTO clips (voice, format, text, audio, made) VALUES (?, ?, ?, ?, ?)')
    .bind(body.voice, format, text, data, Date.now()).run();
  return audio(data);
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

function checkLocked(text, max) {
  if (typeof text !== 'string' || !/^[\w-]+$/.test(text)) throw new HttpError(400, 'That didn’t come through right.');
  if (text.length > max) throw new HttpError(413, max === MAX_TRIP ? 'That ride has too many stops to save. Try splitting it in two.' : 'That’s more than there’s room for.');
  return text;
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
