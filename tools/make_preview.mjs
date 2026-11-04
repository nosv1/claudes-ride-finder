// Draw the link preview (preview.png, 1200×630): the curvy roads of the Ozarks from the built tiles, in the
// map's colors, with the app's name. Shown when the site's link is pasted into a text or a chat.
//
// Run from the repo root:  node tools/make_preview.mjs
// Uses Edge/Chrome like the browser tests (set BROWSER if it isn't found).
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { decodeRow } from '../js/roads.js';
import { CURVE_CLASSES } from '../js/config.js';
import { launch, sleep } from '../tests/app/cdp.mjs';

const W = 1200, H = 630;
// Branson, Table Rock Lake and the hills north of them.
const SOUTH = 36.5, NORTH = 37.25, MID_LON = -93.0;
const SIZE = JSON.parse(readFileSync('tiles/index.js', 'utf8').replace(/^window\.TILE_INDEX = /, '').replace(/;\s*$/, '')).size;

// Equirectangular, squeezed east–west by cos(latitude) so roads keep their shape.
const k = Math.cos((SOUTH + NORTH) / 2 * Math.PI / 180);
const scale = H / (NORTH - SOUTH), halfLon = W / 2 / scale / k;
const WEST = MID_LON - halfLon, EAST = MID_LON + halfLon;
const xy = ([lat, lon]) => [((lon - WEST) * k * scale).toFixed(1), ((NORTH - lat) * scale).toFixed(1)];

const roads = [];
for (let x = Math.floor(WEST / SIZE); x <= Math.floor(EAST / SIZE); x++) {
  for (let y = Math.floor(SOUTH / SIZE); y <= Math.floor(NORTH / SIZE); y++) {
    const file = `tiles/${x}_${y}.js`;
    if (!existsSync(file)) continue;
    runInNewContext(readFileSync(file, 'utf8'), { addTile: (_, rows) => rows.forEach(row => roads.push(decodeRow(row))) });
  }
}

const path = r => `M${r.geom.map(xy).map(p => p.join(',')).join('L')}`;
const others = roads.filter(r => r.cls < 0 && ['primary', 'secondary', 'tertiary', 'trunk', 'motorway'].includes(r.hw));
// Tighter classes on top, so the twisty bits show.
const curvy = roads.filter(r => r.cls >= 0).sort((a, b) => a.cls - b.cls);
const lines = [
  ...others.map(r => `<path d="${path(r)}" stroke="#3a3f4b" stroke-width="1.2"/>`),
  ...curvy.map(r => `<path d="${path(r)}" stroke="${CURVE_CLASSES[r.cls].color}" stroke-width="${CURVE_CLASSES[r.cls].width * 0.8}"/>`),
].join('');
const icon = readFileSync('favicon.svg', 'utf8').replace(/<\?xml[^>]*>/, '');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: #0f1115; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; }
  svg.map { position: absolute; inset: 0; }
  .panel { position: absolute; left: 0; top: 0; bottom: 0; width: 640px; padding: 70px 64px; box-sizing: border-box;
    background: linear-gradient(90deg, #0f1115 55%, rgba(15,17,21,.85) 80%, rgba(15,17,21,0)); color: #f1f5f9; }
  .icon { width: 96px; height: 96px; } .icon svg { width: 100%; height: 100%; }
  h1 { font-size: 76px; margin: 28px 0 12px; letter-spacing: -1px; }
  p { font-size: 32px; line-height: 1.3; margin: 0; color: #cbd5e1; max-width: 480px; }
  .where { margin-top: 36px; font-size: 24px; color: #94a3b8; }
</style></head><body>
<svg class="map" viewBox="0 0 ${W} ${H}" fill="none" stroke-linecap="round" stroke-linejoin="round">${lines}</svg>
<div class="panel"><div class="icon">${icon}</div><h1>Ride Finder</h1>
<p>Curvy roads, fast sweepers and hills. Plan a motorcycle ride for the time you have.</p>
<div class="where">Missouri · Kansas · Texas</div></div>
</body></html>`;

// A file, not a data: URL: the page is a few MB, past what the browser will open from a URL.
const dir = mkdtempSync(join(tmpdir(), 'rf-preview-')), file = join(dir, 'preview.html');
writeFileSync(file, html);
const page = await launch({ width: W, height: H });
try {
  await page.goto(pathToFileURL(file).href);
  await sleep(1500);
  await page.screenshot('preview.png');
  console.log(`preview.png: ${curvy.length} curvy roads, ${others.length} others`);
} finally {
  page.close();
  rmSync(dir, { recursive: true, force: true });
}
