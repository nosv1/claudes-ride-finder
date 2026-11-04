"""Measure hills on the straight back roads already in the tiles, to find the roller coasters, without the raw OSM files.

Usage (from the repo root):  python tools/add_hills.py

build_tiles.py does this itself on a full build, for every straight back road. The built tiles only hold the
straight roads that have a posted limit (the rest are dropped at build time), so this finds the roller coasters
among those; a full rebuild adds the unposted ones (most county roads). Downloads the elevation tiles it needs
into raw/terrain/ once, like the build. Rows already measured are left as they are.
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import build_tiles as bt  # noqa: E402


def read_js(path):
    text = open(path, encoding="utf-8").read()
    return text[text.index(",") + 1: text.rindex(")")]


def main():
    tiles = defaultdict(list)
    for path in sorted(glob.glob(os.path.join(bt.OUT_DIR, "*_*.js"))):
        key = os.path.basename(path)[:-3].removesuffix(".s")
        tiles[key].extend(json.loads(read_js(path)))

    todo = [row for rows in tiles.values() for row in rows if bt.roller_candidate(row) and row[12] is None]
    needed = set()
    for row in todo:
        needed |= bt.terrain_tiles_for(bt.decode(row[11]))
    bt.download_terrain(needed)
    print(f"Measuring hills on {len(todo):,} straight back roads...", flush=True)
    elev = bt.Elevation()
    for i, row in enumerate(todo, 1):
        row[12], row[13] = bt.hills_and_blind(bt.decode(row[11]), elev)
        if i % 2000 == 0:
            print(f"  {i:,}/{len(todo):,}", flush=True)
    print(f"Roller coasters: {sum(bt.is_roller(r) for rows in tiles.values() for r in rows):,}")

    index_text = open(os.path.join(bt.OUT_DIR, "index.js"), encoding="utf-8").read()
    index = json.loads(re.search(r"=\s*(\{.*\})", index_text, re.S).group(1))
    keep = {name: open(os.path.join(bt.OUT_DIR, name), encoding="utf-8").read()
            for name in ("fuel.js", "search.js", "signals.js") if os.path.exists(os.path.join(bt.OUT_DIR, name))}
    bt.write_tiles(tiles, index["regions"])

    # write_tiles starts tiles/ from scratch: put back the gas stations, search index and traffic lights, and keep the date
    # the OSM data is from.
    for name, text in keep.items():
        with open(os.path.join(bt.OUT_DIR, name), "w", encoding="utf-8") as f:
            f.write(text)
    path = os.path.join(bt.OUT_DIR, "index.js")
    new = json.loads(re.search(r"=\s*(\{.*\})", open(path, encoding="utf-8").read(), re.S).group(1))
    new["built"] = index["built"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("window.TILE_INDEX = " + json.dumps(new) + ";\n")


if __name__ == "__main__":
    main()
