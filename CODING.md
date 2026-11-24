# Coding standard

The standard is the hub's [CODING.md](https://github.com/nosv1/nosv1/blob/main/CODING.md): JPL's **Power of Ten**
carried into JavaScript and Python at the strictest settings the tools have. It replaced this file's own version on
2026-11-23. A rider uses this on the road, often with a weak signal, so the bar is code whose behavior can be checked:
simple flow, small pieces, every failure handled where it happens. This page keeps only what's particular to Ride
Finder.

`npm run check` checks what a tool can check: lint with zero warnings, strict types for the JavaScript and the
Python, and the baselines. Run it, and the tests that cover the change (tests/README.md), before every commit. CI runs
it on every push. Review covers the rest.

## How the rules land here

- **Rule 5, checks.** Use `check(ok, what)` (js/check.js) for what must be true where data crosses a boundary (the
  account service, links, storage, another module, a function exported for other modules) and for invariants a change
  relies on. A function that only passes on what's already been checked needs none. A failed check is logged ("Check
  failed: …", which fails the browser tests) and returns false: the caller recovers by doing nothing or keeping what's
  there, never by throwing at the rider.
- **Rule 6, module state.** Module-level state only when several functions share it, with a comment saying what it
  holds.
- **Rule 7, async work.** A promise marked `void` says in a comment that the function it calls handles its own
  failures. Async work that touches the ride on screen checks it's still the same ride (`onScreen()` in main.js).
  Errors are caught where something sensible can be done (a toast, a fallback).

## Code from before the standard

The standard came in on 2026-11-16 and tightened on 2026-11-23 (complexity 10, 4 parameters, strict types, Python
checked too). What the code broke then is in two baselines, so the checks stay clean while new code meets the
standard in full:

- `eslint-suppressions.json`: 226 lint findings, mostly long or complex functions.
- `checks-baseline.json`: 2,045 type findings in the JavaScript (it was checked with `strict` off until then), 435
  Ruff and 550 mypy findings in the Python build tools.

- Don't add to either. New and changed code meets the rules.
- When you change a function that's listed, bring it under the rules if that's reasonable in the same change (split
  it, type the parameter), then run `npm run lint:prune`, `npm run types:update` or `npm run py:update` to drop the
  entry.
- No big rewrite just for the standard: splitting `main.js` all at once would be riskier than the code it replaces.

## Tools

Development only, pinned in package.json and requirements-dev.txt, not part of the site (it has no build step):

- `npm install` and `pip install -r requirements-dev.txt`: once, to get them.
- `npm run check`: lint, types and the baselines, as above.
- `npm run lint:prune`, `npm run types:update`, `npm run py:update`: after fixing code listed in a baseline.
- `eslint-standard.mjs` and `tools/check_baseline.py`: copies of the hub's (change those first).
- `types/globals.d.ts`: what the page has besides the app's modules (MapLibre, Google sign-in, the tile data
  scripts), for the type check.
