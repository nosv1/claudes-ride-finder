"""Write tiles/breaks.js (break spots: local food, parks, lookouts, waterfalls, historic spots) from the state files,
without a full rebuild.

Usage (from the repo root):  python tools/add_breaks.py

build_tiles.py writes the same file on a full build.
"""
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import build_tiles as bt  # noqa: E402


def main(args):
    paths = sorted({p for a in (args or ["raw/*.osm.pbf"]) for p in glob.glob(a)})
    if not paths:
        sys.exit("No .osm.pbf files found in raw/.\n" + bt.__doc__)
    spots = []
    for path in paths:
        print(f"Reading {path}...", flush=True)
        bt.Breaks(spots).apply_file(path, locations=True, idx="flex_mem")
    print(f"Break spots: {bt.write_breaks(spots):,}")


if __name__ == "__main__":
    main(sys.argv[1:])
