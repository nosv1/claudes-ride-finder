# Coding standard

Ride Finder follows JPL's **Power of Ten** rules for safety-critical code (Holzmann, 2006; the basis of the JPL
Institutional Coding Standard for C), adapted to a browser app in JavaScript. A rider uses this on the road, often
with a weak signal, so the bar is code whose behavior can be checked: simple flow, small pieces, every failure
handled where it happens.

`npm run check` checks what a tool can check: lint with zero warnings, and the type check. Run it, and the tests
(tests/README.md), before every commit. Review covers the rest.

## The rules

| # | Power of Ten | Here | Checked by |
| --- | --- | --- | --- |
| 1 | Simple control flow: no goto, setjmp or recursion | No recursion (a retry is a loop with a bound), no labels, no `with`. | lint, review |
| 2 | Every loop has a fixed upper bound | Retries, polling and waits have a stated limit (tries, a timeout). No `while (true)`. | lint, review |
| 3 | No memory allocation after startup | Not applicable: JavaScript allocates and frees memory itself. Instead, nothing grows without bound: caches and maps kept for the session have a limit or are cleared. | review |
| 4 | A function fits on a page | 60 lines at most (blank lines and comments don't count), complexity 15 at most, nesting 4 deep at most, 5 parameters at most (pass an options object beyond that). | lint |
| 5 | Assertions: at least two per function | Where they say something, not a count per function: use `check(ok, what)` (js/check.js) for what must be true where data crosses a boundary (the account service, links, storage, another module, a function exported for other modules) and for invariants a change relies on. A function that only passes on what's already been checked needs none. A failed check is logged ("Check failed: …", which fails the browser tests) and returns false: the caller recovers by doing nothing or keeping what's there, never by throwing at the rider. | review, tests |
| 6 | Data in the smallest scope | `const` by default, no `var`, no shadowing. Module-level state only when several functions share it, with a comment saying what it holds. | lint, review |
| 7 | Check every return value and parameter | Every promise is awaited, returned, given a `.catch`, or marked `void` when the function it calls handles its own failures (say so in a comment). Errors are caught where something sensible can be done (a toast, a fallback), not passed up to nowhere. Async work that touches the ride on screen checks it's still the same ride (`onScreen()` in main.js). | lint (no-floating-promises), review |
| 8 | Limit the preprocessor | Not applicable. Nearest thing: no `eval` and no code built from strings. | lint |
| 9 | Restrict pointers: one level of dereference, no function pointers | Mostly not applicable (callbacks are how JavaScript works). Keep chains short (`a.b.c` at most), and don't pass functions through more than one layer to be called later without a name that says what they're for. | review |
| 10 | All warnings on, zero warnings, static analysis daily | `npm run check` clean on every commit: ESLint (eslint.config.js) and TypeScript's checker over the JavaScript (tsconfig.json; JSDoc where a type isn't clear). | lint, types |

## Code from before the standard

The standard came in on 2026-11-16. What broke rules 4 and 6 then (51 findings: long or complex functions, a few
shadowed names, functions with many parameters) is listed in `eslint-suppressions.json`, so lint stays clean while
new code meets the standard in full.

- Don't add to that file. New and changed code meets the rules.
- When you change a function that's listed, bring it under the rules if that's reasonable in the same change
  (split it, rename the shadowed name), then run `npm run lint:prune` to drop the entry.
- No big rewrite just for the standard: splitting `main.js` all at once would be riskier than the code it replaces.

## Tools

Development only, pinned in package.json, not part of the site (it has no build step):

- `npm install`: once, to get them.
- `npm run check`: lint and types, as above.
- `npm run lint:prune`: after fixing code listed in eslint-suppressions.json.
- `types/globals.d.ts`: what the page has besides the app's modules (MapLibre, Google sign-in, the tile data
  scripts), for the type check.
