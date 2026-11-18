#!/usr/bin/env python3
"""
KhabarShow — Studio-Grade Newspaper Audio & Video Show Generator.
Uses Kokoro-82M multi-voice TTS + FFmpeg per-line synced captions, story progress bar,
rounded article cards, floating callout pills, speaker avatar dock, and smooth zoom motion.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import textwrap
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SAMPLE_RATE = 24000
CACHE_DIR = Path.home() / ".cache" / "epaper-show"
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = FONT_BOLD_CANDIDATES if bold else FONT_REG_CANDIDATES
    for p in candidates:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size=size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def ensure_kokoro_models() -> tuple[Path, Path]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    model_path = CACHE_DIR / "kokoro-v1.0.int8.onnx"
    voices_path = CACHE_DIR / "voices-v1.0.bin"
    if not model_path.is_file():
        urllib.request.urlretrieve(MODEL_URL, model_path)
    if not voices_path.is_file():
        urllib.request.urlretrieve(VOICES_URL, voices_path)
    return model_path, voices_path


def make_chime(duration_sec: float = 1.0, freqs: tuple[float, ...] = (523.25, 659.25, 783.99)) -> np.ndarray:
    t = np.linspace(0, duration_sec, int(SAMPLE_RATE * duration_sec), endpoint=False)
    wave = np.zeros_like(t)
    for i, f in enumerate(freqs):
        delay = i * 0.08
        mask = t >= delay
        env = np.zeros_like(t)
        env[mask] = np.exp(-3.5 * (t[mask] - delay)) * np.minimum(1.0, (t[mask] - delay) / 0.015)
        wave += 0.13 * env * np.sin(2 * np.pi * f * t)
    return wave.astype(np.float32)


def make_silence(sec: float) -> np.ndarray:
    return np.zeros(int(SAMPLE_RATE * sec), dtype=np.float32)


def make_whoosh(duration_sec: float = 0.28) -> np.ndarray:
    """Crisp broadcast transition whoosh + soft sub-thump."""
    n = int(SAMPLE_RATE * duration_sec)
    t = np.linspace(0, duration_sec, n, endpoint=False, dtype=np.float32)
    rng = np.random.default_rng(42)
    noise = rng.standard_normal(n).astype(np.float32)
    # Smooth moving-average lowpass for warm whoosh texture
    win = 18
    noise = np.convolve(noise, np.ones(win, dtype=np.float32) / win, mode="same")
    env = np.sin(np.pi * t / duration_sec) ** 1.4
    sub = 0.22 * np.sin(2 * np.pi * (95 - 50 * (t / duration_sec)) * t) * np.exp(-8.0 * t)
    return (0.18 * noise * env + sub).astype(np.float32)


def make_ui_pop(duration_sec: float = 0.13) -> np.ndarray:
    """Warm marimba/UI pop synced to progressive fact reveals."""
    n = int(SAMPLE_RATE * duration_sec)
    t = np.linspace(0, duration_sec, n, endpoint=False, dtype=np.float32)
    freq = 660.0 + 440.0 * np.exp(-28.0 * t)
    env = np.exp(-22.0 * t) * np.minimum(1.0, t / 0.006)
    wave = 0.20 * env * (np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t))
    return wave.astype(np.float32)


def make_sports_sting(duration_sec: float = 0.55) -> np.ndarray:
    """Upbeat percussive sting for sports thrillers."""
    return make_chime(duration_sec, (523.25, 659.25, 783.99, 1046.5)) * 1.15


def make_music_bed(duration_sec: float) -> np.ndarray:
    """Warm ambient newsroom lo-fi chord bed (Cmaj7 -> Am7 -> Fmaj7 -> G6, 8s loop)."""
    loop_sec = 8.0
    n_loop = int(SAMPLE_RATE * loop_sec)
    t = np.linspace(0, loop_sec, n_loop, endpoint=False, dtype=np.float32)
    chords = [
        (261.63, 329.63, 392.00, 493.88),  # Cmaj7
        (220.00, 261.63, 329.63, 392.00),  # Am7
        (174.61, 220.00, 261.63, 329.63),  # Fmaj7
        (196.00, 246.94, 293.66, 329.63),  # G6
    ]
    bar = loop_sec / 4.0
    bed = np.zeros(n_loop, dtype=np.float32)
    for idx, chord in enumerate(chords):
        s0, s1 = int(idx * bar * SAMPLE_RATE), int((idx + 1) * bar * SAMPLE_RATE)
        seg_t = t[s0:s1] - idx * bar
        env = np.minimum(1.0, seg_t / 0.18) * np.minimum(1.0, (bar - seg_t) / 0.18)
        # Subtle rhythmic pulse at 120 BPM (2 Hz)
        pulse = 0.78 + 0.22 * np.sin(2 * np.pi * 2.0 * seg_t)
        tone = np.zeros_like(seg_t)
        for f in chord:
            tone += 0.22 * np.sin(2 * np.pi * f * seg_t) + 0.05 * np.sin(2 * np.pi * (f * 2.0) * seg_t)
        # Soft sub bass root
        tone += 0.25 * np.sin(2 * np.pi * (chord[0] * 0.5) * seg_t)
        bed[s0:s1] = tone * env * pulse

    total_samples = int(np.ceil(duration_sec * SAMPLE_RATE))
    reps = int(np.ceil(total_samples / n_loop))
    full = np.tile(bed, reps)[:total_samples].astype(np.float32)
    # Normalize bed peak cleanly before sidechain ducking
    peak = float(np.max(np.abs(full))) if len(full) else 1.0
    if peak > 0:
        full = full / peak * 0.35
    return full


def make_gradient_bg(W: int, H: int) -> Image.Image:
    """Create a rich deep-navy to crimson-slate ambient studio backdrop."""
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, W, dtype=np.float32)[None, :]
    r = (14 + 34 * (y ** 1.6) + 18 * (1 - x) * y).clip(0, 255)
    g = (24 + 10 * (1 - y) + 12 * x * (1 - y)).clip(0, 255)
    b = (58 + 38 * (1 - y) - 14 * y).clip(0, 255)
    r, g, b = np.broadcast_arrays(r, g, b)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    img = Image.fromarray(rgb, mode="RGB").convert("RGBA")

    # Subtle ambient bokeh circles
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([int(W * 0.65), int(H * 0.05), int(W * 1.1), int(H * 0.35)], fill=(59, 130, 246, 35))
    gd.ellipse([int(-W * 0.15), int(H * 0.68), int(W * 0.55), int(H * 1.05)], fill=(225, 29, 72, 42))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=60))
    return Image.alpha_composite(img, glow).convert("RGB")


def hex_to_rgb(hex_str: str | None, default: tuple[int, int, int] = (37, 99, 235)) -> tuple[int, int, int]:
    if not hex_str or not isinstance(hex_str, str):
        return default
    h = hex_str.strip().lstrip("#")
    if len(h) != 6:
        return default
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return default


def load_external_audio(wav_path: Path) -> np.ndarray:
    """Load an external WAV (e.g. Kaggle IndicF5), resample to 24 kHz, and normalize loudness."""
    wave, sr = sf.read(str(wav_path), dtype="float32")
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    if sr != SAMPLE_RATE and len(wave) > 1:
        new_len = int(round(len(wave) * SAMPLE_RATE / sr))
        old_idx = np.linspace(0.0, 1.0, len(wave), dtype=np.float64)
        new_idx = np.linspace(0.0, 1.0, new_len, dtype=np.float64)
        wave = np.interp(new_idx, old_idx, wave).astype(np.float32)
    rms = float(np.sqrt(np.mean(wave ** 2))) if len(wave) else 0.0
    if rms > 1e-4:
        wave = wave * (0.14 / rms)
    peak = float(np.max(np.abs(wave))) if len(wave) else 0.0
    if peak > 0.88:
        wave = wave * (0.88 / peak)
    return wave.astype(np.float32)


def draw_rounded_card(
    canvas: Image.Image,
    clip_path: str | None,
    box: tuple[int, int, int, int],
    callout: str,
    font_callout: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    chapter_meta: dict[str, Any] | None = None,
    is_vertical: bool = False,
    line_idx: int = 0,
    total_lines: int = 1,
) -> None:
    x0, y0, x1, y1 = box
    cw, ch = x1 - x0, y1 - y0
    radius = 28
    meta = chapter_meta or {}
    stat_hero = meta.get("stat_hero") or {}
    key_points = [str(k) for k in (meta.get("key_points") or []) if str(k).strip()]
    why_matters = str(meta.get("why_it_matters") or "").strip()
    category = str(meta.get("category") or "").strip().upper()

    # Progressive reveal: facts pop in one-by-one as host speaks each line
    n_pts = len(key_points)
    if total_lines <= 1 or line_idx >= total_lines - 1:
        reveal_count = n_pts
        show_why = True
        active_pt = max(0, min(n_pts - 1, line_idx))
    else:
        reveal_count = min(n_pts, line_idx + 1)
        show_why = False
        active_pt = max(0, reveal_count - 1)
    accent = hex_to_rgb(stat_hero.get("accent"), (225, 29, 72))
    soft_tint = (
        int(255 * 0.90 + accent[0] * 0.10),
        int(255 * 0.90 + accent[1] * 0.10),
        int(255 * 0.90 + accent[2] * 0.10),
        255,
    )
    has_depth = bool(stat_hero or key_points or why_matters)

    # White rounded container
    card = Image.new("RGBA", (cw, ch), (255, 255, 255, 255))
    cd = ImageDraw.Draw(card)

    if not is_vertical and has_depth:
        # 16:9 Split Studio Layout: Left 57% newspaper clip, Right 41% contextual facts & numbers
        split_x = int(cw * 0.575)
        pad = 24
        well_box = [pad, pad, split_x - 16, ch - pad - 14]
        cd.rounded_rectangle(well_box, radius=18, fill=(248, 250, 252, 255), outline=(226, 232, 240, 255), width=2)
        if clip_path and Path(clip_path).is_file():
            clip = Image.open(clip_path).convert("RGB")
            ww = (well_box[2] - well_box[0]) - 24
            wh = (well_box[3] - well_box[1]) - 24
            clip.thumbnail((ww, wh), Image.Resampling.LANCZOS)
            cx = well_box[0] + 12 + (ww - clip.width) // 2
            cy = well_box[1] + 12 + (wh - clip.height) // 2
            card.paste(clip, (cx, cy))

        # Subtle vertical divider
        cd.line([(split_x, pad + 8), (split_x, ch - pad - 20)], fill=(226, 232, 240, 255), width=2)

        # Right Panel: Contextual Facts, Numbers & Key Points
        rx0 = split_x + 26
        rx1 = cw - 28
        rw = rx1 - rx0
        ry = pad + 4

        f_cat = load_font(17, bold=True)
        f_stat_val = load_font(46, bold=True)
        f_stat_lbl = load_font(16, bold=True)
        f_sec = load_font(15, bold=True)
        f_pt = load_font(20, bold=False)
        f_pt_num = load_font(17, bold=True)
        f_why = load_font(18, bold=False)

        if category:
            cb = cd.textbbox((0, 0), category, font=f_cat)
            cpw, cph = (cb[2] - cb[0]) + 24, (cb[3] - cb[1]) + 12
            cd.rounded_rectangle([rx0, ry, rx0 + cpw, ry + cph], radius=cph // 2, fill=soft_tint)
            cd.text((rx0 + 12, ry + 5), category, fill=accent + (255,), font=f_cat)
            ry += cph + 14

        if stat_hero.get("value"):
            sval = str(stat_hero.get("value", ""))
            slbl = str(stat_hero.get("label", "")).upper()
            sh_box = [rx0, ry, rx1, ry + 102]
            cd.rounded_rectangle(sh_box, radius=16, fill=soft_tint)
            cd.rounded_rectangle([rx0, ry, rx0 + 8, ry + 102], radius=4, fill=accent + (255,))
            cd.text((rx0 + 24, ry + 12), sval, fill=(15, 23, 42, 255), font=f_stat_val)
            cd.text((rx0 + 24, ry + 68), slbl, fill=accent + (255,), font=f_stat_lbl)
            ry += 120

        if key_points:
            cd.text((rx0, ry), "KEY FACTS & NUMBERS", fill=(100, 116, 139, 255), font=f_sec)
            ry += 28
            for p_idx, pt in enumerate(key_points[:min(3, reveal_count)], start=1):
                is_active = (p_idx - 1) == active_pt
                wrapped = textwrap.wrap(pt, width=42)[:2]
                box_h = max(46, len(wrapped) * 25 + 16)
                if is_active:
                    cd.rounded_rectangle([rx0 - 8, ry - 6, rx1, ry + box_h], radius=12, fill=soft_tint, outline=accent + (180,), width=2)
                cd.ellipse([rx0 + 2, ry + 4, rx0 + 28, ry + 30], fill=accent + (255,) if is_active else (100, 116, 139, 255))
                cd.text((rx0 + 10, ry + 7), str(p_idx), fill=(255, 255, 255, 255), font=f_pt_num)
                for wi, wl in enumerate(wrapped):
                    cd.text((rx0 + 38, ry + 4 + wi * 25), wl, fill=(15, 23, 42, 255), font=f_pt)
                ry += box_h + 10

        if show_why and why_matters and ry + 78 < ch - 24:
            wy0 = max(ry + 8, ch - 126)
            cd.rounded_rectangle([rx0, wy0, rx1, ch - 24], radius=14, fill=(241, 245, 249, 255), outline=(203, 213, 225, 255), width=2)
            cd.text((rx0 + 16, wy0 + 10), "WHY IT MATTERS", fill=accent + (255,), font=f_sec)
            w_lines = textwrap.wrap(why_matters, width=56)[:3]
            for wi, wl in enumerate(w_lines):
                cd.text((rx0 + 16, wy0 + 32 + wi * 22), wl, fill=(51, 65, 85, 255), font=f_why)

    elif is_vertical and has_depth:
        # 9:16 Vertical Layout: Top Hero Stat Banner + Middle Newspaper Clip + Bottom Key Points Strip
        pad = 22
        cur_y = pad
        f_stat_v = load_font(36, bold=True)
        f_stat_l = load_font(18, bold=True)
        f_pt_v = load_font(22, bold=True)
        f_num_v = load_font(18, bold=True)

        if stat_hero.get("value"):
            sval = str(stat_hero.get("value", ""))
            slbl = str(stat_hero.get("label", "")).upper()
            cd.rounded_rectangle([pad, cur_y, cw - pad, cur_y + 84], radius=16, fill=soft_tint)
            cd.rounded_rectangle([pad, cur_y, pad + 8, cur_y + 84], radius=4, fill=accent + (255,))
            cd.text((pad + 22, cur_y + 10), sval, fill=(15, 23, 42, 255), font=f_stat_v)
            cd.text((pad + 22, cur_y + 52), slbl, fill=accent + (255,), font=f_stat_l)
            cur_y += 98

        bot_reserve = 225 if key_points else 36
        clip_h = max(240, ch - cur_y - bot_reserve - 16)
        if clip_path and Path(clip_path).is_file():
            clip = Image.open(clip_path).convert("RGB")
            clip.thumbnail((cw - pad * 2, clip_h), Image.Resampling.LANCZOS)
            cx = (cw - clip.width) // 2
            cy = cur_y + (clip_h - clip.height) // 2
            card.paste(clip, (cx, cy))

        if key_points:
            ky = ch - bot_reserve
            cd.rounded_rectangle([pad, ky, cw - pad, ch - 34], radius=16, fill=(248, 250, 252, 255), outline=(226, 232, 240, 255), width=2)
            py = ky + 14
            for p_idx, pt in enumerate(key_points[:min(2, reveal_count)], start=1):
                is_active = (p_idx - 1) == min(1, active_pt)
                wrapped = textwrap.wrap(pt, width=50)[:2]
                bh = max(44, len(wrapped) * 26 + 12)
                if is_active:
                    cd.rounded_rectangle([pad + 8, py - 4, cw - pad - 8, py + bh], radius=12, fill=soft_tint, outline=accent + (180,), width=2)
                cd.ellipse([pad + 16, py + 4, pad + 42, py + 30], fill=accent + (255,) if is_active else (100, 116, 139, 255))
                cd.text((pad + 24, py + 7), str(p_idx), fill=(255, 255, 255, 255), font=f_num_v)
                for wi, wl in enumerate(wrapped):
                    cd.text((pad + 54, py + 4 + wi * 26), wl, fill=(15, 23, 42, 255), font=f_pt_v)
                py += bh + 8
    else:
        if clip_path and Path(clip_path).is_file():
            clip = Image.open(clip_path).convert("RGB")
            pad = 22
            clip.thumbnail((cw - pad * 2, ch - pad * 2), Image.Resampling.LANCZOS)
            cx = (cw - clip.width) // 2
            cy = (ch - clip.height) // 2
            card.paste(clip, (cx, cy))

    # Mask rounded corners
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, cw, ch], radius=radius, fill=255)

    # Drop shadow
    shadow = Image.new("RGBA", (cw + 24, ch + 24), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([12, 12, cw + 12, ch + 12], radius=radius, fill=(0, 0, 0, 125))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14))

    rgba_canvas = canvas.convert("RGBA")
    rgba_canvas.paste(shadow, (x0 - 12, y0 - 6), shadow)
    rgba_canvas.paste(card, (x0, y0), mask)

    # Floating dark callout pill at bottom center of card
    if callout:
        d = ImageDraw.Draw(rgba_canvas)
        tb = d.textbbox((0, 0), callout, font=font_callout)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pw, ph = tw + 44, th + 24
        px0 = x0 + (cw - pw) // 2
        py0 = y1 - ph // 2 - 4
        d.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=ph // 2, fill=(17, 24, 39, 240), outline=(255, 255, 255, 60), width=2)
        d.text((px0 + 22, py0 + 10), callout, fill=(255, 255, 255, 255), font=font_callout)

    canvas.paste(rgba_canvas.convert("RGB"))


def render_studio_scene(
    out_path: Path,
    size: tuple[int, int],
    edition_pill: str,
    brand: str,
    hook_title: str,
    chapter_idx: int,
    total_chapters: int,
    clip_path: str | None,
    callout: str,
    speaker_name: str,
    caption_text: str,
    chapter_meta: dict[str, Any] | None = None,
    line_idx: int = 0,
    total_lines: int = 1,
) -> None:
    """Render a studio-grade 9:16 or 16:9 frame matching the reference template."""
    W, H = size
    is_vertical = H > W
    canvas = make_gradient_bg(W, H)
    draw = ImageDraw.Draw(canvas)

    # Fonts scaled cleanly for 1080x1920 or 1920x1080
    f_pill = load_font(22 if is_vertical else 20, bold=True)
    f_brand = load_font(30 if is_vertical else 28, bold=True)
    f_title = load_font(48 if is_vertical else 40, bold=True)
    f_callout = load_font(24 if is_vertical else 22, bold=True)
    f_speaker = load_font(22 if is_vertical else 20, bold=True)
    f_caption = load_font(32 if is_vertical else 28, bold=True)
    f_avatar = load_font(44 if is_vertical else 38, bold=True)

    mx = 56 if is_vertical else 80
    top_y = 54 if is_vertical else 36

    # 1. Top Pill (Paper • Date • Edition) + Brand Mark
    tb = draw.textbbox((0, 0), edition_pill, font=f_pill)
    pw, ph = (tb[2] - tb[0]) + 36, (tb[3] - tb[1]) + 20
    draw.rounded_rectangle([mx, top_y, mx + pw, top_y + ph], radius=ph // 2, fill=(239, 68, 68))
    draw.text((mx + 18, top_y + 9), edition_pill, fill=(255, 255, 255), font=f_pill)

    bb = draw.textbbox((0, 0), brand, font=f_brand)
    bw = bb[2] - bb[0]
    draw.text((W - mx - bw, top_y + 4), brand, fill=(255, 255, 255), font=f_brand)
    draw.text((W - mx + 2, top_y + 2), "*", fill=(244, 63, 94), font=f_brand)

    # 2. Bold Hook Title (max 2 lines)
    title_y = top_y + ph + (28 if is_vertical else 18)
    wrap_chars = 30 if is_vertical else 56
    title_lines = textwrap.wrap(hook_title, width=wrap_chars)[:2]
    for i, tl in enumerate(title_lines):
        draw.text((mx, title_y + i * (56 if is_vertical else 46)), tl, fill=(255, 255, 255), font=f_title)

    # 3. Segmented Progress Bar
    prog_y = title_y + len(title_lines) * (56 if is_vertical else 46) + (26 if is_vertical else 16)
    gap = 10
    total_w = W - mx * 2
    seg_w = (total_w - gap * (total_chapters - 1)) // max(1, total_chapters)
    for i in range(total_chapters):
        sx0 = mx + i * (seg_w + gap)
        if i < chapter_idx:
            draw.rounded_rectangle([sx0, prog_y, sx0 + seg_w, prog_y + 6], radius=3, fill=(255, 255, 255))
        elif i == chapter_idx:
            draw.rounded_rectangle([sx0, prog_y, sx0 + seg_w, prog_y + 6], radius=3, fill=(71, 85, 105))
            frac = max(0.2, min(1.0, (line_idx + 1) / max(1, total_lines)))
            fw = max(12, int(seg_w * frac))
            draw.rounded_rectangle([sx0, prog_y, sx0 + fw, prog_y + 6], radius=3, fill=(244, 63, 94))
        else:
            draw.rounded_rectangle([sx0, prog_y, sx0 + seg_w, prog_y + 6], radius=3, fill=(71, 85, 105))

    # 4. Center Clipped Newspaper Card
    card_top = prog_y + (28 if is_vertical else 22)
    dock_h = 230 if is_vertical else 165
    card_bottom = H - dock_h - (24 if is_vertical else 18)
    draw_rounded_card(
        canvas,
        clip_path,
        (mx, card_top, W - mx, card_bottom),
        callout,
        f_callout,
        chapter_meta=chapter_meta,
        is_vertical=is_vertical,
        line_idx=line_idx,
        total_lines=total_lines,
    )

    # Re-acquire draw after card paste
    draw = ImageDraw.Draw(canvas)

    # 5. Bottom Speaker Avatar + Name Pill + Live Captions
    dock_y = H - dock_h + 18
    av_size = 128 if is_vertical else 104
    is_female = speaker_name.upper() == "ANANYA"
    ring_col = (16, 185, 129) if is_female else (56, 189, 248)
    fill_col = (15, 118, 110) if is_female else (3, 105, 161)

    draw.ellipse([mx, dock_y, mx + av_size, dock_y + av_size], fill=fill_col, outline=ring_col, width=6)
    initial = speaker_name[0].upper()
    ib = draw.textbbox((0, 0), initial, font=f_avatar)
    iw, ih = ib[2] - ib[0], ib[3] - ib[1]
    draw.text((mx + (av_size - iw) // 2, dock_y + (av_size - ih) // 2 - 6), initial, fill=(255, 255, 255), font=f_avatar)

    # Speaker Name Pill
    tx = mx + av_size + 28
    sp_label = speaker_name.upper()
    sb = draw.textbbox((0, 0), sp_label, font=f_speaker)
    sp_w, sp_h = (sb[2] - sb[0]) + 28, (sb[3] - sb[1]) + 14
    draw.rounded_rectangle([tx, dock_y + 2, tx + sp_w, dock_y + 2 + sp_h], radius=sp_h // 2, fill=ring_col)
    draw.text((tx + 14, dock_y + 8), sp_label, fill=(15, 23, 42), font=f_speaker)

    # Live Synced Caption (wrapped cleanly)
    cap_y = dock_y + sp_h + 16
    cap_wrap = 34 if is_vertical else 68
    cap_lines = textwrap.wrap(f'"{caption_text}"', width=cap_wrap)[:3]
    for i, cl in enumerate(cap_lines):
        draw.text((tx, cap_y + i * (38 if is_vertical else 34)), cl, fill=(248, 250, 252), font=f_caption)

    canvas.save(out_path, format="PNG")


def run_ffmpeg(args: list[str]) -> None:
    proc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()}")


def has_videotoolbox() -> bool:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
    return "h264_videotoolbox" in proc.stdout


def render_animated_clip(
    img_path: Path,
    wav_path: Path,
    out_mp4: Path,
    size: tuple[int, int],
    dur_sec: float,
    use_vt: bool = False,
) -> None:
    """Create a smooth, fast hardware-accelerated motion clip synced to a spoken line."""
    W, H = size
    sw, sh = int(round(W * 1.04)), int(round(H * 1.04))
    sw += sw % 2
    sh += sh % 2
    d = max(0.5, dur_sec)
    vf = f"scale={sw}:{sh},crop={W}:{H}:x='(iw-ow)*t/{d:.3f}':y='(ih-oh)*(1-t/{d:.3f})/2',fps=30,format=yuv420p"
    vcodec = ["-c:v", "h264_videotoolbox", "-b:v", "4500k"] if use_vt else ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "22"]
    run_ffmpeg([
        "-loop", "1", "-t", f"{dur_sec:.3f}", "-i", str(img_path),
        "-i", str(wav_path),
        "-vf", vf,
        *vcodec,
        "-c:a", "aac", "-b:a", "192k", "-shortest",
        str(out_mp4),
    ])


def master_broadcast_audio(voice_wav: Path, sfx_wav: Path, bed_wav: Path, out_wav: Path) -> None:
    """Apply broadcast EQ/compression/de-ess to voice, sidechain-duck music bed, mix SFX, and loudnorm."""
    fc = (
        "[0:a]highpass=f=85,"
        "equalizer=f=180:width_type=o:width=1.5:g=2.5,"
        "equalizer=f=3200:width_type=o:width=1.2:g=3.0,"
        "equalizer=f=6500:width_type=o:width=0.8:g=-2.0,"
        "acompressor=threshold=-18dB:ratio=3.2:attack=12:release=140:makeup=2.0,"
        "asplit=2[v_mix][v_sc];"
        "[2:a]volume=0.18[bed];"
        "[bed][v_sc]sidechaincompress=threshold=0.015:ratio=6:attack=30:release=320[bed_ducked];"
        "[1:a]volume=0.85[sfx];"
        "[v_mix][bed_ducked][sfx]amix=inputs=3:duration=first:normalize=0,"
        "loudnorm=I=-16:TP=-1.5:LRA=9[out]"
    )
    run_ffmpeg([
        "-i", str(voice_wav),
        "-i", str(sfx_wav),
        "-i", str(bed_wav),
        "-filter_complex", fc,
        "-map", "[out]",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(out_wav),
    ])


def generate_show(args: argparse.Namespace) -> dict[str, Any]:
    run_sheet_path = Path(args.run_sheet).resolve()
    if not run_sheet_path.is_file():
        raise FileNotFoundError(f"Run-sheet JSON not found: {run_sheet_path}")

    spec = json.loads(run_sheet_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = Path(args.audio_dir).resolve() if getattr(args, "audio_dir", None) else None
    kokoro: Kokoro | None = None

    def get_kokoro() -> Kokoro:
        nonlocal kokoro
        if kokoro is None:
            model_path, voices_path = ensure_kokoro_models()
            kokoro = Kokoro(str(model_path), str(voices_path))
        return kokoro

    edition_pill = spec.get("edition_pill", f"{spec.get('paper', 'THE HINDU').upper()} • {spec.get('date', 'TODAY').upper()}")
    brand = spec.get("brand", "KhabarShow")
    chapters_spec = spec.get("chapters", [])
    total_chapters = len(chapters_spec)

    from concurrent.futures import ThreadPoolExecutor

    chapters_out = []
    voice_segments: list[np.ndarray] = []
    sfx_segments: list[np.ndarray] = []
    timeline: list[dict[str, Any]] = []
    cursor_samples = 0

    intro_chime = make_chime(0.95, (523.25, 659.25, 783.99, 1046.5))
    seg_chime = make_chime(0.55, (587.33, 880.0))
    sports_sting = make_sports_sting(0.55)
    whoosh_sfx = make_whoosh(0.28)
    pop_sfx = make_ui_pop(0.13)

    with tempfile.TemporaryDirectory(prefix="epaper-show-") as tmp_str:
        tmp_dir = Path(tmp_str)

        for idx, ch in enumerate(chapters_spec):
            ch_id = ch.get("id", f"ch_{idx + 1:02d}")
            title = ch.get("title", f"Story {idx + 1}")
            treatment = ch.get("treatment", "news")
            clip_path = ch.get("clip_path")
            callout = ch.get("callout", "")
            is_reel = bool(ch.get("highlight_reel", False))
            lines_spec = [ln for ln in ch.get("lines", []) if str(ln.get("tts_text") or ln.get("text") or "").strip() or ln.get("audio_path")]
            num_lines = len(lines_spec)

            ch_start_ms = int(round(cursor_samples * 1000 / SAMPLE_RATE))

            for l_idx, line in enumerate(lines_spec):
                text = str(line.get("tts_text") or line.get("text") or "").strip()
                voice = line.get("voice", "af_heart")
                speaker = line.get("speaker", "Ananya" if voice.startswith("af_") else "Kabir")
                lang = line.get("lang", "en-us")
                speed = float(line.get("speed", 1.06))
                caption = str(line.get("caption") or line.get("text") or text)

                ext_wav: Path | None = None
                if line.get("audio_path") and Path(str(line["audio_path"])).is_file():
                    ext_wav = Path(str(line["audio_path"]))
                elif audio_dir and line.get("id"):
                    cand = audio_dir / f"{line['id']}.wav"
                    if cand.is_file():
                        ext_wav = cand

                if ext_wav is not None:
                    samples = load_external_audio(ext_wav)
                else:
                    samples, _ = get_kokoro().create(text, voice=voice, speed=speed, lang=lang)
                samples = samples.astype(np.float32)

                # Build aligned voice + SFX segments for this line
                if l_idx == 0:
                    if idx == 0:
                        pre_sfx = intro_chime
                    elif treatment == "sports":
                        pre_sfx = sports_sting
                    elif treatment in ("sensitive_news", "obituary"):
                        pre_sfx = make_silence(0.45)
                    else:
                        pre_sfx = np.concatenate([whoosh_sfx, seg_chime]) * 0.85
                    pre_voice = make_silence(len(pre_sfx) / SAMPLE_RATE)
                else:
                    pre_sfx = pop_sfx
                    pre_voice = make_silence(len(pre_sfx) / SAMPLE_RATE)

                tail_sil = make_silence(0.24)
                line_voice = np.concatenate([pre_voice, samples, tail_sil])
                line_sfx = np.concatenate([pre_sfx, np.zeros(len(samples) + len(tail_sil), dtype=np.float32)])

                start_samp = cursor_samples
                end_samp = cursor_samples + len(line_voice)
                cursor_samples = end_samp

                voice_segments.append(line_voice)
                sfx_segments.append(line_sfx)
                timeline.append({
                    "ch_idx": idx,
                    "ch_id": ch_id,
                    "ch": ch,
                    "title": title,
                    "clip_path": clip_path,
                    "callout": callout,
                    "is_reel": is_reel,
                    "l_idx": l_idx,
                    "num_lines": num_lines,
                    "speaker": speaker,
                    "caption": caption,
                    "start_samp": start_samp,
                    "end_samp": end_samp,
                    "dur_sec": len(line_voice) / SAMPLE_RATE,
                })

            ch_end_ms = int(round(cursor_samples * 1000 / SAMPLE_RATE))
            chapters_out.append({
                "id": ch_id,
                "title": title,
                "treatment": treatment,
                "startSec": round(ch_start_ms / 1000, 2),
                "endSec": round(ch_end_ms / 1000, 2),
                "durationSec": round((ch_end_ms - ch_start_ms) / 1000, 2),
            })

        voice_raw = np.concatenate(voice_segments)
        sfx_raw = np.concatenate(sfx_segments)
        total_dur_sec = len(voice_raw) / SAMPLE_RATE
        bed_raw = make_music_bed(total_dur_sec)[:len(voice_raw)]

        voice_wav = tmp_dir / "voice_raw.wav"
        sfx_wav = tmp_dir / "sfx_raw.wav"
        bed_wav = tmp_dir / "bed_raw.wav"
        master_wav = tmp_dir / "master_polished.wav"
        sf.write(str(voice_wav), voice_raw, SAMPLE_RATE)
        sf.write(str(sfx_wav), sfx_raw, SAMPLE_RATE)
        sf.write(str(bed_wav), bed_raw, SAMPLE_RATE)

        master_broadcast_audio(voice_wav, sfx_wav, bed_wav, master_wav)
        polished_wave, _ = sf.read(str(master_wav), dtype="float32")
        if polished_wave.ndim > 1:
            polished_wave = polished_wave.mean(axis=1)

        meta_lines = [";FFMETADATA1", f"title={spec.get('title', 'KhabarShow')}", ""]
        for c in chapters_out:
            meta_lines.extend([
                "[CHAPTER]",
                "TIMEBASE=1/1000",
                f"START={int(c['startSec'] * 1000)}",
                f"END={int(c['endSec'] * 1000)}",
                f"title={c['title']}",
            ])
        meta_path = tmp_dir / "chapters.txt"
        meta_path.write_text("\n".join(meta_lines), encoding="utf-8")

        episode_mp3 = out_dir / "episode.mp3"
        run_ffmpeg([
            "-i", str(master_wav), "-i", str(meta_path), "-map_metadata", "1",
            "-codec:a", "libmp3lame", "-b:a", "192k", str(episode_mp3),
        ])

        yt_clips: list[Path] = []
        reel_clips: list[Path] = []
        render_jobs: list[tuple[Path, Path, Path, tuple[int, int], float]] = []
        use_vt = has_videotoolbox()

        if args.video or args.reel:
            for item in timeline:
                ch_id = item["ch_id"]
                l_idx = item["l_idx"]
                line_wav = tmp_dir / f"{ch_id}_l{l_idx:02d}.wav"
                seg = polished_wave[item["start_samp"]:item["end_samp"]]
                sf.write(str(line_wav), seg, SAMPLE_RATE)

                if args.video:
                    yt_img = tmp_dir / f"{ch_id}_l{l_idx:02d}_yt.png"
                    yt_mp4 = tmp_dir / f"{ch_id}_l{l_idx:02d}_yt.mp4"
                    render_studio_scene(
                        yt_img, (1920, 1080), edition_pill, brand, item["title"],
                        item["ch_idx"], total_chapters, item["clip_path"], item["callout"],
                        item["speaker"], item["caption"], chapter_meta=item["ch"],
                        line_idx=l_idx, total_lines=item["num_lines"],
                    )
                    yt_clips.append(yt_mp4)
                    render_jobs.append((yt_img, line_wav, yt_mp4, (1920, 1080), item["dur_sec"]))

                if args.reel and item["is_reel"]:
                    rl_img = tmp_dir / f"{ch_id}_l{l_idx:02d}_rl.png"
                    rl_mp4 = tmp_dir / f"{ch_id}_l{l_idx:02d}_rl.mp4"
                    render_studio_scene(
                        rl_img, (1080, 1920), edition_pill, brand, item["title"],
                        item["ch_idx"], total_chapters, item["clip_path"], item["callout"],
                        item["speaker"], item["caption"], chapter_meta=item["ch"],
                        line_idx=l_idx, total_lines=item["num_lines"],
                    )
                    reel_clips.append(rl_mp4)
                    render_jobs.append((rl_img, line_wav, rl_mp4, (1080, 1920), item["dur_sec"]))

            if render_jobs:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    futs = [pool.submit(render_animated_clip, img, wav, mp4, sz, dur, use_vt) for (img, wav, mp4, sz, dur) in render_jobs]
                    for fut in futs:
                        fut.result()

        result: dict[str, Any] = {
            "ok": True,
            "paper": spec.get("paper"),
            "date": spec.get("date"),
            "durationSec": round(total_dur_sec, 2),
            "episodeAudioPath": str(episode_mp3),
            "chapters": chapters_out,
        }

        if args.video and yt_clips:
            yt_list = tmp_dir / "yt_concat.txt"
            yt_list.write_text("\n".join(f"file '{p}'" for p in yt_clips), encoding="utf-8")
            yt_out = out_dir / "youtube_16x9.mp4"
            run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(yt_list), "-c", "copy", str(yt_out)])
            result["youtubeVideoPath"] = str(yt_out)

        if args.reel and reel_clips:
            rl_list = tmp_dir / "rl_concat.txt"
            rl_list.write_text("\n".join(f"file '{p}'" for p in reel_clips), encoding="utf-8")
            rl_out = out_dir / "reel_9x16.mp4"
            run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(rl_list), "-c", "copy", str(rl_out)])
            result["reelVideoPath"] = str(rl_out)

    manifest_path = out_dir / "show_manifest.json"
    manifest_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["manifestPath"] = str(manifest_path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="KhabarShow Studio Video & Audio Generator")
    parser.add_argument("run_sheet")
    parser.add_argument("--out", required=True)
    parser.add_argument("--video", action="store_true")
    parser.add_argument("--reel", action="store_true")
    parser.add_argument("--audio-dir", default=None)
    args = parser.parse_args()
    try:
        res = generate_show(args)
        print(json.dumps(res, indent=2))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
