# Ride Finder

- Follow the coding standard in CODING.md (JPL's Power of Ten, adapted). New and changed code meets it in full; don't
  add to eslint-suppressions.json.
- Before every commit: `npm run check` (lint with zero warnings, and the type check), and the tests that cover the
  change (tests/README.md says which). Every commit also runs `node tools/bump_version.mjs` and updates FEATURES.md
  and QA.md where behavior changed.
- After running tests, check `git status` for tests/heads-up.md: a new line under Fired is a heads-up (not a failure).
  Tell Chris what fired and what you found, and commit the line with that.
