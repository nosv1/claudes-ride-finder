"""Turn OpenStreetMap state extracts into map tiles for index.html.

Usage:  python build_tiles.py

Uses every *.osm.pbf in raw/. Get more states from
https://download.geofabrik.de/north-america/us.html (e.g. arkansas-latest.osm.pbf),
put them in raw/, and re-run. Elevation tiles for curvy roads are downloaded once
into raw/terrain/ (a few hundred MB per state).
"""
import glob
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import numpy as np
import osmium
from PIL import Image

TILE_SIZE = 0.5  # degrees
OUT_DIR = "tiles"

# Ramps (_link) are tight loops that would score as "twisty", so they only appear in speed mode.
CURVY_TYPES = {"primary", "secondary", "tertiary", "unclassified"}
SPEED_TYPES = CURVY_TYPES | {"motorway", "trunk", "residential", "motorway_link", "trunk_link",
                             "primary_link", "secondary_link", "tertiary_link"}

PAVED = {"paved", "asphalt", "concrete", "concrete:plates", "concrete:lanes", "chipseal", "paving_stones", "sett"}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "dirt", "ground", "compacted", "earth", "mud",
           "sand", "grass", "rock", "pebblestone", "woodchips", "gravel;dirt"}

# Curvature: resample each road every STEP metres, measure the turn radius at each
# point, and weight tighter turns more. A road's "curvy score" is weighted metres of curve.
STEP = 25
MIN_SCORE = 250  # below this a way is just a corner or two, not worth riding for


def radius_weight(r):
    if r < 30:
        return 2.0
    if r < 60:
        return 1.6
    if r < 100:
        return 1.3
    if r < 175:
        return 1.0
    return 0.0


# Sweepers: wide, fast curves (150–600 m radius) that the tight-curve score ignores.
# Measured over 100 m so the small wobbles in mapped "straight" roads don't register.
SWEEP_STEP = 100
SWEEP_RADIUS = (150, 600)
MIN_SWEEP = 300  # metres of sweeping curve before a road counts as a sweeper


def resample(pts, step):
    samples, carry, length = [pts[0]], 0.0, 0.0
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        seg = math.hypot(bx - ax, by - ay)
        length += seg
        d = step - carry
        while d <= seg:
            samples.append((ax + (bx - ax) * d / seg, ay + (by - ay) * d / seg))
            d += step
        carry = seg - (d - step)
    return samples, length


def radii(samples):
    for a, b, c in zip(samples, samples[1:], samples[2:]):
        cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
        yield math.dist(a, b) * math.dist(b, c) * math.dist(c, a) / (2 * cross) if cross > 1e-9 else math.inf


def analyze(coords):
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    pts = [(lon * kx, lat * ky) for lat, lon in coords]

    samples, length = resample(pts, STEP)
    score = curvy = 0.0
    for r in radii(samples):
        w = radius_weight(r)
        score += w * STEP
        if w:
            curvy += STEP

    lo, hi = SWEEP_RADIUS
    sweep = sum(SWEEP_STEP for r in radii(resample(pts, SWEEP_STEP)[0]) if lo <= r < hi)
    return length, score, curvy, sweep


# US mappers almost always write "45 mph"; bare numbers are treated as mph too.
def parse_mph(v):
    if not v:
        return None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?$", v.split(";")[0].strip(), re.I)
    if not m:
        return None
    n = float(m.group(1))
    if m.group(2) and "mph" not in m.group(2).lower():
        n /= 1.609
    return round(n)


def speed_of(tags):
    direct = parse_mph(tags.get("maxspeed"))
    if direct is not None:
        return direct
    f, b = parse_mph(tags.get("maxspeed:forward")), parse_mph(tags.get("maxspeed:backward"))
    if f is None and b is None:
        return None
    return max(f or 0, b or 0)


def surface_of(tags):
    s = tags.get("surface", "")
    if s in PAVED:
        return 0
    if s in UNPAVED or tags.get("tracktype", "") in {"grade2", "grade3", "grade4", "grade5"}:
        return 1
    # State routes are paved; county roads with no surface tag may well be gravel.
    return 2 if tags.get("highway") == "unclassified" else 0


# ---------- elevation ----------
# AWS Terrain Tiles: Terrarium-encoded PNGs from USGS elevation data, ~30 m per pixel at zoom 12.
TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRAIN_Z = 12
TERRAIN_DIR = os.path.join("raw", "terrain")
USER_AGENT = "ride-finder/1.0 (personal project)"
CLIMB_STEP = 2.0     # ignore wiggles in the elevation profile smaller than this (metres)
CREST_M = 3.0        # how far a point must rise above the road 75 m either side to be a crest
BLIND_RADIUS = 120   # a turn this tight (metres) at or just past a crest hides what's beyond it


def world_px(lat, lon):
    n = 256 * 2 ** TERRAIN_Z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def terrain_path(x, y):
    return os.path.join(TERRAIN_DIR, str(TERRAIN_Z), str(x), f"{y}.png")


def download_terrain(tiles):
    todo = [t for t in tiles if not os.path.exists(terrain_path(*t))]
    if not todo:
        return
    print(f"Downloading {len(todo):,} elevation tiles (one time; cached in {TERRAIN_DIR}/)...", flush=True)

    def get(t):
        path = terrain_path(*t)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(TERRAIN_URL.format(z=TERRAIN_Z, x=t[0], y=t[1]), headers={"User-Agent": USER_AGENT})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    data = res.read()
                with open(path + ".part", "wb") as f:
                    f.write(data)
                os.replace(path + ".part", path)
                return
            except Exception as e:
                if getattr(e, "code", None) == 404:
                    return
                time.sleep(2 * (attempt + 1))

    with ThreadPoolExecutor(12) as pool:
        for i, _ in enumerate(pool.map(get, todo), 1):
            if i % 500 == 0:
                print(f"  {i:,}/{len(todo):,}", flush=True)


class Elevation:
    """Bilinear elevation lookups over cached terrain tiles, keeping recent tiles in memory."""

    def __init__(self):
        self.cache = OrderedDict()

    def tile(self, x, y):
        if (x, y) in self.cache:
            self.cache.move_to_end((x, y))
            return self.cache[(x, y)]
        try:
            rgb = np.asarray(Image.open(terrain_path(x, y)).convert("RGB"), dtype=np.float64)
            arr = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
        except (OSError, ValueError):
            arr = None
        self.cache[(x, y)] = arr
        if len(self.cache) > 400:
            self.cache.popitem(last=False)
        return arr

    def pixel(self, gx, gy):
        t = self.tile(gx // 256, gy // 256)
        return None if t is None else float(t[gy % 256, gx % 256])

    def at(self, lat, lon):
        fx, fy = world_px(lat, lon)
        fx, fy = fx - 0.5, fy - 0.5
        ix, iy = math.floor(fx), math.floor(fy)
        dx, dy = fx - ix, fy - iy
        v = [self.pixel(ix + a, iy + b) for b in (0, 1) for a in (0, 1)]
        if None in v:
            return None
        return (v[0] * (1 - dx) + v[1] * dx) * (1 - dy) + (v[2] * (1 - dx) + v[3] * dx) * dy


def terrain_tiles_for(coords):
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    samples, _ = resample([(lon * kx, lat * ky) for lat, lon in coords], 100)
    tiles = set()
    for x, y in samples + [(lon * kx, lat * ky) for lat, lon in coords]:
        px, py = world_px(y / ky, x / kx)
        for ox in (-1, 1):
            for oy in (-1, 1):
                tiles.add((int(px + ox) // 256, int(py + oy) // 256))
    return tiles


def hills_and_blind(coords, elev):
    """Up-and-down per km, and spots where a tight turn sits on a crest."""
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    samples, length = resample([(lon * kx, lat * ky) for lat, lon in coords], STEP)
    latlon = [(y / ky, x / kx) for x, y in samples]
    e = [elev.at(lat, lon) for lat, lon in latlon]
    if len(e) < 7 or None in e:
        return None, []

    climb, ref = 0.0, e[0]
    for v in e[1:]:
        if abs(v - ref) >= CLIMB_STEP:
            climb += abs(v - ref)
            ref = v
    hill = round(climb / max(length, 1) * 1000, 1)

    r = [math.inf, *radii(samples), math.inf]  # turn radius at each sample
    blind, skip_to = [], 0
    for i in range(3, len(e) - 3):
        if i < skip_to:
            continue
        crest = e[i] - (e[i - 3] + e[i + 3]) / 2
        if crest >= CREST_M and e[i] >= max(e[i - 1], e[i + 1]) and min(r[i - 1:i + 4]) < BLIND_RADIUS:
            blind += [round(latlon[i][0] * 1e5), round(latlon[i][1] * 1e5)]
            skip_to = i + 8  # one flag per crest
    return hill, blind


def decode(deltas):
    out, lat, lon = [], 0, 0
    for i in range(0, len(deltas), 2):
        lat += deltas[i]
        lon += deltas[i + 1]
        out.append((lat / 1e5, lon / 1e5))
    return out


def encode(coords):
    out, plat, plon = [], 0, 0
    for lat, lon in coords:
        la, lo = round(lat * 1e5), round(lon * 1e5)
        out += [la - plat, lo - plon]
        plat, plon = la, lo
    return out


# Gas stations: does it sell 90+ octane? Few stations have their grades mapped, so
# fall back to the brand — these chains sell premium at nearly every location.
PREMIUM_BRANDS = re.compile(
    r"\b(phillips 66|casey'?s|quiktrip|qt|bp|conoco|shell|cenex|sinclair|kwik shop|love'?s|mobil|exxon|"
    r"murphy|circle k|kum & go|hy-?vee|valero|break ?time|sam'?s club|maverik|amoco|7-eleven|pilot|"
    r"flying j|sunoco|dillons|mfa|costco|gulf|walmart|chevron|texaco|citgo|marathon|speedway|76|zx)\b", re.I)
FUEL_YES, FUEL_LIKELY, FUEL_UNKNOWN, FUEL_NO = 2, 1, 0, -1


def octane_status(tags):
    grades = {int(m.group(1)): v for k, v in tags.items() if (m := re.fullmatch(r"fuel:octane_(\d+)", k))}
    if tags.get("fuel:premium") == "yes" or any(n >= 90 and v == "yes" for n, v in grades.items()):
        return FUEL_YES
    # Ignore "no" for European grades (95/98/100) that US mappers copy from presets.
    if any(90 <= n <= 94 and v == "no" for n, v in grades.items()):
        return FUEL_NO
    if PREMIUM_BRANDS.search(f"{tags.get('brand', '')} {tags.get('name', '')}"):
        return FUEL_LIKELY
    return FUEL_UNKNOWN


def is_gas_station(tags):
    # Skip truck-only diesel islands, which show up as separate stations next to the real one.
    if tags.get("amenity") != "fuel":
        return False
    return not (re.search(r"diesel|truck", tags.get("name", ""), re.I) or tags.get("fuel:octane_87") == "no"
                or tags.get("fuel:gasoline") == "no")


def fuel_row(tags, lat, lon):
    name, brand = tags.get("name") or "", tags.get("brand") or ""
    label = name or brand or "Gas station"
    if brand and name and brand.lower() not in name.lower():
        label = f"{name} ({brand})"
    return [round(lat, 5), round(lon, 5), label, tags.get("addr:city", ""),
            octane_status(tags), tags.get("opening_hours", "")]


# Roads with no posted limit: rural state routes get Missouri/Kansas's 55 mph default,
# county roads 45, and anything among lots of residential streets is treated as town (30).
CELL = 0.01           # degrees, roughly 1 km
URBAN_STREETS = 40    # residential streets within the surrounding 3x3 cells


PLACE_KINDS = ("city", "town", "village")


class Roads(osmium.SimpleHandler):
    def __init__(self, tiles, seen, residential, fuel, places):
        super().__init__()
        self.tiles, self.seen, self.residential, self.fuel, self.places = tiles, seen, residential, fuel, places
        self.count = 0

    def node(self, n):
        if n.tags.get("place") in PLACE_KINDS and "name" in n.tags:
            self.places[n.id] = [n.tags["name"], round(n.location.lat, 4), round(n.location.lon, 4), n.tags["place"]]
        if is_gas_station(n.tags) and ("n", n.id) not in self.fuel:
            self.fuel[("n", n.id)] = fuel_row(dict(n.tags), n.location.lat, n.location.lon)

    def way(self, w):
        if is_gas_station(w.tags) and ("w", w.id) not in self.fuel:
            try:
                pts = [(n.location.lat, n.location.lon) for n in w.nodes]
                self.fuel[("w", w.id)] = fuel_row(dict(w.tags), sum(p[0] for p in pts) / len(pts),
                                                  sum(p[1] for p in pts) / len(pts))
            except (osmium.InvalidLocationError, ZeroDivisionError):
                pass
        hw = w.tags.get("highway")
        if hw == "residential":
            try:
                loc = w.nodes[0].location
                self.residential[cell_of(loc.lat, loc.lon)] += 1
            except osmium.InvalidLocationError:
                pass
        if hw not in SPEED_TYPES or w.id in self.seen:
            return
        tags = {k: w.tags.get(k) for k in ("highway", "name", "ref", "maxspeed", "maxspeed:forward",
                                             "maxspeed:backward", "surface", "tracktype") if k in w.tags}
        mph = speed_of(tags)
        if mph is None and hw not in CURVY_TYPES:
            return
        try:
            coords = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return

        length, score, curvy, sweep = analyze(coords)
        is_curvy = hw in CURVY_TYPES and score >= MIN_SCORE
        is_sweeper = hw in CURVY_TYPES and sweep >= MIN_SWEEP
        if not is_curvy and not is_sweeper and mph is None:
            return

        self.seen.add(w.id)
        mid = coords[len(coords) // 2]
        key = f"{math.floor(mid[1] / TILE_SIZE)}_{math.floor(mid[0] / TILE_SIZE)}"
        # The estimated limit (index 5) is filled in by main() once every file has been read;
        # the midpoint on the end is only needed until then.
        self.tiles[key].append([
            w.id, hw, tags.get("name", ""), tags.get("ref", ""),
            mph, None, surface_of(tags), round(score if is_curvy else 0), round(curvy),
            round(sweep if is_sweeper else 0), round(length), encode(coords), mid,
        ])
        self.count += 1


def cell_of(lat, lon):
    return math.floor(lat / CELL), math.floor(lon / CELL)


def estimate_mph(row, residential):
    """Guess a limit for roads with none on record, so curvy-and-fast can include them."""
    hw, (lat, lon) = row[1], row[-1]
    cy, cx = cell_of(lat, lon)
    nearby = sum(residential[(cy + dy, cx + dx)] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    if nearby >= URBAN_STREETS:
        return 30
    return 45 if hw == "unclassified" else 55


SEARCH_NEAR = 0.03       # degrees: pieces of the same road this close are one stretch (as in the app)
SEARCH_MIN_CURVES = 800  # metres of curves before a stretch is worth listing


def road_index(tiles, places):
    """Named curvy stretches for search: [ref/name, name, s, w, n, e, metres of curves, nearest town]."""
    town_grid = defaultdict(list)
    for p in places:
        town_grid[(math.floor(p[1] * 4), math.floor(p[2] * 4))].append(p)

    def nearest_town(lat, lon):
        cy, cx = math.floor(lat * 4), math.floor(lon * 4)
        near = [p for dy in (-1, 0, 1) for dx in (-1, 0, 1) for p in town_grid[(cy + dy, cx + dx)]]
        k = math.cos(math.radians(lat))
        return min(near, key=lambda p: (p[1] - lat) ** 2 + ((p[2] - lon) * k) ** 2)[0] if near else ""

    by_key = defaultdict(list)
    for rows in tiles.values():
        for row in rows:
            key = row[3] or row[2]
            if key and (row[7] or row[9]):
                by_key[key].append(row)

    out = []
    for key, rows in by_key.items():
        clusters = []  # [s, w, n, e, metres of curves, names seen]
        for row in rows:
            pts = decode(row[11])
            s, n = min(p[0] for p in pts), max(p[0] for p in pts)
            w, e = min(p[1] for p in pts), max(p[1] for p in pts)
            c = next((c for c in clusters if s - SEARCH_NEAR <= c[2] and n + SEARCH_NEAR >= c[0]
                      and w - SEARCH_NEAR <= c[3] and e + SEARCH_NEAR >= c[1]), None)
            if c is None:
                c = [s, w, n, e, 0, defaultdict(int)]
                clusters.append(c)
            c[0], c[1], c[2], c[3] = min(c[0], s), min(c[1], w), max(c[2], n), max(c[3], e)
            c[4] += row[8] + row[9]
            if row[2] and row[2] != key:
                c[5][row[2]] += 1
        for s, w, n, e, curves, names in clusters:
            if curves < SEARCH_MIN_CURVES:
                continue
            name = max(names, key=names.get) if names else ""
            out.append([key, name, round(s, 4), round(w, 4), round(n, 4), round(e, 4), round(curves),
                        nearest_town((s + n) / 2, (w + e) / 2)])
    return out


def main(args):
    # cmd.exe doesn't expand wildcards, so do it here
    paths = sorted({p for a in (args or ["raw/*.osm.pbf"]) for p in glob.glob(a)})
    if not paths:
        sys.exit("No .osm.pbf files found in raw/.\n" + __doc__)
    tiles, seen, residential, fuel, places = defaultdict(list), set(), defaultdict(int), {}, {}
    for path in paths:
        print(f"Reading {path} (takes a few minutes)...", flush=True)
        h = Roads(tiles, seen, residential, fuel, places)
        h.apply_file(path, locations=True, idx="flex_mem")
        print(f"  kept {h.count:,} roads", flush=True)

    for rows in tiles.values():
        for row in rows:
            if row[4] is None:
                row[5] = estimate_mph(row, residential)
            row.pop()

    # Elevation, only for the curvy roads and sweepers (rows with a curve score or sweep).
    curvy_rows = [row for rows in tiles.values() for row in rows if row[7] or row[9]]
    needed = set()
    for row in curvy_rows:
        needed |= terrain_tiles_for(decode(row[11]))
    download_terrain(needed)
    print(f"Measuring hills on {len(curvy_rows):,} curvy roads...", flush=True)
    elev = Elevation()
    for rows in tiles.values():
        for row in rows:
            row += hills_and_blind(decode(row[11]), elev) if (row[7] or row[9]) else (None, [])

    shutil.rmtree(OUT_DIR, ignore_errors=True)
    os.makedirs(OUT_DIR)
    for key, rows in tiles.items():
        with open(os.path.join(OUT_DIR, f"{key}.js"), "w", encoding="utf-8") as f:
            f.write(f'addTile("{key}",')
            json.dump(rows, f, separators=(",", ":"), ensure_ascii=False)
            f.write(");\n")

    regions = sorted(os.path.basename(p).replace("-latest.osm.pbf", "") for p in paths)
    index = {"size": TILE_SIZE, "built": date.today().isoformat(), "regions": regions, "tiles": sorted(tiles)}
    with open(os.path.join(OUT_DIR, "index.js"), "w", encoding="utf-8") as f:
        f.write("window.TILE_INDEX = " + json.dumps(index) + ";\n")
    places = list(places.values())
    search = {"places": places, "roads": road_index(tiles, places)}
    with open(os.path.join(OUT_DIR, "search.js"), "w", encoding="utf-8") as f:
        f.write("window.SEARCH = ")
        json.dump(search, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print(f"Search index: {len(places):,} towns, {len(search['roads']):,} road stretches")

    with open(os.path.join(OUT_DIR, "fuel.js"), "w", encoding="utf-8") as f:
        f.write("window.FUEL = ")
        json.dump(list(fuel.values()), f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print(f"Wrote {len(tiles)} tiles and {len(fuel):,} gas stations to {OUT_DIR}/")


if __name__ == "__main__":
    main(sys.argv[1:])
