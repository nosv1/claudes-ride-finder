# Tests

Run everything from the repo root.

| Command | What it checks | Needs |
|---|---|---|
| `python -m unittest discover tests` | Build logic in `build_tiles.py`: curve, sweeper and hill scoring, blind crests, speed and surface rules, 90+ octane, the search index; plus sanity checks on the built `tiles/` (including the MO-150 sweeper) | Python packages from the build (osmium, numpy, Pillow) |
| `python tests/browser/run.py` | The real page in headless Edge/Chrome: tiles load, modes, popups and Street View, hover outlines, roads stay clickable under every overlay, search matching, trips and share links, Google Maps stop placement | Edge or Chrome (`BROWSER=` to point at one) |
| `python tests/browser/run.py --network` | Adds the live services: Valhalla routing (no fallback), fuel plan along a real route, the ride generator, Photon search | Internet; the public routing server can be slow |

The browser tests reach into the app's top-level names (`map`, `roads`, `trip`, …). If a rewrite
renames them, update the helpers at the top of `tests/browser/tests.js`; the scenarios stay the same.
