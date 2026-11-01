# Ride Finder

A map for finding good motorcycle roads: curvy roads you can ride at a decent speed, starting with Missouri and Kansas.

- **Best rides**: curvy roads with a speed limit at or above your pick (35–55 mph)
- **Curvy**: every curvy road, colored by how twisty it is
- **Speed limits**: roads colored by posted limit

Click a road for its curves, speed limit, and surface, plus Street View and satellite links.

See [FEATURES.md](FEATURES.md) for the full feature list and requirements, and [tests/README.md](tests/README.md) for the tests.

## Data

Road data comes from [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Most rural roads have no posted limit in OSM, so those are estimated: 55 mph for state routes, 45 for county roads, 30 in town.

## Updating or adding states

1. Download state `.osm.pbf` files from [Geofabrik](https://download.geofabrik.de/north-america/us.html) into `raw/`
2. `pip install osmium`
3. `python build_tiles.py`
4. Commit the regenerated `tiles/` folder
