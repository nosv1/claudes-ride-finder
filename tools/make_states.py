"""Write map/states.json: the lower 48 states' outlines, for the map to shade the states with roads.

From the US Census Bureau's cartographic boundary file (public domain), 1:5,000,000:
    https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_5m.zip

    python -I tools/make_states.py path/to/cb_2024_us_state_5m.shp map/states.json

Each state's id is its name the way Geofabrik spells it ("new-york"), so the app matches it to the regions in
tiles/index.js. Outlines are simplified to about 300 m and small islands dropped: they're drawn zoomed out.
"""
import json
import struct
import sys

SKIP = {'AK', 'HI', 'PR', 'VI', 'GU', 'MP', 'AS'}
TOLERANCE = 0.003      # degrees, about 300 m
MIN_AREA = 0.005       # square degrees: smaller islands are left out
MAX_RINGS = 10000      # sanity bound on rings in one state


def read_dbf(path):
    """The rows of a dBASE file, as dicts of stripped strings."""
    data = open(path, 'rb').read()
    count, header, size = struct.unpack('<IHH', data[4:12])
    fields, at = [], 32
    while data[at] != 0x0D:
        name = data[at:at + 11].split(b'\0')[0].decode('ascii')
        fields.append((name, data[at + 16]))
        at += 32
    rows = []
    for k in range(count):
        rec, pos, row = data[header + k * size + 1:header + (k + 1) * size], 0, {}
        for name, width in fields:
            row[name] = rec[pos:pos + width].decode('utf-8').strip()
            pos += width
        rows.append(row)
    return rows


def read_polygons(path):
    """Each record's rings, as lists of (lon, lat)."""
    data, at, out = open(path, 'rb').read(), 100, []
    while at < len(data):
        length = struct.unpack('>I', data[at + 4:at + 8])[0] * 2
        body = data[at + 8:at + 8 + length]
        assert struct.unpack('<i', body[:4])[0] == 5, 'not a polygon file'
        parts, points = struct.unpack('<ii', body[36:44])
        starts = list(struct.unpack(f'<{parts}i', body[44:44 + 4 * parts])) + [points]
        coords = struct.unpack(f'<{2 * points}d', body[44 + 4 * parts:44 + 4 * parts + 16 * points])
        pts = list(zip(coords[0::2], coords[1::2]))
        out.append([pts[starts[i]:starts[i + 1]] for i in range(parts)])
        at += 8 + length
    return out


def signed_area(ring):
    """Shoelace area: negative for the clockwise outer rings shapefiles use."""
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def simplify(pts, tol):
    """Douglas-Peucker, iterative (no recursion)."""
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        far, at = 0, -1
        for k in range(i + 1, j):
            d = abs(dy * (pts[k][0] - ax) - dx * (pts[k][1] - ay)) / norm
            if d > far:
                far, at = d, k
        if far > tol:
            keep.add(at)
            stack += [(i, at), (at, j)]
    return [pts[k] for k in sorted(keep)]


def polygons_of(rings):
    """GeoJSON MultiPolygon coordinates: each outer ring with the holes after it, small islands dropped."""
    assert len(rings) < MAX_RINGS
    polys = []
    for ring in rings:
        area = signed_area(ring)
        if abs(area) < MIN_AREA:
            continue
        # Split the closed ring in two so simplifying keeps at least four corners.
        half = len(ring) // 2
        small = simplify(ring[:half + 1], TOLERANCE)[:-1] + simplify(ring[half:], TOLERANCE)
        small = [[round(x, 4), round(y, 4)] for x, y in small]
        if area < 0:
            polys.append([small[::-1]])        # GeoJSON wants outer rings counterclockwise
        elif polys:
            polys[-1].append(small[::-1])      # a hole, clockwise
    return polys


def main(shp, out):
    rows, shapes = read_dbf(shp[:-4] + '.dbf'), read_polygons(shp)
    assert len(rows) == len(shapes), 'dbf and shp disagree'
    features = []
    for row, rings in sorted(zip(rows, shapes), key=lambda p: p[0]['NAME']):
        if row['STUSPS'] in SKIP:
            continue
        features.append({'type': 'Feature', 'properties': {'id': row['NAME'].lower().replace(' ', '-'), 'name': row['NAME']},
                         'geometry': {'type': 'MultiPolygon', 'coordinates': polygons_of(rings)}})
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    print(f'{len(features)} states -> {out}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
