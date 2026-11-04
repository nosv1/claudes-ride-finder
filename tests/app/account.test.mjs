// Accounts in the app, in headless Edge/Chrome against a local copy of the API (wrangler dev). Run from the repo root:
//   node --test tests/app/account.test.mjs
// Two browsers stand in for the PC and the phone, signed in to the same made-up account. What the API holds is checked
// to be locked: nothing in it reads as the ride, its name or the settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { startWorker } from '../worker-dev.mjs';
import { unlock, linkParts } from '../../js/seal.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const WHO = 'test:rider-' + Date.now();

let server, base, worker, pc, phone;

async function open(page) {
  await page.goto(base);
  await page.waitFor('!!window.RF', 30000);
  await page.eval(`localStorage.setItem('rf2-api', ${JSON.stringify(worker.url)})`);
  await page.goto(base);
  await page.waitFor('window.RF && RF.store.roads.length > 0', 60000);
}
const sheet = page => page.eval("document.getElementById('sheetBody').innerText");
const token = page => page.eval("JSON.parse(localStorage.getItem('rf2-account')).token");
const api = async (page, path) => (await fetch(worker.url + path, { headers: { Authorization: 'Bearer ' + await token(page) } })).json();

before(async () => {
  server = createServer(async (req, res) => {
    let path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (/[\\/]$/.test(path)) path = join(path, 'index.html');
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch (e) {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  worker = await startWorker();
  pc = await launch();
  await open(pc);
  phone = await launch({ mobile: true });
  await open(phone);
});

after(() => {
  pc && pc.close();
  phone && phone.close();
  server && server.close();
  worker && worker.stop();
});

test('signed out: the account page offers Google sign-in, and the ride page points there', async () => {
  await pc.eval("RF.go('account')");
  assert.match(await sheet(pc), /Your rides on every device/);
  assert.equal(await pc.eval("!!document.querySelector('#sheetBody .gsi')"), true);
  await pc.eval(`(async () => { const T = await import('./js/trip.js'); T.addPoint(RF.trip, [37.07, -93.25], 'Coffee in Ozark'); RF.go('trip'); })()`);
  assert.match(await sheet(pc), /Sign in to keep this ride on every device/);
});

test('sign in, save the ride, and its changes save as you go', async () => {
  await pc.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  assert.equal(await pc.eval('RF.account.signedIn()'), true);
  await pc.waitFor("document.querySelector('.save-btn')");
  await pc.eval("document.querySelector('.save-btn').click()");
  await pc.waitFor('RF.account.rideId()');
  await pc.waitFor("document.querySelector('.ride-name')");
  assert.match(await sheet(pc), /In your rides\. Changes save as you go\./);

  // Rename it, and change it (Return to start): both reach the account, locked with the PC's key.
  await pc.eval(`(() => { const i = document.querySelector('.ride-name'); i.value = 'Ozark coffee run'; i.dispatchEvent(new Event('change')); })()`);
  await pc.eval("document.querySelector('.switch input').click()");
  const id = await pc.eval('RF.account.rideId()'), want = await pc.eval(`import('./js/trip.js').then(T => T.encodeTrip(RF.trip))`);
  const key = await pc.eval('RF.account.account.key');
  for (let i = 0; i < 40 && await unlock(key, (await api(pc, `/rides/${id}`)).trip) !== want; i++) await sleep(250);
  const saved = await api(pc, `/rides/${id}`);
  assert.equal(await unlock(key, saved.trip), want, 'the change was saved');
  assert.equal(await unlock(key, saved.name), 'Ozark coffee run');
  assert.notEqual(saved.trip, want, 'the service holds it locked');
  assert.doesNotMatch(JSON.stringify(saved), /Ozark/);
  assert.equal(await unlock('A'.repeat(43), saved.trip), null, 'another key doesn’t open it');
});

test('the phone signs in to the same account: the ride, settings and tags are there', async () => {
  // A setting and a road tag changed on the PC go to the account.
  await pc.eval(`(async () => {
    RF.settings.minSpeed = 55;
    const Tg = await import('./js/tags.js');
    Tg.setTags({ key: 'MO 150', roads: [{ id: 18518688, geom: [[38.9, -94.3], [38.9, -94.2]] }] }, ['great']);
    RF.account.dataChanged();
  })()`);
  const key = await pc.eval('RF.account.account.key');
  const synced = async () => JSON.parse(await unlock(key, (await api(pc, '/me')).data || '') || '{}');
  for (let i = 0; i < 40 && ((await synced()).settings || {}).minSpeed !== 55; i++) await sleep(250);
  assert.equal((await synced()).settings.minSpeed, 55);
  assert.doesNotMatch(JSON.stringify(await api(pc, '/me')), /minSpeed|MO 150|great/, 'settings and tags are locked');

  // The phone signs in, but can't read anything until it opens the PC's device link.
  await phone.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  await phone.waitFor('RF.account.account.locked');
  await phone.eval("RF.go('account')");
  assert.match(await sheet(phone), /Unlock your rides/);
  assert.notEqual(await phone.eval('RF.settings.minSpeed'), 55, 'nothing applied while locked');
  await phone.eval(`(async () => { const T = await import('./js/trip.js'); T.addPoint(RF.trip, [38.9, -94.3], 'Phone stop'); RF.go('trip'); })()`);
  assert.match(await sheet(phone), /Your rides are locked on this device/);

  const link = await pc.eval(`RF.account.deviceLink(${JSON.stringify(base)})`);
  assert.match(link, /#k=[\w-]{43}$/);
  await phone.goto(link);
  await phone.waitFor('!RF.account.account.locked && RF.account.account.rides && RF.account.account.rides.length === 1');
  assert.equal(await phone.eval('location.hash'), '', 'the key is taken out of the address');
  assert.equal(await phone.eval('RF.settings.minSpeed'), 55);
  assert.deepEqual(await phone.eval("import('./js/tags.js').then(Tg => Tg.allTags().map(t => t.key + ':' + t.tags))"), ['MO 150:great']);

  await phone.eval("RF.go('home')");
  await phone.waitFor("[...document.querySelectorAll('#sheetBody .card-title')].some(e => e.textContent === 'Ozark coffee run')");
  await phone.eval("[...document.querySelectorAll('#sheetBody .card')].find(e => e.textContent.includes('Ozark coffee run')).click()");
  await phone.waitFor("RF.trip.items.some(i => i.label === 'Coffee in Ozark')");
  assert.deepEqual(await phone.eval('RF.trip.items.map(i => i.label)'), await pc.eval('RF.trip.items.map(i => i.label)'));
  assert.equal(await phone.eval('RF.account.rideId()'), await pc.eval('RF.account.rideId()'));
});

test('Share makes a short link that opens the ride without signing in, and shows on the account page', async () => {
  await phone.eval("window.shared = null; navigator.share = async d => { window.shared = d.url; }; RF.go('trip')");
  await phone.eval("document.querySelector('.view-head .head-btn').click()");
  await phone.waitFor('window.shared');
  const url = await phone.eval('window.shared');
  assert.match(url, /#s=[\w-]{16}$/);
  // The service has the ride under a hash of the code, locked with a key made from the code: it can read neither.
  const code = url.split('#s=')[1], { id, key } = await linkParts(code);
  const held = (await (await fetch(`${worker.url}/links/${id}`)).json()).trip;
  assert.equal(await unlock(key, held), await phone.eval(`import('./js/trip.js').then(T => T.encodeTrip(RF.trip))`));
  assert.ok(!held.includes(code) && id !== code);
  const other = await launch();
  try {
    await other.goto(base);
    await other.waitFor('!!window.RF', 30000);
    await other.eval(`localStorage.setItem('rf2-api', ${JSON.stringify(worker.url)})`);
    await other.goto('about:blank');  // a fresh start, so the app reads the local API's address
    await other.goto(url);
    await other.waitFor('window.RF && RF.trip.items.length > 0', 30000);
    assert.deepEqual(await other.eval('RF.trip.items.map(i => i.label)'), await phone.eval('RF.trip.items.map(i => i.label)'));
    assert.equal(await other.eval('RF.account.signedIn()'), false);
  } finally {
    other.close();
  }
  await phone.eval("RF.go('account')");
  await phone.waitFor("document.getElementById('sheetBody').innerText.includes('Rides you’ve shared')");
});

test('a ride deleted on the PC leaves the phone’s list when the phone comes back to the app', async () => {
  const id = await pc.eval('RF.account.rideId()');
  assert.equal(await phone.eval('RF.account.rideId()'), id, 'the phone has it open');
  const stops = await phone.eval('RF.trip.items.length');
  await pc.eval(`RF.account.deleteRide(${JSON.stringify(id)})`);
  // Switching back to the app: the page becomes visible again (looks are at most every 30 s, so as if it's been that long).
  await phone.eval(`(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Date.realNow = Date.realNow || Date.now;
    const later = Date.realNow() + 31000;
    Date.now = () => later;
    document.dispatchEvent(new Event('visibilitychange'));
    Date.now = Date.realNow;
  })()`);
  await phone.waitFor('RF.account.account.rides.length === 0');
  assert.equal(await phone.eval('RF.account.rideId()'), null, 'no longer saving to the deleted ride');
  assert.equal(await phone.eval('RF.trip.items.length'), stops, 'its stops stay on screen');
});

test('with the service down, Share falls back to the long link', async () => {
  await phone.eval(`(async () => {
    window.realFetch = window.realFetch || fetch;
    window.fetch = (u, o) => String(u).startsWith(${JSON.stringify(worker.url)}) ? Promise.reject(new TypeError('offline')) : realFetch(u, o);
    window.shared = null; RF.go('trip');
  })()`);
  await phone.eval("document.querySelector('.view-head .head-btn').click()");
  await phone.waitFor('window.shared');
  assert.match(await phone.eval('window.shared'), /#r=[\w-]+$/);
  await phone.eval('window.fetch = realFetch');
});

test('deleting the account takes everything with it and signs you out', async () => {
  const old = await token(phone);
  await phone.eval("RF.go('account')");
  const del = "[...document.querySelectorAll('#sheetBody .btn')].find(b => /Delete account|Tap again/.test(b.textContent))";
  await phone.eval(`${del}.click()`);
  assert.match(await sheet(phone), /Tap again to delete everything/);
  await phone.eval(`${del}.click()`);
  await phone.waitFor('!RF.account.signedIn()');
  const res = await fetch(worker.url + '/me', { headers: { Authorization: 'Bearer ' + old } });
  assert.equal(res.status, 401);
  // The PC's session went with the account too.
  const pcMe = await fetch(worker.url + '/me', { headers: { Authorization: 'Bearer ' + await token(pc) } });
  assert.equal(pcMe.status, 401);
});
