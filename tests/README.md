# Tests

Run everything from the repo root.

| Command | What it checks | Needs |
|---|---|---|
| `python -m unittest discover tests` | Build logic in `build_tiles.py`: curve, sweeper and hill scoring, blind crests, roller coasters (and which file they go in), speed and surface rules, 90+ octane, the search index; plus sanity checks on the built `tiles/` (including the MO-150 sweeper) | Python packages from the build (osmium, numpy, Pillow) |

**The app** (`js/`, `index.html`):

| Command | What it checks |
|---|---|
| `node --test tests/app/logic.test.mjs` | The logic modules against the real data: curve classes, filters, stretches, trips (where an added road goes, which end), loop orientation, doubled-back miles, share links (including the original app's), fuel plan, Google stops, the generator (with and without must-include roads), GPX, search, what a busy router says (and that it isn't asked twice), roller coasters (off unless turned on, never in Best roads) |
| `node --test tests/app/browser.test.mjs` | The app in headless Edge/Chrome over the DevTools protocol: roads draw, MO-150 is a sweeper, tapping a road, legend filters and the key's explanations, search, dragging stops (real mouse and touch input), Add road, share links, phone layout. `RF_NETWORK=1` adds the generator and loops around a chosen road |

**Accounts** (`worker/`, `js/account.js`; both start a local copy of the API with `wrangler dev`, made-up accounts,
nothing touches the real one):

| Command | What it checks |
|---|---|
| `node --test tests/worker.test.mjs` | The API: sign in, save, change and delete a ride, the account key's id is set once, accounts can't see each other's rides, signed-out calls and sign-out, settings and tags (locked text only), share links (ids never reused, open without signing in, only the owner takes one down), bad input and other sites refused, deleting an account takes everything |
| `node --test tests/app/account.test.mjs` | The app, a PC and a phone on one account: the sign-in page, saving a ride and its changes and name, and that the API holds them locked (no other key opens them); the phone is locked until it opens the PC's device link, then gets the ride, settings and tags and opens the ride; Share makes a short link the API can't read that opens signed out (and falls back to the long link with the service down); deleting the account signs both out |

`node tests/app/cdp.mjs <url> out.png [--mobile] [--wait "<js>"]` takes a screenshot once a condition holds.
