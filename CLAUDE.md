# Ride Finder

A map for finding and planning motorcycle rides on curvy roads, live on GitHub Pages.

## Read first

**Before anything else this session, fetch and read Chris's profile:**
https://raw.githubusercontent.com/nosv1/nosv1/main/PROFILE.md

It says who he is and how to work with him. It applies here except where this file says otherwise (the mode
below). If the fetch fails, say so; don't proceed as a generic assistant.

**Before writing any code, fetch and read the coding standard:**
https://raw.githubusercontent.com/nosv1/nosv1/main/CODING.md

Then this repo's state: README.md (what it does), FEATURES.md, BACKLOG.md (what's next) and QA.md.

## This project

- **Mode: "just build it"** (his call, 10-31). Claude writes the code and pushes straight to main.

## Coding standard

The hub's [CODING.md](https://github.com/nosv1/nosv1/blob/main/CODING.md) at its strictest settings (his call,
11-23), plus this repo's notes in [CODING.md](CODING.md). Every code change, without being reminded: read both first;
run **Check** before every commit (don't push and let CI find it); in the reply, say which rules the change touched
and that Check passed; new and changed code meets every rule in full. Don't add to `eslint-suppressions.json` or
`checks-baseline.json`: they only shrink.

- **Check:** `npm run check` (lint with zero warnings, strict types for the JavaScript and Python, the baselines), and
  the tests that cover the change (tests/README.md says which). CI runs `npm run check` and the logic tests on every
  push. One-time setup: `npm install`, `pip install -r requirements-dev.txt`.
- **Rule 5 failures here:** `check(ok, what)` logs and returns false; never throw at the rider (CODING.md).

## Every commit

- Run `node tools/bump_version.mjs` and update FEATURES.md and QA.md where behavior changed.
- After running tests, check `git status` for tests/heads-up.md: a new line under Fired is a heads-up (not a
  failure). Tell Chris what fired and what you found, and commit the line with that.
- Commits authored as Claude (`--author="Claude <noreply@anthropic.com>"`), explicit paths only, never `git add -A`
  or `git add .`.
