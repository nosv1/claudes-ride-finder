// The accounts API (worker/) run locally by wrangler dev, with its own local database. Run from the repo root:
//   node --test tests/worker.test.mjs
// Signs in with made-up "test:" accounts (see worker-dev.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker } from './worker-dev.mjs';

const ORIGIN = 'http://127.0.0.1:8000';
let API, worker;

before(async () => {
  worker = await startWorker();
  API = worker.url;
});

after(() => worker && worker.stop());

async function call(method, path, { body, token, origin = ORIGIN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), cors: res.headers.get('Access-Control-Allow-Origin') };
}
const signIn = async who => (await call('POST', '/login', { body: { credential: 'test:' + who } })).body.token;
const unique = () => 'trip' + Math.random().toString(36).slice(2);

test('sign in, save a ride, change it, see it in the list, delete it', async () => {
  const token = await signIn('rider-' + Date.now());
  assert.ok(token.length > 30);
  const made = await call('POST', '/rides', { token, body: { name: 'Ozarks loop', trip: unique() } });
  assert.equal(made.status, 200);
  const changed = await call('PUT', `/rides/${made.body.id}`, { token, body: { name: 'Ozarks loop, long', trip: 'abc-def_1' } });
  assert.equal(changed.status, 200);
  const got = await call('GET', `/rides/${made.body.id}`, { token });
  assert.equal(got.body.name, 'Ozarks loop, long');
  assert.equal(got.body.trip, 'abc-def_1');
  const me = await call('GET', '/me', { token });
  assert.deepEqual(me.body.rides.map(r => r.id), [made.body.id]);
  assert.equal(me.body.rides[0].trip, undefined, 'the list has names, not whole rides');
  assert.equal((await call('DELETE', `/rides/${made.body.id}`, { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).body.rides.length, 0);
});

test('one account can’t see or change another’s rides', async () => {
  const a = await signIn('a-' + Date.now()), b = await signIn('b-' + Date.now());
  const made = await call('POST', '/rides', { token: a, body: { name: 'Mine', trip: unique() } });
  assert.equal((await call('GET', `/rides/${made.body.id}`, { token: b })).status, 404);
  assert.equal((await call('PUT', `/rides/${made.body.id}`, { token: b, body: { name: 'Stolen' } })).status, 404);
  assert.equal((await call('DELETE', `/rides/${made.body.id}`, { token: b })).status, 404);
  assert.equal((await call('GET', `/rides/${made.body.id}`, { token: a })).body.name, 'Mine');
});

test('signed-out calls are turned away, and signing out ends the session', async () => {
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('GET', '/me', { token: 'made-up' })).status, 401);
  const token = await signIn('out-' + Date.now());
  assert.equal((await call('POST', '/logout', { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).status, 401);
});

test('settings and tags are kept as one blob with its time', async () => {
  const token = await signIn('data-' + Date.now());
  assert.equal((await call('GET', '/me', { token })).body.data, null);
  const data = { settings: { minSpeed: 50 }, tags: [{ key: 'MO 150', tags: ['great'], at: 1, pieces: [] }] };
  assert.equal((await call('PUT', '/data', { token, body: { data, at: 1234 } })).status, 200);
  const me = (await call('GET', '/me', { token })).body;
  assert.deepEqual(me.data, data);
  assert.equal(me.dataAt, 1234);
});

test('share links: anyone can make one, the same ride gets the same link, the owner can take it down', async () => {
  const trip = unique();
  const anon = await call('POST', '/links', { body: { trip } });
  assert.equal(anon.status, 200);
  assert.match(anon.body.id, /^[\w-]{10}$/);
  assert.equal((await call('POST', '/links', { body: { trip } })).body.id, anon.body.id);
  assert.equal((await call('GET', `/links/${anon.body.id}`, { origin: null })).body.trip, trip, 'opening needs no sign-in');

  const token = await signIn('sharer-' + Date.now()), trip2 = unique();
  const mine = await call('POST', '/links', { token, body: { trip: trip2, name: 'Sunday' } });
  assert.deepEqual((await call('GET', '/me', { token })).body.links.map(l => [l.id, l.name]), [[mine.body.id, 'Sunday']]);
  assert.equal((await call('DELETE', `/links/${anon.body.id}`, { token })).status, 404, 'not theirs');
  assert.equal((await call('DELETE', `/links/${mine.body.id}`, { token })).status, 200);
  assert.equal((await call('GET', `/links/${mine.body.id}`)).status, 404);
});

test('bad input, other sites and oversized rides are refused', async () => {
  const token = await signIn('bad-' + Date.now());
  assert.equal((await call('POST', '/rides', { token, body: { name: 'x', trip: 'has spaces' } })).status, 400);
  assert.equal((await call('POST', '/rides', { token, body: { name: ' ', trip: 'ok' } })).status, 400);
  assert.equal((await call('POST', '/rides', { token, body: { name: 'big', trip: 'a'.repeat(9000) } })).status, 413);
  const other = await call('POST', '/links', { body: { trip: unique() }, origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  assert.equal(other.cors, null);
  assert.equal((await call('POST', '/links', { body: { trip: unique() } })).cors, ORIGIN);
  assert.equal((await call('POST', '/login', { body: { credential: 'not.a.jwt' } })).status, 401);
});

test('deleting the account removes its rides, links, data and sessions', async () => {
  const who = 'gone-' + Date.now(), token = await signIn(who);
  await call('POST', '/rides', { token, body: { name: 'Ride', trip: unique() } });
  const link = await call('POST', '/links', { token, body: { trip: unique() } });
  await call('PUT', '/data', { token, body: { data: { settings: {} }, at: 5 } });
  assert.equal((await call('DELETE', '/me', { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).status, 401);
  assert.equal((await call('GET', `/links/${link.body.id}`)).status, 404);
  const again = await signIn(who);
  const me = (await call('GET', '/me', { token: again })).body;
  assert.deepEqual([me.rides.length, me.links.length, me.data], [0, 0, null]);
});
