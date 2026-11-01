# Ride Finder

A map for finding and planning motorcycle rides on curvy, fast, hilly roads, starting with Missouri and Kansas.
Live at <https://nosv1.github.io/claudes-ride-finder/> (works on phones; add it to your home screen to use it like an app).

- **Find roads**: curvy roads and fast sweepers you can ride at a decent speed, with hills, blind crests,
  surface and gas stations (90+ octane where known). Tap a road for its details, elevation and Street View.
- **3D terrain**: tilt the map to see the ridges and valleys the roads follow.
- **Plan a ride**: generate loops from your start for the time you have, built around roads you pick, or build
  your own. See miles, riding time, curvy miles, climbing, and where to get gas for your tank range.
- **Ride it**: open in Google Maps (with extra stops so it sticks to the route), download a GPX for riding apps,
  or share a link.

See [FEATURES.md](FEATURES.md) for the full feature list and requirements, [tests/README.md](tests/README.md)
for the tests, and [BACKLOG.md](BACKLOG.md) for what's next.

## Data

Road data comes from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Most rural roads have no
posted limit in OSM, so those are estimated: 55 mph for state routes, 45 for county roads, 30 in town.
Elevation comes from AWS Terrain Tiles (USGS), basemaps from Esri, routing from FOSSGIS Valhalla.

## Updating or adding states

1. Download state `.osm.pbf` files from [Geofabrik](https://download.geofabrik.de/north-america/us.html) into `raw/`
2. `pip install osmium numpy pillow`
3. `python build_tiles.py` (downloads elevation tiles for curvy roads the first time)
4. Commit the regenerated `tiles/` folder
