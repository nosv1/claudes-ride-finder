"""Draw the app icon (same design as favicon.svg) as PNGs for phones and the installable app.

Run from the repo root:  python tools/make_icons.py
"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (20, 22, 28, 255)
STOPS = [(0, (0x22, 0xd3, 0xee)), (0.55, (0xf5, 0x9f, 0x1b)), (1, (0xe0, 0x40, 0xfb))]


def bezier(p0, p1, p2, p3, n=200):
    for i in range(n + 1):
        t = i / n
        yield tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * e
                    for a, b, c, e in zip(p0, p1, p2, p3))


def line(p0, p1, n=40):
    for i in range(n + 1):
        t = i / n
        yield tuple(a + (b - a) * t for a, b in zip(p0, p1))


def color(y):
    """The road's gradient runs bottom (cyan) to top (pink) over the road's own height, y=58 to y=6."""
    t = (58 - y) / 52
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def draw(size, inset=0.0):
    """inset shrinks the road toward the centre, for maskable icons that get cropped to a circle."""
    big = size * 4
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = 0 if inset else int(14 / 64 * big)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BG)
    k = big / 64 * (1 - 2 * inset)
    off = big * inset
    # favicon.svg: "M18 58 V50 C18 42 46 46 46 38 S18 34 18 26 S46 22 46 14 V6" (each S mirrors the last control point)
    pts = (list(line((18, 58), (18, 50))) + list(bezier((18, 50), (18, 42), (46, 46), (46, 38)))
           + list(bezier((46, 38), (46, 30), (18, 34), (18, 26))) + list(bezier((18, 26), (18, 18), (46, 22), (46, 14)))
           + list(line((46, 14), (46, 6))))
    r = 4.5 * k
    for x, y in pts:
        d.ellipse([off + x * k - r, off + y * k - r, off + x * k + r, off + y * k + r], fill=color(y))
    # Centre-line dashes: stamp small dots along the "on" stretches so the ends are round and the edges smooth
    dist, on, r = 0.0, True, 0.8 * k
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if on:
            d.ellipse([off + x0 * k - r, off + y0 * k - r, off + x0 * k + r, off + y0 * k + r], fill=BG)
        dist += math.hypot(x1 - x0, y1 - y0)
        if dist >= 3.5:
            dist, on = 0.0, not on
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "icons"), exist_ok=True)
    draw(180).save(os.path.join(ROOT, "apple-touch-icon.png"))
    draw(192).save(os.path.join(ROOT, "icons", "icon-192.png"))
    draw(512, inset=0.1).save(os.path.join(ROOT, "icons", "icon-512.png"))
    print("icons written")
