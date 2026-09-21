#!/usr/bin/env python3
"""Standalone scene + animation baker for ONE BeeboBook.

Given a book folder that contains template.json, render every page's scene
picture (scenes/page_N.png) and a gently-looping moving background
(anim/page_N.gif), using the same free, offline art code the built-in books
use. Runs entirely on the home PC — no cloud, no API, no Claude.

    python bake_book.py <book_dir> [--no-anim]

<book_dir> is e.g. .../storybooks/cowrite-abc123 (holds template.json).
"""
import sys, json
from pathlib import Path
import scene_art
import scene_anim


def bake(book_dir, do_anim=True, verbose=True):
    book_dir = Path(book_dir)
    tpl = json.load(open(book_dir / "template.json", encoding="utf-8"))
    slug = book_dir.name
    pages = {str(p["id"]): p.get("text", "") for p in tpl.get("pages", [])}
    chars = tpl.get("characters", [])
    # Feed the animator's book cache so it doesn't need to locate the template.
    scene_anim._BOOK_CACHE[slug] = (pages, chars)
    scenes = book_dir / "scenes"; scenes.mkdir(parents=True, exist_ok=True)
    anim = book_dir / "anim"; anim.mkdir(parents=True, exist_ok=True)
    n = 0
    for pid, text in pages.items():
        try:
            scene_art.render_png(slug, text, pid, scenes / f"page_{pid}.png", characters=chars)
            n += 1
        except Exception as e:
            if verbose: print(f"  ! scene {slug} p{pid}: {e}")
        if do_anim:
            try:
                scene_anim.animate_page(slug, pid, chars, anim / f"page_{pid}.gif")
            except Exception as e:
                if verbose: print(f"  ! anim {slug} p{pid}: {e}")
    if verbose: print(f"baked {slug}: {n}/{len(pages)} scenes"
                      + ("" if do_anim else " (no anim)"))
    return n


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: python bake_book.py <book_dir> [--no-anim]"); sys.exit(2)
    bake(args[0], do_anim=("--no-anim" not in sys.argv))
