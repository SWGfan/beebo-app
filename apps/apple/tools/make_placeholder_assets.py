#!/usr/bin/env python3
"""Regenerates the PLACEHOLDER app icons and launch/top-shelf art for the Apple client.

Pure standard library (zlib + struct), so it runs anywhere. The artwork is deliberately plain:
a designer replaces the PNGs (keep the file names and pixel sizes) before App Store submission.

    python tools/make_placeholder_assets.py
"""
import json
import os
import struct
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BRAND = (0x1F, 0x3A, 0x8A)
BRAND_LIGHT = (0x4C, 0x7B, 0xF0)
WHITE = (255, 255, 255)


def png_bytes(width, height, pixel_fn, alpha):
    channels = 4 if alpha else 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            px = pixel_fn(x, y)
            raw.extend(px[:channels])
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def solid(color):
    return lambda x, y: (color[0], color[1], color[2], 255)


def circle(width, height, color, radius_fraction):
    cx, cy = width / 2.0, height / 2.0
    r = min(width, height) * radius_fraction
    r2 = r * r
    def fn(x, y):
        if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
            return (color[0], color[1], color[2], 255)
        return (0, 0, 0, 0)
    return fn


def bar(width, height, color):
    x0, x1 = width * 0.44, width * 0.56
    y0, y1 = height * 0.32, height * 0.68
    def fn(x, y):
        if x0 <= x <= x1 and y0 <= y <= y1:
            return (color[0], color[1], color[2], 255)
        return (0, 0, 0, 0)
    return fn


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="\n") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")


INFO = {"author": "xcode", "version": 1}


def color_set(base):
    write_json(os.path.join(base, "AccentColor.colorset", "Contents.json"), {
        "colors": [{
            "color": {"color-space": "srgb", "components": {"red": "0.298", "green": "0.482", "blue": "0.941", "alpha": "1.000"}},
            "idiom": "universal",
        }],
        "info": INFO,
    })


def ios(base):
    write_json(os.path.join(base, "Contents.json"), {"info": INFO})
    color_set(base)
    icon = os.path.join(base, "AppIcon.appiconset")
    def pixel(x, y):
        return solid(BRAND)(x, y)
    size = 1024
    circ = circle(size, size, BRAND_LIGHT, 0.32)
    b = bar(size, size, WHITE)
    def fn(x, y):
        p = b(x, y)
        if p[3]:
            return p
        c = circ(x, y)
        if c[3]:
            return c
        return (BRAND[0], BRAND[1], BRAND[2], 255)
    write(os.path.join(icon, "icon-1024.png"), png_bytes(size, size, fn, alpha=False))
    write_json(os.path.join(icon, "Contents.json"), {
        "images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": INFO,
    })


def layer(stack, name, w, h, scales, pixel_fn, alpha):
    layer_dir = os.path.join(stack, name + ".imagestacklayer")
    write_json(os.path.join(layer_dir, "Contents.json"), {"info": INFO})
    imageset = os.path.join(layer_dir, "Content.imageset")
    images = []
    for scale in scales:
        filename = "%s-%dx.png" % (name.lower(), scale)
        write(os.path.join(imageset, filename), png_bytes(w * scale, h * scale, pixel_fn, alpha))
        images.append({"filename": filename, "idiom": "tv", "scale": "%dx" % scale})
    write_json(os.path.join(imageset, "Contents.json"), {"images": images, "info": INFO})


def stack(base, name, w, h, scales):
    d = os.path.join(base, name + ".imagestack")
    write_json(os.path.join(d, "Contents.json"), {
        "layers": [{"filename": "Front.imagestacklayer"}, {"filename": "Middle.imagestacklayer"}, {"filename": "Back.imagestacklayer"}],
        "info": INFO,
    })
    layer(d, "Back", w, h, scales, solid(BRAND), alpha=False)
    layer(d, "Middle", w, h, scales, circle(w, h, BRAND_LIGHT, 0.30), alpha=True)
    layer(d, "Front", w, h, scales, bar(w, h, WHITE), alpha=True)


def shelf(base, name, w, h, scales):
    d = os.path.join(base, name + ".imageset")
    images = []
    for scale in scales:
        filename = "%s-%dx.png" % (name.replace(" ", "-").lower(), scale)
        write(os.path.join(d, filename), png_bytes(w * scale, h * scale, solid(BRAND), alpha=False))
        images.append({"filename": filename, "idiom": "tv", "scale": "%dx" % scale})
    write_json(os.path.join(d, "Contents.json"), {"images": images, "info": INFO})


def tvos(base):
    write_json(os.path.join(base, "Contents.json"), {"info": INFO})
    color_set(base)
    brand = os.path.join(base, "App Icon & Top Shelf Image.brandassets")
    stack(brand, "App Icon - Large", 1280, 768, [1])
    stack(brand, "App Icon - Small", 400, 240, [1, 2])
    shelf(brand, "Top Shelf Image", 1920, 720, [1])
    shelf(brand, "Top Shelf Image Wide", 2320, 720, [1])
    write_json(os.path.join(brand, "Contents.json"), {
        "assets": [
            {"filename": "App Icon - Large.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"},
            {"filename": "App Icon - Small.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"},
            {"filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"},
            {"filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"},
        ],
        "info": INFO,
    })


if __name__ == "__main__":
    ios(os.path.join(ROOT, "App", "iOS", "Assets.xcassets"))
    tvos(os.path.join(ROOT, "App", "tvOS", "Assets.xcassets"))
    print("placeholder assets written under", ROOT)
