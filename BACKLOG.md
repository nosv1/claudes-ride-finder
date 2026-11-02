# Backlog

Ideas that came up, roughly in order of how much they'd help.

- **Bottlenecks to fix before going national** (measured 2026-11-01): the site's map files are 68 MB for
  3 states (about 70% is the speed-limit layer), so the whole US would be near GitHub Pages' 1 GB limit,
  and every rebuild adds to git history. Slim the speed-limit layer, then move tiles off git (e.g.
  Cloudflare R2). Routing uses the free public Valhalla server (20–40 requests per Generate); host our
  own only if other people start using the site.
- **Turn-by-turn "Ride mode"** in the app, so it follows the planned route exactly (Google
  re-plans between stops). Full-screen map following GPS, big next-turn banner, voice prompts
  from Valhalla's turn instructions, screen kept awake, re-routing back onto the planned roads,
  gas and blind-crest callouts. Limits: screen on and app in front (phone mounted on a charger),
  no CarPlay/Android Auto, re-routing needs signal, iPhone voice can be finicky.
- **Fly-through extras**: a chase camera that banks into corners, a "skip the highway" toggle that speeds up
  through straight fast stretches, and recording it as a video to share.
- **Interchange tours and roundabouts**: fast ramps now have their own Interchanges mode.
  Next: roundabouts (`junction=roundabout`, like the double roundabouts on 87th St), and a
  generator for short interchange loops, e.g. west on I-470, US-71 north, I-435 north, the
  87th St roundabouts, and back through the Grandview Triangle.
- **Hide maybe-gravel roads**: an option to hide county roads whose surface isn't recorded
  (drawn dashed today). Many are gravel in the Ozarks.
- **Generator avoids city traffic**: today loops through town only rank lower. Penalize
  connecting routes through built-up areas directly.
- **Straight but hilly "roller coaster" roads**: only curvy roads get elevation data now.
  Scoring hills on every rural road would find them.
- **More states**: Arkansas (Eureka Springs, the Pig Trail), Oklahoma, Iowa, Nebraska. (Texas is in.)
  Check each state's default speed limits in `estimate_mph`.
  Download the `.osm.pbf` into `raw/` and rebuild.
- **Favorites**: star roads you've ridden and liked.
- **Dead-end roads in the generator**: lake roads in the Ozarks often dead-end at the water, so a
  loop rides them out and back. The generator now drops them after routing; marking dead ends in
  `build_tiles.py` would skip them up front (and save routing requests).
