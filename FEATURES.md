# Ride Finder: features and requirements

Ride Finder helps a motorcyclist find and plan rides on curvy, fast, hilly roads, starting
with Missouri, Kansas and Texas. This document is the spec for what the app does today. It
lists what each feature must do, the numbers it relies on, and the lessons that shaped it,
so a rewrite can keep the behavior without rediscovering them.

Live site: https://nosv1.github.io/claudes-ride-finder/ (GitHub Pages, `main` branch, repo root).
The app is static: `index.html`, `app.css` and the modules in `js/` (the logic ones are plain modules tested
in Node), plus the prebuilt data in `tiles/`.

---

## 1. Data build (`build_tiles.py`)

The site is static. All road data is prebuilt offline from OpenStreetMap state extracts, then
committed as `tiles/`. The app needs no OSM server at runtime.

**Inputs**
- Every `raw/*.osm.pbf` (Geofabrik state extracts). `raw/` is gitignored.
- AWS Terrain Tiles (Terrarium PNG, zoom 12, ~30 m/px), downloaded once into `raw/terrain/`,
  only for tiles touching curvy roads (~5,300 tiles / 560 MB for MO+KS; 1.3 GB with Texas).
  A full build of all three takes about 11 minutes the first time, 7–8 once the terrain is cached; `tiles/` is ~67 MB
  (Dallas's tile is the largest, ~5.6 MB, from all its posted residential limits).
- Run with `python build_tiles.py`. It globs `raw/*.osm.pbf` itself, because cmd.exe doesn't expand `*`.

**Outputs** (all plain `<script>` files, so the page also works opened as a local file)
| File | Contents |
|---|---|
| `tiles/index.js` | `window.TILE_INDEX = {size: 0.5, built, regions, tiles: ["x_y", …], speed: ["x_y", …]}` (tiles with curvy / speed-only files) |
| `tiles/{x}_{y}.js` | `addTile("x_y", rows)`, one 0.5° tile, each road assigned by its midpoint |
| `tiles/{x}_{y}.s.js` | `addTile("x_y.s", rows)`: the same tile's roads kept only for their speed limit (~70% of the data) |
| `tiles/signals.js` | `window.SIGNALS = [dlat, dlon, …]`: every `highway=traffic_signals` node, 1e-5° delta-encoded, sorted (`python tools/add_signals.py` writes just this, reading only the nodes) |
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
  - **Texas** (by state law outside towns): **70 mph** on numbered highways (US, TX, FM/RM, Loop, Spur…),
    **60 mph** on everything else, county roads (`CR`) included. The region comes from the `.pbf` file name.
  - Regression case: the Twisted Sisters (RM 335/336/337 by Leakey) top Best roads in the Hill Country.

**Hills and blind crests** (curvy roads, sweepers and straight back roads)
- **Hill:** total climbing plus descending in m per km, using a 2 m hysteresis.
- **Hill levels:** flat <12, rolling ≥12, hilly ≥22, very hilly ≥35.
  - Calibrated on real roads: western Kansas ≈11, around KC ≈18, Ozarks ≈30.
- **Blind crest corner:** a point ≥ 3 m above the average of the points 75 m before and after it, a local maximum, with a turn of radius < 120 m within 25 m before to 75 m after it.
  - One flag per crest.

**Roller coasters** (straight back roads that go up and down a lot)
- Every `primary`/`secondary`/`tertiary`/`unclassified` road over 1 km that isn't curvy or a sweeper is measured
  too. Hilly or more (≥ 22 m/km, 115 ft/mi) makes it a roller coaster, kept in the main `x_y` tiles; the rest
  stay speed-only (or are dropped when they have no posted limit, as before).
  - For these roads the hills are only the climbing that's matched by dropping (2 × the smaller of up and down), so
    one long grade doesn't count: the Red Route in Branson only goes downhill and used to read 43 m/km.
  - A road whose smoothed profile is steeper than 18% over 100 m isn't rated: that's the hillside or bluff beside
    the road in the bare-earth terrain (MO 39 by Shell Knob read as 28% grades along Table Rock Lake).
  - Under 1 km is mostly bridges (the bare-earth terrain has the valley under them) and corners. Highways are left
    out: road cuts and fills make the terrain beside them hillier than the road.
- The build has to keep unposted straight back roads until it has measured them, so a full build reads elevation
  for nearly every rural road, not only the curvy ones.
- `python tools/add_hills.py` does this on the built tiles without the raw files, for the straight roads in them:
  only those with a posted limit (the build drops the others), so a full build finds more.
- Same numbers in `build_tiles.py` (`ROLLER_*`) and `js/config.js` (`ROLLER`).

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

**Highway sweeps** (`motorway`, `trunk` posted ≥ 65 mph), added after everything else is built
- OSM splits highways at every ramp, bridge and limit change, so pieces are joined end to end (each one-way
  carriageway on its own) where the next piece carries straight on (< 30° turn; at a fork, the straightest).
  A piece under 65 mph, or with no posted limit, ends the line.
- Resample the joined line every 100 m and count radii of 150–1,500 m, as for ramps. Curves less than 300 m apart
  are one stretch; a stretch is kept if it sweeps ≥ 600 m. 200 m of straight is kept either side.
- Each stretch is a row in the curvy file of its midpoint's tile: id is minus its first piece's id (a negative
  id never clashes with a way's); limit is the lowest posted along it; lanes the fewest recorded.
- A `trunk` counts only where it's divided: another highway piece running the opposite way within 80 m along most
  of it. A two-way trunk is one line for both directions, not a one-way sweep.
- `python tools/add_highway_sweeps.py` reruns just this step on the built `tiles/` (replacing earlier highway
  sweeps), since everything it needs is in the tiles. About 15 s; no state downloads or full rebuild.
- Regression case: I-435 between Renner Blvd and Lackman Rd in Lenexa sweeps both ways (3 lanes, 65 mph).
- In the app: Highway sweep ≥ 600 m and Big highway sweep ≥ 1,200 m, with 3+ lanes counting ×1.25 (so a 3-lane
  stretch is Big from 960 m). The same bonus applies to their rank in the list.

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
- **3D** button: terrain from the same tiles at 2× exaggeration (hills look flat from above at real height), a
  65° pitch, and tilting allowed to 85° so the camera can sit low. A hazy sky fills the view above the horizon,
  and the gap the map leaves short of the horizon is painted the horizon's color instead of black.
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
- Pop-ups (toasts) last 2 s + 40 ms a letter, at most 5 s (at least 4.5 s with a button like Undo); a tap closes one.
- **Phones:** a bottom sheet with peek, half and full heights. Drag its handle, or tap the handle to step through.
  Swiping the content moves the sheet too, like a map app: down when the list is at its top, up until the sheet is
  full; otherwise the swipe scrolls the list. A swipe of 50 px moves at least one height. (Stop grips and the
  elevation chart keep their own drags.) The swipe is followed on the touched element, which keeps getting the
  touch even if the list re-renders under the finger as roads load.
  - Its height is always the visible part, placed from `window.innerHeight`, so nothing runs under the browser's
    bottom toolbar (Edge).
  - At full height it stops just below the chips.
- **Desktop (≥ 900 px):** the same content in a left panel.
- The map's padding follows the sheet or panel, so centring and fitting use the uncovered part of the map.
- Map buttons: my location, 3D, layers (Dark / Satellite / terrain shading).

**Loading roads**
- Curvy roads, sweepers and fast ramps (the `x_y` files, 19 MB for all three states) load for the view from zoom 7.
  Below that nothing new loads and the list says "Zoom in to see roads": zoomed out over Texas the app used to load
  every tile, both kinds (~67 MB), and phones crashed.
- Speed-only roads (`x_y.s`, 47 MB) load only in Speed limits mode, from zoom 9 ("Zoom in to see speed limits").
- Measured on a phone-size page: KC, Austin, Dallas and the Hill Country at zoom 9, then zoom 4 over Texas: ~110 MB
  of JS heap, nothing loaded at zoom 4.

**Modes**
| Mode | Shows | Colored by |
|---|---|---|
| Best rides (default) | curvy and sweeper roads with a limit (posted or estimated) ≥ the chosen 35/40/45/50/55 mph | curviness |
| All curvy roads | all curvy and sweeper roads | curviness |
| Speed limits | roads with a posted limit only; county and residential roads hidden below zoom 11 | 9 speed bins (≤20 … 70+) |

**Road type** (a chip in Best rides and All curvy roads): which roads those modes show, and the generator uses.
| Road type | Shows | Colored by |
|---|---|---|
| All roads (default) | the curvy roads, plus highway sweeps and Flyover ramps | curviness; highways and flyovers all white ("Highways") |
| Back roads | the curvy roads only | curviness |
| Highways | fast ramps (all 3 tiers) and highway sweeps only (a different kind of riding); the mph and hills chips go away | 3 ramp tiers, 2 highway tiers |

Highway sweeps and fast ramps are never held to the mph or hills chips, on the map or in the generator, with any
road type: with Highways those chips are hidden, and a setting left from All roads doesn't apply.

All roads leaves out the smaller ramp tiers: across a metro at zoom 10–11, every interchange's ramps drew as white
confetti over the curvy roads. The Highways chip in its key turns all highways off and on. Saved settings in the old
Interchanges mode open as Best rides with Highways.

Ramps are never generator candidates (highway sweeps are, see Generate loops); they're one-way, so a ramp stop is ridden
in its own direction (no ⇄). Ramp cards show sweep, lanes, posted limit (never the town estimate) and length.
Highway sweeps work the same way. They're named for the way they head, from first point to last ("I 435 heading
south"), so the two directions are separate stretches, and they're hidden in Speed limits mode, where the plain
highway pieces they're made from already draw.

**Curve classes**, by score per metre:
- Some curves ≥ 0.15
- Curvy ≥ 0.35
- Very curvy ≥ 0.6
- Twisty ≥ 0.9
- Sweepers (cyan) when no tight-curve class applies
- **Not a curvy road:** a closed loop under 1 km (first point = last). Roundabouts and circle drives are all
  curve and showed as Twisty dots (282 of them in KS/MO/TX, e.g. the I-49 / Main St roundabouts in Grandview).
  Loop roads over 1 km (park loops) stay. Roundabouts stored as several pieces aren't caught; see the backlog.

Tapping a class in the key toggles it. **What's this?** at the end of the key opens plain-words rules for each
class (from `about` in `config.js`), plus dashed lines, blind crests and hill levels in ft/mi (rolling 60+, hilly 115+,
very hilly 185+). Desktop also shows each class's rule as a tooltip. The road and ramp cards repeat their class's rule
under the tag, and the Hills chip lists ft/mi.

**Roller coasters** (a chip in the key, off by default, not in Highways)
- Draws the roller coasters in tan (`#c08457`). The hills, mph, Paved and blind-crest filters apply to them too.
- Under Best roads in view: "Roller coasters in view", the top 3 by hills × length. They're never in Best roads,
  and the loop generator doesn't build loops around them (to be aware of, not to ride for). They can still be
  added to a ride by hand.
- Their card says Roller coaster, with the rule, its length and its hills instead of curve miles.

**Filters**
- **Hills:** any / rolling+ / hilly+ / very hilly, in the curvy modes. Only applied when set above "any".
- **Paved** (default on) hides roads recorded as gravel or dirt.

**Best roads in view**
- Named stretches in view, at most 8, ranked by Σ (score + 0.5 × sweep) × (1 + hill/30).
- Each card shows curvy miles, a hill word and the blind-crest count.
- Hover (desktop) outlines the stretch, tap opens its card, and ＋ adds it to the ride.
- A "stretch" means pieces of the same ref/name within ~3 km. Missouri reuses lettered routes in every county.
- **Plan a ride** stays pinned at the bottom of the sheet.

**What's this road?** Tapping any road puts a little tag right there with its name and limit: "MO 7 · 55 mph",
"about 45 mph (not posted)" from the estimate, or "no posted limit" on highways and ramps. A colored road also
opens its card. For the others it loads that spot's speed-limit tile just for the tap (from zoom 10; they're up to
a few MB, so not for every view), with "Checking the speed limit…" in the tag meanwhile, and looks within about 14
screen pixels (20–400 m). The tag goes after 5 s. (It used to be a toast at the bottom of the screen, gave up after
8 s of loading, and looked within 120 m at most, so at zoom 11–12 a tap had to land within 4–8 px of the road.)

**Road card** (tap a road, a card, or a search result)
- For the whole stretch: curve class, curve miles, hills (word and ft/mi), speed (posted, or "~55 mph" when
  estimated) and blind crests.
- For this piece: surface, and an elevation chart. Scrubbing the chart marks the spot on the map.
- Buttons: **Add to ride**, **Plan a loop with this road**, **Street View** at the tapped spot, and **Satellite**.
  - Street View faces the way the planned route travels there, when the route uses this road (within 40 m).
    Otherwise it faces the way the road is drawn in OSM: the direction of travel on a ramp, but arbitrary on a
    two-way road (it looked backwards half the time), so two-way roads get a ⇄ button for the other way.
- Hovering a road on the map (desktop) outlines its whole stretch.

**Long-press the map** (right-click on desktop): Start a ride here, **Ride <road> end to end** (when the spot is on a
colored road), Add a stop here, Street View here.

## 4. Search

- The floating search bar. **/** focuses it on desktop.
- **Local results (instant, offline):**
  - road stretches by ref or name, ignoring words like hwy/route/road and normalizing "K-10"/"k10"/"K 10";
  - towns, with apostrophes ignored ("lees summit");
  - "road + town" queries such as "MO Y camdenton", which find that road within 30 km of the town.
  - Short query words (≤ 2 characters) must match whole words, so "y" doesn't match "york".
  - Queries that look like route numbers list roads first.
- **Online results:** Photon (photon.komoot.io) after 350 ms, biased to the map center and limited to the covered area plus 1°.
- **Picking a result** puts its name in the box (✕ clears the box, the pin and the place card):
  - a road frames its bounds, then opens that stretch's card once its tiles load;
  - a place flies there, drops a pin and opens the place's card: **Add to ride as a stop** (where the route
    passes it, never after a one-way ride's end), **Start here**, **End here** (one way), Street View and
    Directions. Tapping the pin opens the card again. (A rider expected this and got a dot that did nothing.)
  - **Start** in the list makes it the ride's start and opens Plan a ride.
- Tapping a numbered stop marker on the map opens the ride (dragging one still moves it).
- An end set before the start stays the end (it used to become the start).
- Picking a result drops online results still on their way, so they don't reopen the list (and push the side
  panel down) after the pick.
- **Keys:** Enter picks the first result, Esc clears.

## 5. Plan and ride

**Stops** (Your ride)
- **Pinned points:** the start (my location, a map spot, or a search result) and stops added on the map. Pins can be dragged.
  - **Moving a pin:** with a mouse, drag it. On a touchscreen, press and hold (350 ms) to pick it up: it grows, the
    phone buzzes, and it rides 44 px above the finger so it can be seen; let go to drop it. A swipe that starts on a
    pin pans the map. Rows say "drag its pin to move" or, on touch, "hold its pin to move it".
  - **A road stop's pin** dropped on another colored road becomes that road (the toast can undo it). Dropped anywhere
    else it goes back, with a toast saying to drop it on a colored road.
- **Roads:** ridden end to end. Each has an entry, up to 2 "through" points that keep the router on the road, and an exit.
  - **Add to ride** (road card, ＋ on a card, or **Add road** on Your ride then tap a road on the map) puts the road
    where it adds the least straight-line distance (counting the ride home on a loop, never before the start),
    entered from whichever end does that. The toast says which end ("in at the north end") with **Switch ends**.
  - Road rows say which end they're entered and left at ("South end → north end").
  - **A stop on a colored road is that road.** Add stop, then a tap on a colored road, adds the road (as above);
    the toast's **Just a stop** makes it a plain pin there instead. A pinned stop that sits within 30 m of a
    colored road (dragged there, or from an old link) says "Stop on MO 150", with a button that turns it into
    the road, in the same place in the ride, entered from the end that adds the least riding.
- **Your ride** lists the stops first, right under the title, so nothing above them changes height while the
  route is worked out again: after removing one, the next ✕ is under the same finger. The ride's name stays on one
  line for the same reason. **Clear all** sits by the "Stops (n)" heading, with Undo in the toast instead of a
  confirm. Then Add road / Add stop / Start from me, then the route summary, **Generate a loop** (ride time + a button
  that opens Plan a ride and generates through these stops right away), options, fuel and export.
- Rows can be reordered by dragging their grip (touch too), flipped (⇄) and removed (✕).
  - The drag is followed on the whole window: moving the row in the list drops the grip's pointer capture.
    Re-renders wait until the row is dropped.
- **Options:** "Return to start" (loop); between roads: Fastest / Balanced / Back roads.

**Routing**
- Valhalla motorcycle profile (valhalla1.openstreetmap.de) with `use_highways` 1 / 0.5 / 0.
- Pinned stops snap to a street (`search_filter: { min_road_class: 'residential' }`), not the nearest driveway
  or parking lot: a pin by Oldham Road in Swope Park routed in and out of a private drive.
- **The public server takes at most 10 locations per request.** Longer trips are sent in overlapping chunks and joined.
- **No U-turns at stops** (Valhalla `break_through`; the start and finish stay `break`), so a route doesn't ride
  back down a road it just finished. If Valhalla answers with no route that way (a dead end; HTTP 400), it's asked
  again allowing them. Not when it's busy (429, 502–504, or no answer in 30 s): that would double the load.
- Falls back to OSRM (fastest only, with a note shown) if Valhalla fails. OSRM can't avoid motorways.
- **When neither answers**, the message says why, judged by Valhalla's failure: offline ("Planning a route needs
  signal"), busy ("The free route server is busy right now… Give it a minute"), or just unreachable. The same
  message shows for a ride, for the generator (when no loop at all could be routed) and for Try fixing.
- Arrows along the route line show the direction of travel (zoom 10+).

**Summary**
- **Doubled back:** miles of the route ridden a second time, along or against an earlier pass (crossings don't
  count; the first and last 1.5 km from the start and finish don't either). Sampled every 15 m on a ~60 m grid,
  needing headings within ~37° (either way) and 400 m of route between passes. Shown from 0.25 mi as a note with the
  stretches dashed orange on the map, and **Try fixing**: each road is tried the other way round (one route request
  each), keeping a flip when it cuts the doubling back by 200 m+ without adding more than 15% to the ride.
- Miles, riding time, miles on curvy roads, and the blind-crest count along the route; under them, miles on highway
  sweeps and fast ramps when there are 200 m or more (matched on the same ~200 m grid as curvy roads).
- **Elevation profile:** total climbing, low and high points, from Terrain Tiles z12 (~30 m pixels) read in the
  browser. Heights are read every ~60 m along the road (up to 3,000 reads), blended from the 4 pixels around each
  point, and averaged ±2 reads (~±120 m): the terrain grid beside a road (a hillside, a road cut) isn't the road's
  own height, and reading the nearest z11 pixel made the chart jagged and overstated climbing by ~20%. Climbing
  then ignores wiggles under 3 m. Scrubbing the chart (mouse or finger) marks that point on the map.
- **Fly through the ride in 3D** (button under the chart): a camera that rides the route.
  - It plays the ride at 5/10/20/40× its riding time (10× default) using the router's maneuver times, so
    curvy roads go by slower than highways, as they do on the bike.
  - The camera sits low behind the rider: zoom 16.2, pitch 78° (72° on a tall phone screen, else it's mostly
    sky), the rider 70% down the screen. It turns toward the route 250 m ahead, eased over ~0.6 s.
  - Terrain is 2.2× on curvy roads, 1.2× elsewhere, easing between over ~1.5 s. The terrain data has no bridges
    (an overpass is the ground under it), so at 2.2× interchanges and road cuts became canyons, and downtown's
    towers (in the coarse far-off data) became spikes on the horizon. MapLibre reads `map.terrain.exaggeration`
    every frame, so it's changed in place; `setTerrain` would rebuild the terrain.
  - The tilt is asked for every frame. MapLibre lowers it when the camera would be inside a hill, which also
    happens at the start before the terrain there has loaded, and then it would stay low. A tilt by hand is kept.
  - Zoomed in among hills (Swope Park), MapLibre flattened the view all the way to looking straight down.
    Instead, while the tilt comes back lower than asked, the camera backs off (zoom −0.1 at a time, up to 4), and
    once clear it eases back in (0.5 zoom/s) to the zoom asked for. A zoom by hand becomes the zoom asked for.
    More padding also lowers how far MapLibre lets the camera tilt, so only top padding is used.
  - It switches to satellite and hides route numbers and arrows (they smear at that angle). The rider is a
    circle layer on the ground, facing the camera: a DOM marker drifted off the line in 3D, and a ground-aligned
    circle flattened to a sliver.
  - The **road sign** sits centered just above the bottom bar; a blind-crest callout stacks above it (they grow
    upward from the bar, so the road sign never moves).
  - **Turn tag:** from 1.5 mi out, the road you'll turn onto ("↰ MO 350 / Blue Parkway", the router's street
    names, else its words) stands on a stem over the turn on the map (a MapLibre marker, facing the camera).
  - **Heads-up display** (top): the road sign (route number and name) and its **speed limit** sign, from our
    road data under the rider: the nearest road within 25 m running the rider's way (within 35°), so a road
    crossing over or under doesn't count. The flight loads the speed-only tiles along the route (not just the
    curvy roads). Posted limits look like the sign; an estimate is dashed and says LIKELY, and isn't shown on
    motorways, trunks or ramps (the rule of thumb would say 30 on an interstate through town). With no road data
    there, the router's street names (no limit). Under the sign, the **next turn** from 1.5 mi out, in the
    router's words ("In 0.60 mi Keep right to take I 435 North…"); starts, arrivals at stops, continue/becomes
    and stay-straight aren't turns.
  - Things that come and go sit last in each column (left: weather, then the turn; right: mini-map, then the
    speed limit), so they never push the steady ones around.
  - **Weather** under the road sign: the clock time you'd be here (the Leaving time under Weather plus the riding time
    so far), sky, temperature and rain chance, gusts when ≥ 20 mph; yellow when it would be a warning in the
    Weather section. From the forecast point nearest the rider, for that hour (the same forecast, no new request).
  - **Mini-map** (top right, above the speed limit): the whole ride north up, the start in white, the rider in
    yellow. A tap jumps the flight to the nearest point of the ride.
  - **Riding ~52 mph** by the speed button: the pace the router expects on this stretch (maneuver length ÷
    time), which is what the playback runs at, times the speed button.
  - A bar at the bottom: mile, time in, height, and the grade when it's 3% or more ("↗ 6%", over ±150 m);
    the elevation chart as the scrubber (press and drag; it pauses while held); play/pause
    (space), speed, close (Esc). **Blind crests** along the route are called out 400 m before: "⚠ Blind crest
    ahead · 900 ft".
  - Closing puts back the panel, the basemap, the tilt and the terrain, and frames the whole ride.
- A ride bar on the main list shows the ride's stats with **Go**.

**Weather** (Your ride, under the route summary)
- **Leaving** time (default: the next quarter hour; **Now** resets it), up to about a week out.
- Open-Meteo's hourly forecast (free, no key, one request for all points) at points about every 30 km along
  the route, both ends included, at most 12. Each is read for the hour you'll pass it: the time comes from
  Valhalla's maneuver times, or from distance on the OSRM fallback (riding time only, no stops).
- Warnings, each at its worst point with the mile and time: thunderstorms, rain ≥ 40% ("likely" from 60%),
  gusts ≥ 35 mph, ≤ 45°F, ≥ 95°F. Otherwise "Looks good:" with the temperature range, top rain chance and gusts.
- A table per point: time, mile, sky, temperature, rain chance, gusts. Hover or tap a row (or a warning) to put a
  dot on the map there.
- Fetched once per route, again after an hour (a minute after a failure); changing the leave time just reads
  other hours. Points past the forecast say so.

**Fuel**
- Settings: tank range (80–250 mi, default 120) and "90+ only".
- Uses stations within 1.2 km of the route.
- Suggests stops by refueling at the farthest station within 85% of the range, assuming a full tank at the start.
- Warns about any stretch longer than the range, and shows the longest stretch without a station.
- ＋ inserts a station at the right place in the ride.

**What a ride rides** (Your ride, under the stats; the tags on generated loop cards too)
- **Focus tags**, the key's labels in its colors: the curve classes that make up a fifth or more of its curvy miles (a
  half mile of Very curvy or Twisty counts anyway; up to 3), Highway sweeps when they're a fifth of the fun, Roller
  coasters when they're a fifth of what it rides, and how hilly its roads are (Flat to Very hilly, length-weighted).
- **A bar** of the whole ride by kind of road, in the map's colors; the dark rest connects them.
- **What fits your filters**: "2.9 mi fits your filters (45+ mph · Very hilly+ · Paved)", then each road that does, in
  ride order, with its class, hills and miles. Then "Outside your filters", the 5 longest that don't and why
  ("MO F (hilly)", "Jefferson Street (hilly, 35 mph)"). Filters changed after routing update it.
- **Lighting up**: hover a tag, a bar segment, a road that fits or one outside the filters, and its parts of the route
  glow white on the map (exactly the ridden pieces, not the whole road). A tap or click keeps them lit until tapped
  again, which is how it works on a phone; a new route or leaving the page turns it off.
- `rideMix` in `plan.js` matches the route to roads on the same ~200 m grid as curvy miles; unpaved never counts.
  Its `pieces` (runs of the route on one road and kind) are what lights up.
- **Share** sits at the top right of Your ride as well as under Ride it.

**Generate loops** (Plan a ride, or Generate a loop on Your ride)
- While it works, the button says **Stop**. Changing a road filter (mode, road type, mph, hills, Paved, the curve
  classes or ramp tiers in the key) stops it too, saying so: the rides would be on roads the map no longer shows.
- Each card has the ride's **focus tags** (below). **Ride this loop →** is the blue button under the cards.
- Ride time 1–8 h. The start is the first stop, or the rider's location.
- **Must include:** the rider's own stops (roads, gas stops, pinned points).
  - Every loop goes through them.
  - Loops head their way: straight at them, or swinging 35° or 70° to either side.
  - Without any, all 12 directions are tried.
- Looks at roads within `hours × 80 / 2.6` km.
- **Candidates follow the road type**: curvy roads, highway sweeps, or both (All roads). A highway sweep is a stop of its own
  despite being short (the 2 km rule for main roads doesn't apply), ridden in its own direction, scored at half its
  sweep (×1.25 with 3+ lanes), so a good back road still beats one. A loop takes only one direction of a bend:
  one-way stops centered within 1 km are the two directions of the same bend. Never another way home.
  From Lenexa at 1.5 h, loops pick up one or two bends (I-435, I-635, K-10) with the back roads; at 3 h they're
  still mostly back roads.
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
- Routes the top 6 up front, but each side of the start (N, E, S, W) gets its best loop in when it's at least 15%
  as good as the best, so the list isn't all one way.
- When no loop is shown to a side, the status says so ("No loops to the south or west: not enough good roads that
  way with your filters"). From Greenwood at 1.5 h: west is the KC metro, and south's only other curvy road
  (South Amarugia Lane) is gravel, so with Paved on there's no south loop.
- Roads are turned end for end to make the rides between them shortest over the whole loop (not nearest end first).
- **Doubling back:** loops are ranked by fun² / miles × e^(−5 × share ridden twice) (10% twice keeps 61%, 20%
  37%, 40% 14%; it used to be 1 − 3 × share with a floor of 0.1, so past 30% every loop looked equally bad), where
  fun is the miles on curvy roads plus the miles on highway sweeps and fast ramps (straight interstate counts
  nothing). A loop riding more than 4% twice tries each of these (up to 3 rounds), keeping the best:
  - first tries **another way home**: the best-scoring road with an end or midpoint within 3 km of the stretch
    ridden twice, not mostly on it, and fitting the time left (estimate × how far the estimate ran off). Short
    roads count here (800 m+ of curves, not unclassified), though never as the main roads, which need 2 km;
  - **another way back**: a spot to either side of the middle of the longest stretch ridden twice, square to it
    and a third of its length out (2–10 km), put in the part of the loop where the second pass is;
  - it without the generated road most to blame (the one the doubled-back miles are on, else the nearest);
  - keeping a change only if it ranks higher and stays in 80–120%. From Lee's Summit at 1.5 h on back roads, the
    out-and-back "MO TT" loop (48% twice) became Buckner Tarsney → MO TT → Litchford (12%). With another way back,
    from the same start the south loop went from 8.4 to 2.6 mi twice; at 6 h the five loops went from 91 to 76 mi.
  - After this, the stoplight, turnaround and roads-on-the-way passes keep a change only if it also rides no more
    twice than before (or 4%): picking up East Colbern Road on the way once took a loop from 1.4 to 15.5 mi twice.
  - Loops riding more than a fifth twice are left out when at least 2 others aren't.
- **Speed:** loops are routed two at a time, routes asked for during a run are reused (directions often come out
  the same loop), and the router's answers are kept per 10-point chunk, so a change to one stop of a long loop
  re-asks only for the chunks it changes. A 6 h run: 264 requests and 259 s before the chunk cache, 150 and 145 s
  after (209 s before any of this).
- **Stoplights:** each one the route goes through keeps 97% of a loop's rank, and one where it turns left counts
  twice ("booking it down a highway, it's lame to get stopped by a stoplight"; double lefts off a highway are
  the worst). A light within 15 m of the route counts, one per intersection (nodes within 80 m along the route
  are one), and the turn is the change in heading from 60 m before to 60 m after (over 50° left or right), measured
  between the route's points (a straight road mapped with points over 60 m apart used to read as a left: 3 of 7
  "lefts" on one loop).
  The router (Valhalla) has no setting to avoid lights (`signal_penalty` on the motorcycle costing changed
  nothing on valhalla1.openstreetmap.de, Nov 2026), so the app ranks and fixes instead: a loop with a left at
  a light tries dropping the generated road nearest it, as for turnarounds. Option cards show "🚦 12 (3 left)";
  the ride says how many and how many turn left, and the map shows each light on the route (from zoom 10), with an
  orange ring where it turns left. Until `tiles/signals.js` is built, no lights are counted.
- **Turnarounds:** a spot off the curvy roads where the route comes back past within 120 m heading the other way
  (over 150° off) after 400 m to 3 km of riding: off the highway, left twice through the lights and back on, or round
  a block. Not a cloverleaf loop (shorter), not a hairpin (on a curvy road), not in the first or last 1.5 km. Each
  one keeps 60% of a loop's rank, and a loop with one, or with a left turn at a stoplight, tries dropping the
  generated road nearest the first of them (up to twice, kept if it ranks higher and stays in 80–120%). Seen with the Highways road type: a loop rode a sweep on
  I-435 / US 50 west, away from home, then got off and back on to head east. Option cards and the ride say "↺ turns around".
- **Roads on the way:** after that, a routed loop that rides within 500 m of an end of a road it isn't taking
  (a candidate, short ones included, mostly off the route, not one-way) tries adding the best one, then the next
  (up to 2 tries), keeping it if the loop ranks higher and stays in 80–120%. From Lee's Summit at 1.5 h, a loop up
  MO 7 rode straight past MO FF, a sweeper running the same way, which only has 950 m of curves (under the 2 km
  for main roads), so it was highlighted but never picked.
- The same loop reached from two directions is shown once. Loops riding more than 20% twice are
  left out when at least 2 others remain (it was 3). Measured on Oct-31 data: the top loop from south KC went from 29% to 13%,
  from the Lake of the Ozarks from 28% to 1%.
- Option cards show time, miles, curvy miles and %, highway-sweep miles (from 200 m), blind crests, miles ridden twice, and the roads, with the
  rider's in bold.
  Hover previews a loop; tap loads it as the ride.

**One way** (Plan a ride → One way): from the start to an end, the fun way, instead of a loop.
- The end is a pinned stop marked `end`, always last (stops added later go before it; share links keep it). Set it
  with Pick on map under End, or right-click / long-press a spot → **End a ride here** (which switches to One way).
- Instead of a ride time, **extra time for fun roads**: +30 min to +4 h on top of the straight way there, which is
  routed first (Lee's Summit → Warsaw: 86 mi, 91 min).
- Candidate roads come from an oval: within 2 × reach of the start and end added up (reach as for a loop of that
  time). They're ordered by how far along the straight line they are, and the last leg goes to the end, not home.
- Four options, each from its own pool: roads left of the straight line, right of it, within a quarter of its length
  of it, or anywhere; named "North side", "South side", "Near the straight way", "Best roads, any side". They're
  routed and fixed like loops (time, doubling back, "Another way", stoplights, roads on the way), and the chosen
  one rides as a one-way trip. Lee's Summit → Warsaw with +2 h: 148 mi, 3 h 20 min, 47 mi curvy (MO TT, MO OO,
  MO BB), found in 46 s.

**Export**
- **Go / Open in Google Maps:** directions links (9 waypoints each, split into parts).
  - Google re-plans between stops, so the app adds its own stops, up to 2 links' worth.
  - The trip's own stops are always kept.
  - Then a stop in the middle of any stretch over 25 km without one.
  - Then stops 200 m past the turns onto the longest roads, at least 800 m apart.
- **GPX:** waypoints, a route and the full track. For OsmAnd (free and follows the track), Calimoto, REVER, Garmin.
- **Share:** the phone's share sheet (or the clipboard) with a `#r=` link: the ride packed into bytes (varints, points and road ids as steps from the last one), about a
  third the length of the older `#trip=` base64-JSON links, which still open.
  - The link holds base64 JSON of the stops and settings.
  - Links from the original app work too. Opening one loads the ride.
- **Persistence:** the ride saves to localStorage on every change. A ride saved by the original app is picked up once.

**Location**
- A quick, rough fix first (or one the phone already has), then a precise GPS fix.
- Errors say which problem it was: blocked permission (with iPhone steps), no fix, a timeout, or a non-https page.

**About**
- "About, credits and riding safe" under the home list opens the About page: what the app is, **Ride safe** (map
  data can be wrong, rural limits are estimates, always check conditions, plan before you leave), credits for
  every data source and service, what data leaves the device, and the source link.

**Link preview**
- Open Graph and Twitter card tags in `index.html`, so a pasted link shows a card with `preview.png` (1200×630,
  `node tools/make_preview.mjs`: the curvy roads around Branson from the built tiles, in the map's colors).
- A shared ride is in the link's `#fragment`, which preview fetchers never see, so every link shows the same card.
  The image URL is absolute (`https://nosv1.github.io/claudes-ride-finder/preview.png`); a new address needs it changed.

**Installable and offline**
- Web app manifest and icons (`tools/make_icons.py`).
- **Install app** (under the home list, and on the About page) when the browser offers to install (Chrome, Edge,
  Android: the `beforeinstallprompt` prompt is kept and shown on the tap). On iPhone it says how instead (Share →
  Add to Home Screen). Hidden once opened as the installed app.
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
  - Esri tiles need no key, but no published Esri terms clearly allow keyless use in a public app (checked
    2026-11-04; see BACKLOG.md).
- **Google Maps URLs:** the reliable forms are `/maps/@?api=1&map_action=pano&viewpoint=…&heading=…` (Street View)
  and `/maps/dir/?api=1&…&waypoints=a|b` (directions).
  - "No Street View" means Google has no imagery near that spot, and it offers no way to search farther.

## 7. Tests

See `tests/README.md`:
- Build logic in Python: `python -m unittest discover tests`.
- The app's logic modules in Node: `node --test tests/app/logic.test.mjs`.
- The app in headless Edge/Chrome: `node --test tests/app/browser.test.mjs` (`RF_NETWORK=1` adds live routing).
