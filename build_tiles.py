"""Turn OpenStreetMap state extracts into map tiles for index.html.

Usage:  python build_tiles.py

Uses every *.osm.pbf in raw/. Get more states from
https://download.geofabrik.de/north-america/us.html (e.g. arkansas-latest.osm.pbf),
put them in raw/, and re-run. Elevation tiles for curvy roads and the other rural roads (for roller
coasters) are downloaded once into raw/terrain/ (several hundred MB per state).
"""
import bisect
from array import array
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
# Interstate/expressway ramps: scored on their own for long, fast sweeps (flyovers), not tight loops.
RAMP_TYPES = {"motorway_link", "trunk_link"}
# Highways that aren't for traffic: a footpath touching a ramp doesn't make it a junction.
NOT_ROADS = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway", "corridor", "platform",
             "proposed", "construction", "elevator"}
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

# Roller coasters: straight (not curvy, not a sweeper) back roads that go up and down a lot. Shown as a layer to be
# aware of, not used for rides. Every rural road this long is measured; the hilly ones go in the main tiles.
# The app's ROLLER in js/config.js has the same numbers.
ROLLER_TYPES = CURVY_TYPES
ROLLER_MIN_M = 1000   # shorter pieces are mostly bridges and corners, where bare-earth elevation misleads
ROLLER_HILL = 22.0    # metres up and down per km: "Hilly" in the app (115 ft per mile)


# Ramps built for highway speed curve wider than back roads, so their sweeps count up to 1.5 km radius.
RAMP_SWEEP_RADIUS = (150, 1500)


def ramp_sweep(coords):
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    lo, hi = RAMP_SWEEP_RADIUS
    samples, _ = resample([(lon * kx, lat * ky) for lat, lon in coords], SWEEP_STEP)
    return sum(SWEEP_STEP for r in radii(samples) if lo <= r < hi)


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
ROAD_GRADE = 0.18    # steeper than this over 100 m is the hillside beside the road read as the road, not the road


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


def up_and_down(e):
    """Metres climbed and dropped along an elevation profile, ignoring wiggles under CLIMB_STEP."""
    up = down = 0.0
    ref = e[0]
    for v in e[1:]:
        if abs(v - ref) >= CLIMB_STEP:
            if v > ref:
                up += v - ref
            else:
                down += ref - v
            ref = v
    return up, down


def rolling(e, length):
    """How much a straight road keeps going up and down, per km: only climbing that's matched by dropping counts,
    so one long grade doesn't (the Red Route in Branson only goes downhill). None when the profile is steeper than a
    road can be: next to a lake or bluff the bare-earth terrain has the hillside beside the road in it (MO 39 by
    Shell Knob read as 28% grades)."""
    s = [sum(e[max(0, i - 2):i + 3]) / len(e[max(0, i - 2):i + 3]) for i in range(len(e))]
    if any(abs(s[i + 4] - s[i]) > ROAD_GRADE * 4 * STEP for i in range(len(s) - 4)):
        return None
    return round(2 * min(up_and_down(e)) / max(length, 1) * 1000, 1)


def hills_and_blind(coords, elev, straight=False):
    """Up-and-down per km, and spots where a tight turn sits on a crest. For a straight road (a possible roller
    coaster), the up-and-down is only what it keeps doing (see rolling)."""
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    samples, length = resample([(lon * kx, lat * ky) for lat, lon in coords], STEP)
    latlon = [(y / ky, x / kx) for x, y in samples]
    e = [elev.at(lat, lon) for lat, lon in latlon]
    if len(e) < 7 or None in e:
        return None, []

    hill = rolling(e, length) if straight else round(sum(up_and_down(e)) / max(length, 1) * 1000, 1)

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


def is_curvy_row(row):
    return bool(row[7] or row[9])


def roller_candidate(row):
    """A straight back road long enough to measure for hills (rows before or after the hill is added)."""
    return not is_curvy_row(row) and row[1] in ROLLER_TYPES and row[10] >= ROLLER_MIN_M


def is_roller(row):
    """A measured straight back road that's hilly. Row: [..., length (10), coords (11), hill (12), ...]."""
    return roller_candidate(row) and len(row) > 12 and row[12] is not None and row[12] >= ROLLER_HILL


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
# county roads 45, and a road among lots of residential streets is in town (30) if streets actually
# meet it often; one that only skirts subdivisions (a few entrances) is the edge of town (45).
CELL = 0.01           # degrees, roughly 1 km
URBAN_STREETS = 40    # residential streets within the surrounding 3x3 cells
# In town: at least this many residential streets meet it per km, or this many streets and business
# entrances of any kind (not driveways). Measured around KC: town streets ~6-10 and up, NE Strother
# Rd 0.8 and 1.7, SW Scherer Rd 2.3 and 4.3, Swope Pkwy 2.2 and 6.6, a mall road 0 and 9.6.
TOWN_RESIDENTIAL_PER_KM = 3
TOWN_STREETS_PER_KM = 6
EDGE_OF_TOWN_MPH = 45
# Roads whose meeting a candidate counts as a junction (driveways and tracks don't).
JUNCTION_TYPES = {"residential", "living_street", "unclassified", "service", "tertiary", "secondary", "primary",
                  "trunk", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}


PLACE_KINDS = ("city", "town", "village")


class RampNodes(osmium.SimpleHandler):
    """First pass: every node on a ramp, so the main pass can tell which ones other roads meet."""
    def __init__(self):
        super().__init__()
        self.nodes = set()

    def way(self, w):
        if w.tags.get("highway") in RAMP_TYPES:
            self.nodes.update(n.ref for n in w.nodes)


class Roads(osmium.SimpleHandler):
    def __init__(self, tiles, seen, residential, fuel, places, ramp_nodes, region="", lights=None):
        super().__init__()
        self.lights = lights if lights is not None else []  # every traffic light, for the stoplights on a route
        self.region = region  # "missouri", "texas"...: speed defaults differ by state
        self.tiles, self.seen, self.residential, self.fuel, self.places = tiles, seen, residential, fuel, places
        self.lanes = {}
        self.ramp_ways = {}   # id -> (first node, last node, coords, tags, mph)
        self.ramp_nodes = ramp_nodes
        self.signals = set()  # ramp nodes with a traffic light or stop sign
        # Ramp nodes another (non-ramp) road passes through or crosses: ways through the node count
        # 2, ways ending there 1. A road only starting there (1) is a fork the ramp carries on past.
        self.crossing = defaultdict(int)
        self.count = 0
        self.unposted = {}    # id -> (midpoint, node ids) of kept roads with no limit, for count_junctions()

    def node(self, n):
        if n.tags.get("highway") in ("traffic_signals", "stop") and n.id in self.ramp_nodes:
            self.signals.add(n.id)
        if n.tags.get("highway") == "traffic_signals":
            self.lights.append((n.location.lat, n.location.lon))
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
        if hw and hw not in RAMP_TYPES and hw not in NOT_ROADS:
            refs = [n.ref for n in w.nodes]
            for i, r in enumerate(refs):
                if r in self.ramp_nodes:
                    self.crossing[r] += 1 if i in (0, len(refs) - 1) else 2
        if hw == "residential":
            try:
                loc = w.nodes[0].location
                self.residential[cell_of(loc.lat, loc.lon)] += 1
            except osmium.InvalidLocationError:
                pass
        if hw not in SPEED_TYPES or w.id in self.seen:
            return
        tags = {k: w.tags.get(k) for k in ("highway", "name", "ref", "maxspeed", "maxspeed:forward", "maxspeed:backward",
                                             "surface", "tracktype", "lanes", "destination", "destination:ref") if k in w.tags}
        mph = speed_of(tags)
        if mph is None and hw not in CURVY_TYPES and hw not in RAMP_TYPES:
            return
        try:
            coords = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return

        # Ramps are split into short pieces in OSM; they're joined and scored in finish_ramps().
        # One with a traffic light or stop sign partway along isn't a free-flowing ramp. (Nodes come before
        # ways in a .pbf, so the lights are known by now.)
        if hw in RAMP_TYPES:
            refs = [n.ref for n in w.nodes]
            if not any(r in self.signals for r in refs[1:-1]):
                self.ramp_ways[w.id] = (w.nodes[0].ref, w.nodes[-1].ref, coords, tags, mph)
            return

        length, score, curvy, sweep = analyze(coords)
        is_curvy = hw in CURVY_TYPES and score >= MIN_SCORE
        is_sweeper = hw in CURVY_TYPES and sweep >= MIN_SWEEP
        # Unposted straight roads are kept for now in case they're roller coasters; main() drops the flat ones.
        if not is_curvy and not is_sweeper and mph is None and not (hw in ROLLER_TYPES and length >= ROLLER_MIN_M):
            return
        if mph is None:
            self.unposted[w.id] = (coords[len(coords) // 2], array("q", (n.ref for n in w.nodes)))
        self.add_row(w.id, hw, tags, mph, coords, (length, score if is_curvy else 0, curvy, sweep if is_sweeper else 0))

    def add_row(self, wid, hw, tags, mph, coords, scores, name=None, ref=None):
        length, score, curvy, sweep = scores
        self.seen.add(wid)
        mid = coords[len(coords) // 2]
        key = f"{math.floor(mid[1] / TILE_SIZE)}_{math.floor(mid[0] / TILE_SIZE)}"
        # The estimated limit (index 5) is filled in by main() once every file has been read;
        # the midpoint on the end is only needed until then.
        self.tiles[key].append([
            wid, hw, tags.get("name", "") if name is None else name, tags.get("ref", "") if ref is None else ref,
            mph, None, surface_of(tags), round(score), round(curvy), round(sweep), round(length), encode(coords), mid, self.region,
        ])
        lanes = re.match(r"\d+", tags.get("lanes", ""))
        if lanes:
            self.lanes[wid] = int(lanes.group())
        self.count += 1

    def finish_ramps(self):
        """Join ramp pieces end to end (where nothing merges or splits) and score each whole ramp.
        Never across a traffic light, a stop sign or a road crossing: an off-ramp that ends at a
        crossroad and the on-ramp that starts there are two ramps, not one."""
        starts, ends = defaultdict(list), defaultdict(list)
        for wid, (a, b, *_rest) in self.ramp_ways.items():
            starts[a].append(wid)
            ends[b].append(wid)
        joins = lambda node: (len(starts[node]) == 1 and len(ends[node]) == 1
                              and node not in self.signals and self.crossing[node] < 2)
        done = set()

        def walk(first):
            chain = [first]
            done.add(first)
            while joins(self.ramp_ways[chain[-1]][1]):
                nxt = starts[self.ramp_ways[chain[-1]][1]][0]
                if nxt in done:
                    break
                chain.append(nxt)
                done.add(nxt)
            return chain

        chains = [walk(w) for w in self.ramp_ways if w not in done and not joins(self.ramp_ways[w][0])]
        chains += [walk(w) for w in self.ramp_ways if w not in done]  # loops with no clear start
        for chain in chains:
            ways = [self.ramp_ways[w] for w in chain]
            coords = [p for i, way in enumerate(ways) for p in (way[2] if i == 0 else way[2][1:])]
            mph = next((way[4] for way in ways if way[4] is not None), None)
            tags = next((way[3] for way in ways if "destination" in way[3] or "destination:ref" in way[3]), ways[0][3])
            lanes = [int(m.group()) for way in ways if (m := re.match(r"\d+", way[3].get("lanes", "")))]
            length, score, curvy, _ = analyze(coords)
            sweep = ramp_sweep(coords)
            if sweep < MIN_SWEEP and mph is None:
                continue
            to = tags.get("destination:ref") or tags.get("destination")
            name = tags.get("name") or (f"Ramp to {to.replace(';', ' / ')}" if to else "Ramp")
            self.add_row(chain[0], tags["highway"], {**tags, "lanes": str(max(lanes)) if lanes else ""}, mph, coords,
                         (length, 0, curvy, sweep if sweep >= MIN_SWEEP else 0), name=name, ref="")
            self.seen.update(chain)
        self.ramp_ways = {}


def cell_of(lat, lon):
    return math.floor(lat / CELL), math.floor(lon / CELL)


def streets_near(lat, lon, residential):
    cy, cx = cell_of(lat, lon)
    return sum(residential[(cy + dy, cx + dx)] for dy in (-1, 0, 1) for dx in (-1, 0, 1))


def estimate_mph(row, residential, junctions=None):
    """Guess a limit for roads with none on record, so curvy-and-fast can include them.
    row ends with the road's midpoint and region; row[1] is its highway type, row[3] its ref, row[10] its length.
    junctions: id -> (residential streets, streets of any kind) meeting it partway along (count_junctions)."""
    hw, ref, (lat, lon), region = row[1], row[3], row[-2], row[-1]
    if region == "texas":
        # Texas law outside towns: 70 on numbered highways (US, TX, FM/RM, Loop...), 60 on other
        # roads, county roads (CR) included.
        default = 70 if ref and not ref.startswith("CR") else 60
    else:
        default = 45 if hw == "unclassified" else 55
    if streets_near(lat, lon, residential) >= URBAN_STREETS:
        j = (junctions or {}).get(row[0])
        if j is None:  # no count (ramps, or near a state line): town, as before
            return 30
        km = max(row[10] / 1000, 0.05)
        if j[0] / km >= TOWN_RESIDENTIAL_PER_KM or j[1] / km >= TOWN_STREETS_PER_KM:
            return 30
        return min(EDGE_OF_TOWN_MPH, default)
    return default


class Junctions(osmium.SimpleHandler):
    """Which roads meet the given nodes: node -> [(way id, residential?)]."""
    def __init__(self, nodes):
        super().__init__()
        self.nodes = nodes
        self.touches = defaultdict(list)

    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in JUNCTION_TYPES or (hw == "service" and w.tags.get("service") == "driveway"):
            return
        res = hw in ("residential", "living_street")
        for n in w.nodes:
            if n.ref in self.nodes:
                self.touches[n.ref].append((w.id, res))


def count_junctions(path, unposted, residential):
    """For unposted roads among lots of residential streets (the ones estimate_mph might call town):
    id -> (residential streets, streets of any kind) meeting it partway along, not at its ends."""
    inner = {}
    for wid, (mid, refs) in unposted.items():
        if streets_near(*mid, residential) >= URBAN_STREETS:
            inner[wid] = set(refs[1:-1]) - {refs[0], refs[-1]}
    h = Junctions({n for nodes in inner.values() for n in nodes})
    h.apply_file(path)
    out = {}
    for wid, nodes in inner.items():
        met = [[r for w, r in h.touches.get(n, ()) if w != wid] for n in nodes]
        out[wid] = (sum(any(m) for m in met), sum(bool(m) for m in met))
    return out


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
            if key and (row[7] or row[9]) and row[1] not in RAMP_TYPES | HIGHWAY_TYPES:
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


# Highway sweeps: interstates and divided highways posted 65+, where the road itself sweeps for a while
# (the ramps are scored on their own above). OSM splits highways at every ramp and bridge, so pieces are
# joined end to end into one line per direction first; then the stretches that sweep are cut out of it.
HIGHWAY_TYPES = {"motorway", "trunk"}
HIGHWAY_MIN_MPH = 65      # posted; an interstate with no limit on record isn't kept at all
HIGHWAY_MIN_SWEEP = 600   # metres of sweeping curve in one stretch
HIGHWAY_GAP = 300         # straight allowed between two curves of the same stretch
HIGHWAY_LEAD = 200        # straight kept either side, so the stretch starts before the curve
HIGHWAY_JOIN_TURN = math.radians(30)  # the next piece must carry straight on (not a fork off to the side)
DIVIDED_NEAR = 80         # a divided highway's other carriageway runs the other way within this many metres


def _metres(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 111320 * k)


def _bearing(a, b):
    return math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])


def _turn(h1, h2):
    d = abs(h1 - h2) % (2 * math.pi)
    return min(d, 2 * math.pi - d)


def _radius(a, b, c):
    """Turn radius in metres at b, projected around b (good over any length of highway)."""
    kx, ky = 111320 * math.cos(math.radians(b[0])), 110540
    pa, pb, pc = [((p[1] - b[1]) * kx, (p[0] - b[0]) * ky) for p in (a, b, c)]
    return next(radii([pa, pb, pc]))


def _point_at(pts, dist, d):
    """The point d metres along a line whose points are dist[i] metres along it."""
    i = max(1, min(len(pts) - 1, bisect.bisect_left(dist, d)))
    seg = dist[i] - dist[i - 1]
    t = 0 if seg <= 0 else max(0.0, min(1.0, (d - dist[i - 1]) / seg))
    return (pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t), i


def _divided(coords, others):
    """Whether most of a line has another carriageway running the opposite way within DIVIDED_NEAR."""
    step = max(1, len(coords) // 8)
    pairs = [(coords[i], coords[min(i + step, len(coords) - 1)]) for i in range(0, len(coords) - 1, step)]
    hits = 0
    for p, q in pairs:
        h = _bearing(p, q)
        cy, cx = round(p[0] / 0.002), round(p[1] / 0.002)
        near = (s for dy in (-1, 0, 1) for dx in (-1, 0, 1) for s in others.get((cy + dy, cx + dx), ()))
        hits += any(_turn(h, sh) > math.radians(150) and _metres(p, sp) <= DIVIDED_NEAR for sp, sh in near)
    return hits >= 0.6 * len(pairs)


def highway_sweeps(tiles):
    """Add a row for each stretch of 65+ mph highway that sweeps, to the tile of its midpoint.
    Rows are one-way (one carriageway), with a negative id so they never clash with a way's."""
    rows = sorted((r for rs in tiles.values() for r in rs if r[1] in HIGHWAY_TYPES and r[9] == 0), key=lambda r: r[0])
    geom = {r[0]: decode(r[11]) for r in rows}
    fast = {r[0]: r for r in rows if r[4] is not None and r[4] >= HIGHWAY_MIN_MPH}
    starts, ends = defaultdict(list), defaultdict(list)
    for wid in fast:
        starts[geom[wid][0]].append(wid)
        ends[geom[wid][-1]].append(wid)

    # Every highway piece (any limit), sampled every ~100 m with its heading, to tell divided highways
    # (two one-way carriageways) from two-way ones.
    others = defaultdict(list)
    for r in rows:
        pts = geom[r[0]]
        for a, b in zip(pts, pts[1:]):
            h, n = _bearing(a, b), max(1, int(_metres(a, b) / 100))
            for k in range(n + 1):
                p = (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)
                others[(round(p[0] / 0.002), round(p[1] / 0.002))].append((p, h))

    used = set()

    def straightest(options, heading, seq_of):
        best = None
        for w in options:
            if w in used:
                continue
            t = _turn(heading, seq_of(w))
            if t < HIGHWAY_JOIN_TURN and (best is None or t < best[0]):
                best = (t, w)
        return best and best[1]

    chains = []
    for wid in fast:
        if wid in used:
            continue
        used.add(wid)
        chain = [wid]
        while True:  # forward: pieces starting where this one ends
            pts = geom[chain[-1]]
            nxt = straightest(starts[pts[-1]], _bearing(pts[-2], pts[-1]), lambda w: _bearing(geom[w][0], geom[w][1]))
            if nxt is None:
                break
            used.add(nxt)
            chain.append(nxt)
        while True:  # backward: pieces ending where this one starts
            pts = geom[chain[0]]
            prv = straightest(ends[pts[0]], _bearing(pts[0], pts[1]), lambda w: _bearing(geom[w][-2], geom[w][-1]))
            if prv is None:
                break
            used.add(prv)
            chain.insert(0, prv)
        chains.append(chain)

    ids = {r[0] for rs in tiles.values() for r in rs}
    added = 0
    for chain in chains:
        pts, src = [], []
        for w in chain:
            g = geom[w] if not pts else geom[w][1:]
            pts += g
            src += [w] * len(g)
        dist = [0.0]
        for a, b in zip(pts, pts[1:]):
            dist.append(dist[-1] + _metres(a, b))
        if dist[-1] < HIGHWAY_MIN_SWEEP:
            continue
        samples = [_point_at(pts, dist, d)[0] for d in range(0, int(dist[-1]) + 1, SWEEP_STEP)]
        lo, hi = RAMP_SWEEP_RADIUS
        sweeping = [i for i in range(1, len(samples) - 1) if lo <= _radius(*samples[i - 1:i + 2]) < hi]
        groups = []
        for i in sweeping:
            if groups and (i - groups[-1][-1]) * SWEEP_STEP <= HIGHWAY_GAP:
                groups[-1].append(i)
            else:
                groups.append([i])
        for g in groups:
            sweep = len(g) * SWEEP_STEP
            if sweep < HIGHWAY_MIN_SWEEP:
                continue
            d0 = max(0.0, (g[0] - 1) * SWEEP_STEP - HIGHWAY_LEAD)
            d1 = min(dist[-1], (g[-1] + 1) * SWEEP_STEP + HIGHWAY_LEAD)
            (p0, i0), (p1, i1) = _point_at(pts, dist, d0), _point_at(pts, dist, d1)
            coords = [p0]
            for p in pts[i0:i1] + [p1]:
                if p != coords[-1]:
                    coords.append(p)
            ways = [fast[w] for w in dict.fromkeys(src[max(0, i0 - 1):i1 + 1])]
            mid = fast[src[min(len(src) - 1, (i0 + i1) // 2)]]
            if mid[1] == "trunk" and not _divided(coords, others):
                continue  # a two-way highway: one line for both directions, not a one-way sweep
            lanes = [w[14] for w in ways if w[14]]
            length, _, curvy, _ = analyze(coords)
            rid = -ways[0][0]
            while rid in ids:
                rid -= 10 ** 10
            ids.add(rid)
            row = [rid, mid[1], mid[2], mid[3], min(w[4] for w in ways), None, 0, 0, round(curvy), sweep, round(length),
                   encode(coords), None, [], min(lanes) if lanes else None]
            m = coords[len(coords) // 2]
            tiles[f"{math.floor(m[1] / TILE_SIZE)}_{math.floor(m[0] / TILE_SIZE)}"].append(row)
            added += 1
    return added


class Lights(osmium.SimpleHandler):
    """Just the traffic lights (tools/add_signals.py: no need to read the ways)."""
    def __init__(self, lights):
        super().__init__()
        self.lights = lights

    def node(self, n):
        if n.tags.get("highway") == "traffic_signals":
            self.lights.append((n.location.lat, n.location.lon))


def write_signals(lights):
    """tiles/signals.js: every traffic light, delta-encoded like road coords, sorted so the deltas are small.
    The app loads it when it routes, to count the stoplights on a ride."""
    pts = sorted({(round(lat, 5), round(lon, 5)) for lat, lon in lights})
    with open(os.path.join(OUT_DIR, "signals.js"), "w", encoding="utf-8") as f:
        f.write("window.SIGNALS = ")
        json.dump(encode(pts), f, separators=(",", ":"))
        f.write(";\n")
    return len(pts)


def write_tiles(tiles, regions):
    """Each tile in two files: {x}_{y}.js with the curvy roads, sweepers, fast ramps and roller coasters
    (what the ride modes use) and {x}_{y}.s.js with the roads kept only for their speed limit, about
    70% of the data, loaded only in Speed limits mode. Zoomed out over Texas, loading everything took
    ~67 MB and crashed phones."""
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    os.makedirs(OUT_DIR)
    main_keys, speed_keys = [], []
    for key, rows in tiles.items():
        curvy = [r for r in rows if is_curvy_row(r) or is_roller(r)]
        speed = [r for r in rows if not (is_curvy_row(r) or is_roller(r))]
        for name, part, keys in ((key, curvy, main_keys), (f"{key}.s", speed, speed_keys)):
            if not part:
                continue
            keys.append(key)
            with open(os.path.join(OUT_DIR, f"{name}.js"), "w", encoding="utf-8") as f:
                f.write(f'addTile("{name}",')
                json.dump(part, f, separators=(",", ":"), ensure_ascii=False)
                f.write(");\n")
    index = {"size": TILE_SIZE, "built": date.today().isoformat(), "regions": regions,
             "tiles": sorted(main_keys), "speed": sorted(speed_keys)}
    with open(os.path.join(OUT_DIR, "index.js"), "w", encoding="utf-8") as f:
        f.write("window.TILE_INDEX = " + json.dumps(index) + ";\n")


def main(args):
    # cmd.exe doesn't expand wildcards, so do it here
    paths = sorted({p for a in (args or ["raw/*.osm.pbf"]) for p in glob.glob(a)})
    if not paths:
        sys.exit("No .osm.pbf files found in raw/.\n" + __doc__)
    tiles, seen, residential, fuel, places, lanes, lights = defaultdict(list), set(), defaultdict(int), {}, {}, {}, []
    junctions = {}
    for path in paths:
        print(f"Reading {path} (takes a few minutes)...", flush=True)
        ramps = RampNodes()
        ramps.apply_file(path)
        region = os.path.basename(path).replace("-latest.osm.pbf", "")
        h = Roads(tiles, seen, residential, fuel, places, ramps.nodes, region, lights)
        h.apply_file(path, locations=True, idx="flex_mem")
        h.finish_ramps()
        lanes.update(h.lanes)
        junctions.update(count_junctions(path, h.unposted, residential))
        print(f"  kept {h.count:,} roads", flush=True)

    guesses = defaultdict(int)
    for rows in tiles.values():
        for row in rows:
            if row[4] is None:
                row[5] = estimate_mph(row, residential, junctions)
                guesses["town" if row[5] == 30 else "edge of town" if row[0] in junctions else "out of town"] += 1
            del row[-2:]  # midpoint and region
    print("Guessed limits: " + ", ".join(f"{n:,} {k}" for k, n in sorted(guesses.items())), flush=True)

    # Elevation for the curvy roads and sweepers (rows with a curve score or sweep), and the straight back roads, to
    # find the roller coasters. Bare-earth elevation means nothing on a flyover, so not for ramps.
    measure = lambda row: (is_curvy_row(row) and row[1] not in RAMP_TYPES) or roller_candidate(row)
    measured = [row for rows in tiles.values() for row in rows if measure(row)]
    needed = set()
    for row in measured:
        needed |= terrain_tiles_for(decode(row[11]))
    download_terrain(needed)
    print(f"Measuring hills on {len(measured):,} roads...", flush=True)
    elev = Elevation()
    for rows in tiles.values():
        for row in rows:
            row += hills_and_blind(decode(row[11]), elev, roller_candidate(row)) if measure(row) else (None, [])
            row.append(lanes.get(row[0]))
        # Straight roads with no posted limit were only kept in case they were roller coasters.
        rows[:] = [r for r in rows if r[4] is not None or is_curvy_row(r) or is_roller(r)]
    print(f"Roller coasters: {sum(is_roller(r) for rows in tiles.values() for r in rows):,}", flush=True)
    print(f"Highway sweeps: {highway_sweeps(tiles):,}", flush=True)

    regions = sorted(os.path.basename(p).replace("-latest.osm.pbf", "") for p in paths)
    write_tiles(tiles, regions)
    places = list(places.values())
    search = {"places": places, "roads": road_index(tiles, places)}
    with open(os.path.join(OUT_DIR, "search.js"), "w", encoding="utf-8") as f:
        f.write("window.SEARCH = ")
        json.dump(search, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print(f"Search index: {len(places):,} towns, {len(search['roads']):,} road stretches")

    print(f"Traffic lights: {write_signals(lights):,}")

    with open(os.path.join(OUT_DIR, "fuel.js"), "w", encoding="utf-8") as f:
        f.write("window.FUEL = ")
        json.dump(list(fuel.values()), f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print(f"Wrote {len(tiles)} tiles and {len(fuel):,} gas stations to {OUT_DIR}/")


if __name__ == "__main__":
    main(sys.argv[1:])
