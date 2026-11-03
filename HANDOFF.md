# Handoff: finish the stoplight work on the PC

Written by the cloud session that built highway sweeps, road types, turnarounds and stoplight counting. That session
couldn't download the OSM state files or reach the router (Valhalla), so this is what's left. Delete this file
when done.

## Where things stand

Branch `claude/435-traffic-highlight-rshew6`. `main` (live) has everything up to `ec4408e` (highway sweeps, road type
chip, roads on the way, tap for speed limit). On the branch only, not merged yet:

- **Turnarounds** (`turnarounds()` in `js/plan.js`): a loop that gets off and back on the other way ranks lower.
- **Stoplights** (`stoplightsOn()` in `js/plan.js`, `loadSignals()` in `js/store.js`): each light along a route costs
  3% of a loop's rank, a left turn at one counts double, and a loop with a left at a light tries dropping the
  generated road nearest it. **It counts nothing yet: `tiles/signals.js` doesn't exist.**
- Backlog: a cameras layer (plate readers / Flock, speed and red-light cameras).

The rider asked for the stoplight work: "if we're booking it down a highway, it's kind of lame to get stopped by a
stoplight", especially double lefts at signals off a highway.

## To do

1. `git checkout claude/435-traffic-highlight-rshew6 && git pull`
2. Make sure `raw/` has `kansas-latest.osm.pbf`, `missouri-latest.osm.pbf`, `texas-latest.osm.pbf` (else download
   them from https://download.geofabrik.de/north-america/us.html). `pip install osmium numpy pillow`.
3. `python tools/add_signals.py` writes `tiles/signals.js` (nodes only, a minute or two). Expect tens of thousands
   of lights and around 1 MB. If it's much bigger, think about splitting it per tile before going national.
4. Tests:
   - `python -m unittest discover tests`
   - `node --test tests/app/logic.test.mjs`
   - `node --test tests/app/browser.test.mjs`, then again with `RF_NETWORK=1`. The cloud never ran the routed
     generator tests (no network). In slow headless runs, "Add road on the ride page" and "a stop dropped on a
     colored road" sometimes time out waiting for MO-150 to draw; they pass when run alone.
5. **Check on real routes. None of the routed behavior has been tried against Valhalla yet:**
   - The rider's 1.5 h loop from Lee's Summit (start `38.88956, -94.38724`, Balanced, All roads): does a loop up MO 7
     now pick up MO FF ("roads on the way")?
   - Do loop options show "🚦 N (M left)" with believable numbers? Look for false hits, e.g. a highway passing over a
     signalized cross street (lights count within 15 m of the route). Showing the lights on the route map for a
     moment would make this easy to eyeball.
   - With the Highways road type: fewer loops that exit at a light to turn around or turn left?
   - Did generating get much slower? Each fix pass can add up to 2 routing requests per loop.
6. Commit `tiles/signals.js` and push the branch. **Ask the rider before merging to `main`** (merging deploys the
   live site).

## Notes

- Valhalla has no documented setting to avoid traffic lights, which is why the app ranks loops and fixes them
  instead. One third-party config page mentions `signal_penalty` (auto costing). Worth one quick check whether
  `costing_options.motorcycle.signal_penalty` changes anything on valhalla1.openstreetmap.de.
- `tools/add_highway_sweeps.py` now keeps `signals.js` when it rewrites `tiles/`. A full `python build_tiles.py`
  writes `signals.js` too.
- Next ideas the rider liked, in BACKLOG.md: the cameras layer; two-lane 65 mph trunk highways (US 83) aren't scored
  anywhere yet; fast ramps as generator stops; adventures and quests.
