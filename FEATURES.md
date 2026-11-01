# Ride Finder: features and requirements

Ride Finder helps a motorcyclist find and plan rides on curvy, fast, hilly roads, starting
with Missouri and Kansas. This document is the spec for what the app does today. It
lists what each feature must do, the numbers it relies on, and the lessons that shaped it,
so a rewrite can keep the behavior without rediscovering them.

Live site: https://nosv1.github.io/claudes-ride-finder/ (GitHub Pages, `main` branch, repo root).
v2, the new map-first interface (MapLibre, 3D terrain, bottom sheet, offline), is at `/v2/` and implements the same
features; its logic lives in `v2/js/` as plain modules tested in Node.

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

**Road row format** (one OSM way):
`[id, highway, name, ref, mph|null, estMph|null, surface, score, curvy, sweep, length, coords, hill|null, blind]`
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

**Basemaps**
- Esri Dark Gray Canvas (default) or World Imagery. Both are keyless.
- Place-name labels sit in a separate layer above the roads.
- CARTO now requires a key, so don't use it.

**Hillshade**
- Esri World_Hillshade blended under the roads: `overlay` at 55% on Dark, `multiply` at 40% on Satellite.
- Toggled in the layer control.

**Tile loading**
- Loads the 0.5° tiles in view (padded 20%) at zoom ≥ 7 by injecting script tags.
- Tiles listed in `TILE_INDEX` load once. Status line: "Loading N areas…".

**Highway shields**
- One per stretch of numbered or lettered highway (motorway–tertiary with a `ref`) on highlighted roads.
- Shown at zoom ≥ 10, at least 80 px apart.
- Planned routes get their own blue-ringed shields, from the router's street names (I/US/MO/K/KS refs).

## 3. Find roads

**Modes**
| Mode | Shows | Colored by |
|---|---|---|
| Best rides (default) | curvy and sweeper roads with a limit (posted or estimated) ≥ the chosen 35/40/45/50/55 mph | curviness |
| Curvy | all curvy and sweeper roads | curviness |
| Speed limits | roads with a posted limit only; county and residential roads hidden below zoom 11 | 9 speed bins (≤20 … 70+) |

**Curviness bins**, by score per metre:
- Some curves ≥ 0.15
- Curvy ≥ 0.35
- Very curvy ≥ 0.6
- Twisty ≥ 0.9
- Sweepers (cyan) when no tight-curve bin applies

Clicking a legend entry toggles that bin.

**Filters**
- **Hills:** any / rolling+ / hilly+ / very hilly (curvy modes).
- **Hide gravel & dirt** (default on). Unknown-surface county roads draw dashed.

**Best roads in view**
- Named stretches in view, at most 8, ranked by Σ (score + 0.5 × sweep) × (1 + hill/30).
- Each row shows curvy miles and a hill word.
- Hover outlines the stretch, click zooms to it and selects it, and ＋ adds it to the trip.
- A "stretch" means pieces of the same ref/name within ~3 km. Missouri reuses lettered routes in every county.

**Hover and popups on the map**
- Hovering a road outlines its whole stretch.
- Clicking opens a popup at the click point. It shows:
  - the road name and ref;
  - whole-stretch curve miles and hills, with **＋ Add to trip** at the top;
  - this piece's curviness, hills ft/mi, blind-crest count, speed limit (or "~55 mph (estimate)"), and surface;
  - **Street View** at the nearest point on the road, facing along it;
  - **Satellite** and **OSM** links.
- Popups pan clear of the panel.

**Overlays**
- Blind crest ⚠ markers on displayed roads at zoom ≥ 11 (toggle).
- Gas stations colored by 90+ status at zoom ≥ 9 (toggle, off by default).

## 4. Search

- One box at the top of the panel.
- **Local results (instant, offline):**
  - road stretches by ref or name, ignoring words like hwy/route/road and normalizing "K-10"/"k10"/"K 10";
  - towns, with apostrophes ignored ("lees summit");
  - "road + town" queries such as "MO Y camdenton", which find that road within 30 km of the town.
  - Short query words (≤ 2 characters) must match whole words, so "y" doesn't match "york".
  - Queries that look like route numbers list roads first.
- **Online results:** Photon (photon.komoot.io) after 350 ms, biased to the map center and limited to the covered area plus 1°.
- **Picking a result:**
  - a road frames its bounds, then outlines that stretch once its tiles load;
  - a place zooms there and drops a pin;
  - **Start** makes it the trip start.
- **Keys:** Enter picks the first result, Esc clears.

## 5. Plan trip

**Stops**
- **Pinned points:** a start from "my location", or "Pin a stop" by clicking the map. These pins can be dragged.
- **Roads:** ridden end to end. Each has an entry, up to 2 "through" points that keep the router on the road, and an exit.
  - Added roads are oriented to start from the end nearer the previous stop.
- Rows can be reordered (↑↓), flipped (⇄) and removed (✕).
- **Options:** "Return to start" (loop); between roads: Fastest / Balanced / Back roads only.

**Routing**
- Valhalla motorcycle profile (valhalla1.openstreetmap.de) with `use_highways` 1 / 0.5 / 0.
- **The public server takes at most 10 locations per request.** Longer trips are sent in overlapping chunks and joined.
- Falls back to OSRM (fastest only, with a note shown) if Valhalla fails. OSRM can't avoid motorways.

**Summary**
- Miles, riding time, miles on curvy roads, and the blind-crest count along the route.
- **Elevation profile:** total climbing, low and high points, from Terrain Tiles z11 read in the browser. Hovering the chart marks that point on the map.

**Fuel**
- Settings: tank range (80–250 mi, default 120) and "only 90+ stations".
- Uses stations within 1.2 km of the route.
- Suggests stops by refueling at the farthest station within 85% of the range, assuming a full tank at the start.
- Warns about any stretch longer than the range, and shows the longest stretch without a station.
- ＋ inserts a station at the right place in the trip.

**Generate a ride**
- Ride time 1–8 h. The start is the first stop, or the rider's location.
- Looks at roads within `hours × 80 / 2.6` km.
- For each of 12 directions (60° either side):
  - adds roads one at a time, taking the most score per extra hour of estimated riding (60 km/h on roads, 80 km/h between, ×1.3 road factor);
  - up to 4 roads per loop, ordered by angle so the loop goes out one side and back the other.
- Ranks loops by fun × the share of time on good roads, routes the top 6, and trims the weakest road while one runs more than 15% over time.
- Lists the options with time, miles, curvy miles and %, and blind crests. Hover previews a loop and click loads it.

**Export**
- **Google Maps:** directions links (9 waypoints each, split into parts).
  - Google re-plans between stops, so the app adds its own stops, up to 2 links' worth.
  - The trip's own stops are always kept.
  - Then a stop in the middle of any stretch over 25 km without one.
  - Then stops 200 m past the turns onto the longest roads, at least 800 m apart.
- **GPX:** waypoints, a route and the full track. For OsmAnd (free and follows the track), Calimoto, REVER, Garmin.
- **Share link:** `#trip=` base64 JSON of the stops and settings. Opening it loads the trip and switches to Plan trip.
- **Persistence:** the trip saves to localStorage on every change.

## 6. Constraints and lessons (don't relearn these)

- **Public Overpass servers are unreliable**: 504s, timeouts, and 406s for curl's user agent. This is why data is prebuilt.
- **Leaflet renderers:** any vector layer without an explicit `renderer` uses the default canvas, which
  lands *above* the roads' canvas and swallows every road click and hover. This bug happened three times.
  - Overlays above the roads must use SVG in a pane whose `<svg>` has `pointer-events: none`.
  - Layers below the roads can be canvas.
- Elements with the `hidden` attribute need `[hidden] { display: none !important }`, because `.row { display: flex }` overrides it.
- **Hosts and access:**
  - Terrain Tiles and Photon allow cross-origin reads.
  - FOSSGIS Valhalla and OSRM do too.
  - Esri tiles need no key.
- **Google Maps URLs:** the reliable forms are `/maps/@?api=1&map_action=pano&viewpoint=…&heading=…` (Street View) and `/maps/dir/?api=1&…&waypoints=a|b` (directions).

## 7. Tests

See `tests/README.md`. `python -m unittest discover tests` runs the build-logic tests. `python tests/browser/run.py` drives the page in headless Edge or Chrome.
