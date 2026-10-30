#!/usr/bin/env python3
"""
make_icons.py — draws the Ludo app icons from code (same artwork as
src/ludo/LudoLogo.jsx), so they're reproducible and need no design file.

    pip install pillow
    python make_icons.py --out ../../public/ludo/icons

Outputs:
  icon-192.png / icon-512.png   "any" icons (Android install, PWA lists)
  icon-512-maskable.png         art shrunk into the maskable SAFE ZONE — Android
                                crops icons to a circle/squircle, and anything
                                outside the central ~80% can be cut off
  apple-touch-icon.png (180)    iOS home screen (iOS rounds the corners itself)
  favicon-32.png                browser tab
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

RED, GREEN, YELLOW, BLUE = (230, 57, 70), (45, 190, 122), (255, 201, 51), (58, 134, 255)
INK = (26, 18, 64)
BG_TOP, BG_BOTTOM = (38, 24, 96), (16, 10, 43)
BASE = 1024  # draw big, then downscale for clean edges


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    return img


def draw_art(scale):
    """Full-bleed gradient square with the Ludo board centred on it.
    `scale` is the size of the 100-unit art box relative to the canvas; the
    four yards span 12..88 of that box, so scale=1.0 leaves a 12% margin and
    scale=0.76 keeps everything inside the maskable safe circle."""
    img = vertical_gradient(BASE, BG_TOP, BG_BOTTOM).convert("RGBA")
    d = ImageDraw.Draw(img)
    side = BASE * scale
    ox = oy = (BASE - side) / 2
    u = side / 100.0

    def box(x, y, w, h):
        return [ox + x * u, oy + y * u, ox + (x + w) * u, oy + (y + h) * u]

    for (x, y, col) in [(12, 12, RED), (54, 12, GREEN), (54, 54, YELLOW), (12, 54, BLUE)]:
        d.rounded_rectangle(box(x, y, 34, 34), radius=9 * u, fill=col)
    d.rounded_rectangle(box(35, 35, 30, 30), radius=8 * u, fill=(255, 255, 255), outline=INK, width=max(2, int(3 * u)))
    for cx, cy in [(43, 43), (57, 43), (43, 50), (57, 50), (43, 57), (57, 57)]:
        r = 2.6 * u
        d.ellipse([ox + cx * u - r, oy + cy * u - r, ox + cx * u + r, oy + cy * u + r], fill=INK)
    return img


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).convert("RGB").save(path, "PNG", optimize=True)
    print(f"  {path.name:26s} {size}x{size}  {path.stat().st_size / 1024:5.1f} KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="icons")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    any_art = draw_art(1.0)
    maskable_art = draw_art(0.76)
    save(any_art, out / "icon-192.png", 192)
    save(any_art, out / "icon-512.png", 512)
    save(maskable_art, out / "icon-512-maskable.png", 512)
    save(any_art, out / "apple-touch-icon.png", 180)
    save(any_art, out / "favicon-32.png", 32)


if __name__ == "__main__":
    main()
