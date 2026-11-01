# Tests

Run everything from the repo root.

| Command | What it checks | Needs |
|---|---|---|
| `python -m unittest discover tests` | Build logic in `build_tiles.py`: curve, sweeper and hill scoring, blind crests, speed and surface rules, 90+ octane, the search index; plus sanity checks on the built `tiles/` (including the MO-150 sweeper) | Python packages from the build (osmium, numpy, Pillow) |
| `python tests/browser/run.py` | The real page in headless Edge/Chrome: tiles load, modes, popups and Street View, hover outlines, roads stay clickable under every overlay, search matching, trips and share links, Google Maps stop placement | Edge or Chrome (`BROWSER=` to point at one) |
| `python tests/browser/run.py --network` | Adds the live services: Valhalla routing (no fallback), fuel plan along a real route, the ride generator, Photon search | Internet; the public routing server can be slow |

**v2** (`/v2/`, the new interface):

| Command | What it checks |
|---|---|
| `node --test tests/v2/logic.test.mjs` | v2's logic modules against the real data: curve classes, filters, stretches, trips and share links (including v1 links), fuel plan, Google stops, generator, GPX, search |
| `node --test tests/v2/browser.test.mjs` | v2 in headless Edge/Chrome over the DevTools protocol: roads draw, MO-150 is a sweeper, tapping a road, legend filters, search, share links, phone layout. `RF_NETWORK=1` adds the generator |

`node tests/v2/cdp.mjs <url> out.png [--mobile] [--wait "<js>"]` takes a screenshot once a condition holds.

The v1 browser tests reach into the app's top-level names (`map`, `roads`, `trip`, …). If a rewrite
renames them, update the helpers at the top of `tests/browser/tests.js`; the scenarios stay the same.
