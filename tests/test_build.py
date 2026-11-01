"""Tests for build_tiles.py: road scoring, speed/surface rules, fuel, elevation, search index.

Run from the repo root:  python -m unittest discover tests
"""
import glob
import json
import math
import os
import sys
import unittest
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import build_tiles as bt  # noqa: E402

LAT0, LON0 = 38.5, -93.0
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540


def to_latlon(xy):
    """Local metres (x east, y north) around a fixed point -> (lat, lon)."""
    return [(LAT0 + y / KY, LON0 + x / KX) for x, y in xy]


def line(x0, y0, x1, y1, step=5):
    n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
    return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]


def arc(cx, cy, r, a0, a1, step=5):
    n = max(2, int(abs(a1 - a0) * r / step))
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def hairpins(r=40, count=6):
    """A road of alternating semicircles of radius r heading north."""
    pts = []
    for k in range(count):
        cy = k * 2 * r
        a0, a1 = (-math.pi / 2, math.pi / 2) if k % 2 == 0 else (3 * math.pi / 2, math.pi / 2)
        pts += arc(0, cy + r, r, a0, a1)[1 if pts else 0:]
    return pts


class FakeElevation:
    """Stands in for bt.Elevation: elevation from a function of local metres."""

    def __init__(self, fn):
        self.fn = fn

    def at(self, lat, lon):
        return self.fn((lon - LON0) * KX, (lat - LAT0) * KY)


class TestCurvature(unittest.TestCase):
    def test_straight_road_scores_nothing(self):
        length, score, curvy, sweep = bt.analyze(to_latlon(line(0, 0, 0, 2000)))
        self.assertAlmostEqual(length, 2000, delta=5)
        self.assertEqual((score, curvy, sweep), (0, 0, 0))

    def test_hairpins_score_as_curvy(self):
        length, score, curvy, _ = bt.analyze(to_latlon(hairpins()))
        self.assertGreaterEqual(score, bt.MIN_SCORE)
        self.assertGreater(score / length, 0.9, "tight hairpins should reach the Twisty bin")

    def test_wide_curve_is_a_sweeper_not_a_twisty(self):
        # 500 m straight, a 90° bend of radius 300 m, 500 m straight.
        pts = line(0, 0, 0, 500) + arc(300, 500, 300, math.pi, math.pi / 2)[1:] + line(300, 800, 800, 800)[1:]
        _, score, _, sweep = bt.analyze(to_latlon(pts))
        self.assertEqual(score, 0, "a 300 m radius is too wide for the tight-curve score")
        self.assertGreaterEqual(sweep, bt.MIN_SWEEP)

    def test_radius_weights(self):
        self.assertEqual(bt.radius_weight(20), 2.0)
        self.assertEqual(bt.radius_weight(50), 1.6)
        self.assertEqual(bt.radius_weight(80), 1.3)
        self.assertEqual(bt.radius_weight(150), 1.0)
        self.assertEqual(bt.radius_weight(500), 0.0)


class TestRamps(unittest.TestCase):
    def test_wide_flyover_counts_but_a_cloverleaf_loop_is_tight(self):
        flyover = line(0, 0, 0, 300) + arc(800, 300, 800, math.pi, math.pi * 0.75)[1:]  # 800 m radius, ~630 m of curve
        self.assertGreaterEqual(bt.ramp_sweep(to_latlon(flyover)), bt.MIN_SWEEP)
        self.assertEqual(bt.analyze(to_latlon(flyover))[3], 0, "too wide for the back-road sweeper range")
        loop = arc(0, 60, 60, -math.pi / 2, math.pi)  # 270° cloverleaf loop, radius 60 m
        _, _, tight, _ = bt.analyze(to_latlon(loop))
        self.assertGreater(tight, 0.5 * bt.ramp_sweep(to_latlon(loop)), "the app's rule: mostly tight means not a fast ramp")


    def joined(self, signals=(), crossing=None):
        """Two ramp pieces meeting at node 11; the ids of the rows they become."""
        h = bt.Roads(defaultdict(list), set(), defaultdict(int), {}, {}, {10, 11, 12})
        tags = {"highway": "motorway_link"}
        h.ramp_ways = {1: (10, 11, to_latlon(line(0, 0, 0, 200)), tags, 45),
                       2: (11, 12, to_latlon(line(0, 200, 0, 400)), tags, 45)}
        h.signals = set(signals)
        h.crossing.update(crossing or {})
        h.finish_ramps()
        return sorted(row[0] for rows in h.tiles.values() for row in rows)

    def test_pieces_join_where_nothing_else_meets(self):
        self.assertEqual(self.joined(), [1])

    def test_not_joined_across_a_stop_light_or_a_crossroad(self):
        # MO-291 at MO-150: the off-ramp and on-ramp met at the signalled crossroad and became one "fast ramp".
        self.assertEqual(self.joined(signals={11}), [1, 2])
        self.assertEqual(self.joined(crossing={11: 2}), [1, 2])

    def test_joined_past_a_road_that_only_forks_off(self):
        # US 63 at MO 763 (Columbia): MO 763 starts where the ramp carries on.
        self.assertEqual(self.joined(crossing={11: 1}), [1])


class TestSpeedAndSurface(unittest.TestCase):
    def test_parse_mph(self):
        self.assertEqual(bt.parse_mph("45 mph"), 45)
        self.assertEqual(bt.parse_mph("45"), 45, "bare numbers are mph in US data")
        self.assertEqual(bt.parse_mph("80 km/h"), 50)
        self.assertEqual(bt.parse_mph("55 mph;45 mph"), 55)
        self.assertIsNone(bt.parse_mph("signals"))
        self.assertIsNone(bt.parse_mph(None))

    def test_speed_falls_back_to_directional_limits(self):
        self.assertEqual(bt.speed_of({"maxspeed:forward": "45 mph", "maxspeed:backward": "35 mph"}), 45)
        self.assertIsNone(bt.speed_of({"highway": "tertiary"}))

    def test_surface(self):
        self.assertEqual(bt.surface_of({"highway": "tertiary", "surface": "asphalt"}), 0)
        self.assertEqual(bt.surface_of({"highway": "unclassified", "surface": "gravel"}), 1)
        self.assertEqual(bt.surface_of({"highway": "unclassified", "tracktype": "grade3"}), 1)
        self.assertEqual(bt.surface_of({"highway": "unclassified"}), 2, "county road, surface unknown")
        self.assertEqual(bt.surface_of({"highway": "secondary"}), 0, "state routes are assumed paved")

    def test_estimated_limits(self):
        residential = defaultdict(int)
        town = (39.0, -94.4)
        residential[bt.cell_of(*town)] = bt.URBAN_STREETS
        self.assertEqual(bt.estimate_mph([0, "tertiary", town], residential), 30)
        self.assertEqual(bt.estimate_mph([0, "tertiary", (38.0, -92.0)], residential), 55)
        self.assertEqual(bt.estimate_mph([0, "unclassified", (38.0, -92.0)], residential), 45)


class TestFuel(unittest.TestCase):
    def test_octane_status(self):
        self.assertEqual(bt.octane_status({"fuel:octane_91": "yes"}), bt.FUEL_YES)
        self.assertEqual(bt.octane_status({"fuel:premium": "yes"}), bt.FUEL_YES)
        self.assertEqual(bt.octane_status({"fuel:octane_91": "no", "brand": "Shell"}), bt.FUEL_NO)
        self.assertEqual(bt.octane_status({"brand": "Casey's General Store"}), bt.FUEL_LIKELY)
        self.assertEqual(bt.octane_status({"fuel:octane_98": "no", "brand": "BP"}), bt.FUEL_LIKELY,
                         "European grades marked 'no' don't mean no premium")
        self.assertEqual(bt.octane_status({"name": "Joe's Gas"}), bt.FUEL_UNKNOWN)

    def test_diesel_islands_are_not_gas_stations(self):
        self.assertTrue(bt.is_gas_station({"amenity": "fuel", "name": "Casey's"}))
        self.assertFalse(bt.is_gas_station({"amenity": "fuel", "name": "BreakTime Diesel Pumps"}))
        self.assertFalse(bt.is_gas_station({"amenity": "fuel", "fuel:octane_87": "no"}))
        self.assertFalse(bt.is_gas_station({"amenity": "parking"}))

    def test_station_label_includes_brand_once(self):
        self.assertEqual(bt.fuel_row({"name": "Hwy 6 Stop", "brand": "Amoco"}, 38, -93)[2], "Hwy 6 Stop (Amoco)")
        self.assertEqual(bt.fuel_row({"name": "Casey's", "brand": "Casey's"}, 38, -93)[2], "Casey's")
        self.assertEqual(bt.fuel_row({}, 38, -93)[2], "Gas station")


class TestElevation(unittest.TestCase):
    def test_flat_road(self):
        hill, blind = bt.hills_and_blind(to_latlon(line(0, 0, 0, 2000)), FakeElevation(lambda x, y: 250))
        self.assertEqual(hill, 0)
        self.assertEqual(blind, [])

    def test_rolling_road_reads_as_hilly(self):
        roller = FakeElevation(lambda x, y: 250 + 10 * math.sin(y / 400 * 2 * math.pi))
        hill, _ = bt.hills_and_blind(to_latlon(line(0, 0, 0, 2000)), roller)
        self.assertGreater(hill, 22)

    def test_tight_turn_on_a_crest_is_blind(self):
        # North 300 m, a 90° right turn of radius 40 m, east 300 m; the hilltop is at the turn.
        pts = line(0, 0, 0, 300) + arc(40, 300, 40, math.pi, math.pi / 2)[1:] + line(40, 340, 340, 340)[1:]
        hump = FakeElevation(lambda x, y: 250 + 12 * math.exp(-(x ** 2 + (y - 320) ** 2) / 120 ** 2))
        _, blind = bt.hills_and_blind(to_latlon(pts), hump)
        self.assertEqual(len(blind), 2, "one crest, one flag (a lat/lon pair)")

    def test_crest_on_a_straight_is_not_a_blind_corner(self):
        hump = FakeElevation(lambda x, y: 250 + 12 * math.exp(-((y - 300) ** 2) / 120 ** 2))
        _, blind = bt.hills_and_blind(to_latlon(line(0, 0, 0, 600)), hump)
        self.assertEqual(blind, [])

    def test_missing_elevation_gives_no_rating(self):
        hill, blind = bt.hills_and_blind(to_latlon(line(0, 0, 0, 600)), FakeElevation(lambda x, y: None))
        self.assertIsNone(hill)
        self.assertEqual(blind, [])


class TestEncoding(unittest.TestCase):
    def test_round_trip(self):
        coords = [(38.12345, -93.54321), (38.12401, -93.54011), (38.2, -93.5)]
        self.assertEqual(bt.decode(bt.encode(coords)), coords)


class TestSearchIndex(unittest.TestCase):
    @staticmethod
    def row(ref, name, xy, curvy=2000):
        # Only the fields road_index reads: name, ref, score, curvy, sweep, coords.
        r = [0] * 14
        r[2], r[3], r[7], r[8], r[9], r[11] = name, ref, 500, curvy, 0, bt.encode(to_latlon(xy))
        return r

    def test_same_ref_far_apart_is_two_stretches(self):
        tiles = {"t": [self.row("MO Y", "", line(0, 0, 0, 1000)), self.row("MO Y", "", line(50000, 0, 50000, 1000))]}
        self.assertEqual(len(bt.road_index(tiles, [])), 2)

    def test_nearby_pieces_join_and_name_nearest_town(self):
        places = [["Roach", LAT0, LON0, "village"], ["Far Town", LAT0 + 1, LON0, "town"]]
        tiles = {"t": [self.row("MO Y", "Lake Road", line(0, 0, 0, 1000)),
                       self.row("MO Y", "Lake Road", line(0, 1500, 0, 2500))]}
        (entry,) = bt.road_index(tiles, places)
        key, name, *_, curves, town = entry
        self.assertEqual((key, name, curves, town), ("MO Y", "Lake Road", 4000, "Roach"))

    def test_short_stretches_are_left_out(self):
        tiles = {"t": [self.row("MO Z", "", line(0, 0, 0, 500), curvy=300)]}
        self.assertEqual(bt.road_index(tiles, []), [])


TILES = os.path.join(ROOT, "tiles")


@unittest.skipUnless(os.path.exists(os.path.join(TILES, "index.js")), "no built tiles; run build_tiles.py")
class TestBuiltData(unittest.TestCase):
    @staticmethod
    def load(path, start, end):
        s = open(path, encoding="utf-8").read()
        return json.loads(s[s.index(start):s.rindex(end) + 1])

    @staticmethod
    def load_tile(key):
        s = open(os.path.join(TILES, f"{key}.js"), encoding="utf-8").read()  # addTile("key", rows);
        return json.loads(s[s.index(",") + 1:s.rindex(")")])

    def test_index_matches_tile_files(self):
        index = self.load(os.path.join(TILES, "index.js"), "{", "}")
        files = {os.path.basename(p)[:-3] for p in glob.glob(os.path.join(TILES, "*_*.js"))}
        self.assertEqual(set(index["tiles"]), files)

    def test_rows_have_the_expected_shape(self):
        rows = self.load_tile("-189_77")
        for r in rows[:200]:
            self.assertEqual(len(r), 15)
            self.assertIn(r[6], (0, 1, 2))
            self.assertTrue(r[4] is not None or r[5] is not None, "every road has a posted or estimated limit")

    def test_mo150_east_of_lees_summit_is_a_fast_sweeper(self):
        # The rider's reference road: 55 mph sweepers that the first curve score missed entirely.
        rows = self.load_tile("-189_77")
        (mo150,) = [r for r in rows if r[0] == 18518688]
        self.assertEqual(mo150[3], "MO 150")
        self.assertGreaterEqual(mo150[9], 800, "must pass the app's sweeper rule")
        self.assertEqual(mo150[4] if mo150[4] is not None else mo150[5], 55)

    def test_fuel_and_search_files(self):
        fuel = self.load(os.path.join(TILES, "fuel.js"), "[", "]")
        self.assertGreater(len(fuel), 1000)
        self.assertFalse(any("diesel" in f[2].lower() for f in fuel))
        search = self.load(os.path.join(TILES, "search.js"), "{", "}")
        self.assertTrue(any(p[0] == "Camdenton" for p in search["places"]))
        self.assertTrue(any(r[0] == "MO 150" for r in search["roads"]))


if __name__ == "__main__":
    unittest.main()
