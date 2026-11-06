# Handoff: speed limits around Lee's Summit (2026-11-06)

From a cloud session to the PC session. Delete this file once it's dealt with.

## Where things are

Branch `claude/tender-hamilton-2v21q9`, pushed, **not merged to `main`** (so not live). One commit on top of `main`:
"Your own speed limit on a road, and Edit in OpenStreetMap to fix it for everyone". Version bumped to 2026.11.06.1.

```
git fetch origin claude/tender-hamilton-2v21q9
git checkout claude/tender-hamilton-2v21q9
```

## What started it

The rider (Lee's Summit) asked why these don't show in Best rides at 45+ mph. From the built tiles (`tiles/-189_77*.js`):

| Road | Way | What the data says | Why it's hidden |
|---|---|---|---|
| NE Strother Rd | 18511531 (tertiary) | 2.4 km, 800 m sweep (a Sweeper), hill 37.3 (Very hilly), no posted limit | Guessed **30**: the subdivisions off NW Gregory Blvd make its midpoint "in town" (`estimate_mph`, ≥ 40 residential streets in the 3×3 km around it). The rest of Strother is straight, so it isn't kept. |
| SW Scherer Rd | 18515586 (secondary) | 3.5 km, straight, hill 25.2 (a Roller coaster) | Guessed **30** the same way; Roller coasters are also off by default. "SW Scherer Pkwy" on the basemap isn't in the tiles at all (straight, no limit). The rider likes it: 2 lanes, no traffic, wide open; two Flock cameras on it. |
| Raytown Rd | 18534377, 65569836, 1081232786/7, … (secondary) | Guessed 55; 300–500 m of sweep per piece, ~1.9 km over the whole road | Each piece is under the sweeper bar (800 m, or 400 m covering half the piece). 1081232786/7 are hilly enough to be Roller coasters. |

## What the branch adds (done)

- **Your limit** on a road's page (Speed limit section, not ramps/highway sweeps): says what the map has (posted, or
  the guess and why), and a picker for 15–75 mph or "The map's". Stored as `mph` on the stretch's record in
  `js/tags.js` (`setTags(g, tags, note, mph)`, `setSpeed`, `speedFixes`), so it syncs with the account like tags.
  `js/roads.js`: `r.myMph`, `setMyMph`, `limitOf` (yours ?? posted). Used by Best rides' speed chip, Speed limits mode
  (drawn as if posted), the tap tag ("45 mph (yours)") and Ride mode's bar. `main.js` `applySpeedFixes()` runs when
  tiles load and when tags change.
- **Edit in OpenStreetMap** button on every road's page (`openstreetmap.org/edit?way=<id>`; at the spot for highway
  sweeps, whose ids are made up), and **Edit OpenStreetMap here** in the map's long-press/right-click menu.
- FEATURES.md (Your road tags section) and QA.md (Speed limits) updated.

## To do on the PC

1. **Run the browser tests** (the cloud session couldn't: cdnjs, Esri and OpenFreeMap were blocked, so the page never
   loaded): `node --test tests/app/browser.test.mjs`. New test: "your speed limit: set on a road's card…" (uses
   MO-150). Logic tests already pass: `node --test tests/app/logic.test.mjs` (55).
2. **Try it by hand**: All curvy roads → tap NE Strother Rd → Your limit 45 → Best rides at 45+ shows it. Check
   Edit in OpenStreetMap opens the editor with the road selected, on the phone too.
3. Merge to `main` when happy (the rider hasn't said whether they want a PR or to merge themselves).

## Next: proposed, not started

1. **Better town guess** (recommended; the rider was asked and hadn't answered yet). `estimate_mph` in
   `build_tiles.py` calls a road town if ≥ 40 residential streets are in the 3×3 ~1 km cells around its midpoint.
   Roads at the edge of suburbs (Strother, Scherer, likely others around Lee's Summit, Blue Springs, Raymore) get 30.
   Idea: town only if lots of streets nearby **and** residential streets actually meet the road, say ≥ ~3
   junctions per km (count residential ways sharing a node with it; town grids have one every block or two,
   subdivision edges have a few entrances). Needs the `raw/` files and a rebuild, so do it on the PC:
   - Print how many roads go from 30 to the default, and a few examples.
   - Check Strother (18511531) and Scherer (18515586) come out 45/55, MO-150 (18518688) stays a 55 mph sweeper
     (FEATURES.md regression case), and an in-town street stays 30.
   - Add a case to `tests/test_build.py`; update the Speed limits rule in FEATURES.md.
2. **Raytown Rd as a sweeper**: score sweep across a named stretch, not only per piece (`isSweeper` in `js/roads.js`
   is per piece; summing in `summarize` or in the build would do it).
3. **Hidden-road hint**: in Best rides, show roads hidden only by a guessed limit faintly, so they can be tapped and
   given your own limit without switching to All curvy roads.
4. The **Cameras layer** in BACKLOG.md covers the Flock cameras on Scherer.

## Notes

- The rider is fixing limits in OSM too: an edit reaches the app after Geofabrik's next daily extract, a fresh
  `.osm.pbf` in `raw/`, `python build_tiles.py`, `node tools/bump_version.mjs`, commit `tiles/`, push to `main`.
  Only what's on the signs, and road type by importance, not fun (OSM reverts guesses).
- A posted `maxspeed` replaces the town guess entirely, so a `45 mph` tag on Strother fixes it after a rebuild.
