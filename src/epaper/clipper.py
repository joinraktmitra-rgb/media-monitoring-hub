#!/usr/bin/env python3
"""
Precision Newspaper Renderer & Gutter-Snapping Clipper.
Supports:
  - render: PDF -> clean PNGs + optional vision-aid coordinate grid PNGs + vector layout hints
  - clip:   Per-article Y-band/X-band DPI-proportional gutter-snapping + exclude-box white-out masking
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFont


def parse_page_range(spec: str | None, total_pages: int) -> list[int]:
    if not spec or spec.strip().lower() == "all":
        return list(range(total_pages))
    indices: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a_s, b_s = part.split("-", 1)
            a, b = max(1, int(a_s)), min(total_pages, int(b_s))
            for p in range(a, b + 1):
                indices.add(p - 1)
        else:
            p = int(part)
            if 1 <= p <= total_pages:
                indices.add(p - 1)
    return sorted(indices)


def draw_vision_grid(img: Image.Image) -> Image.Image:
    """Overlay normalized 0.0-1.0 ruler ticks and subtle grid lines for Vision AI agents."""
    overlay = img.copy().convert("RGBA")
    draw = ImageDraw.Draw(overlay)
    w, h = overlay.size
    font = ImageFont.load_default()

    for step in range(1, 10):
        frac = step / 10.0
        x = int(round(frac * w))
        y = int(round(frac * h))
        # Subtle semi-transparent cyan/blue grid lines
        draw.line([(x, 0), (x, h)], fill=(0, 120, 255, 70), width=max(1, w // 1200))
        draw.line([(0, y), (w, y)], fill=(0, 120, 255, 70), width=max(1, h // 1600))

        label = f"{frac:.1f}"
        # Top/bottom X labels
        draw.rectangle([x - 16, 2, x + 16, 18], fill=(0, 90, 200, 200))
        draw.text((x - 10, 4), label, fill=(255, 255, 255, 255), font=font)
        # Left/right Y labels
        draw.rectangle([2, y - 8, 34, y + 8], fill=(0, 90, 200, 200))
        draw.text((5, y - 6), label, fill=(255, 255, 255, 255), font=font)

    return overlay.convert("RGB")


def extract_page_hints(page: pymupdf.Page) -> dict[str, Any]:
    """Extract normalized headlines and text/image blocks from native vector PDFs."""
    pw, ph = float(page.rect.width), float(page.rect.height)
    d = page.get_text("dict")
    headlines = []
    text_blocks = []

    for b in d.get("blocks", []):
        btype = b.get("type")
        x0, y0, x1, y1 = b["bbox"]
        norm = [round(x0 / pw, 4), round(y0 / ph, 4), round(x1 / pw, 4), round(y1 / ph, 4)]
        if btype == 0:
            spans = [s for l in b.get("lines", []) for s in l.get("spans", [])]
            if not spans:
                continue
            max_sz = max((float(s.get("size", 0)) for s in spans), default=0.0)
            txt = " ".join(s.get("text", "") for s in spans).strip()
            if not txt:
                continue
            text_blocks.append({"box": norm, "maxFontPt": round(max_sz, 1), "textPreview": txt[:80]})
            if max_sz >= 16.0 and len(txt) >= 8:
                headlines.append({"box": norm, "fontPt": round(max_sz, 1), "text": txt[:140]})

    return {
        "widthPt": round(pw, 2),
        "heightPt": round(ph, 2),
        "isVectorText": len(text_blocks) > 0,
        "headlines": headlines,
        "textBlockCount": len(text_blocks),
    }


def cmd_render(args: argparse.Namespace) -> dict[str, Any]:
    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = pymupdf.open(str(pdf_path))
    indices = parse_page_range(args.pages, len(doc))
    rendered = []

    for idx in indices:
        page = doc[idx]
        pix = page.get_pixmap(dpi=args.dpi)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

        page_id = f"page_{idx + 1:03d}"
        clean_path = out_dir / f"{page_id}.png"
        img.save(clean_path, format="PNG")

        entry: dict[str, Any] = {
            "page": idx + 1,
            "pageId": page_id,
            "imagePath": str(clean_path),
            "width": pix.width,
            "height": pix.height,
        }

        if args.grid:
            grid_path = out_dir / f"{page_id}_grid.png"
            draw_vision_grid(img).save(grid_path, format="PNG")
            entry["gridImagePath"] = str(grid_path)

        if args.hints:
            entry["hints"] = extract_page_hints(page)

        rendered.append(entry)

    hints_path = out_dir / "render_manifest.json"
    manifest = {"ok": True, "pdf": str(pdf_path), "dpi": args.dpi, "totalPages": len(doc), "pages": rendered}
    hints_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    manifest["manifestPath"] = str(hints_path)
    return manifest


def snap_vertical_edge(gray: np.ndarray, x_approx: int, y0: int, y1: int, win: int) -> int:
    """Snap a vertical crop boundary to the center of the cleanest white gutter within [x-win, x+win]."""
    H, W = gray.shape
    lo = max(0, x_approx - win)
    hi = min(W - 1, x_approx + win)
    if hi <= lo:
        return max(0, min(W, x_approx))

    band = gray[max(0, y0) : min(H, y1), lo : hi + 1]
    if band.size == 0:
        return x_approx

    # White-pixel ratio per column + uniformity (low std)
    white_ratio = (band > 245).mean(axis=0)
    col_mean = band.mean(axis=0)
    is_gutter = white_ratio >= 0.92

    best_center = None
    best_dist = 10**9
    run_start = None
    for i, ok in enumerate(is_gutter):
        if ok and run_start is None:
            run_start = i
        elif not ok and run_start is not None:
            center = lo + (run_start + i - 1) // 2
            dist = abs(center - x_approx)
            if (i - run_start) >= 3 and dist < best_dist:
                best_dist = dist
                best_center = center
            run_start = None
    if run_start is not None:
        center = lo + (run_start + len(is_gutter) - 1) // 2
        dist = abs(center - x_approx)
        if (len(is_gutter) - run_start) >= 3 and dist < best_dist:
            best_center = center

    if best_center is not None:
        return best_center

    # Fallback: column with highest mean brightness
    return lo + int(np.argmax(col_mean))


def snap_horizontal_edge(gray: np.ndarray, y_approx: int, x0: int, x1: int, win: int) -> int:
    """Snap a horizontal crop boundary to a white separator or solid dark divider line."""
    H, W = gray.shape
    lo = max(0, y_approx - win)
    hi = min(H - 1, y_approx + win)
    if hi <= lo:
        return max(0, min(H, y_approx))

    band = gray[lo : hi + 1, max(0, x0) : min(W, x1)]
    if band.size == 0:
        return y_approx

    row_mean = band.mean(axis=1)
    white_ratio = (band > 245).mean(axis=1)

    # Prefer solid dark divider line if present (mean < 120) or cleanest white row
    dark_rows = np.where(row_mean < 120)[0]
    if len(dark_rows) > 0:
        closest = dark_rows[int(np.argmin(np.abs((lo + dark_rows) - y_approx)))]
        return lo + int(closest)

    white_rows = np.where(white_ratio >= 0.94)[0]
    if len(white_rows) > 0:
        closest = white_rows[int(np.argmin(np.abs((lo + white_rows) - y_approx)))]
        return lo + int(closest)

    return lo + int(np.argmax(row_mean))


def cmd_clip(args: argparse.Namespace) -> dict[str, Any]:
    coords_path = Path(args.coords).resolve()
    if not coords_path.is_file():
        raise FileNotFoundError(f"Coords JSON not found: {coords_path}")

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    spec = json.loads(coords_path.read_text(encoding="utf-8"))
    clipped = []

    for page_key, page_data in spec.items():
        img_path = Path(page_data["image_path"])
        if not img_path.is_file():
            raise FileNotFoundError(f"Page image not found for {page_key}: {img_path}")

        img = Image.open(img_path).convert("RGB")
        gray = np.asarray(img.convert("L"), dtype=np.float32)
        W, H = img.size

        # DPI-proportional search windows (~1.5% of width, ~1.0% of height)
        win_x = max(15, int(round(0.015 * W)))
        win_y = max(12, int(round(0.010 * H)))

        articles = page_data.get("articles", {})
        for slug, art in articles.items():
            l, t, r, b = [float(v) for v in art["box"]]
            x0 = max(0, min(W - 1, int(round(l * W))))
            y0 = max(0, min(H - 1, int(round(t * H))))
            x1 = max(x0 + 1, min(W, int(round(r * W))))
            y1 = max(y0 + 1, min(H, int(round(b * H))))

            if art.get("snap", True):
                sx0 = snap_vertical_edge(gray, x0, y0, y1, win_x)
                sx1 = snap_vertical_edge(gray, x1, y0, y1, win_x)
                sy0 = snap_horizontal_edge(gray, y0, sx0, sx1, win_y)
                sy1 = snap_horizontal_edge(gray, y1, sx0, sx1, win_y)
                if sx1 > sx0 + 10 and sy1 > sy0 + 10:
                    x0, y0, x1, y1 = sx0, sy0, sx1, sy1

            crop = img.crop((x0, y0, x1, y1))
            excludes = art.get("exclude", [])
            if excludes:
                draw = ImageDraw.Draw(crop)
                for ex in excludes:
                    el, et, er, eb = [float(v) for v in ex]
                    ex0 = max(0, int(round(el * W)) - x0)
                    ey0 = max(0, int(round(et * H)) - y0)
                    ex1 = min(x1 - x0, int(round(er * W)) - x0)
                    ey1 = min(y1 - y0, int(round(eb * H)) - y0)
                    if ex1 > ex0 and ey1 > ey0:
                        draw.rectangle([ex0, ey0, ex1, ey1], fill=(255, 255, 255))

            safe_slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in slug)
            out_file = out_dir / f"{page_key}_{safe_slug}.png"
            crop.save(out_file, format="PNG")

            clipped.append({
                "page": page_key,
                "slug": slug,
                "filePath": str(out_file),
                "width": crop.size[0],
                "height": crop.size[1],
                "snappedBox": [
                    round(x0 / W, 4),
                    round(y0 / H, 4),
                    round(x1 / W, 4),
                    round(y1 / H, 4),
                ],
                "excludedCount": len(excludes),
            })

    return {"ok": True, "count": len(clipped), "clips": clipped}


def main() -> None:
    parser = argparse.ArgumentParser(description="ePaper Vision Renderer & Clipper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ren = sub.add_parser("render")
    p_ren.add_argument("pdf")
    p_ren.add_argument("--out", required=True)
    p_ren.add_argument("--dpi", type=int, default=150)
    p_ren.add_argument("--pages", default="all")
    p_ren.add_argument("--grid", action="store_true")
    p_ren.add_argument("--hints", action="store_true")

    p_clip = sub.add_parser("clip")
    p_clip.add_argument("coords")
    p_clip.add_argument("--out", required=True)

    args = parser.parse_args()
    try:
        res = cmd_render(args) if args.cmd == "render" else cmd_clip(args)
        print(json.dumps(res, indent=2))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
