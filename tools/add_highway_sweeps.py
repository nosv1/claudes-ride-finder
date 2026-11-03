"""Add highway sweeps to the tiles already built, without the raw OSM files.

Usage (from the repo root):  python tools/add_highway_sweeps.py

build_tiles.py does this itself on a full build; this reruns just that step on tiles/ (replacing any
highway sweeps there), so a change to the highway rules doesn't need the state downloads and an
11-minute rebuild. Everything it needs (limits, lanes, geometry of every 65+ highway) is in the tiles.
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
        for row in json.loads(read_js(path)):
            if not (row[1] in bt.HIGHWAY_TYPES and row[9]):  # drop the highway sweeps from a previous run
                tiles[key].append(row)

    index_text = open(os.path.join(bt.OUT_DIR, "index.js"), encoding="utf-8").read()
    index = json.loads(re.search(r"=\s*(\{.*\})", index_text, re.S).group(1))
    keep = {name: open(os.path.join(bt.OUT_DIR, name), encoding="utf-8").read()
            for name in ("fuel.js", "search.js", "signals.js") if os.path.exists(os.path.join(bt.OUT_DIR, name))}

    print(f"Highway sweeps: {bt.highway_sweeps(tiles):,}")
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
