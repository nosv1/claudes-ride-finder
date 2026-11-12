// Behaviour tests for v2 in headless Edge/Chrome. Run from the repo root:
//   node --test tests/app/browser.test.mjs
//   RF_NETWORK=1 node --test tests/app/browser.test.mjs   (adds routing and the generator)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NETWORK = !!process.env.RF_NETWORK;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let server, base, page;
const MO150 = 18518688;

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
  page = await launch();
  await page.goto(base);
  await page.waitFor("window.RF && RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).length > 0", 60000);
});

after(() => {
  page && page.close();
  server && server.close();
});

const rendered = id => page.eval(`RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid', 'roads-dashed'] }).some(f => f.properties.i === ${id})`);
const sheetText = () => page.eval("document.getElementById('sheetBody').innerText");

async function showMo150() {
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.33, 38.835], zoom: 13 })");
  await page.waitFor(`RF.store.byId.has(${MO150}) && RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.i === ${MO150})`, 30000);
}

test('loads roads, draws them, and lists the best ones', async () => {
  assert.ok(await page.eval('RF.store.roads.length') > 1000);
  assert.equal(await page.eval("document.querySelectorAll('#chips .chip').length"), 7);
  // The curve classes, plus Highways & ramps with All roads, and Roller coasters.
  assert.equal(await page.eval("document.querySelectorAll('.legend-chip:not(.key-btn)').length"), 7);
  assert.match(await page.eval("[...document.querySelectorAll('.legend-chip')].map(c => c.textContent).join('|')"), /Roller coasters/);
  assert.match(await sheetText(), /Best roads in view/);
  assert.ok(await page.eval("document.querySelectorAll('.road-card').length") > 0);
});

test('MO-150 east of Lee\'s Summit shows as a sweeper', async () => {
  await showMo150();
  const r = await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); return { cls: r.cls, speed: r.speed }; })()`);
  assert.deepEqual(r, { cls: 0, speed: 55 });
});

test('tapping a road opens its card at that spot, and Add to ride adds it', async () => {
  await showMo150();
  await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); RF.mapView.emit('road', r.id, r.geom[2]); })()`);
  await sleep(300);
  assert.match(await sheetText(), /MO 150[\s\S]*Add to ride/);
  const at = await page.eval(`RF.store.byId.get(${MO150}).geom[2]`);
  const sv = await page.eval("new URL([...document.querySelectorAll('#sheetBody a')].find(a => /Street View/.test(a.textContent)).href).searchParams.get('viewpoint')");
  const [lat, lon] = sv.split(',').map(Number);
  assert.ok(Math.abs(lat - at[0]) < 0.001 && Math.abs(lon - at[1]) < 0.001, `Street View at the tap, got ${sv}`);
  const headings = await page.eval("[...document.querySelectorAll('#sheetBody a')].filter(a => /pano/.test(a.href)).map(a => +new URL(a.href).searchParams.get('heading'))");
  assert.equal(headings.length, 2, 'Street View and the other way');
  assert.equal((headings[1] - headings[0] + 360) % 360, 180);
  const before = await page.eval('RF.trip.items.length');
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Add to ride/.test(b.textContent)).click()");
  assert.equal(await page.eval('RF.trip.items.length'), before + 1);
  assert.equal(await page.eval('RF.trip.items.at(-1).label'), 'MO 150');
});

test('turning off a curve class hides those roads', async () => {
  await showMo150();
  await page.eval("document.querySelector('.view-head .icon-btn') && document.querySelector('.view-head .icon-btn').click()");  // back to the list
  await sleep(200);
  await page.eval("document.querySelectorAll('.legend-chip')[0].click()");  // Sweepers
  await sleep(600);
  assert.equal(await rendered(MO150), false);
  await page.eval("document.querySelectorAll('.legend-chip')[0].click()");
  await page.waitFor(`RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.i === ${MO150})`, 10000);
});

test('the Highways road type shows the fast ramps at the Grandview Triangle and the I-435 bend in Lenexa', async () => {
  await page.eval("document.querySelector('.view-head .icon-btn') && document.querySelector('.view-head .icon-btn').click()");
  const roadType = async label => {
    await page.eval("document.querySelectorAll('#chips .chip')[1].click()");
    await page.eval(`[...document.querySelectorAll('#menu .menu-item')].find(b => b.textContent.startsWith('${label}')).click()`);
  };
  // All roads (the default) already draws them, in one color next to the curvy roads.
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.525, 38.93], zoom: 13.5 })");
  await page.waitFor("RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.rt >= 0)", 30000);
  await roadType('Highways');
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.525, 38.93], zoom: 13.5 })");
  await page.waitFor("RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.rt >= 0)", 30000);
  // Only ramps, once the map has redrawn (Blue River Road, a 45 mph sweeper there, is in the frame before).
  await page.waitFor("RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).every(f => f.properties.rt >= 0)", 5000);
  await page.waitFor("/Fast ramps and highways in view/.test(document.getElementById('sheetBody').innerText) && document.querySelector('.road-card')", 10000);
  assert.match(await sheetText(), /Ramp to I 4/);
  // The I-435 bend in Lenexa: the highway itself, both directions, in the highway tiers.
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.768, 38.946], zoom: 13.5 })");
  await page.waitFor("RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).filter(f => f.properties.hwy === 1 && f.properties.rt >= 3).length >= 2", 30000);
  await page.waitFor("/I 435 heading/.test(document.getElementById('sheetBody').innerText)", 10000);
  // Back roads hides them; then back to All roads for the remaining tests.
  await roadType('Back roads');
  await page.waitFor("!RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.rt >= 0)", 10000);
  await roadType('All roads');
});

test('zoomed far out it loads no more roads, and speed-only roads only in Speed limits mode', async () => {
  const files = () => page.eval("[...document.querySelectorAll('script[src*=\"tiles/\"]')].map(s => s.src.split('/').pop())");
  await sleep(2000);  // what the last view asked for lands first, so it isn't counted as loaded zoomed out
  const before = await files();
  assert.ok(before.every(f => !f.endsWith('.s.js')), 'Best rides loads no speed-only files: ' + before.filter(f => f.endsWith('.s.js')));
  await page.eval("RF.go('home')");
  await page.eval("void RF.mapView.map.jumpTo({ center: [-97, 33], zoom: 4.5 })");  // all of Texas and more
  await sleep(1500);
  assert.equal((await files()).length, before.length, 'nothing loaded zoomed out');
  assert.match(await sheetText(), /Zoom in to see roads/);
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.33, 38.835], zoom: 10 })");
  await page.eval("document.querySelector('#chips .chip').click()");
  await page.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Speed limits/.test(b.textContent)).click()");
  await page.waitFor("[...document.querySelectorAll('script[src*=\"tiles/\"]')].some(s => s.src.endsWith('.s.js'))", 10000);
  await page.eval("document.querySelector('#chips .chip').click()");
  await page.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Best rides/.test(b.textContent)).click()");
});

test('tapping an uncolored road tags its speed limit right there', async () => {
  const MO7 = 517106224, I435 = 567231236;
  await page.eval("RF.go('home')");
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.284, 39.12], zoom: 14 })");
  await page.waitFor(`RF.store.byId.has(${MO7})`, 30000);
  await page.eval(`(() => { const r = RF.store.byId.get(${MO7}); RF.mapView.emit('empty', r.geom[Math.floor(r.geom.length / 2)]); })()`);
  await page.waitFor("/MO 7 · 55 mph/.test(document.querySelector('.tap-tag') ? document.querySelector('.tap-tag').innerText : '')", 15000);
  // A road only in the speed-limit tiles: loaded for the tap.
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.76, 38.95], zoom: 14 })");
  await page.eval("RF.mapView.emit('empty', [38.95, -94.76])");
  await page.waitFor(`RF.store.byId.has(${I435})`, 30000);
  await page.eval(`(() => { const r = RF.store.byId.get(${I435}); RF.mapView.emit('empty', r.geom[Math.floor(r.geom.length / 2)]); })()`);
  await page.waitFor("/I 435 · 70 mph/.test(document.querySelector('.tap-tag') ? document.querySelector('.tap-tag').innerText : '')", 15000);
});

test('search finds a route number and opens the road', async () => {
  await page.eval("(() => { const q = document.getElementById('q'); q.value = 'hwy 7'; q.dispatchEvent(new Event('input')); })()");
  await page.waitFor("document.querySelectorAll('#results .result').length > 0", 5000);
  assert.match(await page.eval("document.querySelector('#results .result').innerText"), /^MO 7/);
  await page.eval("document.querySelector('#results .result').click()");
  await page.waitFor("/MO 7/.test(document.getElementById('sheetBody').innerText) && /Add to ride/.test(document.getElementById('sheetBody').innerText)", 30000);
});

test('a searched place fills the box, opens its card, and its pin opens it again', async () => {
  await page.eval("RF.go('home')");
  await page.eval("(() => { const q = document.getElementById('q'); q.value = 'greenwood'; q.dispatchEvent(new Event('input')); })()");
  await page.waitFor("[...document.querySelectorAll('#results .result')].some(r => /^Greenwood/.test(r.innerText))", 10000);
  await page.eval("[...document.querySelectorAll('#results .result')].find(r => /^Greenwood/.test(r.innerText)).click()");
  await sleep(300);
  assert.match(await page.eval("document.getElementById('q').value"), /^Greenwood/);
  assert.match(await sheetText(), /Greenwood[\s\S]*Add to ride as a stop[\s\S]*Start here[\s\S]*End here/);
  // Away and back by tapping the pin, with real mouse input.
  await page.eval("RF.go('home')");
  await sleep(1200);  // the fly to the place
  const { x, y } = await page.eval("(() => { const r = document.querySelector('.search-pin').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  await page.mouse('mousePressed', x, y);
  await page.mouse('mouseReleased', x, y);
  await sleep(400);
  assert.match(await sheetText(), /Add to ride as a stop/);
  const before = await page.eval('RF.trip.items.length');
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Add to ride as a stop/.test(b.textContent)).click()");
  assert.equal(await page.eval('RF.trip.items.length'), before + 1);
  assert.match(await page.eval("document.getElementById('toast').innerText"), /Added Greenwood/);
  await page.eval("document.getElementById('qClear').click()");
  assert.equal(await page.eval("!!document.querySelector('.search-pin')"), false, 'clearing the search removes the pin');
});

// Drag a stop row by its grip with real mouse or touch input, from row `from` to row `to`.
async function dragRow(p, from, to, kind = 'mouse') {
  // Let any route that's being fetched land first: it adds the summary above the list.
  await sleep(450);
  await p.waitFor('!(RF.info && RF.info.loading)', 40000);
  await sleep(100);
  const { x, y, ty } = await p.eval(`(() => {
    const rows = [...document.querySelectorAll('.stops li')], g = rows[${from}].querySelector('.grip').getBoundingClientRect();
    const t = rows[${to}].getBoundingClientRect();
    return { x: g.left + g.width / 2, y: g.top + g.height / 2, ty: t.top + t.height * (${to} > ${from} ? 0.85 : 0.15) };
  })()`);
  const [down, moveT, up] = kind === 'mouse' ? ['mousePressed', 'mouseMoved', 'mouseReleased'] : ['touchStart', 'touchMove', 'touchEnd'];
  const send = kind === 'mouse' ? (t, a, b) => p.mouse(t, a, b) : (t, a, b) => p.touch(t, a, b);
  await send(down, x, y);
  for (let k = 1; k <= 8; k++) { await send(moveT, x, y + (ty - y) * k / 8); await sleep(30); }
  await send(up, x, ty);
  await sleep(200);
}

const pointTrip = `(async () => {
  const T = await import('./js/trip.js');
  RF.trip.items.length = 0;
  T.setStart(RF.trip, [38.852, -94.343], 'Start');
  ['A', 'B', 'C'].forEach((l, i) => T.addPoint(RF.trip, [38.86 + i * 0.01, -94.3], l));
  RF.go('trip');
})()`;

test('tapping a stop marker on the map opens the ride', async () => {
  await page.eval(pointTrip);
  await page.eval("RF.go('home')");
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.32, 38.87], zoom: 12 })");
  await sleep(500);
  const { x, y } = await page.eval("(() => { const r = [...document.querySelectorAll('.stop-marker')].find(m => m.textContent === '2').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  await page.mouse('mousePressed', x, y);
  await page.mouse('mouseReleased', x, y);
  await sleep(400);
  assert.match(await sheetText(), /Stops \(4\)/);
});

test('stops can be dragged into a new order', async () => {
  await page.eval(pointTrip);
  await page.waitFor("document.querySelectorAll('.stops li').length === 4");
  await dragRow(page, 1, 3);
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.label)'), ['Start', 'B', 'C', 'A']);
  await dragRow(page, 3, 1);
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.label)'), ['Start', 'A', 'B', 'C']);
});

test('removing stops one after another: the next ✕ stays under the finger; Clear all can be undone', async () => {
  await page.eval(pointTrip);
  await page.eval(`(async () => { const T = await import('./js/trip.js'); T.addPoint(RF.trip, [38.9, -94.28], 'D'); RF.go('trip'); })()`);
  await page.waitFor("document.querySelectorAll('.stops li').length === 5");
  const xAt = () => page.eval(`(() => { const b = document.querySelectorAll('.stops li')[1].querySelector('button[title=Remove]').getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  const [x, y] = await xAt();
  for (const left of [4, 3, 2]) {
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseReleased', x, y);
    await sleep(700);   // the route is being worked out again meanwhile
    assert.equal(await page.eval('RF.trip.items.length'), left);
    if (left > 2) assert.deepEqual(await xAt(), [x, y], 'next stop’s ✕ in the same place');
  }
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.label)'), ['Start', 'D']);
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Clear all/.test(b.textContent)).click()");
  assert.equal(await page.eval('RF.trip.items.length'), 0);
  await page.eval("[...document.querySelectorAll('#toast button')].find(b => /Undo/.test(b.textContent)).click()");
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.label)'), ['Start', 'D']);
});

test('stops can be dragged on a phone too', async () => {
  const phone = await launch({ mobile: true });
  try {
    await phone.goto(base);
    await phone.waitFor('window.RF && RF.store.roads.length > 0', 60000);
    await phone.eval(pointTrip);
    await phone.eval("document.getElementById('sheet').dataset.snap = 'full'");
    await sleep(400);
    await dragRow(phone, 1, 2, 'touch');
    assert.deepEqual(await phone.eval('RF.trip.items.map(i => i.label)'), ['Start', 'B', 'A', 'C']);
  } finally {
    phone.close();
  }
});

test('on a phone, hold a stop pin to pick it up and drag it: it rides above the thumb, and the map stays out of it', async () => {
  const phone = await launch({ mobile: true });
  try {
    await phone.goto(base);
    await phone.waitFor('window.RF && RF.store.roads.length > 0', 60000);
    await phone.eval(pointTrip);
    await sleep(400);
    await phone.eval("document.querySelector('#sheetBody .ride-ends button:not(.on)').click()");  // the pins go up with the next change
    await phone.eval("document.getElementById('sheet').dataset.snap = 'peek'");
    await phone.waitFor('RF.route', 60000);  // routing fits the map to the ride: after that, put the pin in view
    await sleep(1000);
    await phone.eval('void RF.mapView.map.jumpTo({ center: [-94.3, 38.86], zoom: 13 })');
    await phone.waitFor("(() => { const m = [...document.querySelectorAll('.stop-marker')].find(m => m.textContent === '2'); if (!m) return false;"
      + " const r = m.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === m; })()", 15000);
    const pin = () => phone.eval("(() => { const r = [...document.querySelectorAll('.stop-marker')].find(m => m.textContent === '2').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
    const before = await phone.eval('JSON.stringify(RF.trip.items[1].pts[0])');
    const center = await phone.eval('JSON.stringify(RF.mapView.map.getCenter())');

    // A swipe that starts on the pin: nothing moves (the pin is the pin's, and it wasn't picked up).
    let [x, y] = await pin();
    await phone.touch('touchStart', x, y);
    for (let k = 1; k <= 5; k++) { await phone.touch('touchMove', x + 12 * k, y); await sleep(16); }
    await phone.touch('touchEnd', x + 60, y);
    await sleep(500);
    assert.equal(await phone.eval('JSON.stringify(RF.trip.items[1].pts[0])'), before, 'a swipe doesn’t move the stop');
    assert.equal(await phone.eval('JSON.stringify(RF.mapView.map.getCenter())'), center, 'or the map');

    // Press and hold past the map's long-press time, then drag: the stop moves, the map doesn't, no menu.
    [x, y] = await pin();
    await phone.touch('touchStart', x, y);
    await sleep(800);
    assert.equal(await phone.eval("document.querySelector('.stop-marker.lifted')?.textContent"), '2', 'picked up');
    assert.equal(await phone.eval("document.getElementById('menu').hidden"), true, 'the map’s long-press menu stays shut');
    const [hx, hy] = await pin();
    assert.ok(Math.abs(hx - x) < 3 && Math.abs(y - hy - 40) < 3, `risen 40 px over the thumb, not thrown off: ${[hx - x, hy - y]}`);
    for (let k = 1; k <= 5; k++) { await phone.touch('touchMove', x - 16 * k, y + 10 * k); await sleep(16); }
    const [mx, my] = await pin();
    assert.ok(Math.abs(mx - (x - 80)) < 3 && Math.abs(my - (y + 50 - 40)) < 3, `follows the thumb: ${[mx - x, my - y]}`);
    await phone.touch('touchEnd', x - 80, y + 50);
    await sleep(500);
    assert.notEqual(await phone.eval('JSON.stringify(RF.trip.items[1].pts[0])'), before, 'the stop moved');
    assert.equal(await phone.eval('JSON.stringify(RF.mapView.map.getCenter())'), center, 'the map stayed put');
    assert.equal(await phone.eval("document.querySelectorAll('.stop-marker.lifted').length"), 0, 'and it was put down');
    assert.equal(await phone.eval("document.getElementById('menu').hidden"), true);
  } finally {
    phone.close();
  }
});

test('the version shows on the home list, and a newer one on the site is offered when the app comes back', async () => {
  await page.eval("RF.go('home')");
  await sleep(300);
  const { APP_VERSION } = await import('../../js/config.js');
  assert.match(await sheetText(), new RegExp(`Version ${APP_VERSION.replace(/\./g, '\.')}`));
  await page.eval(`(() => { const f = window.fetch; window.fetch = (u, o) => /version\.json/.test(String(u))
    ? Promise.resolve(new Response('{ "version": "2999.01.01.1" }')) : f(u, o); })()`);
  await page.eval("void document.dispatchEvent(new Event('visibilitychange'))");
  await sleep(500);
  assert.match(await page.eval("document.getElementById('toast').innerText"), /new version[\s\S]*2999\.01\.01\.1[\s\S]*Update/);
  assert.match(await sheetText(), /Update to 2999\.01\.01\.1/, 'and it stays on the home list');
  // The links at the bottom are on every page, minus the page you're on.
  for (const [v, not] of [['plan', null], ['account', /Your bike, and signing in|Your rides, bike and account/], ['about', /About, credits/]]) {
    await page.eval(`RF.go('${v}')`);
    await sleep(300);
    const foot = await page.eval("[...document.querySelectorAll('#sheetBody .foot-links')].map(f => f.innerText).join('|') + '|' + document.querySelector('#sheetBody > :last-child').innerText");
    assert.ok(foot.includes('Update to 2999.01.01.1') && foot.endsWith(`Version ${APP_VERSION}`), `${v}: ${foot}`);
    if (not) assert.doesNotMatch(foot, not, `${v}: no link to itself`);
    assert.equal(await page.eval("document.querySelectorAll('#sheetBody .fineprint.version').length"), 1, `${v}: one version line`);
  }
  await page.eval("RF.go('home')");
});

test('the ride summary says what it rides, and hovering or tapping a tag lights up those parts of the route', async () => {
  await showMo150();
  await page.eval(`(async () => {
    const T = await import('./js/trip.js');
    RF.trip.items.length = 0;
    T.setStart(RF.trip, [38.852, -94.343], 'Start');
    const { stretchOf } = await import('./js/roads.js'), s = RF.settings;
    const f = { ...s, mode: 'ride', classes: new Set(s.classes), speedBins: new Set(s.speedBins), rampTiers: new Set(s.rampTiers), zoom: 13 };
    T.addRoad(RF.trip, stretchOf(RF.store.roads, RF.store.byId.get(${MO150}), f));
    RF.go('trip');
  })()`);
  await sleep(300);
  await page.eval("document.querySelector('#sheetBody .ride-ends button:not(.on)').click()");  // routes it
  await page.waitFor("document.querySelector('.ride-mix .tag')", 60000);
  assert.match(await page.eval("document.querySelector('.ride-mix').innerText"), /Sweepers[\s\S]*fits your filters[\s\S]*MO 150/);
  const lit = () => page.eval("(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return RF.mapView.map.queryRenderedFeatures({ layers: ['focus'] }).length; })()");
  const tag = "[...document.querySelectorAll('.ride-mix .tag')].find(t => t.textContent === 'Sweepers')";
  await page.eval(`void ${tag}.dispatchEvent(new MouseEvent('mouseenter'))`);
  assert.ok(await lit() > 0, 'hovering Sweepers lights up the sweeper');
  await page.eval(`void ${tag}.dispatchEvent(new MouseEvent('mouseleave'))`);
  assert.equal(await lit(), 0, 'and it goes out after');
  await page.eval(`${tag}.click()`);
  await page.eval(`void ${tag}.dispatchEvent(new MouseEvent('mouseleave'))`);
  assert.ok(await lit() > 0, 'a tap keeps it lit (the phone way)');
  await page.eval(`${tag}.click()`);
  assert.equal(await lit(), 0, 'until tapped again');
  await page.eval("RF.trip.loop = true");
});

test('Add road on the ride page: tap a road, it goes in where it fits, and its ends can be switched', async () => {
  await showMo150();
  await page.eval(pointTrip);
  await page.waitFor("[...document.querySelectorAll('#sheetBody button')].some(b => b.textContent === 'Add road')");
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => b.textContent === 'Add road').click()");
  assert.match(await page.eval("document.getElementById('pickBanner').innerText"), /Tap a road/);
  await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); RF.mapView.emit('road', r.id, r.geom[2]); })()`);
  await sleep(300);
  const labels = await page.eval('RF.trip.items.map(i => i.label)');
  assert.ok(labels.includes('MO 150') && labels.length === 5, JSON.stringify(labels));
  assert.equal(await page.eval("document.getElementById('pickBanner').hidden"), true);
  assert.match(await page.eval("document.getElementById('toast').innerText"), /Added MO 150 as stop \d, in at the \w+ end/);
  const entry = await page.eval("JSON.stringify(RF.trip.items.find(i => i.label === 'MO 150').pts[0])");
  await page.eval("[...document.querySelectorAll('#toast button')].find(b => /Switch ends/.test(b.textContent)).click()");
  const it = await page.eval("(() => { const it = RF.trip.items.find(i => i.label === 'MO 150'); return { first: JSON.stringify(it.pts[0]), last: JSON.stringify(it.pts.at(-1)) }; })()");
  assert.equal(it.last, entry, 'entered from the other end now');
  assert.match(await sheetText(), /MO 150\s+\w+ end → \w+ end/);
});

test('a stop dropped on a colored road rides that road; Just a stop, and the stop list, switch between them', async () => {
  await showMo150();
  await page.eval(pointTrip);
  await page.waitFor("[...document.querySelectorAll('#sheetBody button')].some(b => b.textContent === 'Add stop')");
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => b.textContent === 'Add stop').click()");
  await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); RF.mapView.emit('road', r.id, r.geom[2]); })()`);
  await sleep(300);
  assert.equal(await page.eval("RF.trip.items.filter(i => i.label === 'MO 150' && i.type === 'road').length"), 1);
  await page.eval("[...document.querySelectorAll('#toast button')].find(b => b.textContent === 'Just a stop').click()");
  await sleep(300);
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.type + ":" + i.label)'), ['point:Start', 'point:A', 'point:B', 'point:C', 'point:Stop']);
  // A plain stop on the road says so, and its button makes it the road, in the same place.
  assert.match(await sheetText(), /Stop on MO 150/);
  await page.eval("document.querySelector('#sheetBody button[title=\"Ride MO 150 end to end\"]').click()");
  await sleep(300);
  assert.deepEqual(await page.eval('RF.trip.items.map(i => i.type + ":" + i.label)'), ['point:Start', 'point:A', 'point:B', 'point:C', 'road:MO 150']);
});

test('the ride page can generate loops through its stops', async () => {
  await page.eval(pointTrip);
  await page.waitFor("[...document.querySelectorAll('#sheetBody button')].some(b => /Generate loops through these stops/.test(b.textContent))");
  assert.match(await sheetText(), /Generate a loop[\s\S]*1½ h/);
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Generate loops through these stops/.test(b.textContent)).click()");
  await sleep(100);
  assert.match(await sheetText(), /Plan a ride[\s\S]*Must include/);
  assert.ok(await page.eval("[...document.querySelectorAll('#sheetBody button')].some(b => b.textContent === 'Stop')"), 'the button stops it');
  // Changing a filter stops it: the rides it was building are on roads the map no longer shows.
  const paved = "[...document.querySelectorAll('#chips .chip')].find(c => c.textContent === 'Paved').click()";
  await page.eval(paved);
  await sleep(300);
  assert.equal(await page.eval('RF.gen.running'), false);
  assert.match(await sheetText(), /Stopped: the filters changed/);
  await page.eval(paved);
  await sleep(3000);  // what was in flight comes back to nothing
  assert.deepEqual([await page.eval('RF.gen.running'), await page.eval('RF.gen.options.length')], [false, 0]);
});

test('one way: pick an end, and the planner finds fun ways there that finish at it', async () => {
  await page.eval("RF.go('plan')");
  await page.eval("RF.mapView.emit('menu', [38.88956, -94.38724], { x: 700, y: 400 })");
  await page.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Start a ride here/.test(b.textContent)).click()");
  await page.eval("RF.mapView.emit('menu', [38.2431, -93.3819], { x: 700, y: 400 })");
  await page.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /End a ride here/.test(b.textContent)).click()");
  await sleep(300);
  assert.match(await sheetText(), /One way[\s\S]*Start[\s\S]*End[\s\S]*Extra time for fun roads[\s\S]*\+15 min[\s\S]*Find fun ways there/);
  assert.deepEqual(await page.eval('[RF.trip.loop, RF.trip.items[RF.trip.items.length - 1].end, RF.settings.genShape]'), [false, true, 'oneway']);
  // The ride page offers ways there too, not loops, for a ride with an end.
  await page.eval("RF.go('trip')");
  await sleep(300);
  assert.match(await sheetText(), /Find a more fun way there[\s\S]*\+15 min[\s\S]*Find fun ways there/);
  assert.doesNotMatch(await sheetText(), /Generate loops/);
  await page.eval("RF.go('plan')");
  await sleep(300);
  if (NETWORK) {
    await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Find fun ways there/.test(b.textContent)).click()");
    await page.waitFor('!RF.gen.running', 300000);
    const opts = await page.eval('RF.gen.options.filter(o => o.route).map(o => [o.oneWay, o.items[o.items.length - 1].label, o.curvy > 0])');
    assert.ok(opts.length > 0, await page.eval('RF.gen.status'));
    opts.forEach(o => assert.deepEqual(o, [true, 'End', true]));
    assert.equal(await page.eval('RF.trip.loop'), false, 'the chosen way stays one way');
    // The fastest way comes last, to compare; each fun way says how much longer it is, near the extra chosen (+1 h).
    const ways = await page.eval('RF.gen.options.map(o => [o.way, o.vsFastest, o.route.seconds])');
    assert.equal(ways[ways.length - 1][0], 'fastest');
    ways.slice(0, -1).forEach(([, vs]) => assert.ok(vs >= 0.5 * 3600 && vs <= 1.6 * 3600, `+${Math.round(vs / 60)} min for +1 h`));
    assert.match(await sheetText(), /\+\d+ min[\s\S]*Fastest way/);
    await page.eval("[...document.querySelectorAll('.cards .option')].pop().click()");
    assert.deepEqual(await page.eval('[RF.trip.loop, RF.trip.items.length]'), [false, 2], 'Fastest: just the start and the end');
  }
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => b.textContent === 'Loop').click()");
  assert.equal(await page.eval('RF.settings.genShape'), 'loop');
});

test('the ride page shows the weather along the route, for the time you leave', async () => {
  // Open-Meteo stubbed: dry for the next day, then rain.
  await page.eval(`(() => {
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).includes('open-meteo')) return real(url, opts);
      const n = new URL(url).searchParams.get('latitude').split(',').length, t0 = Math.floor(Date.now() / 3600000) * 3600 - 3600;
      const time = Array.from({ length: 168 }, (_, k) => t0 + k * 3600), wet = time.map(t => t > Date.now() / 1000 + 30 * 3600);
      const one = { hourly: { time, temperature_2m: time.map(() => 71), precipitation_probability: wet.map(w => w ? 80 : 5),
        wind_gusts_10m: time.map(() => 15), weather_code: wet.map(w => w ? 63 : 1) } };
      return Promise.resolve(new Response(JSON.stringify(n > 1 ? Array(n).fill(one) : one)));
    };
  })()`);
  await page.eval(pointTrip);
  await page.eval(`RF.setRoute({ path: Array.from({ length: 200 }, (_, i) => [38.852, -94.343 + i * 0.005]), meters: 86000, seconds: 4000,
    maneuvers: [{ at: 0, end: 199, s: 4000 }] })`);
  await page.waitFor("/Looks good: 71°F, rain chance up to 5%, gusts to 15 mph/.test(document.getElementById('sheetBody').innerText)", 10000);
  assert.ok(await page.eval("document.querySelectorAll('#sheetBody .wx-row:not(.wx-head)').length") >= 3);
  // Leaving in two days: rain.
  await page.eval(`(() => {
    const el = document.querySelector('#sheetBody input.leave'), d = new Date(Date.now() + 48 * 3600000);
    el.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    el.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor("/Rain likely .80%. around mile 0/.test(document.getElementById('sheetBody').innerText)", 5000);
  assert.match(await sheetText(), /Now/);
  // Leave the ride as the other tests expect it.
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => b.textContent === 'Now').click()");
});

test('fly-through: rides the route low in 3D, plays and pauses, seeks, and puts the map back', async () => {
  await page.eval(pointTrip);
  await page.eval(`RF.setRoute({ path: Array.from({ length: 200 }, (_, i) => [38.852, -94.343 + i * 0.005]), meters: 86000, seconds: 4000,
    maneuvers: [{ at: 0, end: 199, s: 4000, km: 86, names: ['US 50'] }] })`);
  await page.waitFor("[...document.querySelectorAll('#sheetBody button')].some(b => /Fly through/.test(b.textContent))", 10000);
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Fly through/.test(b.textContent)).click()");
  assert.ok(await page.eval("RF.fly && document.body.classList.contains('flying') && !!document.querySelector('.fly-bar')"));
  assert.equal(await page.eval("getComputedStyle(document.getElementById('sheet')).display"), 'none', 'the panel steps aside');
  await page.waitFor('RF.fly.s > 3', 10000);
  assert.ok(await page.eval('RF.mapView.map.getPitch()') > 65, 'camera sits low');
  assert.ok(await page.eval("RF.mapView.map.getTerrain() && RF.mapView.map.getLayoutProperty('sat', 'visibility') === 'visible'"));
  assert.match(await page.eval("document.querySelector('.fly-readout').innerText"), /Mile [\d.]+ · \d+ min in/);
  assert.ok(await page.eval("document.querySelector('.fly-road').innerText.trim().length > 0"), 'a road sign');
  assert.match(await page.eval("document.querySelector('.fly-pace').innerText"), /riding ~48 mph/);
  // The weather for when you'd be here (Open-Meteo is stubbed by the weather test: dry, 71°F).
  await page.waitFor("!document.querySelector('.fly-wx').hidden", 5000);
  assert.match(await page.eval("document.querySelector('.fly-wx').innerText"), /\d+:\d\d [AP]M .* 71°F · rain 5%/);
  // The mini-map: a tap at its right edge jumps to the east end of the ride.
  await page.eval(`(() => { const b = document.querySelector('.fly-mini svg').getBoundingClientRect();
    document.querySelector('.fly-mini').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: b.right - b.width * 8 / 116, clientY: b.top + b.height / 2 })); })()`);
  assert.ok(await page.eval('RF.fly.s') > 3900, 'jumped to the far end');
  // Pause holds still; seeking moves the rider.
  await page.eval("document.querySelector('.fly-play').click()");
  const held = await page.eval('RF.fly.s');
  await sleep(400);
  assert.equal(await page.eval('RF.fly.s'), held);
  await page.eval('RF.fly.seek(2000)');
  assert.match(await page.eval("document.querySelector('.fly-readout').innerText"), /Mile 26\.\d/);
  // Esc closes it: the panel, flat map and basemap come back.
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await sleep(300);
  assert.ok(await page.eval("!RF.fly && !document.body.classList.contains('flying') && !document.querySelector('.fly-bar')"));
  assert.equal(await page.eval('RF.mapView.map.getTerrain()'), null);
  assert.equal(await page.eval("RF.mapView.map.getLayoutProperty('sat', 'visibility')"), 'none');
});

// Ride mode on MO-150: a fake GPS (the test hands the app each fix) and a voice that writes down what it says.
test('Ride mode: follows you along the ride, says the turn, notices you left it, tags the road you’re on, and ends', async () => {
  await page.eval(pointTrip);
  await page.eval(`(async () => {
    const g = RF.store.byId.get(${MO150}).geom, mid = Math.floor(g.length / 2);
    RF.setRoute({ path: g, meters: 5000, seconds: 300, maneuvers: [
      { type: 1, at: 0, end: mid, s: 150, km: 2.5, names: ['MO 150'], text: 'Head east on MO 150.' },
      { type: 10, at: mid, end: g.length - 1, s: 150, km: 2.5, names: ['MO Y'], text: 'Turn right onto MO Y.', alert: 'Turn right onto Missouri Y.', pre: 'Turn right onto Missouri Y.' },
      { type: 4, at: g.length - 1, end: g.length - 1, s: 0, km: 0, names: [], text: 'You have arrived.' }] });
    // What's said, in words, whichever voice says it (the recorded clips by default).
    const V = await import('./js/voice.js');
    V.log.length = 0;
    window.__said = V.log;
    speechSynthesis.speak = () => {};
    navigator.geolocation.watchPosition = ok => { window.__gps = ok; return 7; };
    navigator.geolocation.clearWatch = id => { window.__cleared = id; };
    RF.go('trip');
  })()`);
  await page.waitFor("[...document.querySelectorAll('#sheetBody button')].some(b => /Ride it here/.test(b.textContent))", 10000);
  // The voice: a pick says the sample, and is kept on the device.
  await page.eval("[...document.querySelectorAll('.voice-field .seg button')].find(b => b.textContent === 'Faster').click()");
  assert.equal(await page.eval("JSON.parse(localStorage.getItem('rf2-voice-pick')).rate"), '1.15');
  assert.ok(await page.eval("__said.includes('In half a mile, turn right onto Missouri D.')"));
  assert.ok(await page.eval("!!document.querySelector('.voice-field select option')"), 'a list of voices (the phone’s default at least)');
  await page.eval("localStorage.removeItem('rf2-voice-pick')");
  // On the bike before setting off: the trip meter reads 50, typed into the ride's Fuel. Ride mode starts from what's left.
  await page.eval("Object.assign(RF.settings, { bikes: [{ id: 'r', name: 'Rebel', gal: 2.9, mpg: 65, tankMiles: 0 }], defaultBike: 'r' }); RF.go('trip')");
  await page.waitFor("!!document.getElementById('trip-meter')", 5000);
  await page.eval("(() => { const i = document.getElementById('trip-meter'); i.value = '50'; i.dispatchEvent(new Event('change')); })()");
  await page.waitFor("/Rebel: ≈ 139 of 189 mi left in the tank/.test(document.getElementById('sheetBody').innerText)", 5000);
  // A bump you marked before, on the ride a little past where it picks you up again below.
  await page.eval(`import('./js/tags.js').then(T => { const g = RF.store.byId.get(${MO150}).geom; T.addSpot(g[Math.floor(g.length / 2) + 5], 'bump'); })`);
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Ride it here/.test(b.textContent)).click()");
  assert.ok(await page.eval("RF.ride && document.body.classList.contains('riding')"));
  assert.equal(await page.eval("getComputedStyle(document.getElementById('sheet')).display"), 'none', 'the panel steps aside');
  assert.match(await page.eval("document.querySelector('.ride-banner').innerText"), /Finding you/);
  assert.ok(await page.eval("__said.includes('Starting your ride.')"));
  // In the recorded voice (it plays over music on iPhone), every clip loaded at the start for riding without signal
  // (each phrase, and the beep for a robotic voice).
  await page.waitFor(`Promise.all([import('./js/voice.js'), fetch('voice/phrases.json').then(r => r.json())])
    .then(([V, p]) => V.clipsLoaded() >= Object.keys(p).length + (V.recorded()[0].chime ? 1 : 0))`, 15000);
  // GPS fixes riding along the road, at 50 mph.
  const gps = (k, off = 0) => page.eval(`(() => {
    const g = RF.store.byId.get(${MO150}).geom, i = Math.min(g.length - 2, ${k});
    const [a, b] = [g[i], g[i + 1]], hd = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
    __gps({ coords: { latitude: a[0] + ${off}, longitude: a[1], heading: hd, speed: 22, accuracy: 5 }, timestamp: Date.now() });
  })()`);
  const n = await page.eval(`RF.store.byId.get(${MO150}).geom.length`), mid = Math.floor(n / 2);
  await gps(1);
  await gps(2);
  assert.equal(await page.eval('RF.ride.guide.state'), 'on');
  assert.match(await page.eval("document.querySelector('.ride-banner').innerText"), /↱[\s\S]*(mi|ft)[\s\S]*MO Y/);
  assert.match(await page.eval("document.querySelector('.ride-panel').innerText"), /mi left · (back|there) about \d+:\d\d/);
  // The mini-map: the whole ride, with you on it, and your spot; a tap shows the whole ride (Overview).
  await sleep(300);
  assert.ok(await page.eval("+document.querySelector('.ride-mini .dot').getAttribute('cx') > -8"), 'you, on the mini-map');
  assert.equal(await page.eval("document.querySelectorAll('.ride-mini .marks circle').length"), 1, 'the bump on it');
  await sleep(600);
  assert.ok(Math.abs(await page.eval('RF.mapView.map.getPitch()') - 50) < 1, 'heading-up, tilted');
  // The map can be dragged while riding: it stops following until Recenter.
  const at = () => page.eval('JSON.stringify(RF.mapView.map.getCenter())');
  const was = await at();
  await page.mouse('mousePressed', 900, 450);
  for (let k = 1; k <= 8; k++) { await page.mouse('mouseMoved', 900 + 15 * k, 450 + 10 * k); await sleep(30); }
  await page.mouse('mouseReleased', 1020, 530);
  await sleep(400);
  assert.notEqual(await at(), was, 'the map moved');
  assert.equal(await page.eval('RF.ride.following'), false);
  await gps(3);
  await sleep(300);
  const dragged = await at();
  await sleep(300);
  assert.equal(await at(), dragged, 'and stays where it was dragged as you ride on');
  await page.eval("document.querySelector('.ride-recenter').click()");
  assert.equal(await page.eval('RF.ride.following'), true);
  await page.eval("document.querySelector('.ride-mini').click()");
  assert.equal(await page.eval('RF.ride.following'), false, 'the mini-map opens Overview');
  await page.eval("document.querySelector('.ride-recenter').click()");
  // An iPhone that doesn't know the speed says -1: no "-2 mph".
  await page.eval(`(() => { const p = RF.store.byId.get(${MO150}).geom[3]; __gps({ coords: { latitude: p[0], longitude: p[1], heading: -1, speed: -1, accuracy: 5 }, timestamp: Date.now() }); })()`);
  assert.ok(await page.eval("+document.querySelector('.ride-speed b').textContent >= 0"));
  // Coming up on the turn, it's called out.
  for (let k = Math.max(3, mid - 3); k < mid; k++) await gps(k);
  assert.ok(await page.eval("__said.includes('Turn right onto Missouri Y.')"), await page.eval('JSON.stringify(__said)'));
  // Off the road (about 300 m north) for a few fixes: off the ride, with Skip ahead.
  for (let i = 0; i < 3; i++) await gps(mid + 1, 0.003);
  assert.equal(await page.eval('RF.ride.guide.state === "on"'), false);
  assert.match(await page.eval("document.querySelector('.ride-banner').innerText"), /Off your ride|back on your ride/);
  assert.ok(await page.eval("!document.querySelector('.ride-skip').hidden"));
  assert.ok(await page.eval("__said.some(t => /off the ride/.test(t))"));
  // Back on it further along: picked up there.
  await gps(mid + 4);
  assert.equal(await page.eval('RF.ride.guide.state'), 'on');
  assert.ok(await page.eval("__said.some(t => /Back on your ride|Picking up your ride/.test(t))"));
  // The tank: counted down from what was left at the start (139, less what's been ridden); with a station just ahead
  // the last one in reach, it says to stop there.
  assert.match(await page.eval("document.querySelector('.ride-gas').innerText"), /⛽ ~13[5-9] mi in tank/);
  await page.eval(`(() => { const r = RF.ride, m = r.guide.main.m; r.range = 0.5; r.tankAt = r.ridden; r.gas = [{ m: m + 500, name: 'Casey’s' }, { m: m + 30000, name: 'Far' }]; r.update(); })()`);
  assert.match(await page.eval("document.querySelector('.ride-gas').innerText"), /Get gas at Casey’s in 0\.3\d mi: the one after is 18\.\d mi, past your range/);
  assert.ok(await page.eval("document.querySelector('.ride-gas').classList.contains('warn') && __said.includes('Get gas at the next station.')"));
  await page.eval("RF.ride.range = 0.2; RF.ride.tankAt = RF.ride.ridden; RF.ride.update()");
  assert.match(await page.eval("document.querySelector('.ride-gas').innerText"), /Low: ~0 mi in tank, next gas 0\.3\d mi/);
  assert.ok(await page.eval("__said.includes('Fuel’s getting low.')"));
  // Filled up: tap the line, Full.
  await page.eval("document.querySelector('.ride-gas').click()");
  await page.eval("[...document.querySelectorAll('.ride-tag')].find(b => /Filled up/.test(b.textContent)).click()");
  await page.eval("RF.ride.range = 120; RF.ride.gas = []; RF.ride.update()");
  assert.match(await page.eval("document.querySelector('.ride-gas').innerText"), /^⛽ ~120 mi in tank$/);
  assert.equal(await page.eval('RF.settings.bikes[0].tankMiles'), 0, 'filled up: kept on the bike');
  await page.eval("Object.assign(RF.settings, { bikes: [], defaultBike: null })");
  // Coming up on the bump: on screen, and said.
  assert.ok(await page.eval("__said.includes('Bump ahead.')"), await page.eval('JSON.stringify(__said)'));
  assert.match(await page.eval("document.querySelector('.ride-spot').hidden ? '' : document.querySelector('.ride-spot').innerText"), /Bump( ahead · \d+ ft)?/);
  // Mark spot: one tap, where you are, labelled after the ride.
  await page.eval("document.querySelector('.ride-mark').click()");
  assert.match(await page.eval("document.getElementById('toast').innerText"), /Spot marked\. Label it after the ride/);
  assert.ok(await page.eval("__said.includes('Spot marked.')"));
  assert.equal(await page.eval("import('./js/tags.js').then(T => T.spots().filter(s => !s.kind).length)"), 1);
  // Tag road: Rough, on the road you're on.
  await page.eval("[...document.querySelectorAll('.ride-btn')].find(b => /Tag road/.test(b.textContent)).click()");
  await page.eval("[...document.querySelectorAll('.ride-tag')].find(b => b.textContent === 'Rough').click()");
  assert.match(await page.eval("document.getElementById('toast').innerText"), /MO 150 tagged Rough/);
  assert.deepEqual(await page.eval(`import('./js/tags.js').then(T => T.tagOf([${MO150}]).tags)`), ['rough']);
  // End takes two taps; then the map and panel are back, the GPS let go.
  await page.eval("document.querySelector('.ride-btn.end').click()");
  assert.ok(await page.eval('!!RF.ride'), 'one tap doesn’t end it');
  await page.eval("document.querySelector('.ride-btn.end').click()");
  assert.ok(await page.eval("!RF.ride && !document.body.classList.contains('riding') && !document.querySelector('.ride-banner') && window.__cleared === 7"));
  // The spot marked on the way: the list opens, to say what it was.
  await page.waitFor("RF.view === 'spots'", 5000);
  assert.match(await sheetText(), /Your spots[\s\S]*1 to label[\s\S]*Marked spot[\s\S]*Bump/);
  await page.eval("[...document.querySelector('.spot-card').querySelectorAll('.tag-pick')].find(b => b.textContent === 'Pothole').click()");
  assert.deepEqual(await page.eval("import('./js/tags.js').then(T => T.spots().map(s => s.kind).sort())"), ['bump', 'pothole']);
  await page.eval("import('./js/tags.js').then(T => T.restoreTags([]))");
});

test('road tags: tag a road on its card, see it on the map and in the list, and loops leave Don’t ride roads out', async () => {
  await showMo150();
  await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); RF.mapView.emit('road', r.id, r.geom[2]); })()`);
  await page.waitFor("!!document.querySelector('.tag-pick')", 5000);
  await page.eval("[...document.querySelectorAll('.tag-pick')].find(b => b.textContent === 'Don’t ride').click()");
  await page.waitFor("document.querySelector('.tag-pick.on')?.textContent === 'Don’t ride'", 5000);
  const note = "document.querySelector('.tag-note')";
  await page.eval(`(() => { const i = ${note}; i.value = 'Bumpy as hell'; i.dispatchEvent(new Event('change')); })()`);
  const saved = JSON.parse(await page.eval("localStorage.getItem('rf2-tags')"));
  assert.ok(saved.length === 1 && saved[0].tags[0] === 'avoid' && saved[0].note === 'Bumpy as hell' && saved[0].pieces.some(x => x.id === MO150), 'kept on the device');
  await page.waitFor("RF.mapView.map.getSource('tags').serialize().data.features.length > 0", 5000);
  await page.eval("RF.go('home')");
  await page.waitFor("[...document.querySelectorAll('.road-card')].some(c => /MO 150\s*Don’t ride/.test(c.innerText))", 10000);
  // The generator's roads: MO-150 isn't one of them now.
  assert.equal(await page.eval(`import('./js/tags.js').then(T => T.avoidedIds().has(${MO150}))`), true);
  await page.eval("import('./js/tags.js').then(T => T.restoreTags([]))");
});

test('your bikes: typed in on the account page, one the default; the ride page uses it, or another picked for that ride', async () => {
  await page.eval("Object.assign(RF.settings, { bikes: [], defaultBike: null }); RF.go('home')");
  await page.eval("[...document.querySelectorAll('#sheetBody .foot-links button')].find(b => /Your bikes/.test(b.textContent)).click()");
  assert.match(await sheetText(), /Your bikes[\s\S]*Add your bike/);
  const type = (sel, k, v) => page.eval(`(() => { const i = [...document.querySelectorAll('${sel}')][${k}]; i.value = '${v}'; i.dispatchEvent(new Event('change')); })()`);
  const click = re => page.eval(`[...document.querySelectorAll('#sheetBody button')].find(b => ${re}.test(b.textContent)).click()`);
  // Adding one puts the cursor in its name; the page redraws once you're out of the box.
  const added = async n => { await page.waitFor(`document.querySelectorAll('.bike-name').length === ${n}`, 5000); await sleep(100); await page.eval('document.activeElement.blur()'); };
  await click('/Add your bike/');
  await added(1);
  await type('.bike-name', 0, 'GSX-R');
  await type('.bike-item input.num', 0, '4.5');
  await type('.bike-item input.num', 1, '38');
  assert.deepEqual(await page.eval("[...document.querySelector('.bike-fuel').options].map(o => o.textContent)"), ['85', '87', '88', '89', '90', '91', '92', '93', '94'], 'numbers only');
  await page.eval("(() => { const s = document.querySelector('.bike-fuel'); s.value = '91'; s.dispatchEvent(new Event('change')); })()");
  await page.waitFor("/Default[\\s\\S]*About 171 mi on a full tank/.test(document.getElementById('sheetBody').innerText)", 5000);
  assert.doesNotMatch(await sheetText(), /Trip meter/, 'the trip meter is the ride’s, typed in before setting off');
  assert.equal(await page.eval("document.querySelector('.bike-name').value"), 'GSX-R');
  // A second bike; make it the default.
  await click('/Add another bike/');
  await added(2);
  await type('.bike-name', 1, 'Rebel');
  await type('.bike-item input.num', 2, '2.9');
  await type('.bike-item input.num', 3, '65');
  await click('/Make default/');
  assert.equal(await page.eval("RF.settings.bikes.find(b => b.id === RF.settings.defaultBike).name"), 'Rebel');
  // The ride page: the default, and the other picked for this ride only.
  await page.eval(pointTrip);
  await page.waitFor("!!document.getElementById('bike-pick')", 10000);
  assert.match(await page.eval("document.getElementById('bike-pick').selectedOptions[0].textContent"), /Rebel \(default\)/);
  assert.match(await sheetText(), /Rebel: ≈ 189 of 189 mi left/);
  await page.eval("(() => { const s = document.getElementById('bike-pick'); s.value = RF.settings.bikes[0].id; s.dispatchEvent(new Event('change')); })()");
  await page.waitFor("/GSX-R: ≈ 171 of 171 mi left/.test(document.getElementById('sheetBody').innerText)", 5000);
  await page.eval("(() => { const i = document.getElementById('trip-meter'); i.value = '20'; i.dispatchEvent(new Event('change')); })()");
  await page.waitFor("/GSX-R: ≈ 151 of 171 mi left in the tank/.test(document.getElementById('sheetBody').innerText)", 5000);
  // It takes 91: stations with 91+ only, no 90+ box to forget.
  assert.match(await sheetText(), /Stations with 91\+ only: GSX-R takes 91\./);
  assert.equal(await page.eval("[...document.querySelectorAll('#sheetBody .switch span')].some(s => s.textContent === '90+ only')"), false);
  assert.equal(await page.eval("RF.settings.bikes[0].tankMiles"), 20, 'kept on that bike');
  assert.equal(await page.eval("RF.settings.bikes.find(b => b.id === RF.settings.defaultBike).name"), 'Rebel', 'the default stays');
  await page.eval("Object.assign(RF.settings, { bikes: [], defaultBike: null }); RF.trip.bikeId = null; RF.go('home')");
});

test('your spots: mark one from the map’s menu, say what it is, see it on the map, follow the account, and remove it', async () => {
  await showMo150();
  const at = await page.eval(`JSON.stringify(RF.store.byId.get(${MO150}).geom[4])`);
  await page.eval(`RF.mapView.emit('menu', ${at}, { x: 700, y: 400 })`);
  await page.eval("[...document.querySelectorAll('#menu .menu-item')].find(b => /Mark a spot here/.test(b.textContent)).click()");
  await page.waitFor("RF.view === 'spot'", 5000);
  assert.match(await sheetText(), /Marked spot[\s\S]*What’s here[\s\S]*Bump[\s\S]*Pothole[\s\S]*Remove/);
  await page.eval("[...document.querySelectorAll('.tag-pick')].find(b => b.textContent === 'Gravel').click()");
  await page.waitFor("[...document.querySelectorAll('.tag-pick.on')].map(b => b.textContent).join() === 'Gravel'", 5000);
  assert.match(await sheetText(), /^\s*Gravel/);
  await page.waitFor("RF.mapView.map.getSource('spots').serialize().data.features.some(f => f.properties.label === 'Gravel')", 5000);
  // Tapping it on the map opens it.
  await page.eval("RF.go('home')");
  assert.match(await sheetText(), /Your spots \(1\)/);
  await page.eval("RF.mapView.emit('spot', JSON.parse(localStorage.getItem('rf2-tags'))[0].id)");
  assert.equal(await page.eval("RF.view"), 'spot');
  // Kept with the road tags (so it follows the account); merging two copies keeps one of it.
  const kept = JSON.parse(await page.eval("localStorage.getItem('rf2-tags')"));
  assert.ok(kept.length === 1 && kept[0].kind === 'gravel' && kept[0].tags.length === 0 && kept[0].pieces.length === 0);
  assert.equal(await page.eval(`import('./js/account.js').then(A => A.mergeTags(${JSON.stringify(kept)}, ${JSON.stringify(kept)}).length)`), 1);
  // Remove, and Undo puts it back.
  await page.eval("[...document.querySelectorAll('#sheetBody .btn')].find(b => /Remove/.test(b.textContent)).click()");
  assert.equal(await page.eval("import('./js/tags.js').then(T => T.spots().length)"), 0);
  await page.eval("[...document.querySelectorAll('#toast button')].find(b => /Undo/.test(b.textContent)).click()");
  assert.equal(await page.eval("import('./js/tags.js').then(T => T.spots().length)"), 1);
  await page.eval("import('./js/tags.js').then(T => T.restoreTags([]))");
  await page.eval("RF.go('home')");
});

test('your speed limit: set on a road’s card, the map follows it, and it links to OpenStreetMap to fix it there', async () => {
  await showMo150();
  await page.eval(`(() => { const r = RF.store.byId.get(${MO150}); RF.mapView.emit('road', r.id, r.geom[2]); })()`);
  await page.waitFor("!!document.querySelector('#my-speed')", 5000);
  assert.match(await page.eval("document.querySelector('.osm-edit').href"), new RegExp(`openstreetmap\\.org/edit\\?way=${MO150}$`));
  // 40 mph: below the 45+ chip, so MO-150 leaves Best rides' map.
  await page.eval("(() => { const s = document.querySelector('#my-speed'); s.value = '40'; s.dispatchEvent(new Event('change')); })()");
  await page.waitFor(`RF.store.byId.get(${MO150}).speed === 40`, 5000);
  await page.waitFor(`!RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.i === ${MO150})`, 5000);
  assert.equal(JSON.parse(await page.eval("localStorage.getItem('rf2-tags')"))[0].mph, 40, 'kept with the tags');
  await page.waitFor("/40 mph/.test(document.querySelector('.stats').innerText) && /your limit/.test(document.querySelector('.stats').innerText)", 5000);
  // Back to the map's: it's back on the map.
  await page.eval("(() => { const s = document.querySelector('#my-speed'); s.value = ''; s.dispatchEvent(new Event('change')); })()");
  await page.waitFor(`RF.store.byId.get(${MO150}).myMph === null`, 5000);
  await page.waitFor(`RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).some(f => f.properties.i === ${MO150})`, 5000);
  assert.equal(await page.eval("localStorage.getItem('rf2-tags')"), '[]');
  await page.eval("RF.go('home')");
});

test('your places: save a spot as Home from the map menu, find it in search, start a ride from it', async () => {
  const click = text => page.eval(`[...document.querySelectorAll('button, .menu-item, .result')].find(e => e.offsetParent && e.textContent.trim().startsWith(${JSON.stringify(text)})).click()`);
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.38, 38.91], zoom: 13 })");
  await page.eval("(() => { const m = RF.mapView.map; m.fire('contextmenu', { lngLat: m.getCenter(), point: m.project(m.getCenter()) }); })()");
  await click('Save this place');
  await page.waitFor("/Save as/.test(document.getElementById('sheetBody').innerText)", 5000);
  await click('Home');
  await page.waitFor("/Saved as Home/.test(document.getElementById('sheetBody').innerText)", 5000);
  assert.deepEqual(await page.eval('RF.settings.places.map(p => p.name)'), ['Home']);
  assert.ok(await page.eval("JSON.parse(localStorage.getItem('rf2-settings')).places.length === 1"), 'kept with the settings (and the account)');
  // The map menu there now says so.
  await page.eval("(() => { const m = RF.mapView.map; m.fire('contextmenu', { lngLat: m.getCenter(), point: m.project(m.getCenter()) }); })()");
  assert.ok(await page.eval("[...document.querySelectorAll('.menu-item')].some(e => /Your place: Home/.test(e.textContent))"));
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  // Search: the empty box lists it, and "h" finds it first.
  await page.eval("RF.go('home')");
  await page.eval("(() => { const q = document.getElementById('q'); q.focus(); q.dispatchEvent(new Event('focus')); })()");
  await page.waitFor("!document.getElementById('results').hidden && /Home/.test(document.getElementById('results').innerText)", 5000);
  await page.eval("(() => { const q = document.getElementById('q'); q.value = 'h'; q.dispatchEvent(new Event('input')); })()");
  assert.match(await page.eval("document.querySelector('#results .result').innerText"), /^Home/);
  await page.eval("(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); })()");
  // Plan a ride: one tap starts it there.
  await page.eval("RF.go('plan')");
  await page.eval("[...document.querySelectorAll('.my-places button')].find(b => /Home/.test(b.textContent)).click()");
  await page.waitFor("/Home/.test(document.querySelector('.start-row').innerText)", 5000);
  // Remove (and Undo puts it back).
  await page.eval("RF.go('home')");
  await page.eval("(() => { const m = RF.mapView.map; m.fire('contextmenu', { lngLat: m.getCenter(), point: m.project(m.getCenter()) }); })()");
  await click('Your place: Home');
  await click('Remove');
  assert.equal(await page.eval('RF.settings.places.length'), 0);
  await page.eval("RF.go('home')");
});

test('pop-ups go away on their own in a few seconds, or at a tap', async () => {
  await page.eval("import('./js/ui.js').then(u => u.toast('Short note'))");
  assert.equal(await page.eval("document.getElementById('toast').hidden"), false);
  await page.waitFor("document.getElementById('toast').hidden", 3000);
  await page.eval("import('./js/ui.js').then(u => u.toast('With a button', { label: 'Undo', run: () => {} }))");
  await page.eval("document.getElementById('toast').click()");
  assert.equal(await page.eval("document.getElementById('toast').hidden"), true);
});

test('the map key explains what each class means', async () => {
  await page.eval("RF.go('home')");
  await page.eval("document.querySelector('.key-btn').click()");
  const text = await page.eval("document.querySelector('.key-help').innerText");
  assert.match(text, /Sweepers.*500–2,000 ft radius/);
  assert.match(text, /Twisty/);
  assert.match(text, /Blind crest/);
  assert.match(await page.eval("document.querySelector('.legend-chip').title"), /^Sweepers: Fast, wide bends/);
  await page.eval("document.querySelector('.key-btn').click()");
  assert.equal(await page.eval("!!document.querySelector('.key-help')"), false);
});

test('a share link reopens the same ride', async () => {
  const link = await page.eval(`(async () => {
    const T = await import('./js/trip.js');
    T.addPoint(RF.trip, [38.9, -94.3], 'Coffee stop');
    return location.href.split('#')[0] + '#r=' + T.encodeTrip(RF.trip);
  })()`);
  const labels = await page.eval('RF.trip.items.map(i => i.label)');
  const other = await launch();
  try {
    await other.goto(link);
    await other.waitFor('window.RF && RF.trip.items.length > 0', 30000);
    assert.deepEqual(await other.eval('RF.trip.items.map(i => i.label)'), labels);
    assert.match(await other.eval("document.getElementById('sheetBody').innerText"), /Your ride/);
  } finally {
    other.close();
  }
});

test('a share link pasted into the open app opens that ride (no reload), with Undo back to the one you had', async () => {
  await page.eval(pointTrip);
  const mine = await page.eval('JSON.stringify(RF.trip.items.map(i => i.label))');
  const link = await page.eval(`(async () => {
    const T = await import('./js/trip.js'), t = T.newTrip();
    T.setStart(t, [38.9, -94.4], 'Their start');
    T.addPoint(t, [38.95, -94.35], 'Their stop');
    return '#r=' + T.encodeTrip(t);
  })()`);
  await page.eval('window.__same = 1');
  await page.eval(`void (location.hash = '${link}')`);
  await page.waitFor("RF.trip.items.some(i => i.label === 'Their stop')", 5000);
  assert.equal(await page.eval('window.__same'), 1, 'the same page, not a reload');
  assert.equal(await page.eval('location.hash'), '', 'the link is taken out of the address');
  assert.match(await sheetText(), /Your ride/);
  assert.match(await page.eval("document.getElementById('toast').innerText"), /Opened the shared ride/);
  await page.eval("[...document.querySelectorAll('#toast button')].find(b => b.textContent === 'Undo').click()");
  assert.equal(await page.eval('JSON.stringify(RF.trip.items.map(i => i.label))'), mine);
});

test('phone layout: search on top, chips scroll, sheet at the bottom', async () => {
  const phone = await launch({ mobile: true });
  try {
    await phone.goto(base);
    await phone.waitFor('window.RF && RF.store.roads.length > 0', 60000);
    const box = await phone.eval(`(() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      return { search: r('.searchbox').top, chipsWrap: getComputedStyle(document.querySelector('.chips')).flexWrap,
        sheetTop: r('#sheet').top, height: innerHeight, snap: document.getElementById('sheet').dataset.snap };
    })()`);
    assert.ok(box.search < 40, 'search at the top');
    assert.equal(box.chipsWrap, 'nowrap');
    assert.equal(box.snap, 'half');
    assert.ok(box.sheetTop > box.height * 0.4 && box.sheetTop < box.height * 0.6, `sheet at half height (${box.sheetTop})`);
  } finally {
    phone.close();
  }
});

test('phone: swiping the panel moves it, unless the list is scrolled down', async () => {
  const phone = await launch({ mobile: true });
  const snap = () => phone.eval("document.getElementById('sheet').dataset.snap");
  const swipe = async (fromY, toY) => {
    await phone.touch('touchStart', 200, fromY);
    for (let k = 1; k <= 6; k++) { await phone.touch('touchMove', 200, fromY + (toY - fromY) * k / 6); await sleep(25); }
    await phone.touch('touchEnd', 200, toY);
    await sleep(450);
  };
  try {
    await phone.goto(base);
    await phone.waitFor("window.RF && document.querySelectorAll('.road-card').length > 2", 60000);
    assert.equal(await snap(), 'half');
    const top = await phone.eval("document.getElementById('sheetBody').getBoundingClientRect().top");
    await swipe(top + 120, top + 260);
    assert.equal(await snap(), 'peek', 'swipe down on the list hides the panel');
    await swipe(await phone.eval("document.getElementById('sheetBody').getBoundingClientRect().top") + 40, 200);
    assert.notEqual(await snap(), 'peek', 'swipe up opens it again');
    await swipe(await phone.eval("document.getElementById('sheetBody').getBoundingClientRect().top") + 60, 60);
    assert.equal(await snap(), 'full');
    // Fully open and scrolled down: a swipe down scrolls the list back, it doesn't close the panel.
    await phone.eval("document.getElementById('sheetBody').scrollTop = 200");
    const scrolled = await phone.eval("document.getElementById('sheetBody').scrollTop");
    assert.ok(scrolled > 0, 'list can scroll');
    await swipe(400, 520);
    assert.equal(await snap(), 'full');
    assert.ok(await phone.eval("document.getElementById('sheetBody').scrollTop") < scrolled, 'the list scrolled up');
  } finally {
    phone.close();
  }
});

test('generator routes loops and loads the best one as the ride', { skip: !NETWORK && 'set RF_NETWORK=1' }, async () => {
  await page.eval(`(async () => {
    const T = await import('./js/trip.js');
    RF.trip.items.length = 0;
    T.setStart(RF.trip, [38.852, -94.343], 'Start');
  })()`);
  await page.eval("RF.go('plan')");
  await page.eval("[...document.querySelectorAll('#sheetBody .cta')].find(b => /Generate/.test(b.textContent)).click()");
  await page.waitFor('RF.gen.options.length > 0 && !RF.gen.running', 180000);
  const opts = await page.eval('RF.gen.options.map(o => o.route && o.route.seconds)');
  assert.ok(opts.filter(Boolean).length >= 3, `routed loops: ${opts}`);
  assert.ok(opts.every(s => s >= 3 * 3600 * 0.8 && s <= 3 * 3600 * 1.2), `loops within 80–120% of 3 h: ${opts.map(s => (s / 3600).toFixed(2))}`);
  await page.waitFor('RF.route && RF.info && RF.info.curvy != null', 30000);
  assert.ok(await page.eval('RF.trip.items.length') >= 2);
});

test('a loop built around a chosen road always goes through it', { skip: !NETWORK && 'set RF_NETWORK=1' }, async () => {
  await showMo150();
  await page.eval(`(async () => {
    const T = await import('./js/trip.js');
    RF.trip.items.length = 0;
    T.setStart(RF.trip, [38.852, -94.343], 'Start');
    const r = RF.store.byId.get(${MO150});
    RF.mapView.emit('road', r.id, r.geom[2]);
  })()`);
  await sleep(300);
  await page.eval("[...document.querySelectorAll('#sheetBody button')].find(b => /Plan a loop with this road/.test(b.textContent)).click()");
  assert.match(await sheetText(), /Must include[\s\S]*MO 150/);
  await page.eval("[...document.querySelectorAll('#sheetBody .cta')].find(b => /Generate/.test(b.textContent)).click()");
  await page.waitFor('RF.gen.options.length > 0 && !RF.gen.running', 180000);
  const loops = await page.eval('RF.gen.options.filter(o => o.route).map(o => o.items.map(i => i.label + (i.gen ? "*" : "")))');
  assert.ok(loops.length >= 2, JSON.stringify(loops));
  loops.forEach(l => assert.ok(l.includes('MO 150'), `loop without MO 150: ${l}`));
  assert.ok(await page.eval("RF.trip.items.some(i => i.label === 'MO 150' && !i.gen)"));
});
