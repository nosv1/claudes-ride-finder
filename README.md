# Ride Finder

A map for finding and planning motorcycle rides on curvy, fast, hilly roads, starting with Missouri, Kansas and Texas.
Live at <https://nosv1.github.io/claudes-ride-finder/>. It works on phones and computers; install it (Add to Home
Screen on a phone, the install button in the address bar in Chrome or Edge) to use it like an app.

- **Find roads**: curvy roads and fast sweepers you can ride at a decent speed, with hills, blind crests,
  surface and gas stations (90+ octane where known). Tap a road for its details, elevation and Street View.
- **3D terrain**: tilt the map to see the ridges and valleys the roads follow.
- **Plan a ride**: generate loops from your start for the time you have, built around roads you pick, or build
  your own. See miles, riding time, curvy miles, climbing, and where to get gas for your tank range.
- **Weather along the ride**: the forecast for when you'll pass each point, for the time you leave.
- **Fly through it in 3D**: watch the ride from just behind the bike, with the road sign, speed limit, next turn,
  weather and blind crests as they come up.
- **Ride it**: open in Google Maps (with extra stops so it sticks to the route), download a GPX for riding apps,
  or share a link (it shows a preview card in texts and chats).

**Pushing an update** (to `main`, which is the live site): run `node tools/bump_version.mjs` first. It sets the version
the app shows and the one phones compare against to offer the update.

The app's About page has the credits and the riding-safe wording. See [FEATURES.md](FEATURES.md) for the full feature list and requirements, [tests/README.md](tests/README.md)
for the tests, and [BACKLOG.md](BACKLOG.md) for what's next.

## Data

Road data comes from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Most rural roads have no
posted limit in OSM, so those are estimated: 55 mph for state routes, 45 for county roads, 30 in town (Texas: 70 on
numbered highways, 60 elsewhere). Weather comes from Open-Meteo.
Elevation comes from AWS Terrain Tiles (USGS), basemaps from Esri, routing from FOSSGIS Valhalla.

## Updating or adding states

1. Download state `.osm.pbf` files from [Geofabrik](https://download.geofabrik.de/north-america/us.html) into `raw/`
2. `pip install osmium numpy pillow`
3. `python build_tiles.py` (downloads elevation tiles for curvy roads the first time)
4. Commit the regenerated `tiles/` folder

For just the traffic lights (stoplight counts on rides), `python tools/add_signals.py` reads only the nodes of the
state files in a minute or two. To change only the highway-sweep rules, `python tools/add_highway_sweeps.py` redoes that step on the built `tiles/`
in about 15 seconds, without the downloads. `python tools/add_hills.py` measures hills on the straight roads already in
`tiles/` to find the roller coasters (downloads the terrain it needs the first time).

The link preview image (`preview.png`) is drawn from the built tiles: `node tools/make_preview.mjs` redraws it.
