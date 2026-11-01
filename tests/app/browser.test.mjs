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
  assert.equal(await page.eval("document.querySelectorAll('#chips .chip').length"), 6);
  assert.equal(await page.eval("document.querySelectorAll('.legend-chip').length"), 5);
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

test('search finds a route number and opens the road', async () => {
  await page.eval("(() => { const q = document.getElementById('q'); q.value = 'hwy 7'; q.dispatchEvent(new Event('input')); })()");
  await page.waitFor("document.querySelectorAll('#results .result').length > 0", 5000);
  assert.match(await page.eval("document.querySelector('#results .result').innerText"), /^MO 7/);
  await page.eval("document.querySelector('#results .result').click()");
  await page.waitFor("/MO 7/.test(document.getElementById('sheetBody').innerText) && /Add to ride/.test(document.getElementById('sheetBody').innerText)", 30000);
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
  assert.ok(opts.every(s => !s || s <= 3 * 3600 * 1.15));
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
