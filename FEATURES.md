# Ride Finder: features and requirements

Ride Finder helps a motorcyclist find and plan rides on curvy, fast, hilly roads, starting
with Missouri and Kansas. This document is the spec for what the app does today. It
lists what each feature must do, the numbers it relies on, and the lessons that shaped it,
so a rewrite can keep the behavior without rediscovering them.

Live site: https://nosv1.github.io/claudes-ride-finder/ (GitHub Pages, `main` branch, repo root).
The app is static: `index.html`, `app.css` and the modules in `js/` (the logic ones are plain modules tested
in Node), plus the prebuilt data in `tiles/`. `/v2/` only redirects to the root (the app was previewed there).

---

## 1. Data build (`build_tiles.py`)

The site is static. All road data is prebuilt offline from OpenStreetMap state extracts, then
committed as `tiles/`. The app needs no OSM server at runtime.

**Inputs**
- Every `raw/*.osm.pbf` (Geofabrik state extracts). `raw/` is gitignored.
- AWS Terrain Tiles (Terrarium PNG, zoom 12, ~30 m/px), downloaded once into `raw/terrain/`,
  only for tiles touching curvy roads (~5,300 tiles / 560 MB for MO+KS).
- Run with `python build_tiles.py`. It globs `raw/*.osm.pbf` itself, because cmd.exe doesn't expand `*`.

**Outputs** (all plain `<script>` files, so the page also works opened as a local file)
| File | Contents |
|---|---|
| `tiles/index.js` | `window.TILE_INDEX = {size: 0.5, built, regions, tiles: ["x_y", …]}` |
| `tiles/{x}_{y}.js` | `addTile("x_y", rows)`, one 0.5° tile, each road assigned by its midpoint |
| `tiles/fuel.js` | `window.FUEL = [[lat, lon, label, city, status90, hours], …]` |
| `tiles/search.js` | `window.SEARCH = {places: [[name, lat, lon, kind]], roads: [[key, name, s, w, n, e, curveMetres, nearestTown]]}` |

**Road row format** (one OSM way, or one joined ramp):
`[id, highway, name, ref, mph|null, estMph|null, surface, score, curvy, sweep, length, coords, hill|null, blind, lanes|null]`
- `coords`: 1e-5° integers, delta-encoded `[dlat, dlon, …]`. `blind`: absolute 1e-5° pairs.
- `surface`: 0 paved, 1 gravel/dirt, 2 unknown (only `unclassified` roads with no tag; state routes assumed paved).

**Which roads are kept:** a way is kept if it is curvy, a sweeper, or has a posted speed limit.
- Curvy and sweeper candidates: `primary`, `secondary`, `tertiary`, `unclassified`.
- Speed-only roads also include `motorway`, `trunk`, `residential` and all `_link` types.
- Ramps (`_link`) are never curvy, because they're tight loops that would score as "twisty".

**Curvature score**
- Resample every 25 m, take the circumradius of each triple, and weight it by radius:
  <30 m ×2, <60 m ×1.6, <100 m ×1.3, <175 m ×1. Score = Σ weight × 25 m. Curvy metres = Σ 25 m where weight > 0.
- A way counts as curvy if its score is ≥ 250. That filters out roads with only a corner or two.

**Sweepers**
- Resample every 100 m; that spacing ignores the GPS wobble in mapped straight roads. Count radii of 150–600 m.
- Stored if ≥ 300 m. The app shows a road as a sweeper if it has ≥ 800 m of sweeps, or ≥ 400 m covering ≥ 50% of the road.
- Looser rules flooded farm country.
- Regression case: MO-150 east of Lee's Summit (way 18518688) must be a sweeper with an estimated 55 mph.

**Speed limits**
- `maxspeed`, falling back to `maxspeed:forward`/`backward`. Bare numbers are read as mph, because that's how US mappers use them.
- Roads without a limit get an estimate:
  - **30 mph:** in town, meaning ≥ 40 residential streets in the surrounding 3×3 grid of ~1 km cells.
  - **45 mph:** `unclassified` (county) roads.
  - **55 mph:** everything else.

**Hills and blind crests** (curvy roads and sweepers only)
- **Hill:** total climbing plus descending in m per km, using a 2 m hysteresis.
- **Hill levels:** flat <12, rolling ≥12, hilly ≥22, very hilly ≥35.
  - Calibrated on real roads: western Kansas ≈11, around KC ≈18, Ozarks ≈30.
- **Blind crest corner:** a point ≥ 3 m above the average of the points 75 m before and after it, a local maximum, with a turn of radius < 120 m within 25 m before to 75 m after it.
  - One flag per crest.

**Fast ramps** (`motorway_link`, `trunk_link`)
- OSM splits ramps into short pieces, so pieces are joined end to end where nothing merges or splits, then
  scored as one ramp, stored under the first piece's id and named from `destination:ref` ("Ramp to I 435 North").
- **Never joined across a junction:** not at a node tagged `traffic_signals` or `stop`, nor where another road
  passes through or crosses (a way through the node, or two ending there). A road that only starts there is a
  fork the ramp carries on past, so that still joins (US 63 at MO 763). A ramp piece with a light or stop sign
  partway along is dropped. Regression cases: MO-291 at MO-150 (Lee's Summit), I-35 at Princeton St (Ottawa) were
  off-ramp + on-ramp joined across the crossroad into one "flyover". A first pass over each `.pbf` collects ramp
  nodes so the main pass can see which other roads touch them.
- Sweep for ramps counts radii of 150–1,500 m (highway-speed ramps curve wider than back roads).
- Kept if they sweep ≥ 300 m or have a posted limit. No elevation (bare-earth data is meaningless on a flyover),
  not in the search index. Lane counts go on every row (index 14).
- The app's rule for a **fast ramp**: sweep ≥ 300 m and no more than half as much tight curve, which drops
  cloverleaf loops. Tiers: Sweeping ramp ≥ 300 m, Long sweep ≥ 600 m, Flyover ≥ 1,000 m.

**Gas stations**
- `amenity=fuel` nodes and ways (centroid). Diesel or truck-only pumps are skipped.
- 90+ octane status:
  - **2:** listed, meaning `fuel:octane_N=yes` for N ≥ 90, or `fuel:premium=yes`.
  - **−1:** no, meaning an explicit `no` for octane 90–94. A "no" for 95/98/100 is ignored, since those are copied from European presets.
  - **1:** likely, meaning a major brand that sells premium.
  - **0:** unknown.

**Search index**
- Every city, town and village.
- Every named curvy or sweeper stretch with ≥ 800 m of curves.
  - Pieces with the same ref/name within 0.03° count as one stretch.
  - Each stretch stores its bounding box and nearest town.

## 2. Map

MapLibre GL (WebGL). Everything outside `js/mapview.js` works in [lat, lon].

**Basemaps and terrain**
- Esri Dark Gray Canvas (default) or World Imagery as raster layers, both keyless. CARTO now requires a key.
- Place-name labels sit in a separate raster layer above the roads.
- Hillshade drawn by MapLibre from AWS Terrain Tiles (Terrarium encoding), toggled in the layers menu.
- **3D** button: terrain from the same tiles at 1.5× exaggeration and a 60° pitch.
- Map text (shields) uses OpenFreeMap's font server (Noto Sans).

**Roads on the map**
- One GeoJSON source of every loaded road. Each road carries its curve class, speed, whether the limit is
  posted, speed bin, hill level, surface, minor-road flag and ref.
- The mode and filters become layer filters that mirror `roads.visible()`, so changing a filter never rebuilds the data.
- Unknown-surface county roads draw dashed, in a separate layer.
- **Highway shields:** a line-placed symbol layer on numbered and lettered highways (motorway–tertiary with a `ref`)
  at zoom ≥ 9. MapLibre handles spacing and collisions.
- Planned routes get blue-ringed shields from the router's street names (I/US/MO/K/KS refs).
- Blind crest ⚠ symbols on visible roads at zoom ≥ 11 (toggle).
- Gas stations colored by 90+ status at zoom ≥ 9 (toggle, off by default).

**Tile loading**
- Road data loads by injecting script tags for the 0.5° tiles in view (padded 10%). It doesn't wait for the map
  to be ready. Tiles in `TILE_INDEX` load once.

## 3. Find roads

**Layout**
- A floating search bar with filter chips under it: mode, speed floor (Best rides), hills, Paved, ⚠ Blind crests, Gas.
- Chip menus close on a second tap of the chip, a tap anywhere else, Esc, or the map moving.
- **Phones:** a bottom sheet with peek, half and full heights. Drag its handle, or tap the handle to step through.
  - Its height is always the visible part, placed from `window.innerHeight`, so nothing runs under the browser's
    bottom toolbar (Edge).
  - At full height it stops just below the chips.
- **Desktop (≥ 900 px):** the same content in a left panel.
- The map's padding follows the sheet or panel, so centring and fitting use the uncovered part of the map.
- Map buttons: my location, 3D, layers (Dark / Satellite / terrain shading).

**Modes**
| Mode | Shows | Colored by |
|---|---|---|
| Best rides (default) | curvy and sweeper roads with a limit (posted or estimated) ≥ the chosen 35/40/45/50/55 mph | curviness |
| All curvy roads | all curvy and sweeper roads | curviness |
| Interchanges | fast interchange ramps only (a different kind of riding) | 3 ramp tiers |
| Speed limits | roads with a posted limit only; county and residential roads hidden below zoom 11 | 9 speed bins (≤20 … 70+) |

Ramps never appear in the curvy modes or the generator's candidates; they're one-way, so a ramp stop is ridden
in its own direction (no ⇄). Ramp cards show sweep, lanes, posted limit (never the town estimate) and length.

**Curve classes**, by score per metre:
- Some curves ≥ 0.15
- Curvy ≥ 0.35
- Very curvy ≥ 0.6
- Twisty ≥ 0.9
- Sweepers (cyan) when no tight-curve class applies

Tapping a class in the key toggles it. **What's this?** at the end of the key opens plain-words rules for each
class (from `about` in `config.js`), plus dashed lines, blind crests and hill levels in ft/mi (rolling 60+, hilly 115+,
very hilly 185+). Desktop also shows each class's rule as a tooltip. The road and ramp cards repeat their class's rule
under the tag, and the Hills chip lists ft/mi.

**Filters**
- **Hills:** any / rolling+ / hilly+ / very hilly, in the curvy modes. Only applied when set above "any".
- **Paved** (default on) hides roads recorded as gravel or dirt.

**Best roads in view**
- Named stretches in view, at most 8, ranked by Σ (score + 0.5 × sweep) × (1 + hill/30).
- Each card shows curvy miles, a hill word and the blind-crest count.
- Hover (desktop) outlines the stretch, tap opens its card, and ＋ adds it to the ride.
- A "stretch" means pieces of the same ref/name within ~3 km. Missouri reuses lettered routes in every county.
- **Plan a ride** stays pinned at the bottom of the sheet.

**Road card** (tap a road, a card, or a search result)
- For the whole stretch: curve class, curve miles, hills (word and ft/mi), speed (posted, or "~55 mph" when
  estimated) and blind crests.
- For this piece: surface, and an elevation chart. Scrubbing the chart marks the spot on the map.
- Buttons: **Add to ride**, **Plan a loop with this road**, **Street View** at the tapped spot facing along the
  road, and **Satellite**.
- Hovering a road on the map (desktop) outlines its whole stretch.

**Long-press the map** (right-click on desktop): Start a ride here, Add a stop here, Street View here.

## 4. Search

- The floating search bar. **/** focuses it on desktop.
- **Local results (instant, offline):**
  - road stretches by ref or name, ignoring words like hwy/route/road and normalizing "K-10"/"k10"/"K 10";
  - towns, with apostrophes ignored ("lees summit");
  - "road + town" queries such as "MO Y camdenton", which find that road within 30 km of the town.
  - Short query words (≤ 2 characters) must match whole words, so "y" doesn't match "york".
  - Queries that look like route numbers list roads first.
- **Online results:** Photon (photon.komoot.io) after 350 ms, biased to the map center and limited to the covered area plus 1°.
- **Picking a result:**
  - a road frames its bounds, then opens that stretch's card once its tiles load;
  - a place flies there and drops a pin;
  - **Start** makes it the ride's start and opens Plan a ride.
- Picking a result drops online results still on their way, so they don't reopen the list (and push the side
  panel down) after the pick.
- **Keys:** Enter picks the first result, Esc clears.

## 5. Plan and ride

**Stops** (Your ride)
- **Pinned points:** the start (my location, a map spot, or a search result) and stops added on the map. Pins can be dragged.
- **Roads:** ridden end to end. Each has an entry, up to 2 "through" points that keep the router on the road, and an exit.
  - **Add to ride** (road card, ＋ on a card, or **Add road** on Your ride then tap a road on the map) puts the road
    where it adds the least straight-line distance (counting the ride home on a loop, never before the start),
    entered from whichever end does that. The toast says which end ("in at the north end") with **Switch ends**.
  - Road rows say which end they're entered and left at ("South end → north end").
- Rows can be reordered by dragging their grip (touch too), flipped (⇄) and removed (✕).
  - The drag is followed on the whole window: moving the row in the list drops the grip's pointer capture.
    Re-renders wait until the row is dropped.
- **Options:** "Return to start" (loop); between roads: Fastest / Balanced / Back roads.

**Routing**
- Valhalla motorcycle profile (valhalla1.openstreetmap.de) with `use_highways` 1 / 0.5 / 0.
- **The public server takes at most 10 locations per request.** Longer trips are sent in overlapping chunks and joined.
- **No U-turns at stops** (Valhalla `break_through`; the start and finish stay `break`), so a route doesn't ride
  back down a road it just finished. If Valhalla answers with no route that way (a dead end), it's asked again
  allowing them.
- Falls back to OSRM (fastest only, with a note shown) if Valhalla fails. OSRM can't avoid motorways.
- Arrows along the route line show the direction of travel (zoom 10+).

**Summary**
- **Doubled back:** miles of the route ridden a second time, along or against an earlier pass (crossings don't
  count; the first and last 1.5 km from the start and finish don't either). Sampled every 15 m on a ~60 m grid,
  needing headings within ~37° (either way) and 400 m of route between passes. Shown from 0.25 mi as a note with the
  stretches dashed orange on the map, and **Try fixing**: each road is tried the other way round (one route request
  each), keeping a flip when it cuts the doubling back by 200 m+ without adding more than 15% to the ride.
- Miles, riding time, miles on curvy roads, and the blind-crest count along the route.
- **Elevation profile:** total climbing, low and high points, from Terrain Tiles z11 read in the browser.
  Scrubbing the chart (mouse or finger) marks that point on the map.
- A ride bar on the main list shows the ride's stats with **Go**.

**Fuel**
- Settings: tank range (80–250 mi, default 120) and "90+ only".
- Uses stations within 1.2 km of the route.
- Suggests stops by refueling at the farthest station within 85% of the range, assuming a full tank at the start.
- Warns about any stretch longer than the range, and shows the longest stretch without a station.
- ＋ inserts a station at the right place in the ride.

**Generate loops** (Plan a ride)
- Ride time 1–8 h. The start is the first stop, or the rider's location.
- **Must include:** the rider's own stops (roads, gas stops, pinned points).
  - Every loop goes through them.
  - Loops head their way: straight at them, or swinging 35° or 70° to either side.
  - Without any, all 12 directions are tried.
- Looks at roads within `hours × 80 / 2.6` km.
- For each direction (60° either side):
  - adds roads one at a time, taking the most score per extra hour of estimated riding (60 km/h on roads, 80 km/h
    between, ×1.3 road factor), up to the chosen time;
  - each road is charged at least its share of the time still to fill (time left ÷ road slots left), and near ties
    go to the road using more time, so long rides reach out instead of stacking short roads by the start;
  - up to max(4, 1.5 × hours) roads, at most 9 (a 6 h loop needs about 9), ordered by angle so the loop goes out
    one side and back the other;
  - ranked by score × share of time on the roads × (estimated hours ÷ chosen hours)², so loops that fill the time win.
- Generated stops are marked `gen`. Generating again swaps them but keeps the rider's.
- **Loops must route to 80–120% of the chosen time.** Under 80%, the loop is filled again aiming longer by the
  ratio the estimate was off (up to twice, 2 more roads allowed); over 120%, its weakest generated road is dropped
  (up to twice). Only loops in range are shown; if none are, the 3 nearest with a note. (A 6 h request once gave a
  1.5 h loop: the old limit of 4 roads and pure score-per-hour stacked short roads near the start.) Measured live
  from Lee's Summit: 6 h loops 6.1–6.8 h, 3 h loops 2.9–3.5 h.
- Trimming a loop only drops generated roads.
- Routes the top 6 up front.
- Roads are turned end for end to make the rides between them shortest over the whole loop (not nearest end first).
- **Doubling back:** loops are ranked by curvy² / miles × (1 − 3 × share ridden twice), floor 0.1. A loop riding
  more than 4% twice is tried without the generated road most to blame (the one the doubled-back miles are on,
  else the nearest), up to twice, keeping the change only if it ranks higher. Loops riding more than 20% twice are
  left out when at least 3 others remain. Measured on Oct-31 data: the top loop from south KC went from 29% to 13%,
  from the Lake of the Ozarks from 28% to 1%.
- Option cards show time, miles, curvy miles and %, blind crests, miles ridden twice, and the roads, with the
  rider's in bold.
  Hover previews a loop; tap loads it as the ride.

**Export**
- **Go / Open in Google Maps:** directions links (9 waypoints each, split into parts).
  - Google re-plans between stops, so the app adds its own stops, up to 2 links' worth.
  - The trip's own stops are always kept.
  - Then a stop in the middle of any stretch over 25 km without one.
  - Then stops 200 m past the turns onto the longest roads, at least 800 m apart.
- **GPX:** waypoints, a route and the full track. For OsmAnd (free and follows the track), Calimoto, REVER, Garmin.
- **Share:** the phone's share sheet (or the clipboard) with a `#trip=` link.
  - The link holds base64 JSON of the stops and settings.
  - Links from the original app work too. Opening one loads the ride.
- **Persistence:** the ride saves to localStorage on every change. A ride saved by the original app is picked up once.

**Location**
- A quick, rough fix first (or one the phone already has), then a precise GPS fix.
- Errors say which problem it was: blocked permission (with iPhone steps), no fix, a timeout, or a non-https page.

**Installable and offline**
- Web app manifest and icons (`tools/make_icons.py`).
- The service worker serves app files network-first, so updates show at once and the cache covers offline use.
- Map imagery, terrain and fonts are cached as you browse (cache-first), up to ~4,000 tiles.

## 6. Constraints and lessons (don't relearn these)

- **Public Overpass servers are unreliable**: 504s, timeouts, and 406s for curl's user agent. This is why data is prebuilt.
- **MapLibre's `load` event** waits for every first tile and may never come on a slow connection or in a headless
  browser.
  - The app waits for the style instead, by polling `isStyleLoaded()`.
  - Road data doesn't wait for the map at all.
- **Headless `--virtual-time-budget` races MapLibre's web workers.** Browser tests drive Edge/Chrome over the
  DevTools protocol with real waiting instead (`tests/app/cdp.mjs`).
- **Phones and `100vh`:** the visible height excludes browser toolbars, so size from `window.innerHeight`.
- **A sheet slid partly off-screen hides its end.** Size the sheet to its visible height instead of translating it.
- Elements with the `hidden` attribute need `[hidden] { display: none !important }`, because `display: flex` rules override it.
- **Hosts and access:**
  - Terrain Tiles, Photon, OpenFreeMap fonts, FOSSGIS Valhalla and OSRM allow cross-origin reads.
  - Esri tiles need no key.
- **Google Maps URLs:** the reliable forms are `/maps/@?api=1&map_action=pano&viewpoint=…&heading=…` (Street View)
  and `/maps/dir/?api=1&…&waypoints=a|b` (directions).
  - "No Street View" means Google has no imagery near that spot, and it offers no way to search farther.

## 7. Tests

See `tests/README.md`:
- Build logic in Python: `python -m unittest discover tests`.
- The app's logic modules in Node: `node --test tests/app/logic.test.mjs`.
- The app in headless Edge/Chrome: `node --test tests/app/browser.test.mjs` (`RF_NETWORK=1` adds live routing).
