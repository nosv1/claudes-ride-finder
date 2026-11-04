# Handoff: check Ready to share and roller coasters on the PC

Written by the cloud session that built both. That session couldn't reach cdnjs, Esri or Geofabrik, so the browser
tests never ran and the full rebuild wasn't possible. This is what's left. Delete this file when done.

## Where things stand

Branch `claude/blissful-heisenberg-bq75pr`, two commits on top of `main` (`06308e3`), not merged:

- **`2e68fdb` Ready to share:** About page (link under the home list), link preview (OG tags + `preview.png` from
  `tools/make_preview.mjs`), a busy/offline message when routing fails, Install app button (iPhone gets the steps).
  Also a fix: a busy Valhalla (429/5xx/timeout) was asked twice; the U-turn retry now only follows a 400.
- **`36ab5f2` Roller coasters:** straight back roads (primary/secondary/tertiary/unclassified, over 1 km, not curvy)
  that are Hilly or more (≥ 22 m/km). A "Roller coasters" chip in the key, off by default, tan lines, "Roller
  coasters in view" under the list. Never in Best roads or the generator. `tools/add_hills.py` measured the ones in
  `tiles/`: 1,547, all with posted limits, because the build drops unposted straight roads.

Checked in the cloud: Python and logic tests pass; Playwright with stubbed hosts showed the About page, Install
prompt, busy message, and roller coasters filtered off/on correctly. **Not checked:** the real browser tests, and
how the tan lines look (headless drew no lines at all, for any road).

## To do

1. `git checkout claude/blissful-heisenberg-bq75pr && git pull`
2. Tests:
   - `python -m unittest discover tests`
   - `node --test tests/app/logic.test.mjs`
   - `node --test tests/app/browser.test.mjs` (never ran on this branch), then `RF_NETWORK=1` for routing
3. QA.md, sections **Ready to share** and **Roller coasters**, on the PC and the phone. In particular:
   - Chrome/Edge: Install app shows and opens the install prompt.
   - Roller coasters around Springfield and Branson: do they really feel like roller coasters? Watch for false ones:
     MO 39 near Shell Knob (steep hillside beside the road reads as the road), and plains roads on the KS–NE line
     (Road A / Elm Road at 40.00 N reads 46 m/km; it dips through creek draws, which may be real).
4. Full rebuild for the unposted roller coasters (most county roads): `raw/` needs the three `.osm.pbf` files, then
   `python build_tiles.py`. It now measures nearly every rural road, so the first run downloads a lot more terrain
   and takes longer than the old ~11 min. Check `tiles/` size afterwards (main tiles were 19.5 MB). Then rerun the
   tests and `node tools/make_preview.mjs` if the roads changed much.
5. Open decision, his call: the Esri basemap (keyless vs a free-tier key). Written up at the top of BACKLOG.md.
6. Merge to `main` when it looks right, and delete this file.
