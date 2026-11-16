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
import { lock, unlock, linkParts } from '../../js/seal.js';

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

test('planning never changes a saved ride: it makes a new one; a ride is selected only from your rides', async () => {
  const id = await pc.eval('RF.account.rideId()');
  const before = (await api(pc, `/rides/${id}`)).trip, labels = await pc.eval('RF.trip.items.map(i => i.label)');
  // Selected: the home bar names it (the bar shows once there's a route; the router isn't asked in these tests).
  await pc.eval("RF.setRoute({ path: [[38.9, -94.3], [38.95, -94.35]], meters: 8000, seconds: 600, maneuvers: [] }); RF.go('home')");
  await pc.waitFor("document.querySelector('.ride-bar') && /Ozark coffee run · from your rides/.test(document.querySelector('.ride-bar').innerText)", 15000);
  // Start a ride here (from the map): a new ride, and the saved one stays as it was.
  await pc.eval("RF.mapView.emit('menu', [38.95, -94.4], { x: 700, y: 400 })");
  await pc.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Start a ride here/.test(b.textContent)).click()");
  assert.equal(await pc.eval('RF.account.rideId()'), null, 'no ride selected');
  assert.match(await pc.eval("document.getElementById('toast').innerText"), /New ride\. Ozark coffee run stays in your rides as it was\./);
  await sleep(2500);  // longer than a save takes
  assert.equal((await api(pc, `/rides/${id}`)).trip, before, 'the saved ride wasn’t touched');
  assert.equal(await pc.eval("RF.account.account.rides.length"), 1, 'and nothing else was saved');
  // Picking it from your rides selects it again, as it was.
  const toastText = () => pc.eval("document.getElementById('toast').innerText");
  const openSaved = async (name, rid) => {
    const card = `[...document.querySelectorAll('#sheetBody .card')].find(e => e.querySelector('.card-title')?.textContent === ${JSON.stringify(name)})`;
    await pc.eval("RF.go('account')");
    await pc.waitFor(card);
    await pc.eval(`${card}.click()`);
    await pc.waitFor(`RF.account.rideId() === ${JSON.stringify(rid)} && RF.view === 'trip'`);
  };
  const openOzark = () => openSaved('Ozark coffee run', id);
  await openOzark();
  assert.deepEqual(await pc.eval('RF.trip.items.map(i => i.label)'), labels);
  // Plan a ride says so up front; a Generate that stops before changing anything (one way, no end) leaves it selected.
  await pc.eval("RF.go('plan')");
  assert.match(await sheet(pc), /Planning here makes a new ride\. Ozark coffee run stays in your rides as it is\./);
  const shape = l => pc.eval(`[...document.querySelectorAll('#sheetBody .seg.shape button')].find(b => b.textContent === '${l}').click()`);
  await shape('One way');
  await pc.eval("document.querySelector('#sheetBody .cta').click()");
  await pc.waitFor("/Set where you’re headed first/.test(RF.gen.status)");
  assert.equal(await pc.eval('RF.account.rideId()'), id, 'still selected');
  await shape('Loop');
  // New ride: the saved one stays as it was, and Undo selects it again.
  await pc.eval("RF.go('trip')");
  const newRideBtn = "[...document.querySelectorAll('#sheetBody .btn')].find(b => /New ride/.test(b.textContent))";
  const newRide = async () => { await pc.waitFor(newRideBtn); await pc.eval(`${newRideBtn}.click()`); };
  const undo = () => pc.eval("[...document.querySelectorAll('#toast button')].find(b => b.textContent === 'Undo').click()");
  await newRide();
  assert.equal(await pc.eval('RF.account.rideId()'), null);
  assert.match(await toastText(), /New ride\. Ozark coffee run stays in your rides as it was\./);
  await undo();
  assert.equal(await pc.eval('RF.account.rideId()'), id);
  assert.deepEqual(await pc.eval('RF.trip.items.map(i => i.label)'), labels);
  // Loops listed for another ride don't stay on screen once a saved ride is opened (a card there would replace it).
  await newRide();
  await pc.eval('RF.gen.options.push({ items: [], route: null })');
  await openOzark();
  assert.equal(await pc.eval('RF.gen.options.length'), 0);
  // Undo puts back the ride that was on screen, loops and all.
  await undo();
  assert.equal(await pc.eval('RF.account.rideId()'), null);
  assert.equal(await pc.eval('RF.gen.options.length'), 1, 'the listed loops are back');
  await pc.eval('RF.gen.options.length = 0');
  // A pick on the map that was waiting is called off when a saved ride is opened.
  await pc.eval("RF.go('plan')");
  await pc.waitFor("[...document.querySelectorAll('#sheetBody .btn')].some(b => b.textContent.includes('Pick on map'))");
  await pc.eval("[...document.querySelectorAll('#sheetBody .btn')].find(b => b.textContent.includes('Pick on map')).click()");
  assert.equal(await pc.eval("document.getElementById('pickBanner').hidden"), false);
  await openOzark();
  assert.equal(await pc.eval("document.getElementById('pickBanner').hidden"), true, 'no pick waiting');
  // Planning still on its way when a saved ride is opened stops: a location fix (or a failure to get one) that comes
  // afterwards changes nothing and says nothing, for Generate (still finding the start) and for My location.
  await pc.eval('window.fixes = []; navigator.geolocation.getCurrentPosition = (ok, fail) => fixes.push({ ok, fail })');
  const generateBtn = "document.querySelector('#sheetBody .cta')";
  const myLocationBtn = "[...document.querySelectorAll('#sheetBody .btn')].find(b => b.textContent.includes('My location'))";
  for (const [button, found] of [[generateBtn, true], [generateBtn, false], [myLocationBtn, true], [myLocationBtn, false]]) {
    await pc.eval("RF.go('trip')");
    await newRide();
    await pc.eval("RF.go('plan')");
    await pc.waitFor(button);
    await pc.eval(`${button}.click()`);
    await pc.waitFor('fixes.length === 1');
    await openOzark();
    await pc.eval(found ? 'fixes.splice(0).forEach(f => f.ok({ coords: { latitude: 38.95, longitude: -94.4, accuracy: 20 } }))'
      : 'fixes.splice(0).forEach(f => f.fail({ code: 1 }))');
    await sleep(500);
    assert.equal(await pc.eval('RF.account.rideId()'), id, 'still selected');
    assert.deepEqual(await pc.eval('RF.trip.items.map(i => i.label)'), labels, 'its start wasn’t replaced');
    assert.match(await toastText(), /^Opened Ozark coffee run/, 'the Undo for opening it is still there');
    assert.equal(await pc.eval('RF.gen.status'), '', 'and its planner says nothing');
  }
  // Generate finding your location, and a start picked on the map meanwhile: that start is the one it uses.
  await pc.eval("RF.go('trip')");
  await newRide();
  await pc.eval("RF.go('plan')");
  await pc.waitFor(generateBtn);
  await pc.eval(`${generateBtn}.click()`);
  await pc.waitFor('fixes.length === 1');
  await pc.eval("[...document.querySelectorAll('#sheetBody .btn')].find(b => b.textContent.includes('Pick on map')).click()");
  await pc.eval("RF.mapView.emit('empty', [38.9, -94.5])");
  await pc.eval('fixes.splice(0).forEach(f => f.ok({ coords: { latitude: 38.95, longitude: -94.4, accuracy: 20 } }))');
  await sleep(300);
  assert.equal(await pc.eval('RF.trip.items[0].label'), 'Start', 'the picked start stays');
  if (await pc.eval('RF.gen.running')) await pc.eval(`${generateBtn}.click()`);  // Stop: the router isn't asked here
  // Save to your rides still on its way when a saved ride is opened: it's saved, but the ride opened stays selected
  // (its Undo too), and Undo brings back the ride that was on screen, not selected (it wasn't yet).
  await pc.eval("RF.go('trip')");
  await pc.waitFor("document.querySelector('#sheetBody .save-btn')");
  await pc.eval(`window.realFetch = window.realFetch || fetch; window.held = [];
    window.fetch = (u, o) => o && o.method === 'POST' && String(u).endsWith('/rides') ? new Promise(r => held.push(() => r(realFetch(u, o)))) : realFetch(u, o)`);
  await pc.eval("document.querySelector('#sheetBody .save-btn').click()");
  await pc.waitFor('held.length === 1');
  await pc.eval('window.fetch = realFetch');
  await openOzark();
  await pc.eval('held.splice(0).forEach(f => f())');
  await pc.waitFor('RF.account.account.rides.length === 2');
  await sleep(300);
  assert.equal(await pc.eval('RF.account.rideId()'), id, 'the ride opened is still the one selected');
  assert.match(await toastText(), /^Opened Ozark coffee run/);
  const other = await pc.eval(`RF.account.account.rides.find(r => r.id !== ${JSON.stringify(id)})`);
  const otherBefore = (await api(pc, `/rides/${other.id}`)).trip;
  await undo();
  assert.equal(await pc.eval('RF.account.rideId()'), null);
  // Open that ride, then Ozark, then Undo: it's selected again, and not saved straight back.
  await openSaved(other.name, other.id);
  await openOzark();
  await undo();
  assert.equal(await pc.eval('RF.account.rideId()'), other.id);
  await sleep(2500);
  assert.equal((await api(pc, `/rides/${other.id}`)).trip, otherBefore, 'not saved straight back');
  await openOzark();
  await pc.eval(`RF.account.deleteRide(${JSON.stringify(other.id)})`);
  await pc.eval('delete navigator.geolocation.getCurrentPosition');
  // Save to your rides on its way, then planning makes the ride on screen a new one (Start a ride here): the save
  // doesn't select it, and what was planned isn't saved into it.
  const startHere = async at => {
    await pc.eval(`RF.mapView.emit('menu', ${JSON.stringify(at)}, { x: 700, y: 400 })`);
    await pc.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Start a ride here/.test(b.textContent)).click()");
  };
  await newRide();
  await startHere([38.95, -94.4]);
  await pc.eval("RF.go('trip')");
  await pc.waitFor("document.querySelector('#sheetBody .save-btn')");
  await pc.eval(`window.held = [];
    window.fetch = (u, o) => o && o.method === 'POST' && String(u).endsWith('/rides') ? new Promise(r => held.push(() => r(realFetch(u, o)))) : realFetch(u, o)`);
  await pc.eval("document.querySelector('#sheetBody .save-btn').click()");
  await pc.waitFor('held.length === 1');
  await pc.eval('window.fetch = realFetch');
  await startHere([38.9, -94.5]);
  await pc.eval('held.splice(0).forEach(f => f())');
  await pc.waitFor('RF.account.account.rides.length === 2');
  await sleep(300);
  assert.equal(await pc.eval('RF.account.rideId()'), null, 'the planned ride is a new one, not the ride just saved');
  assert.match(await toastText(), /^Saved to your rides as it was when you tapped Save/, 'and it says the save went');
  const planned = await pc.eval(`RF.account.account.rides.find(r => r.id !== ${JSON.stringify(id)}).id`);
  const plannedBefore = (await api(pc, `/rides/${planned}`)).trip;
  await sleep(2500);
  assert.equal((await api(pc, `/rides/${planned}`)).trip, plannedBefore, 'nothing planned was saved into it');
  await pc.eval(`RF.account.deleteRide(${JSON.stringify(planned)})`);
  await openOzark();
  // After a reload this device doesn't know how Ozark stands: New ride, then Undo, doesn't send its copy back
  // (the check at the end: Ozark is still as it was).
  await pc.goto(base);
  await pc.waitFor(`RF.account.rideId() === ${JSON.stringify(id)} && RF.account.account.rides?.length === 1`, 30000);
  await pc.eval("RF.go('trip')");
  await newRide();
  await undo();
  assert.equal(await pc.eval('RF.account.rideId()'), id);
  await sleep(2500);
  assert.equal((await api(pc, `/rides/${id}`)).trip, before, 'the saved ride wasn’t touched');
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

// Saving to a saved ride on the PC. What the account holds is asked with the phone's session and key (the PC signs
// out along the way).
const packed = () => pc.eval("import('./js/trip.js').then(T => T.encodeTrip(RF.trip))");
const inAccount = async rid => unlock(await phone.eval('RF.account.account.key'), (await api(phone, `/rides/${rid}`)).trip);
async function toggle() {  // Return to start, on the ride page
  if (await pc.eval('RF.view') !== 'trip') await pc.eval("RF.go('trip')");
  await pc.waitFor("document.querySelector('.switch input')");
  await pc.eval("document.querySelector('.switch input').click()");
}
async function saveNew() {
  await pc.eval("RF.go('trip')");
  await pc.waitFor("document.querySelector('#sheetBody .save-btn')");
  await pc.eval("document.querySelector('#sheetBody .save-btn').click()");
  await pc.waitFor('RF.account.rideId()');
  await pc.waitFor("document.querySelector('.switch input')");
  return pc.eval('RF.account.rideId()');
}
// hold(match): the calls match picks wait for held.shift()() (sent then, or sent now and answered then).
const hold = (match, { sendNow = false } = {}) => pc.eval(`window.realFetch = window.realFetch || fetch; window.held = []; window.sent = [];
  window.fetch = (u, o) => {
    sent.push(String(u));
    const go = () => realFetch(u, o), p = ${sendNow} ? go() : null;
    return (${match})(String(u), o || {}) ? new Promise(r => held.push(() => r(p || go()))) : p || go();
  }`);
const putRide = "(u, o) => o.method === 'PUT' && u.includes('/rides/')";
// No signal for saves to a ride: they fail at once.
const offline = () => pc.eval(`window.realFetch = window.realFetch || fetch;
  window.fetch = (u, o) => o && o.method === 'PUT' && String(u).includes('/rides/') ? Promise.reject(new TypeError('offline')) : realFetch(u, o)`);
const online = () => pc.eval('window.fetch = window.realFetch || fetch');

test('changes to a saved ride get there in order, before a delete or sign-out, and after a reload', async () => {
  // A change made while a save is on its way waits for it, so the newer copy is the one that stays.
  let id = await saveNew();
  await hold(putRide);
  await toggle();
  await pc.waitFor('held.length === 1', 5000);
  await toggle();
  const want = await packed();
  await sleep(2500);
  assert.equal(await pc.eval('held.length'), 1, 'the second save waits for the first');
  await pc.eval('held.shift()()');
  await pc.waitFor('held.length === 1', 5000);
  await pc.eval('held.shift()()');
  await pc.waitFor('!RF.account.account.saving', 5000);
  assert.equal(await inAccount(id), want);
  await pc.eval('window.fetch = realFetch');

  // Deleted with a change still waiting: the change goes first, so Undo brings the ride back with it.
  await toggle();
  const edited = await packed();
  assert.equal(await pc.eval(`RF.account.deleteRide(${JSON.stringify(id)}).then(w => w.trip)`), edited);

  // Deleted on the phone with a change waiting here: once the PC sees it's gone, nothing is sent to it.
  id = await saveNew();
  await toggle();
  await phone.eval(`RF.account.deleteRide(${JSON.stringify(id)})`);
  await pc.eval('RF.account.refresh()');
  await sleep(2000);
  assert.equal(await pc.eval('RF.account.rideId()'), null);
  assert.equal(await pc.eval('RF.account.account.error'), '', 'nothing was sent to the deleted ride');

  // Save to your rides, then sign out while it's on its way: the signed-out device doesn't keep it selected.
  await pc.waitFor("document.querySelector('#sheetBody .save-btn')");
  await hold("(u, o) => o.method === 'POST' && u.endsWith('/rides')", { sendNow: true });
  await pc.eval("document.querySelector('#sheetBody .save-btn').click()");
  await pc.waitFor('held.length === 1');
  await pc.eval('RF.account.signOut()');
  await pc.eval('held.shift()()');
  await sleep(500);
  assert.equal(await pc.eval("localStorage.getItem('rf2-ride-id')"), null, 'no ride selected for an account signed out of');
  assert.equal(await pc.eval("document.getElementById('toast').innerText"), 'Saved to your rides.', 'and changes don’t save');
  await pc.eval('window.fetch = realFetch');

  // Sign out while a save is on its way: it gets there before the session ends.
  await pc.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  id = await saveNew();
  await hold(putRide);
  await toggle();
  const last = await packed();
  await pc.waitFor('held.length === 1', 5000);
  await pc.eval('window.out = RF.account.signOut(), 0');
  await sleep(500);
  assert.equal(await pc.eval("sent.some(u => u.endsWith('/logout'))"), false, 'the sign-out waits for the save');
  await pc.eval('held.shift()()');
  await pc.eval('out');
  assert.equal(await inAccount(id), last);
  await pc.eval('window.fetch = realFetch');

  // A save that failed (no signal) isn't lost when the app closes: it goes once the app is back and your rides load.
  await pc.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  id = await saveNew();
  await offline();
  await toggle();
  const unsent = await packed();
  await pc.waitFor('RF.account.account.error', 5000);
  assert.notEqual(await inAccount(id), unsent);
  await pc.goto(base);
  await pc.waitFor(`RF.account.rideId() === ${JSON.stringify(id)} && RF.account.account.rides?.length > 0`, 30000);
  for (let i = 0; i < 40 && await inAccount(id) !== unsent; i++) await sleep(250);
  assert.equal(await inAccount(id), unsent, 'sent after the reload');
  await pc.waitFor("!localStorage.getItem('rf2-unsent')", 5000);
});

test('a change kept for later goes only while it’s the newest, and isn’t lost to a reload, an expired session or a slow sign-out', async () => {
  const reload = async rid => {
    await pc.goto(base);
    await pc.waitFor(`RF.account.rideId() === ${JSON.stringify(rid)} && RF.account.account.rides?.length > 0`, 30000);
  };
  const reaches = async (rid, want, what) => {
    for (let i = 0; i < 40 && await inAccount(rid) !== want; i++) await sleep(250);
    assert.equal(await inAccount(rid), want, what);
  };
  // The phone saves trip to the ride, as a device that doesn't know of this one's changes.
  const phoneSaves = async (rid, trip) => {
    const locked = await lock(await phone.eval('RF.account.account.key'), trip);
    assert.equal(await phone.eval(`fetch(${JSON.stringify(`${worker.url}/rides/${rid}`)}, { method: 'PUT',
      headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('rf2-account')).token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip: ${JSON.stringify(locked)} }) }).then(r => r.status)`), 200, 'the phone changed it');
  };
  const kept = rid => pc.eval(`JSON.parse(localStorage.getItem('rf2-unsent'))?.[${JSON.stringify(rid)}] ?? null`);
  const toastText = () => pc.eval("document.getElementById('toast').innerText");

  // A change that failed here, then the ride changed on the phone: the phone's change stays, and the ride on screen
  // here is just a ride now (it says so).
  let id = await pc.eval('RF.account.rideId()');
  const theirs = await packed();
  await offline();
  await toggle();
  await pc.waitFor('RF.account.account.error', 5000);
  await phoneSaves(id, theirs);
  await pc.goto(base);
  await pc.waitFor('RF.account.account.rides?.length > 0 && RF.account.rideId() === null', 30000);
  await sleep(500);
  assert.equal(await inAccount(id), theirs, 'the change made later on the phone wasn’t overwritten');
  assert.match(await toastText(), /was changed on another device, so this copy wasn’t saved there/);
  assert.equal(await kept(id), null);

  // Back to the copy whose save is on its way, then the app closes before it gets there: it goes after the reload.
  id = await saveNew();
  await hold(putRide);
  await toggle();
  const onItsWay = await packed();
  await pc.waitFor('held.length === 1', 5000);
  await toggle();
  await toggle();
  assert.equal(await packed(), onItsWay);
  await reload(id);
  await reaches(id, onItsWay, 'sent after the reload');

  // A change that failed, then the ride is renamed: a new name isn't a change to the ride, so the change still goes.
  await offline();
  await toggle();
  const beforeRename = await packed();
  await pc.waitFor('RF.account.account.error', 5000);
  await online();
  await pc.eval(`RF.account.renameRide(${JSON.stringify(id)}, 'Renamed run')`);
  await pc.eval('RF.account.refresh()');
  await reaches(id, beforeRename, 'sent after the rename');
  assert.equal(await pc.eval('RF.account.rideId()'), id, 'still selected');

  // No signal for a while, so several saves in a row get no answer: once it's back, the change still goes (it isn't
  // taken for another device's).
  await offline();
  for (let i = 0; i < 3; i++) {
    await pc.eval("RF.account.account.error = ''");
    await toggle();
    await pc.waitFor('RF.account.account.error', 5000);
  }
  await online();
  await toggle();
  await reaches(id, await packed(), 'sent once the signal is back');
  assert.equal(await pc.eval('RF.account.rideId()'), id, 'still selected after no signal');

  // Changed before Your rides have loaded (no key yet): it goes once they have, unless the phone changed the ride
  // meanwhile.
  await pc.eval('RF.account.account.key = null');
  await toggle();
  const early = await packed();
  assert.equal(await kept(id), early, 'kept');
  await pc.eval('RF.account.refresh()');
  await reaches(id, early, 'sent once Your rides loaded');
  await pc.eval('RF.account.account.key = null; RF.account.account.rides = null');
  await toggle();
  await phoneSaves(id, early);
  const phoneCopy = (await api(phone, `/rides/${id}`)).trip;
  await pc.eval('RF.account.refresh()');
  await pc.waitFor('RF.account.rideId() === null', 5000);
  assert.equal((await api(phone, `/rides/${id}`)).trip, phoneCopy, 'the phone’s change stays');

  // A change that failed, then the session runs out: it goes once you sign in again.
  id = await saveNew();
  await offline();
  await toggle();
  const beforeExpiry = await packed();
  await pc.waitFor('RF.account.account.error', 5000);
  await pc.eval(`window.realFetch(${JSON.stringify(`${worker.url}/logout`)}, { method: 'POST',
    headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('rf2-account')).token } })`);  // the session ends elsewhere
  await online();
  await pc.eval('RF.account.refresh().catch(() => 0)');
  assert.equal(await pc.eval('RF.account.signedIn()'), false);
  await pc.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  await reaches(id, beforeExpiry, 'sent after signing in again');

  // Sign out while a save is on its way, and change the ride again meanwhile: that change gets there too.
  id = await saveNew();
  await hold(putRide);
  await toggle();
  await pc.waitFor('held.length === 1', 5000);
  await pc.eval('window.out = RF.account.signOut(), 0');
  await toggle();
  const meanwhile = await packed();
  await pc.eval('held.shift()()');
  await pc.waitFor('held.length === 1', 5000);
  await pc.eval('held.shift()()');
  await pc.eval('out');
  assert.equal(await inAccount(id), meanwhile);
  await online();

  // Something going wrong after a save (here, something listening to the account) doesn't stop the saves after it.
  await pc.eval(`RF.account.finishSignIn(${JSON.stringify(WHO)})`);
  id = await saveNew();
  await pc.eval(`window.boom = true; RF.account.onAccountChanged(() => {
    if (window.boom && !RF.account.account.saving) { window.boom = false; throw new Error('a listener went wrong'); }
  })`);
  await toggle();
  await pc.waitFor('!window.boom', 5000);
  await toggle();
  await reaches(id, await packed(), 'the next save still went');
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

// Last: nothing the pages did along the way failed a check (CODING.md, rule 5) or threw without being caught.
test('no failed checks or uncaught errors on the pages', () => {
  assert.deepEqual(pc.logs.filter(l => /^Check failed|^EXCEPTION/.test(l)), []);
  assert.deepEqual(phone.logs.filter(l => /^Check failed|^EXCEPTION/.test(l)), []);
});
