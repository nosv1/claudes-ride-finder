# Tests

Run everything from the repo root.

| Command | What it checks | Needs |
|---|---|---|
| `python -m unittest discover tests` | Build logic in `build_tiles.py`: curve, sweeper and hill scoring, blind crests, speed and surface rules, 90+ octane, the search index; plus sanity checks on the built `tiles/` (including the MO-150 sweeper) | Python packages from the build (osmium, numpy, Pillow) |

**The app** (`js/`, `index.html`):

| Command | What it checks |
|---|---|
| `node --test tests/app/logic.test.mjs` | The logic modules against the real data: curve classes, filters, stretches, trips and share links (including the original app's), fuel plan, Google stops, the generator (with and without must-include roads), GPX, search |
| `node --test tests/app/browser.test.mjs` | The app in headless Edge/Chrome over the DevTools protocol: roads draw, MO-150 is a sweeper, tapping a road, legend filters, search, share links, phone layout. `RF_NETWORK=1` adds the generator and loops around a chosen road |

`node tests/app/cdp.mjs <url> out.png [--mobile] [--wait "<js>"]` takes a screenshot once a condition holds.
