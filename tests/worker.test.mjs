// The accounts API (worker/) run locally by wrangler dev, with its own local database. Run from the repo root:
//   node --test tests/worker.test.mjs
// Signs in with made-up "test:" accounts (see worker-dev.mjs). The app locks everything before sending it, so here a
// "ride" is any base64url text: the API only stores and returns it.
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
const locked = () => 'L' + Math.random().toString(36).slice(2) + '_x-y';
const linkId = () => (Math.random().toString(36).slice(2) + 'aaaaaaaaaaaaaaaa').slice(0, 16);

test('sign in, save a ride, change it, see it in the list, delete it', async () => {
  const token = await signIn('rider-' + Date.now());
  assert.ok(token.length > 30);
  const made = await call('POST', '/rides', { token, body: { name: 'nameA', trip: locked() } });
  assert.equal(made.status, 200);
  const changed = await call('PUT', `/rides/${made.body.id}`, { token, body: { name: 'nameB', trip: 'abc-def_1' } });
  assert.equal(changed.status, 200);
  const got = await call('GET', `/rides/${made.body.id}`, { token });
  assert.equal(got.body.name, 'nameB');
  assert.equal(got.body.trip, 'abc-def_1');
  const me = await call('GET', '/me', { token });
  assert.deepEqual(me.body.rides.map(r => r.id), [made.body.id]);
  assert.equal(me.body.rides[0].trip, undefined, 'the list has names, not whole rides');
  assert.equal((await call('DELETE', `/rides/${made.body.id}`, { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).body.rides.length, 0);
});

test('the account key’s id is set once, by the first device', async () => {
  const token = await signIn('key-' + Date.now());
  assert.equal((await call('GET', '/me', { token })).body.keyId, null);
  assert.equal((await call('PUT', '/key', { token, body: { keyId: 'first-key-id-123' } })).body.keyId, 'first-key-id-123');
  assert.equal((await call('PUT', '/key', { token, body: { keyId: 'other-key-id-456' } })).body.keyId, 'first-key-id-123', 'a second device can’t replace it');
  assert.equal((await call('GET', '/me', { token })).body.keyId, 'first-key-id-123');
  assert.equal((await call('PUT', '/key', { token, body: { keyId: 'short' } })).status, 400);
});

test('one account can’t see or change another’s rides', async () => {
  const a = await signIn('a-' + Date.now()), b = await signIn('b-' + Date.now());
  const made = await call('POST', '/rides', { token: a, body: { name: 'Mine', trip: locked() } });
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

test('settings and tags are kept as one locked blob with its time', async () => {
  const token = await signIn('data-' + Date.now());
  assert.equal((await call('GET', '/me', { token })).body.data, null);
  const data = locked();
  assert.equal((await call('PUT', '/data', { token, body: { data, at: 1234 } })).status, 200);
  const me = (await call('GET', '/me', { token })).body;
  assert.equal(me.data, data);
  assert.equal(me.dataAt, 1234);
  assert.equal((await call('PUT', '/data', { token, body: { data: { settings: {} }, at: 5 } })).status, 400, 'only locked text');
});

test('share links: anyone can make one by its id, ids are never reused, the owner can take theirs down', async () => {
  const id = linkId(), trip = locked();
  const anon = await call('POST', '/links', { body: { id, trip } });
  assert.deepEqual([anon.status, anon.body.id], [200, id]);
  assert.equal((await call('POST', '/links', { body: { id, trip: locked() } })).status, 409, 'an id is never overwritten');
  assert.deepEqual((await call('GET', `/links/${id}`, { origin: null })).body, { trip }, 'opening needs no sign-in');
  assert.equal((await call('POST', '/links', { body: { id: 'tooshort', trip } })).status, 400);

  const token = await signIn('sharer-' + Date.now()), mine = linkId();
  await call('POST', '/links', { token, body: { id: mine, trip: locked(), owner: 'ownerBlob' } });
  assert.deepEqual((await call('GET', '/me', { token })).body.links.map(l => [l.id, l.owner]), [[mine, 'ownerBlob']]);
  assert.equal((await call('DELETE', `/links/${id}`, { token })).status, 404, 'not theirs');
  assert.equal((await call('DELETE', `/links/${mine}`, { token })).status, 200);
  assert.equal((await call('GET', `/links/${mine}`)).status, 404);
});

test('bad input, other sites and oversized rides are refused', async () => {
  const token = await signIn('bad-' + Date.now());
  assert.equal((await call('POST', '/rides', { token, body: { name: 'x', trip: 'has spaces' } })).status, 400);
  assert.equal((await call('POST', '/rides', { token, body: { name: ' ', trip: 'ok' } })).status, 400);
  assert.equal((await call('POST', '/rides', { token, body: { name: 'big', trip: 'a'.repeat(17000) } })).status, 413);
  const other = await call('POST', '/links', { body: { id: linkId(), trip: locked() }, origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  assert.equal(other.cors, null);
  assert.equal((await call('POST', '/links', { body: { id: linkId(), trip: locked() } })).cors, ORIGIN);
  assert.equal((await call('POST', '/login', { body: { credential: 'not.a.jwt' } })).status, 401);
});

test('deleting the account removes its rides, links, data, key and sessions', async () => {
  const who = 'gone-' + Date.now(), token = await signIn(who), id = linkId();
  await call('PUT', '/key', { token, body: { keyId: 'gone-key-id-0001' } });
  await call('POST', '/rides', { token, body: { name: 'Ride', trip: locked() } });
  await call('POST', '/links', { token, body: { id, trip: locked(), owner: 'o' } });
  await call('PUT', '/data', { token, body: { data: locked(), at: 5 } });
  assert.equal((await call('DELETE', '/me', { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).status, 401);
  assert.equal((await call('GET', `/links/${id}`)).status, 404);
  const again = await signIn(who);
  const me = (await call('GET', '/me', { token: again })).body;
  assert.deepEqual([me.rides.length, me.links.length, me.data, me.keyId], [0, 0, null, null]);
});

// Only refusals: a real clip would spend the day's Workers AI allowance (wrangler dev runs it on the real service).
test('the voice refuses what it can’t say, unknown voices, and other sites, before making anything', async () => {
  assert.equal((await call('POST', '/speak', { body: { text: 'onto Missouri D.', voice: 'nobody' } })).status, 400);
  assert.equal((await call('POST', '/speak', { body: { text: '<script>', voice: 'helena' } })).status, 400);
  assert.equal((await call('POST', '/speak', { body: { text: 'a'.repeat(121), voice: 'helena' } })).status, 400);
  assert.equal((await call('POST', '/speak', { body: { text: 'onto Missouri D.', voice: 'helena', format: 'ogg' } })).status, 400);
  assert.equal((await call('POST', '/speak', { body: { text: 'onto Missouri D.', voice: 'helena' }, origin: 'https://evil.example' })).status, 403);
});
