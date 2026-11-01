# Backlog

Ideas that came up, roughly in order of how much they'd help.

- **Weather forecast for a ride.** Hourly forecast at points along the planned route, timed
  to when you'll be there: rain chance, temperature, wind gusts. Flag rain or storms on the ride.
  Open-Meteo is free with no key and allows cross-origin requests.
- **Turn-by-turn "Ride mode"** in the app, so it follows the planned route exactly (Google
  re-plans between stops). Full-screen map following GPS, big next-turn banner, voice prompts
  from Valhalla's turn instructions, screen kept awake, re-routing back onto the planned roads,
  gas and blind-crest callouts. Limits: screen on and app in front (phone mounted on a charger),
  no CarPlay/Android Auto, re-routing needs signal, iPhone voice can be finicky.
- **Route fly-through**: a 3D camera flight along a planned ride (inspired by the "god's eye
  view" project). Tilted camera following the route and looking ahead, play/pause and speed,
  a scrubber tied to the elevation chart, blind crests called out as it passes them.
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
