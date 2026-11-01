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
- **Fun interchange ramps**: long, fast, multi-lane on/off ramps and flyovers, like the
  Grandview Triangle (I-435 / I-470 / US-71 / I-49 in KC). Ramps (`motorway_link`,
  `trunk_link`) are left out of curve scoring today because tight cloverleaf loops would all
  look "twisty". Score them separately: keep sweeping ones (150–600 m radius over a few hundred
  metres), prefer `lanes` ≥ 2 and higher speeds, skip short tight loops; show them as their own
  class ("Ramps") with their own toggle.
- **Hide maybe-gravel roads**: an option to hide county roads whose surface isn't recorded
  (drawn dashed today). Many are gravel in the Ozarks.
- **Generator avoids city traffic**: today loops through town only rank lower. Penalize
  connecting routes through built-up areas directly.
- **Straight but hilly "roller coaster" roads**: only curvy roads get elevation data now.
  Scoring hills on every rural road would find them.
- **More states**: Arkansas (Eureka Springs, the Pig Trail), Oklahoma, Iowa, Nebraska.
  Download the `.osm.pbf` into `raw/` and rebuild.
- **Favorites**: star roads you've ridden and liked.
