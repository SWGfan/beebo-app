#!/usr/bin/env python3
"""
scene_art.py — automatic "storybook clip-art" scene behind each BeeboBook page.

For a page it picks a themed backdrop (day / night / space / undersea / …) from
the book + the page's own words, layers in a few big motifs, and renders a soft,
flat, rounded illustration to PNG. Fully automatic, one picture per page.

Style: flat vector, warm palette, rounded organic shapes, gentle gradients —
picture-book "clip-art", deliberately simple and friendly rather than painterly.
"""

import hashlib
import io
import json
import math
import random
import re
from pathlib import Path

W, H = 1200, 1600  # portrait, cropped to fill a phone reader

# ---------------------------------------------------------------- palettes

SKIES = {
    "day":   ("#8fd3ff", "#eaf7ff"),
    "sunset":("#ffb27a", "#ffe6c7"),
    "night": ("#26306b", "#5b6bb5"),
    "space": ("#160f3a", "#3a2a7a"),
    "sea":   ("#0f8fb2", "#8fe7e0"),
    "jungle":("#7ec96b", "#d8f3b0"),
    "dusk":  ("#c98ad6", "#ffd9e6"),
}
GROUNDS = {
    "grass": "#79c56a", "grass2": "#5fae52",
    "sand":  "#f2d9a6", "sand2": "#e6c589",
    "road":  "#5a5f70", "road2": "#4a4f5e",
    "seabed":"#f0dca0", "seabed2":"#e2c884",
    "snow":  "#eef6ff", "snow2": "#dbe9fb",
    "floor": "#caa27a", "floor2":"#b58a63",
}


def _lerp_hex(a, b, t):
    a = a.lstrip("#"); b = b.lstrip("#")
    ca = tuple(int(a[i:i+2], 16) for i in (0, 2, 4))
    cb = tuple(int(b[i:i+2], 16) for i in (0, 2, 4))
    return "#%02x%02x%02x" % tuple(round(ca[i] + (cb[i]-ca[i]) * t) for i in range(3))


# ---------------------------------------------------------------- motifs
# Each motif returns an SVG group string. cx,cy = anchor, s = scale (1.0 base).

def m_sun(cx, cy, s=1.0, c="#ffd54a"):
    r = 120 * s
    rays = ""
    for k in range(12):
        import math
        a = k * math.pi / 6
        x1, y1 = cx + math.cos(a)*r*1.25, cy + math.sin(a)*r*1.25
        x2, y2 = cx + math.cos(a)*r*1.7, cy + math.sin(a)*r*1.7
        rays += f'<line x1="{x1:.0f}" y1="{y1:.0f}" x2="{x2:.0f}" y2="{y2:.0f}" stroke="{c}" stroke-width="{14*s:.0f}" stroke-linecap="round" opacity="0.85"/>'
    return f'<g>{rays}<circle cx="{cx}" cy="{cy}" r="{r:.0f}" fill="{c}"/><circle cx="{cx}" cy="{cy}" r="{r:.0f}" fill="#fff" opacity="0.15"/></g>'

def m_moon(cx, cy, s=1.0):
    r = 100 * s
    return (f'<g><circle cx="{cx}" cy="{cy}" r="{r:.0f}" fill="#fdf6c9"/>'
            f'<circle cx="{cx+r*0.35:.0f}" cy="{cy-r*0.25:.0f}" r="{r*0.85:.0f}" fill="#26306b" opacity="0.0"/>'
            f'<circle cx="{cx-r*0.3:.0f}" cy="{cy+r*0.1:.0f}" r="{r*0.16:.0f}" fill="#efe6a8"/>'
            f'<circle cx="{cx+r*0.2:.0f}" cy="{cy+r*0.35:.0f}" r="{r*0.12:.0f}" fill="#efe6a8"/></g>')

def m_stars(seed, n=26, area=(0, 0, W, 900), c="#fff"):
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        x = rnd.uniform(area[0], area[2]); y = rnd.uniform(area[1], area[3])
        r = rnd.uniform(2, 6); o = rnd.uniform(0.5, 1)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="{c}" opacity="{o:.2f}"/>')
    # a few sparkle plus-shapes
    for _ in range(6):
        x = rnd.uniform(area[0], area[2]); y = rnd.uniform(area[1], area[3]); l = rnd.uniform(8, 16)
        out.append(f'<path d="M{x:.0f} {y-l:.0f}L{x:.0f} {y+l:.0f}M{x-l:.0f} {y:.0f}L{x+l:.0f} {y:.0f}" stroke="{c}" stroke-width="3" stroke-linecap="round" opacity="0.9"/>')
    return "<g>" + "".join(out) + "</g>"

def m_cloud(cx, cy, s=1.0, c="#ffffff"):
    return (f'<g opacity="0.95"><ellipse cx="{cx}" cy="{cy}" rx="{110*s:.0f}" ry="{55*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-70*s:.0f}" cy="{cy+8*s:.0f}" r="{50*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+70*s:.0f}" cy="{cy+10*s:.0f}" r="{56*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-28*s:.0f}" r="{58*s:.0f}" fill="{c}"/></g>')

def m_hill(cx, cy, s=1.0, c="#5fae52"):
    rx, ry = 520*s, 260*s
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx:.0f}" ry="{ry:.0f}" fill="{c}"/>'

def m_tree(cx, cy, s=1.0, c="#3e9b58"):
    # cy = base (ground) y
    th = 150*s
    return (f'<g><rect x="{cx-16*s:.0f}" y="{cy-th:.0f}" width="{32*s:.0f}" height="{th:.0f}" rx="{10*s:.0f}" fill="#8a5a35"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-th-70*s:.0f}" r="{95*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-70*s:.0f}" cy="{cy-th-20*s:.0f}" r="{70*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+70*s:.0f}" cy="{cy-th-20*s:.0f}" r="{70*s:.0f}" fill="{c}"/></g>')

def m_pine(cx, cy, s=1.0, c="#2f8f57"):
    th = 60*s
    def tri(w, y, h):
        return f'<path d="M{cx:.0f} {y-h:.0f}L{cx-w:.0f} {y:.0f}L{cx+w:.0f} {y:.0f}Z" fill="{c}"/>'
    return (f'<g><rect x="{cx-12*s:.0f}" y="{cy-th:.0f}" width="{24*s:.0f}" height="{th:.0f}" fill="#8a5a35"/>'
            + tri(95*s, cy-th, 130*s) + tri(80*s, cy-th-70*s, 120*s) + tri(60*s, cy-th-140*s, 110*s) + "</g>")

def m_castle(cx, cy, s=1.0, c="#cfd6e6"):
    # cy = base. A simple friendly castle.
    b = 190*s
    top = cy - 300*s
    tw = 55*s
    def tower(x):
        return (f'<rect x="{x-tw/2:.0f}" y="{top:.0f}" width="{tw:.0f}" height="{cy-top:.0f}" fill="{c}"/>'
                f'<path d="M{x-tw/2-10*s:.0f} {top:.0f}L{x:.0f} {top-55*s:.0f}L{x+tw/2+10*s:.0f} {top:.0f}Z" fill="#b26bd6"/>'
                f'<rect x="{x-10*s:.0f}" y="{top+40*s:.0f}" width="{20*s:.0f}" height="{34*s:.0f}" rx="{9*s:.0f}" fill="#7a86b8"/>')
    body = f'<rect x="{cx-b:.0f}" y="{cy-210*s:.0f}" width="{2*b:.0f}" height="{210*s:.0f}" fill="{c}"/>'
    door = f'<path d="M{cx-32*s:.0f} {cy:.0f}L{cx-32*s:.0f} {cy-70*s:.0f}Q{cx:.0f} {cy-104*s:.0f} {cx+32*s:.0f} {cy-70*s:.0f}L{cx+32*s:.0f} {cy:.0f}Z" fill="#6b4a86"/>'
    return "<g>" + body + tower(cx-b) + tower(cx+b) + tower(cx) + door + "</g>"

def m_dragon(cx, cy, s=1.0, c="#7bd08a"):
    # small friendly dragon (side)
    body = f'<ellipse cx="{cx}" cy="{cy}" rx="{95*s:.0f}" ry="{68*s:.0f}" fill="{c}"/>'
    head = f'<circle cx="{cx+80*s:.0f}" cy="{cy-40*s:.0f}" r="{48*s:.0f}" fill="{c}"/>'
    eye = f'<circle cx="{cx+95*s:.0f}" cy="{cy-48*s:.0f}" r="{8*s:.0f}" fill="#243"/>'
    wing = f'<path d="M{cx-10*s:.0f} {cy-30*s:.0f}Q{cx-30*s:.0f} {cy-130*s:.0f} {cx+40*s:.0f} {cy-70*s:.0f}Z" fill="#a7e6b0"/>'
    tail = f'<path d="M{cx-80*s:.0f} {cy+10*s:.0f}Q{cx-170*s:.0f} {cy+20*s:.0f} {cx-150*s:.0f} {cy-40*s:.0f}" stroke="{c}" stroke-width="{26*s:.0f}" fill="none" stroke-linecap="round"/>'
    tummy = f'<ellipse cx="{cx+5*s:.0f}" cy="{cy+20*s:.0f}" rx="{55*s:.0f}" ry="{38*s:.0f}" fill="#eafbe9"/>'
    # little back spikes so it reads as a dragon, plus a snout, horn and nostril
    spikes = "".join(
        f'<path d="M{cx-40*s+k*36*s:.0f} {cy-58*s:.0f}L{cx-24*s+k*36*s:.0f} {cy-96*s:.0f}L{cx-8*s+k*36*s:.0f} {cy-58*s:.0f}Z" fill="#5cbf72"/>'
        for k in range(3))
    horn = f'<path d="M{cx+70*s:.0f} {cy-78*s:.0f}L{cx+82*s:.0f} {cy-116*s:.0f}L{cx+94*s:.0f} {cy-78*s:.0f}Z" fill="#efe6a8"/>'
    snout = f'<ellipse cx="{cx+118*s:.0f}" cy="{cy-30*s:.0f}" rx="{22*s:.0f}" ry="{16*s:.0f}" fill="{c}"/>'
    nostril = f'<circle cx="{cx+126*s:.0f}" cy="{cy-32*s:.0f}" r="{4*s:.0f}" fill="#243"/>'
    return "<g>" + tail + wing + spikes + body + tummy + snout + head + horn + eye + nostril + "</g>"

def m_lantern(cx, cy, s=1.0, c="#ffcf5a"):
    # a paper lantern sitting on the ground; cy = base it rests on
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy-2*s:.0f}" rx="{40*s:.0f}" ry="{9*s:.0f}" fill="#000" opacity="0.10"/>'
            f'<rect x="{cx-8*s:.0f}" y="{cy-118*s:.0f}" width="{16*s:.0f}" height="{16*s:.0f}" rx="{4*s:.0f}" fill="#8a5a35"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-58*s:.0f}" rx="{40*s:.0f}" ry="{58*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx-12*s:.0f}" cy="{cy-70*s:.0f}" rx="{10*s:.0f}" ry="{20*s:.0f}" fill="#fff" opacity="0.30"/>'
            f'<rect x="{cx-40*s:.0f}" y="{cy-104*s:.0f}" width="{80*s:.0f}" height="{10*s:.0f}" rx="{5*s:.0f}" fill="#c94a6a"/>'
            f'<rect x="{cx-40*s:.0f}" y="{cy-22*s:.0f}" width="{80*s:.0f}" height="{10*s:.0f}" rx="{5*s:.0f}" fill="#c94a6a"/></g>')

def m_rocket(cx, cy, s=1.0, c="#ff6b6b"):
    return (f'<g><path d="M{cx:.0f} {cy-140*s:.0f}Q{cx+50*s:.0f} {cy-60*s:.0f} {cx+42*s:.0f} {cy+60*s:.0f}L{cx-42*s:.0f} {cy+60*s:.0f}Q{cx-50*s:.0f} {cy-60*s:.0f} {cx:.0f} {cy-140*s:.0f}Z" fill="#eef3ff"/>'
            f'<path d="M{cx:.0f} {cy-140*s:.0f}Q{cx+50*s:.0f} {cy-60*s:.0f} {cx+42*s:.0f} {cy+60*s:.0f}" fill="none"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-40*s:.0f}" r="{26*s:.0f}" fill="#7cc4ff"/>'
            f'<path d="M{cx-42*s:.0f} {cy+30*s:.0f}L{cx-85*s:.0f} {cy+80*s:.0f}L{cx-42*s:.0f} {cy+60*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx+42*s:.0f} {cy+30*s:.0f}L{cx+85*s:.0f} {cy+80*s:.0f}L{cx+42*s:.0f} {cy+60*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx-24*s:.0f} {cy+60*s:.0f}Q{cx:.0f} {cy+150*s:.0f} {cx+24*s:.0f} {cy+60*s:.0f}Z" fill="#ffb14a"/></g>')

def m_planet(cx, cy, s=1.0, c="#c98ad6"):
    return (f'<g><ellipse cx="{cx}" cy="{cy}" rx="{160*s:.0f}" ry="{40*s:.0f}" fill="none" stroke="#ffd76a" stroke-width="{12*s:.0f}" opacity="0.9" transform="rotate(-18 {cx} {cy})"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{95*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-30*s:.0f}" cy="{cy-20*s:.0f}" r="{22*s:.0f}" fill="#fff" opacity="0.15"/></g>')

def m_wave_band(y, c, s=1.0):
    path = f'M0 {y:.0f}'
    x = 0
    up = True
    while x <= W:
        path += f' q 100 {(-40 if up else 40)*s:.0f} 200 0'
        x += 200; up = not up
    path += f' L{W} {H} L0 {H} Z'
    return f'<path d="{path}" fill="{c}"/>'

def m_fish(cx, cy, s=1.0, c="#ff9f45"):
    return (f'<g><ellipse cx="{cx}" cy="{cy}" rx="{50*s:.0f}" ry="{32*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-45*s:.0f} {cy:.0f}L{cx-85*s:.0f} {cy-28*s:.0f}L{cx-85*s:.0f} {cy+28*s:.0f}Z" fill="{c}"/>'
            f'<circle cx="{cx+28*s:.0f}" cy="{cy-6*s:.0f}" r="{7*s:.0f}" fill="#243"/></g>')

def m_coral(cx, cy, s=1.0, c="#ff7aa2"):
    return (f'<g><path d="M{cx:.0f} {cy:.0f}Q{cx-20*s:.0f} {cy-90*s:.0f} {cx-60*s:.0f} {cy-110*s:.0f}" stroke="{c}" stroke-width="{22*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<path d="M{cx:.0f} {cy:.0f}Q{cx+10*s:.0f} {cy-120*s:.0f} {cx:.0f} {cy-150*s:.0f}" stroke="{c}" stroke-width="{22*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<path d="M{cx:.0f} {cy:.0f}Q{cx+30*s:.0f} {cy-90*s:.0f} {cx+65*s:.0f} {cy-105*s:.0f}" stroke="{c}" stroke-width="{22*s:.0f}" fill="none" stroke-linecap="round"/></g>')

def m_bubbles(seed, area, c="#ffffff"):
    rnd = random.Random(seed)
    out = []
    for _ in range(18):
        x = rnd.uniform(*area[0:3:2]); y = rnd.uniform(area[1], area[3]); r = rnd.uniform(5, 20)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.0f}" fill="none" stroke="{c}" stroke-width="3" opacity="0.5"/>')
    return "<g>" + "".join(out) + "</g>"

def m_dino(cx, cy, s=1.0, c="#7bbf7a"):
    return (f'<g><path d="M{cx-120*s:.0f} {cy:.0f}Q{cx-160*s:.0f} {cy-40*s:.0f} {cx-120*s:.0f} {cy-70*s:.0f}" stroke="{c}" stroke-width="{30*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<ellipse cx="{cx}" cy="{cy-40*s:.0f}" rx="{110*s:.0f}" ry="{70*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx+70*s:.0f} {cy-70*s:.0f}Q{cx+150*s:.0f} {cy-120*s:.0f} {cx+120*s:.0f} {cy-30*s:.0f}" stroke="{c}" stroke-width="{40*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<circle cx="{cx+128*s:.0f}" cy="{cy-70*s:.0f}" r="{7*s:.0f}" fill="#243"/>'
            f'<rect x="{cx-60*s:.0f}" y="{cy+20*s:.0f}" width="{26*s:.0f}" height="{60*s:.0f}" rx="{10*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx+30*s:.0f}" y="{cy+20*s:.0f}" width="{26*s:.0f}" height="{60*s:.0f}" rx="{10*s:.0f}" fill="{c}"/></g>')

def m_car(cx, cy, s=1.0, c="#ff5a5a"):
    return (f'<g><rect x="{cx-90*s:.0f}" y="{cy-40*s:.0f}" width="{180*s:.0f}" height="{55*s:.0f}" rx="{22*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-55*s:.0f} {cy-40*s:.0f}Q{cx-30*s:.0f} {cy-85*s:.0f} {cx+30*s:.0f} {cy-80*s:.0f}L{cx+55*s:.0f} {cy-40*s:.0f}Z" fill="{c}"/>'
            f'<circle cx="{cx-45*s:.0f}" cy="{cy+18*s:.0f}" r="{28*s:.0f}" fill="#333"/><circle cx="{cx-45*s:.0f}" cy="{cy+18*s:.0f}" r="{12*s:.0f}" fill="#ccc"/>'
            f'<circle cx="{cx+45*s:.0f}" cy="{cy+18*s:.0f}" r="{28*s:.0f}" fill="#333"/><circle cx="{cx+45*s:.0f}" cy="{cy+18*s:.0f}" r="{12*s:.0f}" fill="#ccc"/></g>')

def m_ship(cx, cy, s=1.0, c="#8a5a35"):
    return (f'<g><path d="M{cx-120*s:.0f} {cy:.0f}Q{cx:.0f} {cy+70*s:.0f} {cx+120*s:.0f} {cy:.0f}L{cx+90*s:.0f} {cy-40*s:.0f}L{cx-90*s:.0f} {cy-40*s:.0f}Z" fill="{c}"/>'
            f'<rect x="{cx-4*s:.0f}" y="{cy-190*s:.0f}" width="{8*s:.0f}" height="{150*s:.0f}" fill="#5a3a20"/>'
            f'<path d="M{cx:.0f} {cy-180*s:.0f}L{cx+90*s:.0f} {cy-120*s:.0f}L{cx:.0f} {cy-70*s:.0f}Z" fill="#fff"/></g>')

def m_chest(cx, cy, s=1.0, c="#a86a3a"):
    return (f'<g><rect x="{cx-60*s:.0f}" y="{cy-40*s:.0f}" width="{120*s:.0f}" height="{60*s:.0f}" rx="{8*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-60*s:.0f} {cy-40*s:.0f}Q{cx:.0f} {cy-90*s:.0f} {cx+60*s:.0f} {cy-40*s:.0f}Z" fill="#8a5a2a"/>'
            f'<rect x="{cx-60*s:.0f}" y="{cy-48*s:.0f}" width="{120*s:.0f}" height="{16*s:.0f}" fill="#ffd54a"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-16*s:.0f}" r="{9*s:.0f}" fill="#ffd54a"/></g>')

def m_palm(cx, cy, s=1.0):
    fronds = ""
    import math
    for a in (-1.1, -0.5, 0, 0.5, 1.1):
        ex = cx + math.sin(a)*130*s; ey = cy-180*s - math.cos(a)*40*s
        fronds += f'<path d="M{cx:.0f} {cy-180*s:.0f}Q{(cx+ex)/2:.0f} {ey-60*s:.0f} {ex:.0f} {ey:.0f}" stroke="#3e9b58" stroke-width="{18*s:.0f}" fill="none" stroke-linecap="round"/>'
    return (f'<g><path d="M{cx-14*s:.0f} {cy:.0f}Q{cx-30*s:.0f} {cy-100*s:.0f} {cx:.0f} {cy-180*s:.0f}Q{cx+30*s:.0f} {cy-100*s:.0f} {cx+14*s:.0f} {cy:.0f}Z" fill="#9a6a3a"/>' + fronds + "</g>")

def m_wand(cx, cy, s=1.0):
    return (f'<g><line x1="{cx-40*s:.0f}" y1="{cy+40*s:.0f}" x2="{cx+30*s:.0f}" y2="{cy-40*s:.0f}" stroke="#5a3a86" stroke-width="{12*s:.0f}" stroke-linecap="round"/>'
            f'<path d="M{cx+40*s:.0f} {cy-70*s:.0f}l10 26 27 4-20 19 5 27-22-14-24 12 7-27-19-19 27-2Z" fill="#ffd54a"/></g>')

def m_cake(cx, cy, s=1.0, c="#ffd1e6"):
    return (f'<g><rect x="{cx-70*s:.0f}" y="{cy-60*s:.0f}" width="{140*s:.0f}" height="{60*s:.0f}" rx="{10*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx-70*s:.0f}" y="{cy-80*s:.0f}" width="{140*s:.0f}" height="{26*s:.0f}" rx="{12*s:.0f}" fill="#fff"/>'
            f'<line x1="{cx:.0f}" y1="{cy-80*s:.0f}" x2="{cx:.0f}" y2="{cy-120*s:.0f}" stroke="#ff8fab" stroke-width="6"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-128*s:.0f}" r="{10*s:.0f}" fill="#ffb14a"/></g>')

def m_balloon(cx, cy, s=1.0, c="#ff6b6b"):
    return (f'<g><path d="M{cx:.0f} {cy+70*s:.0f}L{cx:.0f} {cy+30*s:.0f}" stroke="#999" stroke-width="2"/>'
            f'<ellipse cx="{cx}" cy="{cy}" rx="{34*s:.0f}" ry="{42*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx-10*s:.0f}" cy="{cy-14*s:.0f}" rx="{8*s:.0f}" ry="{12*s:.0f}" fill="#fff" opacity="0.4"/></g>')

def m_leaf_canopy(c="#3e9b58"):
    return (f'<g opacity="0.95"><ellipse cx="200" cy="80" rx="320" ry="180" fill="{c}"/>'
            f'<ellipse cx="700" cy="40" rx="380" ry="200" fill="{c}"/>'
            f'<ellipse cx="1050" cy="110" rx="300" ry="180" fill="{c}"/></g>')

def m_monkey(cx, cy, s=1.0):
    return (f'<g><ellipse cx="{cx}" cy="{cy}" rx="{55*s:.0f}" ry="{62*s:.0f}" fill="#8a5a35"/>'
            f'<circle cx="{cx}" cy="{cy-6*s:.0f}" r="{40*s:.0f}" fill="#c69a6a"/>'
            f'<circle cx="{cx-40*s:.0f}" cy="{cy-30*s:.0f}" r="{16*s:.0f}" fill="#8a5a35"/><circle cx="{cx+40*s:.0f}" cy="{cy-30*s:.0f}" r="{16*s:.0f}" fill="#8a5a35"/>'
            f'<circle cx="{cx-14*s:.0f}" cy="{cy-10*s:.0f}" r="{6*s:.0f}" fill="#243"/><circle cx="{cx+14*s:.0f}" cy="{cy-10*s:.0f}" r="{6*s:.0f}" fill="#243"/></g>')

def m_flowers(seed, ground_y, c1="#ff8fab", c2="#ffd54a"):
    rnd = random.Random(seed); out = []
    for _ in range(9):
        x = rnd.uniform(60, W-60); y = ground_y + rnd.uniform(10, 120); s = rnd.uniform(0.5, 1.0)
        col = rnd.choice([c1, c2, "#b98cff", "#fff"])
        out.append(f'<g><line x1="{x:.0f}" y1="{y:.0f}" x2="{x:.0f}" y2="{y-40*s:.0f}" stroke="#3e9b58" stroke-width="4"/>')
        for a in range(5):
            import math
            ang = a*2*math.pi/5
            out.append(f'<circle cx="{x+math.cos(ang)*12*s:.0f}" cy="{y-40*s+math.sin(ang)*12*s:.0f}" r="{9*s:.0f}" fill="{col}"/>')
        out.append(f'<circle cx="{x:.0f}" cy="{y-40*s:.0f}" r="{6*s:.0f}" fill="#ffd54a"/></g>')
    return "<g>" + "".join(out) + "</g>"

def m_house(cx, cy, s=1.0, c="#ffd9a8"):
    return (f'<g><rect x="{cx-90*s:.0f}" y="{cy-120*s:.0f}" width="{180*s:.0f}" height="{120*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-110*s:.0f} {cy-120*s:.0f}L{cx:.0f} {cy-200*s:.0f}L{cx+110*s:.0f} {cy-120*s:.0f}Z" fill="#c9603a"/>'
            f'<rect x="{cx-24*s:.0f}" y="{cy-70*s:.0f}" width="{48*s:.0f}" height="{70*s:.0f}" rx="{6*s:.0f}" fill="#8a5a35"/>'
            f'<rect x="{cx+34*s:.0f}" y="{cy-100*s:.0f}" width="{40*s:.0f}" height="{40*s:.0f}" fill="#7cc4ff"/></g>')

def m_rabbit(cx, cy, s=1.0, body="#ffffff", belly=None, ears="up"):
    # cy = base the rabbit sits on. `ears` = "up" (Mini Rex) or "lop" (French Lop, droopy).
    belly = belly or _lerp_hex(body, "#ffffff", 0.55)
    if ears == "lop":
        # long droopy ears that hang down beside the face (French Lop)
        ear = (f'<ellipse cx="{cx-34*s:.0f}" cy="{cy-30*s:.0f}" rx="{13*s:.0f}" ry="{34*s:.0f}" fill="{body}" transform="rotate(-62 {cx-34*s:.0f} {cy-30*s:.0f})"/>'
               f'<ellipse cx="{cx+34*s:.0f}" cy="{cy-30*s:.0f}" rx="{13*s:.0f}" ry="{34*s:.0f}" fill="{body}" transform="rotate(62 {cx+34*s:.0f} {cy-30*s:.0f})"/>')
    else:
        ear = (f'<ellipse cx="{cx-14*s:.0f}" cy="{cy-80*s:.0f}" rx="{10*s:.0f}" ry="{32*s:.0f}" fill="{body}"/>'
               f'<ellipse cx="{cx+14*s:.0f}" cy="{cy-80*s:.0f}" rx="{10*s:.0f}" ry="{32*s:.0f}" fill="{body}"/>')
    return (f'<g><ellipse cx="{cx}" cy="{cy-6*s:.0f}" rx="{45*s:.0f}" ry="{40*s:.0f}" fill="{body}"/>'
            f'<ellipse cx="{cx}" cy="{cy+6*s:.0f}" rx="{30*s:.0f}" ry="{26*s:.0f}" fill="{belly}"/>'
            + ear +
            f'<circle cx="{cx}" cy="{cy-40*s:.0f}" r="{30*s:.0f}" fill="{body}"/>'
            f'<circle cx="{cx-10*s:.0f}" cy="{cy-44*s:.0f}" r="{5*s:.0f}" fill="#243"/><circle cx="{cx+10*s:.0f}" cy="{cy-44*s:.0f}" r="{5*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-34*s:.0f}" r="{4*s:.0f}" fill="#ff8fab"/></g>')

def m_cape(cx, cy, s=1.0, c="#4a7bd6"):
    # simple superhero emblem/star burst
    pts = []
    for k in range(10):
        r = (60 if k % 2 == 0 else 26)*s
        a = k*math.pi/5 - math.pi/2
        pts.append(f'{cx+math.cos(a)*r:.0f},{cy+math.sin(a)*r:.0f}')
    return f'<g><circle cx="{cx}" cy="{cy}" r="{80*s:.0f}" fill="{c}"/><polygon points="{" ".join(pts)}" fill="#ffd54a"/></g>'

# --- people & companions (drawn when a page's characters are on stage) --------

def m_person(cx, cy, s=1.0, skin="#f2c69b", shirt="#4a7bd6", hair="#5a3a20", child=True):
    # cy = feet. A simple, friendly standing figure. `child` gives bigger head / shorter body.
    H = (170 if child else 210) * s
    head_r = (34 if child else 30) * s
    hy = cy - H + head_r                       # head center y
    torso_top = hy + head_r + 4*s
    torso_bot = cy - (52 if child else 66)*s
    tw = (54 if child else 58) * s
    legs = (f'<rect x="{cx-tw*0.42:.0f}" y="{torso_bot-6*s:.0f}" width="{tw*0.34:.0f}" height="{(52 if child else 66)*s:.0f}" rx="{7*s:.0f}" fill="#3a4a6a"/>'
            f'<rect x="{cx+tw*0.08:.0f}" y="{torso_bot-6*s:.0f}" width="{tw*0.34:.0f}" height="{(52 if child else 66)*s:.0f}" rx="{7*s:.0f}" fill="#3a4a6a"/>')
    arms = (f'<rect x="{cx-tw*0.62:.0f}" y="{torso_top+6*s:.0f}" width="{tw*0.18:.0f}" height="{(torso_bot-torso_top)*0.9:.0f}" rx="{7*s:.0f}" fill="{shirt}"/>'
            f'<rect x="{cx+tw*0.44:.0f}" y="{torso_top+6*s:.0f}" width="{tw*0.18:.0f}" height="{(torso_bot-torso_top)*0.9:.0f}" rx="{7*s:.0f}" fill="{shirt}"/>')
    torso = f'<rect x="{cx-tw/2:.0f}" y="{torso_top:.0f}" width="{tw:.0f}" height="{torso_bot-torso_top:.0f}" rx="{16*s:.0f}" fill="{shirt}"/>'
    head = f'<circle cx="{cx:.0f}" cy="{hy:.0f}" r="{head_r:.0f}" fill="{skin}"/>'
    hairc = f'<path d="M{cx-head_r:.0f} {hy-2*s:.0f}Q{cx:.0f} {hy-head_r*1.7:.0f} {cx+head_r:.0f} {hy-2*s:.0f}Q{cx+head_r*0.5:.0f} {hy-head_r*0.6:.0f} {cx:.0f} {hy-head_r*0.55:.0f}Q{cx-head_r*0.5:.0f} {hy-head_r*0.6:.0f} {cx-head_r:.0f} {hy-2*s:.0f}Z" fill="{hair}"/>'
    eyes = f'<circle cx="{cx-head_r*0.34:.0f}" cy="{hy+2*s:.0f}" r="{3.4*s:.0f}" fill="#243"/><circle cx="{cx+head_r*0.34:.0f}" cy="{hy+2*s:.0f}" r="{3.4*s:.0f}" fill="#243"/>'
    smile = f'<path d="M{cx-head_r*0.34:.0f} {hy+head_r*0.42:.0f}Q{cx:.0f} {hy+head_r*0.72:.0f} {cx+head_r*0.34:.0f} {hy+head_r*0.42:.0f}" stroke="#b56a5a" stroke-width="{2.6*s:.0f}" fill="none" stroke-linecap="round"/>'
    return "<g>" + legs + arms + torso + head + hairc + eyes + smile + "</g>"

def m_dog(cx, cy, s=1.0, c="#c98a4a"):
    # cy = base. small friendly side-view pup
    return (f'<g><path d="M{cx-70*s:.0f} {cy-30*s:.0f}Q{cx-100*s:.0f} {cy-55*s:.0f} {cx-78*s:.0f} {cy-72*s:.0f}" stroke="{c}" stroke-width="{16*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<ellipse cx="{cx}" cy="{cy-34*s:.0f}" rx="{62*s:.0f}" ry="{38*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx-46*s:.0f}" y="{cy-24*s:.0f}" width="{16*s:.0f}" height="{28*s:.0f}" rx="{6*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx+30*s:.0f}" y="{cy-24*s:.0f}" width="{16*s:.0f}" height="{28*s:.0f}" rx="{6*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+56*s:.0f}" cy="{cy-56*s:.0f}" r="{30*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx+44*s:.0f}" cy="{cy-78*s:.0f}" rx="{11*s:.0f}" ry="{18*s:.0f}" fill="{_lerp_hex(c,"#000000",0.18)}"/>'
            f'<circle cx="{cx+80*s:.0f}" cy="{cy-52*s:.0f}" r="{7*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx+66*s:.0f}" cy="{cy-58*s:.0f}" r="{5*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx+84*s:.0f}" cy="{cy-40*s:.0f}" r="{6*s:.0f}" fill="#3a2a20"/></g>')

def m_parrot(cx, cy, s=1.0, c="#3fbf6b"):
    return (f'<g><path d="M{cx-30*s:.0f} {cy+10*s:.0f}L{cx-78*s:.0f} {cy+46*s:.0f}L{cx-30*s:.0f} {cy+40*s:.0f}Z" fill="{_lerp_hex(c,"#1f7f45",0.4)}"/>'
            f'<ellipse cx="{cx}" cy="{cy}" rx="{40*s:.0f}" ry="{52*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx+6*s:.0f} {cy-6*s:.0f}q{34*s:.0f} 8 {14*s:.0f} 44" stroke="#ffd54a" stroke-width="{14*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<circle cx="{cx+6*s:.0f}" cy="{cy-44*s:.0f}" r="{26*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+14*s:.0f}" cy="{cy-48*s:.0f}" r="{6*s:.0f}" fill="#243"/>'
            f'<path d="M{cx+30*s:.0f} {cy-44*s:.0f}q{18*s:.0f} 2 {6*s:.0f} 18q-{12*s:.0f} 2 -{14*s:.0f} -8Z" fill="#ff9f45"/>'
            f'<path d="M{cx+2*s:.0f} {cy-66*s:.0f}q{10*s:.0f} -14 {22*s:.0f} -6" stroke="#ff5a5a" stroke-width="{7*s:.0f}" fill="none" stroke-linecap="round"/></g>')

def m_owl(cx, cy, s=1.0, c="#a98a6a"):
    return (f'<g><ellipse cx="{cx}" cy="{cy-30*s:.0f}" rx="{46*s:.0f}" ry="{54*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-42*s:.0f} {cy-64*s:.0f}L{cx-30*s:.0f} {cy-92*s:.0f}L{cx-14*s:.0f} {cy-66*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx+42*s:.0f} {cy-64*s:.0f}L{cx+30*s:.0f} {cy-92*s:.0f}L{cx+14*s:.0f} {cy-66*s:.0f}Z" fill="{c}"/>'
            f'<ellipse cx="{cx}" cy="{cy-14*s:.0f}" rx="{34*s:.0f}" ry="{40*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.5)}"/>'
            f'<circle cx="{cx-18*s:.0f}" cy="{cy-40*s:.0f}" r="{16*s:.0f}" fill="#fff"/><circle cx="{cx+18*s:.0f}" cy="{cy-40*s:.0f}" r="{16*s:.0f}" fill="#fff"/>'
            f'<circle cx="{cx-18*s:.0f}" cy="{cy-40*s:.0f}" r="{7*s:.0f}" fill="#243"/><circle cx="{cx+18*s:.0f}" cy="{cy-40*s:.0f}" r="{7*s:.0f}" fill="#243"/>'
            f'<path d="M{cx-7*s:.0f} {cy-30*s:.0f}L{cx+7*s:.0f} {cy-30*s:.0f}L{cx:.0f} {cy-18*s:.0f}Z" fill="#ff9f45"/></g>')

def m_dolphin(cx, cy, s=1.0, c="#6ab0d8"):
    return (f'<g><path d="M{cx-96*s:.0f} {cy+6*s:.0f}Q{cx-30*s:.0f} {cy-64*s:.0f} {cx+70*s:.0f} {cy-36*s:.0f}Q{cx+96*s:.0f} {cy-28*s:.0f} {cx+96*s:.0f} {cy-10*s:.0f}Q{cx+40*s:.0f} {cy-8*s:.0f} {cx-30*s:.0f} {cy+30*s:.0f}Q{cx-70*s:.0f} {cy+46*s:.0f} {cx-96*s:.0f} {cy+6*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx-96*s:.0f} {cy+6*s:.0f}Q{cx-132*s:.0f} {cy-6*s:.0f} {cx-128*s:.0f} {cy-40*s:.0f}Q{cx-108*s:.0f} {cy-20*s:.0f} {cx-96*s:.0f} {cy+6*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx-4*s:.0f} {cy-52*s:.0f}L{cx+20*s:.0f} {cy-92*s:.0f}L{cx+30*s:.0f} {cy-48*s:.0f}Z" fill="{_lerp_hex(c,"#2a6a90",0.4)}"/>'
            f'<path d="M{cx-30*s:.0f} {cy+18*s:.0f}Q{cx+30*s:.0f} {cy+6*s:.0f} {cx+80*s:.0f} {cy-6*s:.0f}L{cx+80*s:.0f} {cy-2*s:.0f}Q{cx+30*s:.0f} {cy+18*s:.0f} {cx-20*s:.0f} {cy+34*s:.0f}Z" fill="{_lerp_hex(c,"#ffffff",0.55)}"/>'
            f'<circle cx="{cx+62*s:.0f}" cy="{cy-24*s:.0f}" r="{6*s:.0f}" fill="#243"/></g>')

def m_alien(cx, cy, s=1.0, c="#8fd66b"):
    return (f'<g><line x1="{cx:.0f}" y1="{cy-96*s:.0f}" x2="{cx:.0f}" y2="{cy-124*s:.0f}" stroke="{c}" stroke-width="{5*s:.0f}"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-130*s:.0f}" r="{8*s:.0f}" fill="#ffd54a"/>'
            f'<ellipse cx="{cx}" cy="{cy-46*s:.0f}" rx="{40*s:.0f}" ry="{52*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx}" cy="{cy-6*s:.0f}" rx="{34*s:.0f}" ry="{30*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx-16*s:.0f}" cy="{cy-52*s:.0f}" rx="{11*s:.0f}" ry="{16*s:.0f}" fill="#243"/>'
            f'<ellipse cx="{cx+16*s:.0f}" cy="{cy-52*s:.0f}" rx="{11*s:.0f}" ry="{16*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx-13*s:.0f}" cy="{cy-56*s:.0f}" r="{4*s:.0f}" fill="#fff"/><circle cx="{cx+19*s:.0f}" cy="{cy-56*s:.0f}" r="{4*s:.0f}" fill="#fff"/></g>')

def m_ghost(cx, cy, s=1.0, c="#eef2ff"):
    return (f'<g opacity="0.95"><path d="M{cx-46*s:.0f} {cy:.0f}L{cx-46*s:.0f} {cy-56*s:.0f}Q{cx-46*s:.0f} {cy-116*s:.0f} {cx:.0f} {cy-116*s:.0f}Q{cx+46*s:.0f} {cy-116*s:.0f} {cx+46*s:.0f} {cy-56*s:.0f}L{cx+46*s:.0f} {cy:.0f}'
            f'q-{15*s:.0f} -18 -{23*s:.0f} 0q-{8*s:.0f} 18 -{23*s:.0f} 0Z" fill="{c}"/>'
            f'<circle cx="{cx-15*s:.0f}" cy="{cy-64*s:.0f}" r="{6*s:.0f}" fill="#556"/><circle cx="{cx+15*s:.0f}" cy="{cy-64*s:.0f}" r="{6*s:.0f}" fill="#556"/>'
            f'<path d="M{cx-10*s:.0f} {cy-46*s:.0f}q{10*s:.0f} 10 {20*s:.0f} 0" stroke="#889" stroke-width="{3*s:.0f}" fill="none" stroke-linecap="round"/></g>')

def m_cat(cx, cy, s=1.0, c="#6a6a78"):
    return (f'<g><path d="M{cx-70*s:.0f} {cy:.0f}Q{cx-120*s:.0f} {cy-10*s:.0f} {cx-96*s:.0f} {cy-56*s:.0f}" stroke="{c}" stroke-width="{16*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<ellipse cx="{cx}" cy="{cy-30*s:.0f}" rx="{54*s:.0f}" ry="{40*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+30*s:.0f}" cy="{cy-64*s:.0f}" r="{30*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx+8*s:.0f} {cy-84*s:.0f}L{cx+14*s:.0f} {cy-112*s:.0f}L{cx+30*s:.0f} {cy-90*s:.0f}Z" fill="{c}"/>'
            f'<path d="M{cx+52*s:.0f} {cy-84*s:.0f}L{cx+50*s:.0f} {cy-112*s:.0f}L{cx+32*s:.0f} {cy-90*s:.0f}Z" fill="{c}"/>'
            f'<circle cx="{cx+20*s:.0f}" cy="{cy-64*s:.0f}" r="{5*s:.0f}" fill="#ffd54a"/><circle cx="{cx+40*s:.0f}" cy="{cy-64*s:.0f}" r="{5*s:.0f}" fill="#ffd54a"/></g>')

def m_clock(cx, cy, s=1.0):
    return (f'<g><circle cx="{cx}" cy="{cy}" r="{44*s:.0f}" fill="#fff"/><circle cx="{cx}" cy="{cy}" r="{44*s:.0f}" fill="none" stroke="#5a3a86" stroke-width="{7*s:.0f}"/>'
            f'<line x1="{cx:.0f}" y1="{cy:.0f}" x2="{cx:.0f}" y2="{cy-28*s:.0f}" stroke="#5a3a86" stroke-width="{5*s:.0f}" stroke-linecap="round"/>'
            f'<line x1="{cx:.0f}" y1="{cy:.0f}" x2="{cx+20*s:.0f}" y2="{cy+8*s:.0f}" stroke="#5a3a86" stroke-width="{5*s:.0f}" stroke-linecap="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{4*s:.0f}" fill="#5a3a86"/></g>')

def m_marble(cx, cy, s=1.0, c="#8fe36b"):
    return (f'<g><circle cx="{cx}" cy="{cy}" r="{34*s:.0f}" fill="{c}" opacity="0.30"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{16*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-5*s:.0f}" cy="{cy-5*s:.0f}" r="{5*s:.0f}" fill="#fff" opacity="0.8"/></g>')

def m_robot(cx, cy, s=1.0, c="#a6b8ca"):
    # a cheerful little helper robot on wheels; cy = base
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy+2*s:.0f}" rx="{40*s:.0f}" ry="{8*s:.0f}" fill="#000" opacity="0.10"/>'
            f'<line x1="{cx:.0f}" y1="{cy-104*s:.0f}" x2="{cx:.0f}" y2="{cy-128*s:.0f}" stroke="#8a97a6" stroke-width="{4*s:.0f}"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-132*s:.0f}" r="{7*s:.0f}" fill="#ffd54a"/>'
            f'<rect x="{cx-46*s:.0f}" y="{cy-104*s:.0f}" width="{92*s:.0f}" height="{86*s:.0f}" rx="{22*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx-34*s:.0f}" y="{cy-90*s:.0f}" width="{68*s:.0f}" height="{44*s:.0f}" rx="{14*s:.0f}" fill="#2a3442"/>'
            f'<circle cx="{cx-14*s:.0f}" cy="{cy-68*s:.0f}" r="{8*s:.0f}" fill="#6fd3ff"/><circle cx="{cx+14*s:.0f}" cy="{cy-68*s:.0f}" r="{8*s:.0f}" fill="#6fd3ff"/>'
            f'<rect x="{cx-16*s:.0f}" y="{cy-40*s:.0f}" width="{32*s:.0f}" height="{5*s:.0f}" rx="{2*s:.0f}" fill="#6fd3ff" opacity="0.8"/>'
            f'<rect x="{cx-42*s:.0f}" y="{cy-22*s:.0f}" width="{84*s:.0f}" height="{18*s:.0f}" rx="{9*s:.0f}" fill="#7a8798"/>'
            f'<circle cx="{cx-22*s:.0f}" cy="{cy-2*s:.0f}" r="{11*s:.0f}" fill="#333"/><circle cx="{cx+22*s:.0f}" cy="{cy-2*s:.0f}" r="{11*s:.0f}" fill="#333"/></g>')

def m_mouse(cx, cy, s=1.0, c="#b7b7c4"):
    # a shy little baker mouse in an apron; cy = base
    return (f'<g><path d="M{cx-34*s:.0f} {cy-6*s:.0f}Q{cx-84*s:.0f} {cy-10*s:.0f} {cx-66*s:.0f} {cy-44*s:.0f}" stroke="{c}" stroke-width="{7*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<ellipse cx="{cx}" cy="{cy-24*s:.0f}" rx="{38*s:.0f}" ry="{32*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-26*s:.0f} {cy-24*s:.0f}h{52*s:.0f}v{24*s:.0f}h-{52*s:.0f}z" fill="#fff" opacity="0.85"/>'
            f'<circle cx="{cx+6*s:.0f}" cy="{cy-70*s:.0f}" r="{15*s:.0f}" fill="{c}"/><circle cx="{cx+34*s:.0f}" cy="{cy-70*s:.0f}" r="{15*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+6*s:.0f}" cy="{cy-70*s:.0f}" r="{8*s:.0f}" fill="#ffc7d2"/><circle cx="{cx+34*s:.0f}" cy="{cy-70*s:.0f}" r="{8*s:.0f}" fill="#ffc7d2"/>'
            f'<circle cx="{cx+20*s:.0f}" cy="{cy-50*s:.0f}" r="{25*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+15*s:.0f}" cy="{cy-52*s:.0f}" r="{4*s:.0f}" fill="#243"/><circle cx="{cx+30*s:.0f}" cy="{cy-52*s:.0f}" r="{4*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx+42*s:.0f}" cy="{cy-44*s:.0f}" r="{4.5*s:.0f}" fill="#ff8fab"/></g>')

def m_plant(cx, cy, s=1.0, c="#3fae5a"):
    # a cheerful little talking houseplant in a pot; cy = base
    leaves = "".join(
        f'<ellipse cx="{cx+dx*s:.0f}" cy="{cy-70*s+dy*s:.0f}" rx="{16*s:.0f}" ry="{34*s:.0f}" fill="{c}" transform="rotate({rot} {cx+dx*s:.0f} {cy-70*s+dy*s:.0f})"/>'
        for dx, dy, rot in [(-22,-6,-32),(0,-22,0),(22,-6,32)])
    return (f'<g>{leaves}'
            f'<path d="M{cx-30*s:.0f} {cy-36*s:.0f}L{cx-24*s:.0f} {cy:.0f}L{cx+24*s:.0f} {cy:.0f}L{cx+30*s:.0f} {cy-36*s:.0f}Z" fill="#d98a5a"/>'
            f'<circle cx="{cx-8*s:.0f}" cy="{cy-20*s:.0f}" r="{3.4*s:.0f}" fill="#243"/><circle cx="{cx+8*s:.0f}" cy="{cy-20*s:.0f}" r="{3.4*s:.0f}" fill="#243"/>'
            f'<path d="M{cx-7*s:.0f} {cy-12*s:.0f}q{7*s:.0f} 7 {14*s:.0f} 0" stroke="#7a4a2a" stroke-width="{2.4*s:.0f}" fill="none" stroke-linecap="round"/></g>')


# ---------------------------------------------------------------- NEW motifs
# A campfire, water, weather, and lots of story props/animals. Every motif keeps
# the flat, friendly, bold-shape house style. Motifs that animate carry a CSS
# class (class="fire" / "water" / "glow") so tests + the animator can find them.

def m_campfire(cx, cy, s=1.0):
    """Crossed logs, layered teardrop flames and a warm ground glow. cy = base."""
    def flame(bx, w, h, col):
        by = cy - 6 * s
        return (f'<path d="M{bx:.0f} {by:.0f} '
                f'Q{bx-w:.0f} {by-h*0.55:.0f} {bx:.0f} {by-h:.0f} '
                f'Q{bx+w:.0f} {by-h*0.55:.0f} {bx:.0f} {by:.0f} Z" fill="{col}"/>')
    glow = (f'<ellipse class="fireglow" cx="{cx:.0f}" cy="{cy-60*s:.0f}" '
            f'rx="{175*s:.0f}" ry="{140*s:.0f}" fill="#ffb347" opacity="0.20"/>')
    logs = (f'<g>'
            f'<rect x="{cx-80*s:.0f}" y="{cy-10*s:.0f}" width="{160*s:.0f}" height="{20*s:.0f}" rx="{10*s:.0f}" fill="#7a4a2a" transform="rotate(-14 {cx:.0f} {cy:.0f})"/>'
            f'<rect x="{cx-80*s:.0f}" y="{cy-10*s:.0f}" width="{160*s:.0f}" height="{20*s:.0f}" rx="{10*s:.0f}" fill="#8a5a35" transform="rotate(14 {cx:.0f} {cy:.0f})"/>'
            f'<circle cx="{cx-74*s:.0f}" cy="{cy+3*s:.0f}" r="{9*s:.0f}" fill="#d8b487"/>'
            f'<circle cx="{cx+74*s:.0f}" cy="{cy+3*s:.0f}" r="{9*s:.0f}" fill="#d8b487"/></g>')
    flames = ('<g class="fire">'
              + flame(cx - 26 * s, 30 * s, 96 * s, "#ff7a1a")
              + flame(cx + 26 * s, 30 * s, 96 * s, "#ff7a1a")
              + flame(cx, 44 * s, 172 * s, "#ff5a2a")
              + flame(cx, 32 * s, 130 * s, "#ff9f2a")
              + flame(cx, 22 * s, 88 * s, "#ffd24a")
              + flame(cx, 12 * s, 48 * s, "#fff0a8")
              + '</g>')
    # a couple of drifting embers
    embers = (f'<circle cx="{cx-40*s:.0f}" cy="{cy-150*s:.0f}" r="{4*s:.0f}" fill="#ffd24a" opacity="0.8"/>'
              f'<circle cx="{cx+34*s:.0f}" cy="{cy-176*s:.0f}" r="{3*s:.0f}" fill="#ffb347" opacity="0.7"/>')
    return f'<g class="campfire">{glow}{logs}{flames}{embers}</g>'


def m_tent(cx, cy, s=1.0, c="#e0575b"):
    """A friendly triangular tent. cy = base."""
    h = 200 * s
    w = 150 * s
    top = cy - h
    body = f'<path d="M{cx:.0f} {top:.0f} L{cx-w:.0f} {cy:.0f} L{cx+w:.0f} {cy:.0f} Z" fill="{c}"/>'
    shade = f'<path d="M{cx:.0f} {top:.0f} L{cx+w:.0f} {cy:.0f} L{cx+w*0.3:.0f} {cy:.0f} Z" fill="{_lerp_hex(c,"#000000",0.16)}"/>'
    door = (f'<path d="M{cx:.0f} {cy:.0f} L{cx-34*s:.0f} {cy:.0f} Q{cx:.0f} {cy-120*s:.0f} {cx:.0f} {top+30*s:.0f} '
            f'Q{cx:.0f} {cy-120*s:.0f} {cx+34*s:.0f} {cy:.0f} Z" fill="{_lerp_hex(c,"#000000",0.35)}"/>')
    pole = f'<line x1="{cx:.0f}" y1="{top:.0f}" x2="{cx:.0f}" y2="{top-24*s:.0f}" stroke="#8a5a35" stroke-width="{5*s:.0f}"/>'
    flag = f'<path d="M{cx:.0f} {top-24*s:.0f} l{26*s:.0f} {7*s:.0f} l-{26*s:.0f} {7*s:.0f} Z" fill="#ffd54a"/>'
    return f'<g>{body}{shade}{door}{pole}{flag}</g>'


def m_boat(cx, cy, s=1.0, c="#e0575b"):
    """A little rowboat with stripes, sitting on the water/sand. cy = waterline."""
    hull = (f'<path d="M{cx-112*s:.0f} {cy-34*s:.0f} Q{cx:.0f} {cy+58*s:.0f} {cx+112*s:.0f} {cy-34*s:.0f} Z" fill="{c}"/>')
    stripe = (f'<path d="M{cx-96*s:.0f} {cy-22*s:.0f} Q{cx:.0f} {cy+30*s:.0f} {cx+96*s:.0f} {cy-22*s:.0f}" '
              f'stroke="#ffffff" stroke-width="{10*s:.0f}" fill="none" stroke-linecap="round"/>')
    rim = f'<rect x="{cx-112*s:.0f}" y="{cy-40*s:.0f}" width="{224*s:.0f}" height="{10*s:.0f}" rx="{5*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.4)}"/>'
    seat = f'<rect x="{cx-30*s:.0f}" y="{cy-40*s:.0f}" width="{60*s:.0f}" height="{9*s:.0f}" rx="{4*s:.0f}" fill="#8a5a35"/>'
    oar = f'<line x1="{cx+20*s:.0f}" y1="{cy-36*s:.0f}" x2="{cx+120*s:.0f}" y2="{cy-70*s:.0f}" stroke="#8a5a35" stroke-width="{7*s:.0f}" stroke-linecap="round"/>'
    return f'<g class="boat">{hull}{stripe}{rim}{seat}{oar}</g>'


def m_sail_boat(cx, cy, s=1.0, c="#e0575b"):
    hull = f'<path d="M{cx-100*s:.0f} {cy-30*s:.0f} Q{cx:.0f} {cy+50*s:.0f} {cx+100*s:.0f} {cy-30*s:.0f} Z" fill="{c}"/>'
    mast = f'<line x1="{cx:.0f}" y1="{cy-30*s:.0f}" x2="{cx:.0f}" y2="{cy-180*s:.0f}" stroke="#8a5a35" stroke-width="{7*s:.0f}"/>'
    sail = f'<path d="M{cx+8*s:.0f} {cy-176*s:.0f} L{cx+80*s:.0f} {cy-46*s:.0f} L{cx+8*s:.0f} {cy-46*s:.0f} Z" fill="#ffffff"/>'
    sail2 = f'<path d="M{cx-8*s:.0f} {cy-150*s:.0f} L{cx-64*s:.0f} {cy-46*s:.0f} L{cx-8*s:.0f} {cy-46*s:.0f} Z" fill="#ffe6c7"/>'
    return f'<g class="boat">{hull}{mast}{sail2}{sail}</g>'


def m_water_pool(y, bottom=None, c1="#4aa8d8", c2="#7fd0ec"):
    """A body of water with a wavy top edge at `y`, filling down to `bottom`."""
    if bottom is None:
        bottom = H
    path = f'M0 {y:.0f}'
    x = 0; up = True
    while x <= W:
        path += f' q60 {(-16 if up else 16):.0f} 120 0'; x += 120; up = not up
    path += f' L{W} {bottom:.0f} L0 {bottom:.0f} Z'
    ripples = "".join(
        f'<path d="M{60+(k*230)%980:.0f} {y+46+k*34:.0f} q34 -10 68 0 q34 10 68 0" '
        f'stroke="#ffffff" stroke-width="4" fill="none" opacity="0.30" stroke-linecap="round"/>'
        for k in range(4))
    return (f'<g class="water"><path d="{path}" fill="{c1}"/>'
            f'<path d="{path}" fill="{c2}" opacity="0.35"/>{ripples}</g>')


def m_mountain(cx, cy, s=1.0, c="#8f9bbf", snow=True):
    """A background mountain with an optional snow cap. cy = base."""
    w = 300 * s; h = 360 * s
    peak = cy - h
    body = f'<path d="M{cx-w:.0f} {cy:.0f} L{cx:.0f} {peak:.0f} L{cx+w:.0f} {cy:.0f} Z" fill="{c}"/>'
    shade = f'<path d="M{cx:.0f} {peak:.0f} L{cx+w:.0f} {cy:.0f} L{cx+w*0.25:.0f} {cy:.0f} Z" fill="{_lerp_hex(c,"#000000",0.14)}"/>'
    cap = ""
    if snow:
        cap = (f'<path d="M{cx-w*0.33:.0f} {peak+h*0.33:.0f} L{cx:.0f} {peak:.0f} L{cx+w*0.33:.0f} {peak+h*0.33:.0f} '
               f'Q{cx+w*0.12:.0f} {peak+h*0.22:.0f} {cx:.0f} {peak+h*0.30:.0f} '
               f'Q{cx-w*0.12:.0f} {peak+h*0.22:.0f} {cx-w*0.33:.0f} {peak+h*0.33:.0f} Z" fill="#eef6ff"/>')
    return f'<g>{body}{shade}{cap}</g>'


def m_rainbow(cx, cy, r=440, s=1.0):
    """A cheerful arc rainbow. cx,cy = arc center (usually below horizon)."""
    r = r * s
    cols = ["#ff6b6b", "#ff9f45", "#ffd54a", "#5fc86a", "#4aa8d8", "#8a5ad6"]
    out = []
    for i, col in enumerate(cols):
        rr = r - i * 22 * s
        out.append(f'<path d="M{cx-rr:.0f} {cy:.0f} A{rr:.0f} {rr:.0f} 0 0 1 {cx+rr:.0f} {cy:.0f}" '
                   f'stroke="{col}" stroke-width="{20*s:.0f}" fill="none" opacity="0.9"/>')
    return '<g class="rainbow">' + "".join(out) + "</g>"


def m_rain(seed, n=54, area=(0, 0, W, 1200)):
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        x = rnd.uniform(area[0], area[2]); y = rnd.uniform(area[1], area[3]); l = rnd.uniform(20, 36)
        out.append(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x-7:.0f}" y2="{y+l:.0f}" '
                   f'stroke="#cfeaf7" stroke-width="3" stroke-linecap="round" opacity="0.55"/>')
    return '<g class="rain">' + "".join(out) + "</g>"


def m_snowfall(seed, n=70, area=(0, 0, W, 1300)):
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        x = rnd.uniform(area[0], area[2]); y = rnd.uniform(area[1], area[3]); r = rnd.uniform(3, 8)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#ffffff" opacity="{rnd.uniform(0.5,0.95):.2f}"/>')
    return '<g class="snow">' + "".join(out) + "</g>"


def m_snowman(cx, cy, s=1.0):
    """cy = base."""
    return (f'<g><circle cx="{cx:.0f}" cy="{cy-40*s:.0f}" r="{60*s:.0f}" fill="#f4faff"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-130*s:.0f}" r="{44*s:.0f}" fill="#f4faff"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-200*s:.0f}" r="{32*s:.0f}" fill="#f4faff"/>'
            f'<circle cx="{cx-11*s:.0f}" cy="{cy-206*s:.0f}" r="{4.5*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx+11*s:.0f}" cy="{cy-206*s:.0f}" r="{4.5*s:.0f}" fill="#243"/>'
            f'<path d="M{cx:.0f} {cy-198*s:.0f} l{26*s:.0f} {6*s:.0f} l-{26*s:.0f} {6*s:.0f} Z" fill="#ff9f45"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-126*s:.0f}" r="{5*s:.0f}" fill="#333"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-108*s:.0f}" r="{5*s:.0f}" fill="#333"/>'
            f'<line x1="{cx-40*s:.0f}" y1="{cy-134*s:.0f}" x2="{cx-84*s:.0f}" y2="{cy-160*s:.0f}" stroke="#8a5a35" stroke-width="{6*s:.0f}" stroke-linecap="round"/>'
            f'<line x1="{cx+40*s:.0f}" y1="{cy-134*s:.0f}" x2="{cx+84*s:.0f}" y2="{cy-160*s:.0f}" stroke="#8a5a35" stroke-width="{6*s:.0f}" stroke-linecap="round"/>'
            f'<rect x="{cx-30*s:.0f}" y="{cy-244*s:.0f}" width="{60*s:.0f}" height="{14*s:.0f}" rx="{4*s:.0f}" fill="#4a4a5a"/>'
            f'<rect x="{cx-20*s:.0f}" y="{cy-280*s:.0f}" width="{40*s:.0f}" height="{40*s:.0f}" fill="#4a4a5a"/></g>')


def m_sled(cx, cy, s=1.0, c="#e0575b"):
    """cy = base (snow)."""
    return (f'<g><path d="M{cx-80*s:.0f} {cy:.0f} L{cx+90*s:.0f} {cy:.0f} Q{cx+120*s:.0f} {cy:.0f} {cx+118*s:.0f} {cy-24*s:.0f}" '
            f'stroke="#8a97a6" stroke-width="{7*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<rect x="{cx-80*s:.0f}" y="{cy-40*s:.0f}" width="{170*s:.0f}" height="{22*s:.0f}" rx="{8*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx-70*s:.0f}" y="{cy-20*s:.0f}" width="{12*s:.0f}" height="{20*s:.0f}" fill="#8a5a35"/>'
            f'<rect x="{cx+60*s:.0f}" y="{cy-20*s:.0f}" width="{12*s:.0f}" height="{20*s:.0f}" fill="#8a5a35"/></g>')


def m_kite(cx, cy, s=1.0, c="#e0575b"):
    """A diamond kite up in the sky with a tail. cx,cy = kite center."""
    d = 46 * s
    diamond = f'<path d="M{cx:.0f} {cy-d:.0f} L{cx+d*0.8:.0f} {cy:.0f} L{cx:.0f} {cy+d:.0f} L{cx-d*0.8:.0f} {cy:.0f} Z" fill="{c}"/>'
    cross = (f'<line x1="{cx:.0f}" y1="{cy-d:.0f}" x2="{cx:.0f}" y2="{cy+d:.0f}" stroke="#ffffff" stroke-width="{3*s:.0f}" opacity="0.6"/>'
             f'<line x1="{cx-d*0.8:.0f}" y1="{cy:.0f}" x2="{cx+d*0.8:.0f}" y2="{cy:.0f}" stroke="#ffffff" stroke-width="{3*s:.0f}" opacity="0.6"/>')
    tail = (f'<path d="M{cx:.0f} {cy+d:.0f} q{20*s:.0f} {40*s:.0f} -{6*s:.0f} {70*s:.0f} q-{26*s:.0f} {30*s:.0f} {8*s:.0f} {64*s:.0f}" '
            f'stroke="#ffd54a" stroke-width="{4*s:.0f}" fill="none" stroke-linecap="round"/>')
    bows = "".join(f'<path d="M{cx+dx:.0f} {cy+dy:.0f} l{8*s:.0f} -{6*s:.0f} l0 {12*s:.0f} Z" fill="#5fc86a"/>'
                   for dx, dy in [(6*s, d+30*s), (-2*s, d+96*s)])
    return f'<g class="kite">{tail}{bows}{diamond}{cross}</g>'


def m_ball(cx, cy, s=1.0, c="#e0575b"):
    r = 42 * s
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy+r+6*s:.0f}" rx="{r*0.9:.0f}" ry="{8*s:.0f}" fill="#000" opacity="0.10"/>'
            f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="{c}"/>'
            f'<path d="M{cx-r:.0f} {cy:.0f} Q{cx:.0f} {cy-r*0.5:.0f} {cx+r:.0f} {cy:.0f}" stroke="#fff" stroke-width="{4*s:.0f}" fill="none"/>'
            f'<path d="M{cx-r:.0f} {cy:.0f} Q{cx:.0f} {cy+r*0.5:.0f} {cx+r:.0f} {cy:.0f}" stroke="#fff" stroke-width="{4*s:.0f}" fill="none"/>'
            f'<line x1="{cx:.0f}" y1="{cy-r:.0f}" x2="{cx:.0f}" y2="{cy+r:.0f}" stroke="#fff" stroke-width="{4*s:.0f}"/>'
            f'<circle cx="{cx-r*0.35:.0f}" cy="{cy-r*0.35:.0f}" r="{8*s:.0f}" fill="#fff" opacity="0.5"/></g>')


def m_bed(cx, cy, s=1.0, c="#7cc4ff"):
    """A cozy little bed with pillow + blanket. cy = base (floor)."""
    return (f'<g><rect x="{cx-120*s:.0f}" y="{cy-70*s:.0f}" width="{240*s:.0f}" height="{70*s:.0f}" rx="{10*s:.0f}" fill="#c98a5a"/>'
            f'<rect x="{cx-124*s:.0f}" y="{cy-150*s:.0f}" width="{22*s:.0f}" height="{150*s:.0f}" rx="{8*s:.0f}" fill="#a86a3a"/>'
            f'<rect x="{cx+102*s:.0f}" y="{cy-110*s:.0f}" width="{22*s:.0f}" height="{110*s:.0f}" rx="{8*s:.0f}" fill="#a86a3a"/>'
            f'<rect x="{cx-118*s:.0f}" y="{cy-96*s:.0f}" width="{236*s:.0f}" height="{34*s:.0f}" rx="{12*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-30*s:.0f} {cy-96*s:.0f} h{148*s:.0f} v{34*s:.0f} h-{148*s:.0f} Q{cx-46*s:.0f} {cy-80*s:.0f} {cx-30*s:.0f} {cy-96*s:.0f} Z" fill="{_lerp_hex(c,"#000000",0.12)}"/>'
            f'<rect x="{cx-112*s:.0f}" y="{cy-104*s:.0f}" width="{80*s:.0f}" height="{40*s:.0f}" rx="{16*s:.0f}" fill="#fff"/></g>')


def m_bridge(cx, cy, s=1.0, c="#c98a5a"):
    """A little arched footbridge. cy = deck base."""
    return (f'<g><path d="M{cx-140*s:.0f} {cy:.0f} Q{cx:.0f} {cy-120*s:.0f} {cx+140*s:.0f} {cy:.0f} '
            f'L{cx+140*s:.0f} {cy+18*s:.0f} Q{cx:.0f} {cy-100*s:.0f} {cx-140*s:.0f} {cy+18*s:.0f} Z" fill="{c}"/>'
            f'<path d="M{cx-140*s:.0f} {cy-8*s:.0f} Q{cx:.0f} {cy-128*s:.0f} {cx+140*s:.0f} {cy-8*s:.0f}" '
            f'stroke="{_lerp_hex(c,"#ffffff",0.4)}" stroke-width="{8*s:.0f}" fill="none"/>'
            + "".join(f'<line x1="{cx-120*s+i*40*s:.0f}" y1="{cy-70*s+abs(i-3)*10*s:.0f}" x2="{cx-120*s+i*40*s:.0f}" y2="{cy-96*s+abs(i-3)*10*s:.0f}" stroke="{_lerp_hex(c,"#ffffff",0.4)}" stroke-width="{5*s:.0f}"/>' for i in range(7))
            + "</g>")


def m_whale(cx, cy, s=1.0, c="#6a8fd8"):
    return (f'<g><path d="M{cx-120*s:.0f} {cy:.0f} Q{cx-120*s:.0f} {cy-70*s:.0f} {cx-20*s:.0f} {cy-70*s:.0f} '
            f'Q{cx+110*s:.0f} {cy-70*s:.0f} {cx+120*s:.0f} {cy-10*s:.0f} '
            f'Q{cx+150*s:.0f} {cy-40*s:.0f} {cx+160*s:.0f} {cy-6*s:.0f} '
            f'Q{cx+150*s:.0f} {cy+20*s:.0f} {cx+120*s:.0f} {cy+10*s:.0f} '
            f'Q{cx+100*s:.0f} {cy+40*s:.0f} {cx-40*s:.0f} {cy+40*s:.0f} '
            f'Q{cx-120*s:.0f} {cy+40*s:.0f} {cx-120*s:.0f} {cy:.0f} Z" fill="{c}"/>'
            f'<path d="M{cx-120*s:.0f} {cy+6*s:.0f} Q{cx-40*s:.0f} {cy+40*s:.0f} {cx+90*s:.0f} {cy+18*s:.0f} '
            f'L{cx+90*s:.0f} {cy+22*s:.0f} Q{cx-40*s:.0f} {cy+46*s:.0f} {cx-116*s:.0f} {cy+18*s:.0f} Z" fill="{_lerp_hex(c,"#ffffff",0.5)}"/>'
            f'<circle cx="{cx-70*s:.0f}" cy="{cy-30*s:.0f}" r="{6*s:.0f}" fill="#243"/>'
            f'<path d="M{cx-40*s:.0f} {cy-70*s:.0f} q-{6*s:.0f} -{36*s:.0f} {18*s:.0f} -{42*s:.0f} q-{14*s:.0f} {14*s:.0f} -{2*s:.0f} {42*s:.0f} Z" fill="#bfe3f5"/></g>')


def m_crab(cx, cy, s=1.0, c="#ff6b6b"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{48*s:.0f}" ry="{34*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-16*s:.0f}" cy="{cy-24*s:.0f}" r="{7*s:.0f}" fill="#fff"/><circle cx="{cx+16*s:.0f}" cy="{cy-24*s:.0f}" r="{7*s:.0f}" fill="#fff"/>'
            f'<circle cx="{cx-16*s:.0f}" cy="{cy-24*s:.0f}" r="{3.5*s:.0f}" fill="#243"/><circle cx="{cx+16*s:.0f}" cy="{cy-24*s:.0f}" r="{3.5*s:.0f}" fill="#243"/>'
            f'<path d="M{cx-40*s:.0f} {cy+2*s:.0f} q-{40*s:.0f} -{6*s:.0f} -{44*s:.0f} -{34*s:.0f}" stroke="{c}" stroke-width="{10*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<path d="M{cx+40*s:.0f} {cy+2*s:.0f} q{40*s:.0f} -{6*s:.0f} {44*s:.0f} -{34*s:.0f}" stroke="{c}" stroke-width="{10*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<circle cx="{cx-86*s:.0f}" cy="{cy-38*s:.0f}" r="{12*s:.0f}" fill="{c}"/><circle cx="{cx+86*s:.0f}" cy="{cy-38*s:.0f}" r="{12*s:.0f}" fill="{c}"/>'
            + "".join(f'<line x1="{cx+sgn*30*s:.0f}" y1="{cy+20*s:.0f}" x2="{cx+sgn*64*s:.0f}" y2="{cy+34*s:.0f}" stroke="{c}" stroke-width="{6*s:.0f}" stroke-linecap="round"/>' for sgn in (-1, 1))
            + "</g>")


def m_turtle(cx, cy, s=1.0, c="#5fae52"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{60*s:.0f}" ry="{44*s:.0f}" fill="#3e8f6a"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-6*s:.0f}" rx="{50*s:.0f}" ry="{36*s:.0f}" fill="{c}"/>'
            + "".join(f'<path d="M{cx+dx*s:.0f} {cy-6*s:.0f} l{10*s:.0f} -{10*s:.0f} l{10*s:.0f} {10*s:.0f} l-{10*s:.0f} {12*s:.0f} Z" fill="{_lerp_hex(c,"#2a6a44",0.4)}"/>' for dx in (-30, -6, 18))
            + f'<circle cx="{cx+64*s:.0f}" cy="{cy-4*s:.0f}" r="{18*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+72*s:.0f}" cy="{cy-8*s:.0f}" r="{4*s:.0f}" fill="#243"/>'
            f'<rect x="{cx-52*s:.0f}" y="{cy+30*s:.0f}" width="{20*s:.0f}" height="{16*s:.0f}" rx="{7*s:.0f}" fill="{c}"/>'
            f'<rect x="{cx+30*s:.0f}" y="{cy+30*s:.0f}" width="{20*s:.0f}" height="{16*s:.0f}" rx="{7*s:.0f}" fill="{c}"/></g>')


def m_frog(cx, cy, s=1.0, c="#5fc86a"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{52*s:.0f}" ry="{40*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy+18*s:.0f}" rx="{40*s:.0f}" ry="{22*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.4)}"/>'
            f'<circle cx="{cx-26*s:.0f}" cy="{cy-38*s:.0f}" r="{18*s:.0f}" fill="{c}"/><circle cx="{cx+26*s:.0f}" cy="{cy-38*s:.0f}" r="{18*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-26*s:.0f}" cy="{cy-40*s:.0f}" r="{9*s:.0f}" fill="#fff"/><circle cx="{cx+26*s:.0f}" cy="{cy-40*s:.0f}" r="{9*s:.0f}" fill="#fff"/>'
            f'<circle cx="{cx-26*s:.0f}" cy="{cy-40*s:.0f}" r="{4.5*s:.0f}" fill="#243"/><circle cx="{cx+26*s:.0f}" cy="{cy-40*s:.0f}" r="{4.5*s:.0f}" fill="#243"/>'
            f'<path d="M{cx-24*s:.0f} {cy+6*s:.0f} Q{cx:.0f} {cy+22*s:.0f} {cx+24*s:.0f} {cy+6*s:.0f}" stroke="#2a6a44" stroke-width="{4*s:.0f}" fill="none" stroke-linecap="round"/>'
            f'<ellipse cx="{cx-50*s:.0f}" cy="{cy+34*s:.0f}" rx="{16*s:.0f}" ry="{9*s:.0f}" fill="{c}"/><ellipse cx="{cx+50*s:.0f}" cy="{cy+34*s:.0f}" rx="{16*s:.0f}" ry="{9*s:.0f}" fill="{c}"/></g>')


def m_bird(cx, cy, s=1.0, c="#7cc4ff"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{34*s:.0f}" ry="{26*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+26*s:.0f}" cy="{cy-18*s:.0f}" r="{18*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+32*s:.0f}" cy="{cy-20*s:.0f}" r="{4*s:.0f}" fill="#243"/>'
            f'<path d="M{cx+42*s:.0f} {cy-16*s:.0f} l{16*s:.0f} {4*s:.0f} l-{16*s:.0f} {8*s:.0f} Z" fill="#ff9f45"/>'
            f'<path d="M{cx-6*s:.0f} {cy-4*s:.0f} q-{30*s:.0f} -{24*s:.0f} -{44*s:.0f} {4*s:.0f} q{24*s:.0f} {6*s:.0f} {44*s:.0f} {6*s:.0f} Z" fill="{_lerp_hex(c,"#000000",0.16)}"/>'
            f'<path d="M{cx-24*s:.0f} {cy+18*s:.0f} l{18*s:.0f} {20*s:.0f} l{10*s:.0f} -{16*s:.0f} Z" fill="{_lerp_hex(c,"#000000",0.2)}"/></g>')


def m_butterfly(cx, cy, s=1.0, c="#ff8fab"):
    return (f'<g><line x1="{cx:.0f}" y1="{cy-20*s:.0f}" x2="{cx:.0f}" y2="{cy+20*s:.0f}" stroke="#5a3a20" stroke-width="{5*s:.0f}" stroke-linecap="round"/>'
            f'<circle cx="{cx-24*s:.0f}" cy="{cy-16*s:.0f}" r="{20*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx+24*s:.0f}" cy="{cy-16*s:.0f}" r="{20*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-22*s:.0f}" cy="{cy+16*s:.0f}" r="{16*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.3)}"/>'
            f'<circle cx="{cx+22*s:.0f}" cy="{cy+16*s:.0f}" r="{16*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.3)}"/>'
            f'<path d="M{cx:.0f} {cy-22*s:.0f} q-{8*s:.0f} -{14*s:.0f} -{16*s:.0f} -{16*s:.0f}" stroke="#5a3a20" stroke-width="{3*s:.0f}" fill="none"/>'
            f'<path d="M{cx:.0f} {cy-22*s:.0f} q{8*s:.0f} -{14*s:.0f} {16*s:.0f} -{16*s:.0f}" stroke="#5a3a20" stroke-width="{3*s:.0f}" fill="none"/></g>')


def m_bear(cx, cy, s=1.0, c="#b98a5a"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy-40*s:.0f}" rx="{62*s:.0f}" ry="{56*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-110*s:.0f}" r="{46*s:.0f}" fill="{c}"/>'
            f'<circle cx="{cx-40*s:.0f}" cy="{cy-146*s:.0f}" r="{18*s:.0f}" fill="{c}"/><circle cx="{cx+40*s:.0f}" cy="{cy-146*s:.0f}" r="{18*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-96*s:.0f}" rx="{26*s:.0f}" ry="{20*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.4)}"/>'
            f'<circle cx="{cx-16*s:.0f}" cy="{cy-120*s:.0f}" r="{5*s:.0f}" fill="#243"/><circle cx="{cx+16*s:.0f}" cy="{cy-120*s:.0f}" r="{5*s:.0f}" fill="#243"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-100*s:.0f}" rx="{8*s:.0f}" ry="{6*s:.0f}" fill="#3a2a20"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-8*s:.0f}" rx="{40*s:.0f}" ry="{28*s:.0f}" fill="{_lerp_hex(c,"#ffffff",0.35)}"/></g>')


def m_fox(cx, cy, s=1.0, c="#ff8c42"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy-30*s:.0f}" rx="{54*s:.0f}" ry="{40*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx-70*s:.0f} {cy-20*s:.0f} Q{cx-120*s:.0f} {cy-30*s:.0f} {cx-108*s:.0f} {cy+10*s:.0f} Q{cx-90*s:.0f} {cy-4*s:.0f} {cx-64*s:.0f} {cy-8*s:.0f} Z" fill="{c}"/>'
            f'<path d="M{cx-108*s:.0f} {cy+10*s:.0f} Q{cx-118*s:.0f} {cy+2*s:.0f} {cx-114*s:.0f} {cy-8*s:.0f}" stroke="#fff" stroke-width="{8*s:.0f}" fill="none"/>'
            f'<circle cx="{cx+26*s:.0f}" cy="{cy-56*s:.0f}" r="{30*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx+6*s:.0f} {cy-78*s:.0f} L{cx-2*s:.0f} {cy-112*s:.0f} L{cx+22*s:.0f} {cy-86*s:.0f} Z" fill="{c}"/>'
            f'<path d="M{cx+46*s:.0f} {cy-78*s:.0f} L{cx+54*s:.0f} {cy-112*s:.0f} L{cx+30*s:.0f} {cy-86*s:.0f} Z" fill="{c}"/>'
            f'<path d="M{cx+18*s:.0f} {cy-44*s:.0f} q{8*s:.0f} {10*s:.0f} {16*s:.0f} 0 L{cx+26*s:.0f} {cy-30*s:.0f} Z" fill="#fff"/>'
            f'<circle cx="{cx+26*s:.0f}" cy="{cy-30*s:.0f}" r="{5*s:.0f}" fill="#243"/>'
            f'<circle cx="{cx+18*s:.0f}" cy="{cy-58*s:.0f}" r="{4*s:.0f}" fill="#243"/><circle cx="{cx+36*s:.0f}" cy="{cy-58*s:.0f}" r="{4*s:.0f}" fill="#243"/></g>')


def m_horse(cx, cy, s=1.0, c="#c98a5a"):
    return (f'<g><ellipse cx="{cx:.0f}" cy="{cy-70*s:.0f}" rx="{78*s:.0f}" ry="{46*s:.0f}" fill="{c}"/>'
            f'<path d="M{cx+50*s:.0f} {cy-90*s:.0f} Q{cx+120*s:.0f} {cy-120*s:.0f} {cx+118*s:.0f} {cy-160*s:.0f} '
            f'L{cx+92*s:.0f} {cy-160*s:.0f} Q{cx+94*s:.0f} {cy-128*s:.0f} {cx+40*s:.0f} {cy-108*s:.0f} Z" fill="{c}"/>'
            f'<circle cx="{cx+112*s:.0f}" cy="{cy-150*s:.0f}" r="{4*s:.0f}" fill="#243"/>'
            f'<path d="M{cx+70*s:.0f} {cy-150*s:.0f} q-{30*s:.0f} {8*s:.0f} -{40*s:.0f} {40*s:.0f}" stroke="#5a3a20" stroke-width="{10*s:.0f}" fill="none" stroke-linecap="round"/>'
            + "".join(f'<rect x="{cx+dx*s:.0f}" y="{cy-30*s:.0f}" width="{16*s:.0f}" height="{34*s:.0f}" rx="{6*s:.0f}" fill="{c}"/>' for dx in (-60, -24, 20, 54))
            + f'<path d="M{cx-78*s:.0f} {cy-80*s:.0f} q-{34*s:.0f} {10*s:.0f} -{30*s:.0f} {50*s:.0f}" stroke="#5a3a20" stroke-width="{10*s:.0f}" fill="none" stroke-linecap="round"/></g>')


def m_crown(cx, cy, s=1.0, c="#ffd54a"):
    return (f'<g><path d="M{cx-54*s:.0f} {cy:.0f} L{cx-54*s:.0f} {cy-40*s:.0f} L{cx-30*s:.0f} {cy-16*s:.0f} '
            f'L{cx:.0f} {cy-52*s:.0f} L{cx+30*s:.0f} {cy-16*s:.0f} L{cx+54*s:.0f} {cy-40*s:.0f} L{cx+54*s:.0f} {cy:.0f} Z" fill="{c}"/>'
            f'<rect x="{cx-54*s:.0f}" y="{cy-4*s:.0f}" width="{108*s:.0f}" height="{14*s:.0f}" rx="{5*s:.0f}" fill="{_lerp_hex(c,"#e0a020",0.5)}"/>'
            f'<circle cx="{cx:.0f}" cy="{cy-52*s:.0f}" r="{7*s:.0f}" fill="#ff6b6b"/>'
            f'<circle cx="{cx-54*s:.0f}" cy="{cy-40*s:.0f}" r="{6*s:.0f}" fill="#5fc86a"/><circle cx="{cx+54*s:.0f}" cy="{cy-40*s:.0f}" r="{6*s:.0f}" fill="#5fc86a"/>'
            f'<circle cx="{cx:.0f}" cy="{cy+3*s:.0f}" r="{5*s:.0f}" fill="#7cc4ff"/></g>')


def m_lamp(cx, cy, s=1.0, c="#ffcf5a"):
    """A standing lamp post with a warm glowing head. cy = base."""
    return (f'<g class="lamp"><ellipse class="lampglow" cx="{cx:.0f}" cy="{cy-206*s:.0f}" rx="{80*s:.0f}" ry="{80*s:.0f}" fill="{c}" opacity="0.18"/>'
            f'<rect x="{cx-6*s:.0f}" y="{cy-210*s:.0f}" width="{12*s:.0f}" height="{210*s:.0f}" rx="{5*s:.0f}" fill="#4a4a5a"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{28*s:.0f}" ry="{8*s:.0f}" fill="#4a4a5a"/>'
            f'<path d="M{cx-30*s:.0f} {cy-208*s:.0f} L{cx+30*s:.0f} {cy-208*s:.0f} L{cx+20*s:.0f} {cy-244*s:.0f} L{cx-20*s:.0f} {cy-244*s:.0f} Z" fill="#3a3a4a"/>'
            f'<ellipse cx="{cx:.0f}" cy="{cy-206*s:.0f}" rx="{22*s:.0f}" ry="{20*s:.0f}" fill="{c}"/>'
            f'<ellipse cx="{cx-6*s:.0f}" cy="{cy-210*s:.0f}" rx="{7*s:.0f}" ry="{9*s:.0f}" fill="#fff" opacity="0.5"/></g>')


def m_forest_band(seed, ground_y, s=1.0):
    """A row of little pines/trees along the horizon for a woodsy backdrop."""
    rnd = random.Random(seed ^ 0x51ed)
    out = []
    x = 40
    while x < W - 40:
        yy = ground_y + rnd.uniform(-10, 30)
        sc = rnd.uniform(0.5, 0.8) * s
        if rnd.random() < 0.5:
            out.append(m_pine(x, yy, sc, _lerp_hex("#2f8f57", "#1f6f42", rnd.random())))
        else:
            out.append(m_tree(x, yy, sc * 0.9, _lerp_hex("#3e9b58", "#2f7f48", rnd.random())))
        x += rnd.uniform(120, 190)
    return '<g opacity="0.92">' + "".join(out) + "</g>"


# ---------------------------------------------------------------- book themes

def book_theme(slug):
    T = {
        "sleepover":   dict(sky="night",  ground="floor", sig=["stars", "moon", "house"]),
        "bunnies":     dict(sky="day",    ground="grass", sig=["sun", "cloud", "rabbit", "flowers"]),
        "fairytale":   dict(sky="dusk",   ground="grass", sig=["castle", "lantern", "dragon", "stars"]),
        "carrace":     dict(sky="day",    ground="road",  sig=["sun", "cloud", "car", "flag"]),
        "space":       dict(sky="space",  ground=None,    sig=["stars", "planet", "rocket"]),
        "underwater":  dict(sky="sea",    ground="seabed",sig=["fish", "coral", "bubbles"]),
        "dinosaurs":   dict(sky="day",    ground="grass", sig=["sun", "dino", "tree", "volcano"]),
        "detective":   dict(sky="dusk",   ground="floor", sig=["house", "cake", "magnify"]),
        "pirates":     dict(sky="day",    ground="sand",  sig=["sun", "ship", "palm", "chest"]),
        "magicschool": dict(sky="dusk",   ground="floor", sig=["castle", "wand", "stars", "book"]),
        "jungle":      dict(sky="jungle", ground="grass", sig=["canopy", "monkey", "palm", "flowers"]),
        "superhero":   dict(sky="day",    ground="grass", sig=["sun", "cloud", "city", "cape"]),
        "robot":       dict(sky="day",    ground="grass", sig=["sun", "cloud", "house", "flowers"]),
        "bakery":      dict(sky="night",  ground="floor", sig=["house", "cake", "moon"]),
        "snowpup":     dict(sky="day",    ground="snow",  sig=["sun", "cloud", "pine", "mountain"]),
        "band":        dict(sky="day",    ground="grass", sig=["sun", "cloud", "house", "flowers"]),
        "campfire":    dict(sky="night",  ground="grass", sig=["moon", "stars", "forest", "fire", "tent"]),
    }
    return T.get(slug, dict(sky="day", ground="grass", sig=["sun", "cloud", "tree"]))


# keyword -> extra motif token.  Whole-word matched (see compose_svg), with a
# light singular stem, so "car" won't fire on "careful". Synonyms + plurals of a
# thing map to the same motif so a page that NAMES an object shows that object.
KW = {
    # sky / time of day
    "moon": "moon", "midnight": "moon", "moonlight": "moon", "star": "stars",
    "sun": "sun", "sunny": "sun", "morning": "sun", "sunrise": "sun", "sunshine": "sun",
    "cloud": "cloud", "sky": "cloud",
    # fire / campfire  ★
    "fire": "fire", "campfire": "fire", "bonfire": "fire", "flame": "fire",
    "marshmallow": "fire", "ember": "fire", "spark": "fire", "log": "fire",
    "tent": "tent", "camp": "tent",
    # weather
    "rain": "rain", "rainy": "rain", "storm": "rain", "drizzle": "rain",
    "snow": "snowfall", "snowy": "snowfall", "snowflake": "snowfall", "blizzard": "snowfall", "snowing": "snowfall",
    "rainbow": "rainbow",
    # castles / magic
    "castle": "castle", "palace": "castle", "tower": "castle",
    "dragon": "dragon", "lantern": "lantern", "festival": "lantern", "lamp": "lamp",
    "lamppost": "lamp", "streetlight": "lamp", "candle": "lamp", "torch": "lamp",
    "wand": "wand", "magic": "wand", "magical": "wand", "spell": "wand",
    "crown": "crown", "king": "crown", "queen": "crown", "princess": "crown", "prince": "crown",
    "book": "book",
    # space
    "rocket": "rocket", "spaceship": "rocket", "planet": "planet", "space": "stars",
    "alien": "alien", "astronaut": "rocket", "galaxy": "stars", "comet": "stars",
    # water / undersea
    "fish": "fish", "coral": "coral", "reef": "coral", "sea": "fish", "ocean": "fish",
    "pearl": "coral", "dolphin": "dolphin", "bubble": "bubbles", "seaweed": "coral",
    "whale": "whale", "crab": "crab", "turtle": "turtle", "shark": "fish",
    "river": "water", "lake": "water", "pond": "water", "stream": "water",
    "creek": "water", "puddle": "water",
    "bridge": "bridge", "frog": "frog", "lily": "water",
    # dinosaurs
    "dinosaur": "dino", "triceratops": "dino", "rex": "dino", "valley": "tree", "volcano": "volcano",
    # food / party
    "cake": "cake", "cupcake": "cake", "cookie": "cake", "pie": "cake", "candy": "cake",
    "birthday": "balloon", "balloon": "balloon",
    "clue": "magnify", "mystery": "magnify", "detective": "magnify", "magnifying": "magnify",
    # pirates / island
    "ship": "ship", "pirate": "ship", "sail": "boat", "boat": "boat", "rowboat": "boat",
    "canoe": "boat", "raft": "boat", "dinghy": "boat",
    "treasure": "chest", "gold": "chest", "island": "palm", "beach": "palm",
    "sand": "palm", "map": "chest", "coconut": "palm", "cove": "boat",
    # jungle
    "jungle": "canopy", "monkey": "monkey", "vine": "canopy", "tree": "tree", "leaf": "canopy",
    "forest": "forest", "woods": "forest", "wood": "forest",
    # people / places
    "hero": "cape", "city": "city", "mountain": "mountain",
    "grass": "flowers", "flower": "flowers", "garden": "flowers", "backyard": "flowers", "meadow": "flowers",
    "house": "house", "home": "house", "cottage": "house", "cabin": "house", "bakery": "house",
    "bed": "bed", "pillow": "bed", "bedroom": "bed",
    "kite": "kite", "ball": "ball",
    # animals / companions
    "rabbit": "rabbit", "bunny": "rabbit", "binky": "rabbit",
    "car": "car", "race": "car", "kart": "car", "derby": "flag", "finish": "flag", "checkered": "flag",
    "ghost": "ghost", "cat": "cat", "kitten": "cat", "dollhouse": "house",
    "clock": "clock", "marble": "marble", "owl": "owl", "parrot": "parrot", "macaw": "parrot",
    "dog": "dog", "puppy": "dog", "pup": "dog",
    "robot": "robot", "mouse": "mouse", "sled": "sled", "snowman": "snowman", "snowmen": "snowman",
    "bird": "bird", "butterfly": "butterfly", "bear": "bear", "fox": "fox", "horse": "horse",
    "flag": "flag",
}


# How to draw a character, inferred from its role description. Returns
# (motif_name, kwargs). Named companions (a dragon, a dolphin, the two rabbits)
# get their own creature; everyone else is a friendly little person.
def char_motif(role):
    r = (role or "").lower()
    def has(*ws):
        return any(w in r for w in ws)
    baby = has("baby", "little", "tiny", "small")
    if has("lop"):
        return ("rabbit", dict(body="#333333", belly="#f4f4f4", ears="lop"))
    if has("rex") or has("bunny") or has("rabbit"):
        body = "#e8c27a" if has("golden", "honey", "tan", "brown", "gold") else "#ffffff"
        return ("rabbit", dict(body=body, ears="up"))
    if has("dragon"):
        return ("dragon", dict())
    if has("dolphin"):
        return ("dolphin", dict())
    if has("parrot", "macaw"):
        return ("parrot", dict())
    if has("owl"):
        return ("owl", dict())
    if has("alien"):
        return ("alien", dict())
    if has("triceratops", "dinosaur", "dino"):
        return ("dino", dict(s=0.85 if baby else 1.0))
    if has("houseplant", "plant"):
        return ("plant", dict())
    if has("robot", "android", "bot"):
        return ("robot", dict())
    if has("mouse", "mice"):
        return ("mouse", dict())
    if has("dog", "puppy", "pup", "husky"):
        return ("dog", dict())
    if has("cat", "kitten"):
        return ("cat", dict())
    if has("ghost"):
        return ("ghost", dict())
    return ("person", dict(child=True))


def _defs():
    d = ""
    for name, (a, b) in SKIES.items():
        d += (f'<linearGradient id="sky_{name}" x1="0" y1="0" x2="0" y2="1">'
              f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>')
    return f"<defs>{d}</defs>"


def _place_ground(kind):
    if not kind:
        return ""
    gy = 1120
    c1 = GROUNDS.get(kind, "#79c56a"); c2 = GROUNDS.get(kind + "2", c1)
    if kind in ("seabed",):
        return f'<path d="M0 {gy} Q300 {gy-60} 600 {gy} T1200 {gy} L1200 {H} L0 {H}Z" fill="{c1}"/>'
    if kind == "road":
        road = f'<path d="M0 {H} L420 {gy} L780 {gy} L1200 {H}Z" fill="{c1}"/>'
        dashes = "".join(f'<rect x="{590-8}" y="{gy+40+k*120}" width="16" height="60" rx="8" fill="#ffd54a"/>' for k in range(4))
        grass = f'<rect x="0" y="{gy}" width="1200" height="{H-gy}" fill="#79c56a"/>'
        return grass + road + dashes
    # rolling ground
    return (f'<path d="M0 {gy+40} Q300 {gy-40} 600 {gy+20} T1200 {gy} L1200 {H} L0 {H}Z" fill="{c1}"/>'
            f'<path d="M0 {gy+120} Q400 {gy+60} 800 {gy+110} T1200 {gy+120} L1200 {H} L0 {H}Z" fill="{c2}"/>')


def _page_motifs(slug, page_text):
    """Return (sky, motifs, stems) for a page: signature motifs + keyword hits
    from the page's own words, plus a light day/night override from the text."""
    th = book_theme(slug)
    text = (page_text or "").lower()
    words = set(re.findall(r"[a-z]+", text))
    stems = set()
    for w in words:
        stems.add(w)
        if w.endswith("es") and len(w) > 4: stems.add(w[:-2])
        if w.endswith("s") and len(w) > 3: stems.add(w[:-1])

    motifs = list(th["sig"])
    for kw, mo in KW.items():
        if kw in stems and mo not in motifs:
            motifs.append(mo)

    # Day/night driven by the page text as well as the book. Only nudge in the
    # obvious cases so we never fight a book's intended mood.
    sky = th["sky"]
    night_words = {"night", "midnight", "moonlit", "moonlight", "starry", "bedtime"}
    day_words = {"sunrise", "morning", "sunny", "noon", "daytime", "sunshine", "dawn"}
    if sky in ("day", "sunset", "dusk", "jungle") and (night_words & stems) and not (day_words & stems):
        sky = "night"
    elif sky == "night" and (day_words & stems) and not (night_words & stems):
        sky = "day"
    return sky, motifs, stems


def compose_scene(slug, page_text, page_id, characters=None, suppress=()):
    """Build the page SVG and a dict of animation hints (positions of fire,
    water, lamps, weather) so scene_anim can add believable motion. `suppress`
    is a set of layer tokens to omit from the static art (used by the animator
    to own the motion of falling weather)."""
    seed = int(hashlib.md5(f"{slug}-{page_id}".encode()).hexdigest(), 16)
    rnd = random.Random(seed)
    raw = page_text or ""
    th = book_theme(slug)
    sky, motifs, stems = _page_motifs(slug, page_text)
    suppress = set(suppress)

    ground_y = 1120
    hints = {"sky": sky, "ground_y": ground_y, "fires": [], "water_y": None,
             "lamps": [], "weather": None, "rainbow": False, "sea": sky == "sea"}

    layers = [f'<rect width="{W}" height="{H}" fill="url(#sky_{sky})"/>']

    # ---- celestial / sky ----
    if sky in ("night", "space"):
        layers.append(m_stars(seed, n=30 if sky == "space" else 22, c="#ffffff"))
    elif sky == "dusk" and "stars" in motifs:
        layers.append(m_stars(seed, n=9, area=(0, 0, W, 420), c="#fff6ff"))
    want_moon = "moon" in motifs or (sky in ("night", "space") and "sun" not in stems)
    if want_moon and sky != "space":
        layers.append(m_moon(950, 300, 1.1))
    elif "sun" in motifs and sky not in ("night", "space"):
        layers.append(m_sun(960, 300, 1.0))
    if "planet" in motifs:
        layers.append(m_planet(300, 360, 1.0, rnd.choice(["#c98ad6", "#7cc4ff", "#ffb14a"])))
    if sky not in ("night", "space", "sea"):
        for _ in range(rnd.randint(2, 3)):
            layers.append(m_cloud(rnd.uniform(150, 1050), rnd.uniform(160, 460), rnd.uniform(0.6, 1.0)))
    if sky == "sea":
        layers.append(m_bubbles(seed, (0, 200, W, 1100)))
    if "kite" in motifs and sky not in ("space", "sea"):
        layers.append(m_kite(rnd.uniform(230, 420), rnd.uniform(240, 380), 1.0,
                             rnd.choice(["#e0575b", "#4a7bd6", "#5fc86a", "#ffd54a"])))

    # ---- far background ----
    if sky == "jungle" or "canopy" in motifs:
        layers.append(m_leaf_canopy())
    if "rainbow" in motifs and sky not in ("space", "sea"):
        layers.append(m_rainbow(600, ground_y - 40, 460, 1.0))
        hints["rainbow"] = True
    if "mountain" in motifs and sky != "space":
        snowcap = th["ground"] == "snow" or "snow" in stems or "snowfall" in motifs
        layers.append(m_mountain(300, ground_y + 30, 1.0, "#9aa6c8", snowcap))
        layers.append(m_mountain(820, ground_y + 20, 1.25, "#8390b8", snowcap))
    if sky != "space":
        layers.append(m_hill(300, ground_y+80, 1.0, _lerp_hex(SKIES[sky][0], "#4a8f52", 0.5)))
        layers.append(m_hill(950, ground_y+60, 1.2, _lerp_hex(SKIES[sky][0], "#3e7b46", 0.6)))
    if "forest" in motifs and sky != "space":
        layers.append(m_forest_band(seed, ground_y - 10, 1.0))
    if "city" in motifs:
        bx = 0; b = ""; rr = random.Random(seed+7)
        while bx < W:
            bw = rr.uniform(70, 130); bh = rr.uniform(160, 380)
            b += f'<rect x="{bx:.0f}" y="{ground_y-bh:.0f}" width="{bw:.0f}" height="{bh:.0f}" fill="#6b74a8"/>'
            bx += bw + rr.uniform(8, 30)
        layers.append(f'<g opacity="0.9">{b}</g>')
    if "volcano" in motifs:
        layers.append(f'<path d="M60 {ground_y} L260 {ground_y-260} L460 {ground_y}Z" fill="#8a6a5a"/><path d="M220 {ground_y-230} L260 {ground_y-260} L300 {ground_y-230} Z" fill="#ff7a4a"/>')

    # ---- ground ----
    layers.append(_place_ground(th["ground"]))

    # ---- water on a land page (river / lake / pond / stream): a pond band low
    #      in the foreground so characters stand on the grass above the shore ----
    if "water" in motifs and sky != "sea":
        wy = ground_y + 200
        layers.append(m_water_pool(wy, bottom=H))
        hints["water_y"] = wy

    # ---- midground features ----
    if "castle" in motifs:
        layers.append(m_castle(620, ground_y, 1.15, "#e7e0f2"))
    if "ship" in motifs:
        layers.append(m_ship(620, ground_y-30, 1.2))
    if "canopy" in motifs:
        layers.append(m_palm(180, ground_y+40, 1.1)); layers.append(m_palm(1040, ground_y+30, 1.0))
    if "bridge" in motifs and hints["water_y"] is not None:
        layers.append(m_bridge(600, hints["water_y"] + 20, 1.0))
    if "tent" in motifs:
        layers.append(m_tent(230, ground_y + 40, 1.0, rnd.choice(["#e0575b", "#4a7bd6", "#e08a3c"])))
    if "snowman" in motifs:
        layers.append(m_snowman(1000, ground_y + 30, 1.0))
    if "boat" in motifs:
        by = hints["water_y"] + 30 if hints["water_y"] is not None else ground_y + 60
        layers.append(m_boat(880, by, 1.0, rnd.choice(["#e0575b", "#4a7bd6", "#e08a3c"])))

    # -------- foreground: who and what the page talks about --------
    present = []
    low = raw.lower()
    for c in (characters or []):
        tok = str(c.get("token", ""))
        if tok and tok.lower() in low:
            mo, kw = char_motif(c.get("role", ""))
            present.append((mo, dict(kw), tok))
    present.sort(key=lambda t: 1 if t[0] == "person" else 0)
    trimmed, people = [], 0
    for mo, kw, tok in present:
        if mo == "person":
            people += 1
            if people > 1:
                continue
        trimmed.append((mo, kw, tok))
    present = trimmed

    # foreground props the page mentions, then a signature filler
    ITEM_FG = ("fire", "chest", "cake", "lantern", "lamp", "balloon", "magnify",
               "book", "flag", "marble", "clock", "ghost", "cat", "car", "dog",
               "owl", "parrot", "robot", "mouse", "snowman", "sled", "crown",
               "ball", "bed", "crab", "turtle", "frog", "bird", "butterfly",
               "bear", "fox", "horse", "whale")
    SIG_FG = ("dragon", "rocket", "dino", "car", "rabbit", "monkey", "tree",
              "fish", "coral", "cape", "wand", "fire")
    present_names = {p[0] for p in present}
    # things already drawn as scenery — don't duplicate them in the foreground
    drawn = set()
    for k in ("tent", "snowman", "boat", "bridge"):
        if k in motifs:
            drawn.add(k)
    fg = list(present)
    for mo in motifs:
        if mo in ITEM_FG and mo not in present_names and mo not in drawn and all(f[0] != mo for f in fg):
            fg.append((mo, {}, ""))
    for mo in motifs:
        if mo in SIG_FG and mo not in present_names and mo not in drawn and all(f[0] != mo for f in fg):
            fg.append((mo, {}, ""))

    # Fire is the warm heart of a scene: it always gets the front-center spot and
    # is drawn first so characters gather to its sides, never on top of it.
    fg.sort(key=lambda f: 0 if f[0] == "fire" else 1)
    fg = fg[:3]
    swim = sky == "sea"
    # front-center for fire, then the two sides; extra items go center-back.
    if fg and fg[0][0] == "fire":
        spots = [(600, ground_y + 150), (280, ground_y + 60), (930, ground_y + 60)]
    else:
        spots = [(300, ground_y + 70), (910, ground_y + 60), (600, ground_y + 120)]

    person_palette = (
        ["#f2c69b", "#e8b088", "#c98a5a", "#a86a3a", "#f7d7b0"],
        ["#4a7bd6", "#e0575b", "#3fae5a", "#f0a63c", "#8a5ad6", "#e06aa0"],
        ["#3a2a20", "#5a3a20", "#8a5a35", "#2a2a2a", "#c9843a"],
    )
    for i, (mo, kw, tok) in enumerate(fg):
        cx, cy = spots[i]
        if mo == "fire":
            layers.append(m_campfire(cx, cy, 1.2 if i == 0 else 0.9))
            hints["fires"].append((cx, cy, 1.2 if i == 0 else 0.9))
        elif mo == "dragon": layers.append(m_dragon(cx, cy - 40, kw.get("s", 1.0)))
        elif mo == "rocket": layers.append(m_rocket(cx, cy - 60, 1.0))
        elif mo == "dino": layers.append(m_dino(cx, cy - 30, kw.get("s", 1.0)))
        elif mo == "car": layers.append(m_car(cx, cy - 20, 1.0))
        elif mo == "rabbit":
            layers.append(m_rabbit(cx, cy - 6, 1.0, body=kw.get("body", "#ffffff"),
                                   belly=kw.get("belly"), ears=kw.get("ears", "up")))
        elif mo == "monkey": layers.append(m_monkey(cx, cy - 30, 1.0))
        elif mo == "dog": layers.append(m_dog(cx, cy, 1.0))
        elif mo == "cat": layers.append(m_cat(cx, cy, 1.0))
        elif mo == "robot": layers.append(m_robot(cx, cy, 1.0))
        elif mo == "mouse": layers.append(m_mouse(cx, cy, 1.0))
        elif mo == "parrot": layers.append(m_parrot(cx, cy - 60, 1.0))
        elif mo == "owl": layers.append(m_owl(cx, cy - 10, 1.0))
        elif mo == "dolphin": layers.append(m_dolphin(cx, cy - (330 if swim else 40), 1.0))
        elif mo == "alien": layers.append(m_alien(cx, cy, 1.0))
        elif mo == "ghost": layers.append(m_ghost(cx, cy - 30, 1.1))
        elif mo == "plant": layers.append(m_plant(cx, cy, 1.0))
        elif mo == "person":
            h = int(hashlib.md5((tok or str(i)).encode()).hexdigest(), 16)
            skin = person_palette[0][h % len(person_palette[0])]
            shirt = person_palette[1][(h // 7) % len(person_palette[1])]
            hair = person_palette[2][(h // 13) % len(person_palette[2])]
            layers.append(m_person(cx, cy, 1.0, skin=skin, shirt=shirt, hair=hair,
                                   child=kw.get("child", True)))
        elif mo == "cake": layers.append(m_cake(cx, cy, 1.0))
        elif mo == "wand": layers.append(m_wand(cx, cy - 30, 1.2))
        elif mo == "cape": layers.append(m_cape(cx, cy - 40, 1.0))
        elif mo == "tree": layers.append(m_tree(cx, cy, 1.0))
        elif mo == "palm": layers.append(m_palm(cx, cy, 1.0))
        elif mo == "house": layers.append(m_house(cx, cy, 1.0))
        elif mo == "fish": layers.append(m_fish(cx, cy - (300 if swim else 60), 1.2, rnd.choice(["#ff9f45", "#ffd54a", "#ff7aa2"])))
        elif mo == "coral": layers.append(m_coral(cx, cy + 20, 1.0, rnd.choice(["#ff7aa2", "#b98cff", "#ff9f45"])))
        elif mo == "lantern":
            layers.append(m_lantern(cx, cy + 10, 1.2)); hints["lamps"].append((cx, cy + 10 - 58 * 1.2))
        elif mo == "lamp":
            layers.append(m_lamp(cx, cy, 1.0)); hints["lamps"].append((cx, cy - 206))
        elif mo == "clock": layers.append(m_clock(cx, cy - 220, 1.0))
        elif mo == "marble": layers.append(m_marble(cx, cy - 10, 1.0))
        elif mo == "crown": layers.append(m_crown(cx, cy - 40, 1.4))
        elif mo == "ball": layers.append(m_ball(cx, cy - 46, 1.0, rnd.choice(["#e0575b", "#4a7bd6", "#ffd54a"])))
        elif mo == "bed": layers.append(m_bed(cx, cy, 1.0))
        elif mo == "sled": layers.append(m_sled(cx, cy, 1.0))
        elif mo == "snowman": layers.append(m_snowman(cx, cy, 1.0))
        elif mo == "crab": layers.append(m_crab(cx, cy - 20, 1.0))
        elif mo == "turtle": layers.append(m_turtle(cx, cy - (280 if swim else 20), 1.0))
        elif mo == "frog": layers.append(m_frog(cx, cy - 24, 1.0))
        elif mo == "bird": layers.append(m_bird(cx, cy - 40, 1.1))
        elif mo == "butterfly": layers.append(m_butterfly(cx, cy - 120, 1.0))
        elif mo == "bear": layers.append(m_bear(cx, cy, 1.0))
        elif mo == "fox": layers.append(m_fox(cx, cy, 1.0))
        elif mo == "horse": layers.append(m_horse(cx, cy, 1.0))
        elif mo == "whale": layers.append(m_whale(cx, cy - (300 if swim else 40), 1.0))
        elif mo == "balloon":
            for k in range(3): layers.append(m_balloon(cx - 40 + k * 40, cy - 160 - k * 10, 1.0, rnd.choice(["#ff6b6b", "#4a7bd6", "#ffd54a"])))
        elif mo == "magnify":
            layers.append(f'<g><circle cx="{cx}" cy="{cy-60}" r="46" fill="none" stroke="#5a3a86" stroke-width="14"/><line x1="{cx+32}" y1="{cy-28}" x2="{cx+70}" y2="{cy+10}" stroke="#5a3a86" stroke-width="16" stroke-linecap="round"/></g>')
        elif mo == "book":
            layers.append(f'<g><rect x="{cx-60}" y="{cy-40}" width="120" height="80" rx="8" fill="#c94a6a"/><rect x="{cx-6}" y="{cy-40}" width="12" height="80" fill="#8a2a48"/></g>')
        elif mo == "flag":
            layers.append(f'<g><rect x="{cx-3}" y="{cy-160}" width="6" height="160" fill="#333"/>' +
                          "".join(f'<rect x="{cx+col*15}" y="{cy-160+row*15}" width="15" height="15" fill="{("#333" if (col+row)%2==0 else "#fff")}"/>' for row in range(4) for col in range(6)) + "</g>")

    # grass flowers accent
    if th["ground"] in ("grass",) and "flowers" in motifs:
        layers.append(m_flowers(seed, ground_y+40))

    # ---- weather overlay (top): rain / snow. Suppressible so the animator can
    #      own the falling motion instead of doubling it. ----
    if "rain" in motifs and "rain" not in suppress and sky != "sea":
        layers.append(m_rain(seed)); hints["weather"] = "rain"
    elif "rain" in motifs:
        hints["weather"] = "rain"
    if ("snowfall" in motifs or th["ground"] == "snow") and sky != "sea":
        if "snow" not in suppress:
            layers.append(m_snowfall(seed))
        hints["weather"] = "snow"

    body = "".join(layers)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{_defs()}{body}</svg>'
    return svg, hints


def compose_svg(slug, page_text, page_id, characters=None):
    return compose_scene(slug, page_text, page_id, characters=characters)[0]


def render_png(slug, page_text, page_id, out_path, characters=None):
    import cairosvg
    svg = compose_svg(slug, page_text, page_id, characters=characters)
    cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=str(out_path), output_width=W, output_height=H)


if __name__ == "__main__":
    import sys
    # quick sample render for review
    samples = sys.argv[1:] or ["fairytale:1", "underwater:1", "space:1"]
    Path("art_samples").mkdir(exist_ok=True)
    tpls, chars = {}, {}
    for spec in samples:
        slug, pid = spec.split(":")
        if slug not in tpls:
            p = f"newbooks/{slug}.json"
            if not Path(p).exists(): p = f"{slug}.json"
            d = json.load(open(p))
            tpls[slug] = {str(x["id"]): x["text"] for x in d["pages"]}
            chars[slug] = d.get("characters", [])
        render_png(slug, tpls[slug].get(pid, ""), pid, f"art_samples/{slug}_{pid}.png",
                   characters=chars[slug])
        print("wrote", f"art_samples/{slug}_{pid}.png")
