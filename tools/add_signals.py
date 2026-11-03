"""Write tiles/signals.js (every traffic light) from the state files, without a full rebuild.

Usage (from the repo root):  python tools/add_signals.py

Reads only the nodes of each raw/*.osm.pbf, so it takes a minute or two rather than the full build's 11.
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
    lights = []
    for path in paths:
        print(f"Reading {path}...", flush=True)
        bt.Lights(lights).apply_file(path)
    print(f"Traffic lights: {bt.write_signals(lights):,}")


if __name__ == "__main__":
    main(sys.argv[1:])
