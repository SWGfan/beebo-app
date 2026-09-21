#!/usr/bin/env python3
"""
scene_anim.py — gentle, bedtime-appropriate looping background animations for
BeeboBook storybook pages.

Each static page scene (built by scene_art.py) is turned into a small, calm,
seamlessly-looping GIF. The base illustration is kept perfectly still so the
characters and foreground never wobble; all motion lives in a soft overlay
chosen from the page's theme:

    night / space  -> stars twinkling (+ a slow moon-glow pulse when there's a moon)
    dusk           -> a few faint magical sparkles up high
    jungle         -> drifting firefly glimmers
    sea            -> bubbles rising + a very gentle whole-scene float/bob
    day / sunset   -> clouds drifting a few pixels across the upper sky

Everything is deliberately subtle (a few px of motion, soft opacity breathing)
and loops seamlessly (frame N blends back into frame 0 via periodic sine phases
or wrap-around translation).

scene_art.py is imported READ-ONLY (motif builders + book_theme reused). This
module never modifies it.

CLI:
    python scene_anim.py --slug space          # one book
    python scene_anim.py --all                  # every book
    python scene_anim.py --slug underwater --page 3
"""

import argparse
import hashlib
import io
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import cairosvg
import scene_art  # read-only reuse of motifs + book_theme

ROOT = Path(__file__).resolve().parent
SCENES_DIR = ROOT / "scenes_out"
OUT_DIR = ROOT / "anim_out"

# Output geometry: static scenes are 1200x1600 (portrait, 3:4). We downscale to
# keep GIF weight low while matching the aspect exactly.
SRC_W, SRC_H = scene_art.W, scene_art.H            # 1200 x 1600
OUT_W, OUT_H = 468, 624                             # 0.39x, 3:4
SCALE = OUT_W / SRC_W

# Animation defaults: modest frame count + a slow, calm cadence.
FRAMES = 18
FPS = 9                                             # -> ~111ms/frame, 2s loop
GIF_COLORS = 64


# ------------------------------------------------------------------ book data
_BOOK_CACHE = {}


def _book_path(slug):
    for p in (ROOT / "newbooks" / f"{slug}.json", ROOT / f"{slug}.json"):
        if p.exists():
            return p
    return None


def load_book(slug):
    """Return (pages: {id_str: text}, characters: list) for a slug, or None."""
    if slug in _BOOK_CACHE:
        return _BOOK_CACHE[slug]
    p = _book_path(slug)
    if not p:
        _BOOK_CACHE[slug] = None
        return None
    d = json.load(open(p))
    pages = {str(x["id"]): x.get("text", "") for x in d.get("pages", [])}
    chars = d.get("characters", [])
    _BOOK_CACHE[slug] = (pages, chars)
    return _BOOK_CACHE[slug]


def discover_slugs():
    """Books that have both a template JSON and a rendered scene dir."""
    slugs = []
    for d in sorted(SCENES_DIR.iterdir()):
        if d.is_dir() and _book_path(d.name):
            slugs.append(d.name)
    return slugs


# ---------------------------------------------------------------- base raster
def render_base(slug, page_id, characters, suppress=()):
    """Rasterize the static scene at OUT size. Returns (image, hints).

    `suppress` lets the animator omit static falling weather from the base so the
    overlay can own that motion (no doubled rain/snow)."""
    pages, _ = load_book(slug) or ({}, [])
    text = pages.get(str(page_id), "")
    svg, hints = scene_art.compose_scene(slug, text, str(page_id),
                                         characters=characters, suppress=suppress)
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                           output_width=OUT_W, output_height=OUT_H)
    return Image.open(io.BytesIO(png)).convert("RGB"), hints


# ------------------------------------------------------------------- effects
# Overlays are computed in numpy float32 [0..255]. `screen` blends a soft glow
# onto the base without darkening; `over` alpha-composites.

def _screen(base, add):
    # base, add: float arrays HxWx3 in 0..255
    return 255.0 - (255.0 - base) * (255.0 - add) / 255.0


def _soft_disc(radius):
    """A radial falloff sprite (0..1), smooth to the edge — a soft glow dot."""
    r = int(math.ceil(radius))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1].astype(np.float32)
    d = np.sqrt(xx * xx + yy * yy) / max(radius, 1e-3)
    s = np.clip(1.0 - d, 0.0, 1.0)
    return s * s * (3 - 2 * s)  # smoothstep


def _stamp(canvas, sprite, cx, cy, color, amp):
    """Add sprite*color*amp onto canvas (HxWx3) centered at cx,cy (screen-add)."""
    if amp <= 0:
        return
    h, w = canvas.shape[:2]
    sh, sw = sprite.shape
    x0 = int(round(cx - sw / 2)); y0 = int(round(cy - sh / 2))
    x1, y1 = x0 + sw, y0 + sh
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(w, x1), min(h, y1)
    if cx0 >= cx1 or cy0 >= cy1:
        return
    sub = sprite[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0][..., None]
    add = sub * (np.array(color, np.float32) * amp)
    region = canvas[cy0:cy1, cx0:cx1]
    canvas[cy0:cy1, cx0:cx1] = 255.0 - (255.0 - region) * (255.0 - add) / 255.0


def _seed(slug, page_id):
    return int(hashlib.md5(f"anim-{slug}-{page_id}".encode()).hexdigest(), 16)


def fx_twinkle(base, slug, page_id, t, *, count, region, colors,
               rmin, rmax, base_amp, moon=False):
    """Stars gently fading in and out. `t` in [0,1) — seamless via sine phase."""
    rnd = random.Random(_seed(slug, page_id))
    x0, y0, x1, y1 = region
    canvas = np.array(base, np.float32)
    for _ in range(count):
        x = rnd.uniform(x0, x1) * OUT_W
        y = rnd.uniform(y0, y1) * OUT_H
        rad = rnd.uniform(rmin, rmax)
        phase = rnd.random()
        col = colors[rnd.randrange(len(colors))]
        # opacity breathes; stays >=0 so it never fully vanishes harshly
        amp = base_amp * (0.5 + 0.5 * math.sin(2 * math.pi * (t + phase)))
        _stamp(canvas, _soft_disc(rad), x, y, col, amp)
    if moon:
        # slow glow pulse around the moon (scene_art draws it near 950,300/1200)
        mx, my = 950 * SCALE, 300 * SCALE
        pulse = 0.35 + 0.20 * math.sin(2 * math.pi * t)  # gentle, always-on
        _stamp(canvas, _soft_disc(120 * SCALE), mx, my, (255, 250, 210), pulse)
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))


def _cloud_strip(seed, tile_w, band_h, n=3):
    """Render a transparent horizontal strip of soft clouds (reuses scene_art)."""
    rnd = random.Random(seed)
    parts = []
    for _ in range(n):
        cx = rnd.uniform(0, tile_w)
        cy = rnd.uniform(band_h * 0.30, band_h * 0.72)
        s = rnd.uniform(0.7, 1.1)
        parts.append(scene_art.m_cloud(cx, cy, s, "#ffffff"))
    body = "".join(parts)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{tile_w:.0f}" '
           f'height="{band_h:.0f}" viewBox="0 0 {tile_w:.0f} {band_h:.0f}">'
           f'<g opacity="0.55">{body}</g></svg>')
    ow = int(tile_w * SCALE)
    oh = int(band_h * SCALE)
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                           output_width=ow, output_height=oh)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def fx_clouds(base, strip, t):
    """Drift a wrap-around cloud strip a few pixels across the upper sky."""
    frame = base.copy()
    sw = strip.width
    # total drift across the loop = one tile width, so it wraps seamlessly
    off = int((t * sw)) % sw
    y = int(OUT_H * 0.05)
    # paste twice for seamless wrap
    frame.paste(strip, (-off, y), strip)
    frame.paste(strip, (sw - off, y), strip)
    frame.paste(strip, (-off - sw, y), strip)
    return frame


def fx_bubbles(base, slug, page_id, t, *, region, count):
    """Bubbles rising and wrapping — plus the caller adds a gentle bob."""
    rnd = random.Random(_seed(slug, page_id) ^ 0x9e3779b9)
    x0, y0, x1, y1 = region
    span = (y1 - y0) * OUT_H
    canvas = np.array(base, np.float32)
    for _ in range(count):
        x = rnd.uniform(x0, x1) * OUT_W
        rad = rnd.uniform(2.0, 5.0)
        start = rnd.random()
        drift = rnd.uniform(-6, 6)
        prog = (t + start) % 1.0
        y = y0 * OUT_H + (1.0 - prog) * span
        xx = x + math.sin(2 * math.pi * (t + start)) * drift
        # fade in at the bottom, out at the top, so wrap is invisible
        edge = min(prog, 1 - prog) * 2.0
        amp = 0.5 * min(1.0, edge * 1.6)
        _stamp(canvas, _soft_disc(rad), xx, y, (235, 250, 255), amp)
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))


def _bob(img, dy):
    """Shift the whole frame vertically by dy px, edge-clamped (no gap)."""
    if dy == 0:
        return img
    a = np.array(img)
    out = np.empty_like(a)
    if dy > 0:
        out[dy:] = a[:-dy]; out[:dy] = a[0]
    else:
        out[:dy] = a[-dy:]; out[dy:] = a[-1]
    return Image.fromarray(out)


# ------------------------------------------------- additive motif effects
# Each factory returns a closure `apply(img, t) -> img` that composites one calm,
# seamlessly-looping motion onto a frame. `t` in [0,1). They stack, so a campfire
# night page can twinkle its stars AND flicker its fire AND pulse a lantern.

def _np(img):
    return np.array(img, np.float32)


def _img(arr):
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def fire_effect(slug, page_id, fx, fy, fs):
    """Flickering warm glow + shimmering flame tips over the drawn campfire."""
    cx = fx * SCALE
    base_y = (fy - 6 * fs) * SCALE
    rnd = random.Random(_seed(slug, page_id) ^ 0xF12E ^ int(fx))
    ph = [rnd.random() for _ in range(4)]
    glow_r = 78 * fs * SCALE
    core_r = 30 * fs * SCALE
    tip_r = 13 * fs * SCALE

    def apply(img, t):
        c = _np(img)
        two = 2 * math.pi
        fl = (0.5 + 0.30 * math.sin(two * (t + ph[0]))
              + 0.20 * math.sin(two * (2 * t + ph[1])))
        fl = max(0.0, min(1.0, fl))
        _stamp(c, _soft_disc(glow_r), cx, (fy - 58 * fs) * SCALE, (255, 150, 45), 0.16 + 0.14 * fl)
        _stamp(c, _soft_disc(core_r), cx, base_y - 66 * fs * SCALE, (255, 214, 90), 0.40 + 0.32 * fl)
        for k in range(3):
            jy = math.sin(two * (t + ph[k + 1])) * (7 * fs * SCALE)
            _stamp(c, _soft_disc(tip_r), cx + (k - 1) * 15 * fs * SCALE,
                   base_y - 92 * fs * SCALE + jy, (255, 185, 65), 0.28 + 0.30 * fl)
        return _img(c)
    return apply


def glow_effect(lx, ly, color=(255, 210, 120), radius=64.0, amp=0.30, swing=0.16):
    """A soft warm lamp/lantern glow that breathes."""
    cx, cy = lx * SCALE, ly * SCALE
    r = radius * SCALE

    def apply(img, t):
        c = _np(img)
        p = amp + swing * math.sin(2 * math.pi * t)
        _stamp(c, _soft_disc(r), cx, cy, color, max(0.0, p))
        return _img(c)
    return apply


def ripple_effect(slug, page_id, water_y):
    """Gentle drifting shimmer + tiny bob on a land pond, below the characters."""
    y0 = water_y * SCALE
    rnd = random.Random(_seed(slug, page_id) ^ 0x21A3)
    marks = [(rnd.random(), rnd.uniform(y0 + 6, OUT_H - 4), rnd.uniform(14, 30),
              rnd.random(), 1 if rnd.random() < 0.5 else -1) for _ in range(9)]

    def apply(img, t):
        c = _np(img)
        two = 2 * math.pi
        for sx, yy, w, phase, d in marks:
            x = ((sx + d * 0.16 * t) % 1.0) * OUT_W
            amp = 0.16 * (0.55 + 0.45 * math.sin(two * (t + phase)))
            spr = _soft_disc(w)
            spr = spr[::2]  # squash vertically -> a flat water glint
            _stamp(c, spr, x, yy, (236, 250, 255), amp)
        return _img(c)
    return apply


def rain_effect(slug, page_id):
    rnd = random.Random(_seed(slug, page_id) ^ 0x5A1)
    span = OUT_H + 24
    drops = [(rnd.uniform(0, OUT_W), rnd.uniform(0, span), rnd.uniform(0.85, 1.0))
             for _ in range(64)]

    def apply(img, t):
        im = img.copy()
        d = ImageDraw.Draw(im, "RGBA")
        for x, y0, spd in drops:
            yy = (y0 + t * span) % span
            d.line([(x, yy), (x - 4, yy + 14)], fill=(205, 232, 247, 150), width=1)
        return im
    return apply


def snow_effect(slug, page_id):
    rnd = random.Random(_seed(slug, page_id) ^ 0x53E0)
    span = OUT_H + 24
    flakes = [(rnd.uniform(0, OUT_W), rnd.uniform(0, span), rnd.uniform(1.2, 3.2),
               rnd.random(), rnd.uniform(4, 10)) for _ in range(58)]

    def apply(img, t):
        im = img.copy()
        d = ImageDraw.Draw(im, "RGBA")
        for bx, y0, r, phase, sway in flakes:
            yy = (y0 + t * span) % span
            xx = bx + sway * math.sin(2 * math.pi * (t + phase))
            d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=(255, 255, 255, 210))
        return im
    return apply


# ------------------------------------------------------------- effect routing
def background_effect(sky, page_id, slug):
    """The ambient sky motion for a page, as an apply(img,t) closure (or None)."""
    if sky in ("night", "space"):
        moon = True  # a moon-glow pulse is harmless when there's no moon (off-canvas)
        count = 34 if sky == "space" else 24
        return lambda img, t: fx_twinkle(
            img, slug, page_id, t, count=count, region=(0.02, 0.02, 0.98, 0.52),
            colors=[(255, 255, 255), (200, 220, 255), (255, 245, 210)],
            rmin=1.6, rmax=4.2, base_amp=0.9, moon=moon and sky != "space")
    if sky == "dusk":
        return lambda img, t: fx_twinkle(
            img, slug, page_id, t, count=12, region=(0.05, 0.03, 0.95, 0.30),
            colors=[(255, 246, 255), (255, 236, 200)],
            rmin=1.4, rmax=3.4, base_amp=0.7, moon=False)
    if sky == "jungle":
        return lambda img, t: fx_twinkle(
            img, slug, page_id, t, count=16, region=(0.05, 0.30, 0.95, 0.78),
            colors=[(255, 240, 160), (210, 255, 170)],
            rmin=1.6, rmax=3.8, base_amp=0.8, moon=False)
    return None  # sea + day handled specially in build_frames


def build_frames(slug, page_id, characters, frames=FRAMES):
    # Suppress static falling weather so the overlay owns the motion (no doubling).
    base, hints = render_base(slug, page_id, characters, suppress=("rain", "snow"))
    sky = hints["sky"]

    effects = []  # stacked apply(img,t) closures, background first
    bg = background_effect(sky, page_id, slug)
    if bg is not None:
        effects.append(bg)
    elif sky != "sea":  # day / sunset -> drifting clouds
        seed = _seed(slug, page_id)
        strip = _cloud_strip(seed, SRC_W * 1.4, SRC_H * 0.42, n=3)
        effects.append(lambda img, t, _s=strip: fx_clouds(img, _s, t))

    # additive motifs keyed off the scene's own hints
    for f in hints.get("fires", []):
        fx, fy, fs = f
        effects.append(fire_effect(slug, page_id, fx, fy, fs))
    for lx, ly in hints.get("lamps", []):
        effects.append(glow_effect(lx * 1.0, ly * 1.0))
    if hints.get("water_y") is not None:
        effects.append(ripple_effect(slug, page_id, hints["water_y"]))
    if hints.get("weather") == "rain":
        effects.append(rain_effect(slug, page_id))
    elif hints.get("weather") == "snow":
        effects.append(snow_effect(slug, page_id))

    sea = sky == "sea"
    out = []
    for i in range(frames):
        t = i / frames
        img = base
        if sea:
            img = fx_bubbles(base, slug, page_id, t,
                             region=(0.05, 0.12, 0.95, 0.92), count=22)
        for e in effects:
            img = e(img, t)
        if sea:
            img = _bob(img, int(round(3.0 * math.sin(2 * math.pi * t))))
        out.append(img)
    return out


# ------------------------------------------------------------------- save GIF
def save_gif(frames, out_path, fps=FPS, colors=GIF_COLORS):
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dur = int(round(1000 / fps))
    # Quantize every frame against one shared palette (from a median-cut of
    # frame 0) so the GIF carries a single global palette -> smaller + stable.
    # No dithering: flat sky gradients stay clean and identical frame-to-frame
    # (calmer for bedtime, and much smaller GIFs — no per-frame dither noise).
    pal_src = frames[0].quantize(colors=colors, method=Image.MEDIANCUT)
    q = [f.quantize(palette=pal_src, dither=Image.NONE) for f in frames]
    q[0].save(out_path, save_all=True, append_images=q[1:], loop=0,
              duration=dur, optimize=True, disposal=2)
    return out_path.stat().st_size


def animate_page(slug, page_id, characters, out_path, frames=FRAMES, fps=FPS):
    """Public API: write a looping GIF for one page. Returns file size (bytes)."""
    fr = build_frames(slug, page_id, characters, frames=frames)
    return save_gif(fr, out_path, fps=fps)


# --------------------------------------------------------------------- batch
def animate_book(slug, frames=FRAMES, fps=FPS, verbose=True):
    book = load_book(slug)
    if not book:
        if verbose:
            print(f"  ! {slug}: no template JSON, skipped")
        return []
    pages, chars = book
    kind = scene_art.book_theme(slug)["sky"]
    results = []
    for pid in sorted(pages, key=lambda s: int(s)):
        out = OUT_DIR / slug / f"page_{pid}.gif"
        try:
            sz = animate_page(slug, pid, chars, out, frames=frames, fps=fps)
            results.append((out, sz))
        except Exception as e:  # keep the batch going
            if verbose:
                print(f"  ! {slug} p{pid}: {e}")
    if verbose and results:
        avg = sum(s for _, s in results) / len(results)
        print(f"  {slug:12s} [{kind:8s}] {len(results):2d} gifs, "
              f"avg {avg/1024:5.1f} KB, max {max(s for _,s in results)/1024:5.1f} KB")
    return results


def main():
    ap = argparse.ArgumentParser(description="Gentle looping backgrounds for BeeboBook pages.")
    ap.add_argument("--slug", help="animate a single book")
    ap.add_argument("--all", action="store_true", help="animate every book")
    ap.add_argument("--page", help="with --slug: only this page id")
    ap.add_argument("--frames", type=int, default=FRAMES)
    ap.add_argument("--fps", type=int, default=FPS)
    args = ap.parse_args()

    if args.slug and args.page:
        book = load_book(args.slug)
        if not book:
            print("no such book:", args.slug); return
        _, chars = book
        out = OUT_DIR / args.slug / f"page_{args.page}.gif"
        sz = animate_page(args.slug, args.page, chars, out,
                          frames=args.frames, fps=args.fps)
        print(f"wrote {out}  ({sz/1024:.1f} KB)")
        return

    if args.slug:
        animate_book(args.slug, frames=args.frames, fps=args.fps)
        return

    if args.all:
        slugs = discover_slugs()
        print(f"animating {len(slugs)} books: {', '.join(slugs)}")
        grand = []
        for s in slugs:
            grand += animate_book(s, frames=args.frames, fps=args.fps)
        if grand:
            tot = sum(sz for _, sz in grand)
            print(f"\nTOTAL {len(grand)} gifs, {tot/1024/1024:.2f} MB, "
                  f"avg {tot/len(grand)/1024:.1f} KB")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
