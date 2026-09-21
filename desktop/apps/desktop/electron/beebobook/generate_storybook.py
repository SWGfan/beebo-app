#!/usr/bin/env python3
"""
generate_storybook.py  —  BeeboBook narration generator

Turns a tokenized story TEMPLATE + a set of name values into a personalized,
ready-to-play read-along: a filled-in story.json plus one narration MP3 per
page, written into a folder keyed by a hash of the name values.

The SAME script runs in two places, unchanged:
  * in the cloud, to pre-render the built-in "default names" narration that
    ships with the app, and
  * on the BeeboTV home server (the family PC), invoked by streamServer.js
    whenever a reader picks or changes names, to render narration that speaks
    those exact names.

Because the output folder is keyed by set_hash(values) — and the app computes
the identical hash — a name set that's already been rendered is found instantly
and never regenerated.

Usage:
  python generate_storybook.py <template.json> <out_root> [--values values.json]
         [--voice af_heart] [--charvoices charvoices.json]

  <out_root>    is the book's audio root; output goes to <out_root>/<setHash>/.
  --values      JSON object of { "{{TOKEN}}": "Name", ... }. Missing/blank tokens
                fall back to each character's template default. Omit for all-defaults.
  --voice       the NARRATOR voice id (default af_heart).
  --charvoices  JSON object of { "{{TOKEN}}": "voiceId", ... }, optional per-character
                voice overrides. A character whose quoted dialogue is read in its own
                voice; unlisted characters (and all narration) use the narrator voice.

Prints the resulting setHash on the last line as: SET_HASH=<hash>
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


# On Windows, every child process this generator launches (ffmpeg, espeak-ng via
# the voice engine, …) would otherwise flash up its own console window — a whole
# flurry of them while a book is being prepared. Force CREATE_NO_WINDOW onto
# every subprocess this process spawns, so narration generates completely
# silently in the background. No-op on macOS/Linux.
if sys.platform == "win32":
    _CREATE_NO_WINDOW = 0x08000000
    _orig_popen_init = subprocess.Popen.__init__

    def _silent_popen_init(self, *args, **kwargs):
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_NO_WINDOW
        _orig_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _silent_popen_init


# ----- personalization + hashing (MUST match the app's Kotlin port exactly) -----

def resolve_values(template: dict, provided: dict) -> dict:
    """For every character token in the template, pick the provided value
    (trimmed) if non-blank, else the character's own default. Returns an
    ordered {token: value} over the template's declared characters."""
    out = {}
    for c in template.get("characters", []):
        token = c["token"]
        supplied = (provided.get(token) or "").strip()
        out[token] = supplied if supplied else c.get("default", "")
    return out


DEFAULT_VOICE = "af_heart"


def set_hash(resolved: dict, narrator: str = DEFAULT_VOICE, char_voices: dict = None) -> str:
    """Deterministic 16-hex id for a resolved name set, the narrator voice, and any
    per-character voice overrides. Sorted by token so the app and server always agree
    regardless of insertion order.

    The identity rule MUST match byte-for-byte across the app and server:
      * the narrator voice is folded in as a "_voice=<v>" line ONLY when it isn't
        the default af_heart — so every book voiced by the default narrator with no
        overrides keeps its original names-only id and nothing re-renders;
      * each character override is folded in as a "_v:{{TOKEN}}=<v>" line, sorted by
        token, AFTER the "_voice=" line, and only when that override is a real voice
        that differs from the narrator (an override equal to the narrator is a no-op).
    """
    canonical = "\n".join(f"{tok}={resolved[tok]}" for tok in sorted(resolved))
    parts = []
    if narrator and narrator != DEFAULT_VOICE:
        parts.append(f"_voice={narrator}")
    cv = char_voices or {}
    for token in sorted(cv):
        v = cv[token]
        if v and v != narrator:
            parts.append(f"_v:{token}={v}")
    if parts:
        canonical += "\n" + "\n".join(parts)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def personalize(template: dict, resolved: dict) -> dict:
    import copy
    story = copy.deepcopy(template)

    def fill(s: str) -> str:
        for token, val in resolved.items():
            s = s.replace(token, val)
        return s

    story["coverMeta"] = {k: fill(v) for k, v in story.get("coverMeta", {}).items()}
    for page in story["pages"]:
        page["text"] = fill(page["text"])
        for choice in page.get("choices", []):
            choice["text"] = fill(choice["text"])
        if page.get("isEnding"):
            page["endingTitle"] = fill(page.get("endingTitle", ""))
    return story


# ----- spoken text (matches the reference generate_audio.py) -----

def build_page_audio_text(page: dict) -> str:
    # Narrator reads ONLY the story text — the app speaks the options itself, once,
    # after they appear on screen. Baking the choices in here made them get read
    # twice (once by the narrator, again by the app), so they're left out.
    return page["text"]


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")


def align_spans(body_text: str, word_timings: list) -> list:
    """Snap each spoken word (in order, with page-audio start/end seconds) onto a
    WHOLE on-screen word, returning [{cStart, cEnd, start, end}, ...] as character
    spans into the display text. Highlighting always covers a real word, never a
    space or half a word, and it self-resynchronizes when the voice tokenizer
    splits or merges a word (e.g. contractions). The spoken "Choice 1: ..." tail
    is dropped naturally: it has no matching on-screen words left, so the walk ends.
    """
    body_words = [(m.start(), m.end(), m.group().lower()) for m in _WORD_RE.finditer(body_text)]
    spans = []
    bi = 0
    for word, start, end in word_timings:
        w = (word or "").strip().lower()
        if not w or not any(ch.isalnum() for ch in w):
            continue
        if bi >= len(body_words):
            break
        # Prefer the next body word that matches; look ahead a little to resync.
        matched = None
        for j in range(bi, min(bi + 4, len(body_words))):
            bw = body_words[j][2]
            if bw == w or bw.startswith(w) or w.startswith(bw):
                matched = j
                break
        if matched is None:
            matched = bi  # no nearby match: keep moving in lockstep
        cs, ce, _ = body_words[matched]
        spans.append({"cStart": cs, "cEnd": ce,
                      "start": round(float(start), 3), "end": round(float(end), 3)})
        bi = matched + 1
    return spans


# ----- generation -----

def generate(template_path: str, out_root: str, provided: dict, narrator_voice: str = "af_heart",
             char_voices: dict = None, lang_code: str = "a") -> str:
    char_voices = char_voices or {}
    template = json.loads(Path(template_path).read_text(encoding="utf-8"))
    resolved = resolve_values(template, provided)
    sh = set_hash(resolved, narrator_voice, char_voices)
    # Any override that actually names a different voice than the narrator makes this
    # a multi-voice render; otherwise it collapses to a plain single-voice narration.
    multivoice = any(v and v != narrator_voice for v in char_voices.values())

    out_dir = Path(out_root) / sh
    out_dir.mkdir(parents=True, exist_ok=True)

    story = personalize(template, resolved)
    story["setHash"] = sh
    story["resolvedNames"] = resolved
    (out_dir / "story.json").write_text(json.dumps(story, ensure_ascii=False, indent=2),
                                        encoding="utf-8")

    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    timings_path = out_dir / "timings.json"
    timings = json.loads(timings_path.read_text()) if timings_path.exists() else {}

    # Per-page audio cache, shared across every name set of this book and keyed by
    # a hash of the exact spoken text. A page with no name in it produces the same
    # text for every reader, so it is voiced once and copied ever after; only the
    # pages that actually say a name are re-rendered when names change. The voice
    # model itself is loaded lazily, so a book whose pages are all cached needs no
    # model load at all.
    # The per-page audio cache is keyed by spoken text, so it MUST be scoped by the
    # full voice MIX — narrator + every non-default character override — otherwise a
    # page voiced by one mix would be reused for another. The default narrator with
    # no overrides keeps the ORIGINAL top-level cache path (nothing to re-warm, and
    # every already-warmed default page still hits); any other mix gets its own
    # subfolder keyed by a short signature of that mix.
    _overrides = sorted((tok, v) for tok, v in char_voices.items()
                        if v and v != narrator_voice)
    if narrator_voice == DEFAULT_VOICE and not _overrides:
        cache_dir = Path(out_root) / "_cache"
    else:
        _sig_src = narrator_voice + "|" + ";".join(f"{t}={v}" for t, v in _overrides)
        _sig = hashlib.sha256(_sig_src.encode("utf-8")).hexdigest()[:12]
        cache_dir = Path(out_root) / "_cache" / f"voice_{_sig}"
    cache_dir.mkdir(parents=True, exist_ok=True)

    import soundfile as sf
    import numpy as np
    from voice_engine import pipeline_for

    def synth(text, voice):
        pipe = pipeline_for(voice)
        chunks, word_timings, offset = [], [], 0.0
        for r in pipe(text, voice=voice):
            audio = r.audio
            audio = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
            for tok in (getattr(r, "tokens", None) or []):
                wt, st, en = getattr(tok, "text", None), getattr(tok, "start_ts", None), getattr(tok, "end_ts", None)
                if wt and st is not None and en is not None:
                    word_timings.append((wt, offset + float(st), offset + float(en)))
            chunks.append(audio)
            offset += len(audio) / 24000.0
        full = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        return full, word_timings

    # ---- name splicing: reuse a page's fixed audio, swap in only the names ----
    clip_dir = out_dir / "_clips"
    clip_dir.mkdir(parents=True, exist_ok=True)
    default_resolved = resolve_values(template, {})
    # The default set FOR THIS VOICE MIX — so name-splicing only ever reuses audio in
    # the same voice mix (a different mix has its own default to splice from).
    default_hash = set_hash(default_resolved, narrator_voice, char_voices)
    default_dir = Path(out_root) / default_hash
    is_default_set = (sh == default_hash)
    # default name value (lowercased) -> token, only for tokens whose value CHANGED
    # from the default and whose default is a real (non-blank) spoken word.
    val2tok = {}
    for tok, cv in resolved.items():
        dv = default_resolved.get(tok, "")
        if dv and cv != dv:
            val2tok[dv.lower()] = tok
    clip_cache = {}

    def synth_clip(name):
        """Voice one name with mid-phrase prosody, cut back out via its word timing."""
        name = (name or "").strip()
        if not name:
            return None
        full, wt = synth(f"and {name} went on", narrator_voice)
        first = name.lower().split()[0]
        seg = next(((s, e) for w, s, e in wt if (w or "").strip().lower() == first), None)
        if seg is None:
            return None
        a, b = max(0, int(seg[0] * 24000)), int(seg[1] * 24000)
        clip = full[a:b]
        if len(clip) < 240:
            return None
        p = clip_dir / f"clip_{abs(hash(name)) % 1000000}.wav"
        sf.write(str(p), clip, 24000)
        return (p, round(len(clip) / 24000.0, 3))

    def splice_page(page, pid, mp3_path):
        """Build this page's audio from the default page + fresh name clips. Returns
        (durationSec, spans) or None to fall back to a full re-render."""
        try:
            dmp3 = default_dir / f"page_{pid}.mp3"
            if not dmp3.exists():
                return None
            dstory = json.loads((default_dir / "story.json").read_text(encoding="utf-8"))
            dtext = next((p["text"] for p in dstory["pages"] if str(p["id"]) == pid), None)
            dtimings = json.loads((default_dir / "timings.json").read_text(encoding="utf-8")).get(pid, [])
            if not dtext or not dtimings:
                return None
            words = [{"text": dtext[s["cStart"]:s["cEnd"]], "start": float(s["start"]), "end": float(s["end"])}
                     for s in dtimings]
            slots = {i: val2tok[w["text"].lower()] for i, w in enumerate(words) if w["text"].lower() in val2tok}
            if not slots:
                return None
            for i, tok in slots.items():
                cv = resolved[tok]
                if cv not in clip_cache:
                    c = synth_clip(cv)
                    if c is None:
                        return None
                    clip_cache[cv] = c
            base_wav = out_dir / f"_base_{pid}.wav"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(dmp3), "-ar", "24000", "-ac", "1", str(base_wav)], check=True)
            # Build an ordered op list (a slice of the base, or a name clip) plus the
            # retimed word list, then assemble the whole page in ONE ffmpeg pass.
            ops, newwords, newtime, i, n = [], [], 0.0, 0, len(words)
            while i < n:
                if i in slots:
                    clip_wav, clip_dur = clip_cache[resolved[slots[i]]]
                    ops.append(("clip", clip_wav))
                    newwords.append({"text": resolved[slots[i]], "start": newtime, "end": newtime + clip_dur})
                    newtime += clip_dur
                    i += 1
                else:
                    j = i
                    while j < n and j not in slots:
                        j += 1
                    run = words[i:j]
                    a, b = run[0]["start"], run[-1]["end"]
                    ops.append(("base", a, b))
                    off = newtime - a
                    for w in run:
                        newwords.append({"text": w["text"], "start": off + w["start"], "end": off + w["end"]})
                    newtime += (b - a)
                    i = j
            inputs, filt, labels = [], [], []
            for k, op in enumerate(ops):
                if op[0] == "base":
                    inputs += ["-i", str(base_wav)]
                    filt.append(f"[{k}:a]atrim=start={op[1]:.3f}:end={op[2]:.3f},asetpts=PTS-STARTPTS[s{k}]")
                else:
                    inputs += ["-i", str(op[1])]
                    filt.append(f"[{k}:a]asetpts=PTS-STARTPTS[s{k}]")
                labels.append(f"[s{k}]")
            filt.append("".join(labels) + f"concat=n={len(ops)}:v=0:a=1[out]")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt),
                            "-map", "[out]", "-ar", "24000", "-ac", "1", "-b:a", "64k", str(mp3_path)], check=True)
            spans = align_spans(page["text"], [(w["text"], w["start"], w["end"]) for w in newwords])
            try: base_wav.unlink()
            except Exception: pass
            return (round(newtime, 2), spans)
        except Exception as e:
            print(f"  (splice failed page {pid}: {e}; re-rendering)")
            return None

    # ---- single-voice render of one page in the narrator voice (the base path,
    #      and the guaranteed fallback for a multi-voice page that fails) ----
    def render_single(page, pid, mp3_path):
        spoken = build_page_audio_text(page)
        full, word_timings = synth(spoken, narrator_voice)
        wav_tmp = out_dir / f"page_{pid}.wav"
        sf.write(str(wav_tmp), full, 24000)
        # Transcode to a small streamable MP3; ExoPlayer/media3 plays it natively.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_tmp),
             "-b:a", "64k", str(mp3_path)],
            check=True,
        )
        wav_tmp.unlink(missing_ok=True)
        dur = round(len(full) / 24000, 2)
        # Highlight spans map only onto the on-screen page text (never the choices).
        spans = align_spans(page["text"], word_timings)
        return dur, spans

    # ---- multi-voice: dialogue read by the speaking character's voice ----
    # Map each overriding character's spoken NAME (lowercased) to its voice. Built
    # once from the resolved names; only overrides that differ from the narrator.
    name2voice = {
        resolved[token].lower(): char_voices[token]
        for token in char_voices
        if char_voices[token] and char_voices[token] != narrator_voice
        and resolved.get(token)
    }
    # Match a quoted span (straight "..." or curly “...”), non-greedy, kept whole.
    _QUOTE_RE = re.compile(r'"[^"]*"|“[^”]*”')
    _ATTR_WINDOW = 90  # chars to scan on each side of a quote for a speaker name

    def _name_matches(window):
        """All (position, voice) for character names occurring in `window`, matched
        case-insensitively on word boundaries."""
        hits = []
        for name, v in name2voice.items():
            for m in re.finditer(r"\b" + re.escape(name) + r"\b", window, re.IGNORECASE):
                hits.append((m.start(), v))
        return hits

    # Words that mark actual SPEECH (not just any action). A name tied to one of these
    # is the speaker — the reliable signal, wherever the name sits relative to the quote.
    _SPEECH_VERBS = (r"said|says|asked|asks|called|calls|shouted|shouts|whispered|whispers|"
                     r"cried|cries|replied|replies|answered|answers|exclaimed|yelled|yells|"
                     r"chirped|chirps|squeaked|squeaks|hummed|sang|sings|hooted|hoots|added|"
                     r"adds|mumbled|murmured|gasped|groaned|announced|wondered|giggled")

    def _verb_attribution(text, s, e):
        """The strong signal: a name attached to a SPEECH verb, e.g. `said Sam`, `Sam
        said`, right after or right before the quote. Returns a voice or None."""
        after = text[e:e + _ATTR_WINDOW]
        # `"..." said Sam`  /  `"...", said Sam`
        m = re.match(r"\s*[,]?\s*(?:" + _SPEECH_VERBS + r")\s+([A-Za-z][A-Za-z'’\-]*)", after, re.IGNORECASE)
        if not m:
            # `"..." Sam said`
            m = re.match(r"\s*[,]?\s*([A-Za-z][A-Za-z'’\-]*)\s+(?:" + _SPEECH_VERBS + r")", after, re.IGNORECASE)
        if m:
            v = name2voice.get(m.group(1).lower())
            if v:
                return v
        before = text[max(0, s - _ATTR_WINDOW):s]
        # `Sam said, "..."`  — the name+verb immediately before the quote.
        m = re.search(r"([A-Za-z][A-Za-z'’\-]*)\s+(?:" + _SPEECH_VERBS + r")\s*[,:]?\s*$", before, re.IGNORECASE)
        if m:
            v = name2voice.get(m.group(1).lower())
            if v:
                return v
        return None

    def _attribute_quote(text, s, e):
        """Pick the voice for the quote at text[s:e]. First trust a speech-verb
        attribution (`said Sam` / `Sam said`) on either side — that's the speaker no
        matter where the name sits. Failing that, fall back to the nearest character
        name within THIS sentence (ahead first, then behind), so a name in the next
        sentence can never steal the line. Default: the narrator."""
        v = _verb_attribution(text, s, e)
        if v:
            return v
        # Fallback: nearest name, ahead first, cut at this sentence's boundary.
        after_full = text[e:e + _ATTR_WINDOW]
        m = re.search(r'[.!?]', after_full)
        after = after_full[:m.start()] if m else after_full
        hits = _name_matches(after)
        if hits:
            return min(hits, key=lambda h: h[0])[1]
        before_full = text[max(0, s - _ATTR_WINDOW):s]
        bounds = list(re.finditer(r'[.!?]', before_full))
        before = before_full[bounds[-1].end():] if bounds else before_full
        hits = _name_matches(before)
        if hits:
            return max(hits, key=lambda h: h[0])[1]
        return narrator_voice

    def _segment_runs(page_text, tail):
        """Ordered (voice, text) runs: quoted spans in the page text go to their
        speaker's voice, everything else (and the appended Choice tail) narrates.
        Adjacent same-voice runs are merged. Every source character is preserved,
        so concatenating the run texts reproduces the spoken text exactly."""
        runs = []
        idx = 0
        for m in _QUOTE_RE.finditer(page_text):
            s, e = m.start(), m.end()
            if s > idx:
                runs.append((narrator_voice, page_text[idx:s]))
            runs.append((_attribute_quote(page_text, s, e), page_text[s:e]))
            idx = e
        if idx < len(page_text):
            runs.append((narrator_voice, page_text[idx:]))
        if tail:
            runs.append((narrator_voice, tail))
        merged = []
        for v, t in runs:
            if merged and merged[-1][0] == v:
                merged[-1] = (v, merged[-1][1] + t)
            else:
                merged.append((v, t))
        return merged

    def render_multivoice(page, pid, mp3_path):
        page_text = page["text"]
        spoken = build_page_audio_text(page)
        # The Choice tail (if any) is whatever build_page_audio_text appended after
        # the page text; it always narrates.
        tail = spoken[len(page_text):]
        runs = _segment_runs(page_text, tail)
        chunks, all_word_timings, cum = [], [], 0.0
        for v, t in runs:
            if not t.strip():
                continue
            full, wt = synth(t, v)
            for w, st, en in wt:
                all_word_timings.append((w, cum + st, cum + en))
            chunks.append(full)
            cum += len(full) / 24000.0
        if not chunks:
            raise RuntimeError("no audio produced")
        full_audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        wav_tmp = out_dir / f"page_{pid}.wav"
        sf.write(str(wav_tmp), full_audio, 24000)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_tmp),
             "-b:a", "64k", str(mp3_path)],
            check=True,
        )
        wav_tmp.unlink(missing_ok=True)
        dur = round(len(full_audio) / 24000, 2)
        # Highlighting still maps onto the on-screen page text, exactly as the
        # single-voice path does.
        spans = align_spans(page["text"], all_word_timings)
        return dur, spans

    generated, skipped, reused, spliced_n = 0, 0, 0, 0
    for page in story["pages"]:
        pid = str(page["id"])
        spoken = build_page_audio_text(page)
        h = text_hash(spoken)
        mp3_path = out_dir / f"page_{pid}.mp3"

        # Already correct in THIS set (audio + timings present, text unchanged).
        if manifest.get(pid, {}).get("hash") == h and mp3_path.exists() and pid in timings:
            skipped += 1
            continue

        cache_mp3 = cache_dir / f"{h}.mp3"
        cache_meta = cache_dir / f"{h}.json"
        if cache_mp3.exists() and cache_meta.exists():
            # Voiced before for this exact text (e.g. a nameless page) — reuse it.
            shutil.copyfile(cache_mp3, mp3_path)
            meta = json.loads(cache_meta.read_text())
            manifest[pid] = {"hash": h, "file": mp3_path.name, "durationSec": meta["durationSec"]}
            timings[pid] = meta["spans"]
            reused += 1
            continue

        # A page that says a name: reuse its fixed audio, splice in only the new
        # name(s). Falls back to a full render if anything looks off. Splicing reuses
        # a single-voice base clip, so it is DISABLED for a multi-voice mix.
        if not multivoice and not is_default_set:
            res = splice_page(page, pid, mp3_path)
            if res is not None:
                dur, spans = res
                manifest[pid] = {"hash": h, "file": mp3_path.name, "durationSec": dur}
                timings[pid] = spans
                shutil.copyfile(mp3_path, cache_mp3)
                cache_meta.write_text(json.dumps({"durationSec": dur, "spans": spans}, ensure_ascii=False))
                spliced_n += 1
                print(f"  page {pid}: spliced ({dur}s)")
                continue

        if multivoice:
            try:
                dur, spans = render_multivoice(page, pid, mp3_path)
                print(f"  page {pid}: {dur}s, {len(spans)} words (multi-voice)")
            except Exception as e:
                # Never leave a page unvoiced: fall back to a full single-voice
                # narrator render of this page.
                print(f"  (multivoice failed page {pid}: {e}; single-voice re-render)")
                dur, spans = render_single(page, pid, mp3_path)
                print(f"  page {pid}: {dur}s, {len(spans)} words")
        else:
            dur, spans = render_single(page, pid, mp3_path)
            print(f"  page {pid}: {dur}s, {len(spans)} words")

        manifest[pid] = {"hash": h, "file": mp3_path.name, "durationSec": dur}
        timings[pid] = spans
        # Seed the shared cache for future name sets of this book.
        shutil.copyfile(mp3_path, cache_mp3)
        cache_meta.write_text(json.dumps({"durationSec": dur, "spans": spans}, ensure_ascii=False))
        generated += 1

    # ----- narrator-voiced CHOICE clips -------------------------------------
    # The two options are read in the SAME gentle narrator voice as the page
    # (never the app's on-device robot voice). Each branching page gets a short
    # separate clip that the app plays AFTER it has revealed the option buttons,
    # so the flow is: page is read -> 1s pause -> options appear -> narrator says
    # them. Entirely best-effort and isolated from the page narration above: any
    # failure just leaves a page without a choices clip (the app shows the options
    # silently) and never disturbs the story audio, which is already written.
    for page in story["pages"]:
        if page.get("isEnding"):
            continue
        opts = [str(c.get("text", "")).strip() for c in page.get("choices", [])]
        opts = [o for o in opts if o]
        if len(opts) < 2:
            continue
        pid = str(page["id"])
        # Cache/skip key: the exact spoken options plus the narrator voice, so a
        # different voice (or edited option text) re-renders but an unchanged one is reused.
        ctext = " \u2026 ".join(opts)
        ch = text_hash("CHOICES|" + str(narrator_voice) + "|" + ctext)
        ch_mp3 = out_dir / f"page_{pid}_choices.mp3"
        entry = manifest.get(pid) or {}
        if entry.get("choicesHash") == ch and ch_mp3.exists():
            continue
        cache_ch_mp3 = cache_dir / f"choices_{ch}.mp3"
        try:
            if cache_ch_mp3.exists():
                shutil.copyfile(cache_ch_mp3, ch_mp3)
            else:
                gap = np.zeros(int(0.55 * 24000), dtype="float32")  # a breath between the two options
                pieces = []
                for i, o in enumerate(opts):
                    say = o if o.endswith((".", "!", "?", "\u2026")) else (o + ".")
                    audio, _wt = synth(say, narrator_voice)
                    if i:
                        pieces.append(gap)
                    pieces.append(audio)
                full = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
                wav_tmp = out_dir / f"page_{pid}_choices.wav"
                sf.write(str(wav_tmp), full, 24000)
                subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_tmp),
                     "-b:a", "64k", str(ch_mp3)],
                    check=True,
                )
                wav_tmp.unlink(missing_ok=True)
                shutil.copyfile(ch_mp3, cache_ch_mp3)
            entry["choicesHash"] = ch
            entry["choicesFile"] = ch_mp3.name
            manifest[pid] = entry
            print(f"  page {pid}: choices clip ready")
        except Exception as e:
            print(f"  (choices clip failed page {pid}: {e})")

    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    timings_path.write_text(json.dumps(timings, ensure_ascii=False), encoding="utf-8")
    # A .ready marker the server checks to know generation finished cleanly.
    (out_dir / ".ready").write_text("1")
    try:
        shutil.rmtree(clip_dir)
    except Exception:
        pass
    print(f"(reused {reused} cached, spliced {spliced_n} name pages)")
    print(f"Done: {generated} generated, {skipped} cached -> {out_dir}")
    print(f"SET_HASH={sh}")
    return sh


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("template")
    ap.add_argument("out_root")
    ap.add_argument("--values", default=None, help="JSON object of {{TOKEN}}: Name")
    ap.add_argument("--voice", default="af_heart", help="narrator voice id")
    ap.add_argument("--charvoices", default=None,
                    help="JSON object of {{TOKEN}}: voiceId, per-character voice overrides")
    args = ap.parse_args()

    provided = {}
    if args.values:
        p = Path(args.values)
        provided = json.loads(p.read_text(encoding="utf-8") if p.exists() else args.values)

    charvoices = {}
    if args.charvoices:
        p = Path(args.charvoices)
        charvoices = json.loads(p.read_text(encoding="utf-8") if p.exists() else args.charvoices)

    generate(args.template, args.out_root, provided,
             narrator_voice=args.voice, char_voices=charvoices)
