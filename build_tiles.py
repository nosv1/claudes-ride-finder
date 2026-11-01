"""Turn OpenStreetMap state extracts into map tiles for index.html.

Usage:  python build_tiles.py

Uses every *.osm.pbf in raw/. Get more states from
https://download.geofabrik.de/north-america/us.html (e.g. arkansas-latest.osm.pbf),
put them in raw/, and re-run.
"""
import glob
import json
import math
import os
import re
import shutil
import sys
from collections import defaultdict
from datetime import date

import osmium

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


class Roads(osmium.SimpleHandler):
    def __init__(self, tiles, seen, residential, fuel):
        super().__init__()
        self.tiles, self.seen, self.residential, self.fuel = tiles, seen, residential, fuel
        self.count = 0

    def node(self, n):
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


def main(args):
    # cmd.exe doesn't expand wildcards, so do it here
    paths = sorted({p for a in (args or ["raw/*.osm.pbf"]) for p in glob.glob(a)})
    if not paths:
        sys.exit("No .osm.pbf files found in raw/.\n" + __doc__)
    tiles, seen, residential, fuel = defaultdict(list), set(), defaultdict(int), {}
    for path in paths:
        print(f"Reading {path} (takes a few minutes)...", flush=True)
        h = Roads(tiles, seen, residential, fuel)
        h.apply_file(path, locations=True, idx="flex_mem")
        print(f"  kept {h.count:,} roads", flush=True)

    for rows in tiles.values():
        for row in rows:
            if row[4] is None:
                row[5] = estimate_mph(row, residential)
            row.pop()

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
    with open(os.path.join(OUT_DIR, "fuel.js"), "w", encoding="utf-8") as f:
        f.write("window.FUEL = ")
        json.dump(list(fuel.values()), f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print(f"Wrote {len(tiles)} tiles and {len(fuel):,} gas stations to {OUT_DIR}/")


if __name__ == "__main__":
    main(sys.argv[1:])
