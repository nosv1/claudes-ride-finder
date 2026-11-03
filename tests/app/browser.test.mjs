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
  // The curve classes, plus Highways & ramps with All roads.
  assert.equal(await page.eval("document.querySelectorAll('.legend-chip:not(.key-btn)').length"), 6);
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
  assert.ok(await page.eval("RF.mapView.map.queryRenderedFeatures({ layers: ['roads-solid'] }).every(f => f.properties.rt >= 0)"), 'only ramps drawn');
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
  const before = await files();
  assert.ok(before.every(f => !f.endsWith('.s.js')), 'Best rides loads no speed-only files');
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

test('tapping an uncolored road tells its speed limit', async () => {
  const MO7 = 517106224, I435 = 567231236;
  await page.eval("RF.go('home')");
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.284, 39.12], zoom: 14 })");
  await page.waitFor(`RF.store.byId.has(${MO7})`, 30000);
  await page.eval(`(() => { const r = RF.store.byId.get(${MO7}); RF.mapView.emit('empty', r.geom[Math.floor(r.geom.length / 2)]); })()`);
  await page.waitFor("/MO 7 · 55 mph/.test(document.getElementById('toast').innerText)", 15000);
  // A road only in the speed-limit tiles: loaded for the tap.
  await page.eval("void RF.mapView.map.jumpTo({ center: [-94.76, 38.95], zoom: 14 })");
  await page.eval("RF.mapView.emit('empty', [38.95, -94.76])");
  await page.waitFor(`RF.store.byId.has(${I435})`, 30000);
  await page.eval(`(() => { const r = RF.store.byId.get(${I435}); RF.mapView.emit('empty', r.geom[Math.floor(r.geom.length / 2)]); })()`);
  await page.waitFor("/I 435 · 70 mph/.test(document.getElementById('toast').innerText)", 15000);
});

test('search finds a route number and opens the road', async () => {
  await page.eval("(() => { const q = document.getElementById('q'); q.value = 'hwy 7'; q.dispatchEvent(new Event('input')); })()");
  await page.waitFor("document.querySelectorAll('#results .result').length > 0", 5000);
  assert.match(await page.eval("document.querySelector('#results .result').innerText"), /^MO 7/);
  await page.eval("document.querySelector('#results .result').click()");
  await page.waitFor("/MO 7/.test(document.getElementById('sheetBody').innerText) && /Add to ride/.test(document.getElementById('sheetBody').innerText)", 30000);
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
  assert.match(await sheetText(), /Plan a ride[\s\S]*Must include[\s\S]*Working…/);
  // Let it finish (or fail offline) so it can't change the ride under later tests.
  await page.waitFor('!RF.gen.running', 180000);
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
    return location.href.split('#')[0] + '#trip=' + T.encodeTrip(RF.trip);
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
