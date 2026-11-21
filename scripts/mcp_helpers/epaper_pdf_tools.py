#!/usr/bin/env python3
"""
Ampio Media Intelligence — Fast Multilingual ePaper PDF Search & Text/OCR Extractor.
Used by MCP tools:
  - epaper_search_pdf: Scans 1 or all PDFs across every page for keywords (Hindi/English/Tamil)
    and returns exact page numbers + normalized 0.0-1.0 bounding boxes.
  - epaper_extract_page_text: Extracts structured vector text blocks (with font size & normalized
    boxes) from specified pages, with automatic Tesseract OCR fallback for scanned/raster pages.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pymupdf


def normalize_text(text: str) -> str:
    if not text:
        return ""
    t = re.sub(r"[\u200b\u200c\u200d\u00ad\ufeff]+", "", text)
    t = re.sub(r"[ \t]+", " ", t)
    return t


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


def ocr_page_image(page: pymupdf.Page, dpi: int = 180, lang: str = "eng+hin") -> str:
    pix = page.get_pixmap(dpi=dpi)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        tmp_path = tf.name
    try:
        pix.save(tmp_path)
        for try_lang in [lang, "eng"]:
            try:
                proc = subprocess.run(
                    ["tesseract", tmp_path, "stdout", "-l", try_lang],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    return proc.stdout.strip()
            except Exception:
                continue
        return ""
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def search_single_pdf(
    pdf_path: Path,
    keywords: list[str],
    ocr_raster_pages: bool = False,
    max_matches_per_pdf: int = 25,
) -> dict[str, Any]:
    doc = pymupdf.open(str(pdf_path))
    total_pages = len(doc)
    matches: list[dict[str, Any]] = []
    raster_pages: list[int] = []
    vector_pages = 0

    kw_patterns = [(kw, re.compile(re.escape(normalize_text(kw)), re.IGNORECASE)) for kw in keywords if kw.strip()]

    for page_idx in range(total_pages):
        page = doc[page_idx]
        page_num = page_idx + 1
        pw, ph = float(page.rect.width) or 1.0, float(page.rect.height) or 1.0

        raw_text = normalize_text(page.get_text("text") or "")
        is_raster = len(raw_text.strip()) < 40

        if is_raster:
            raster_pages.append(page_num)
            if ocr_raster_pages:
                ocr_txt = normalize_text(ocr_page_image(page))
                for kw, pat in kw_patterns:
                    m = pat.search(ocr_txt)
                    if m:
                        start = max(0, m.start() - 80)
                        end = min(len(ocr_txt), m.end() + 140)
                        matches.append({
                            "page": page_num,
                            "keyword": kw,
                            "match_type": "ocr_raster",
                            "snippet": ocr_txt[start:end].replace("\n", " ").strip(),
                            "normalized_box": None,
                        })
                        if len(matches) >= max_matches_per_pdf:
                            break
            if len(matches) >= max_matches_per_pdf:
                break
            continue

        vector_pages += 1
        blocks = page.get_text("blocks")
        matched_on_page = set()

        for b in blocks:
            x0, y0, x1, y1, b_text = b[0], b[1], b[2], b[3], normalize_text(b[4] or "")
            if not b_text.strip():
                continue
            for kw, pat in kw_patterns:
                if pat.search(b_text):
                    key = (page_num, kw, round(x0 / pw, 2), round(y0 / ph, 2))
                    if key in matched_on_page:
                        continue
                    matched_on_page.add(key)

                    # Expand slightly for helpful context hint
                    norm_box = [
                        round(max(0.0, x0 / pw), 4),
                        round(max(0.0, y0 / ph), 4),
                        round(min(1.0, x1 / pw), 4),
                        round(min(1.0, y1 / ph), 4),
                    ]
                    matches.append({
                        "page": page_num,
                        "keyword": kw,
                        "match_type": "vector_text",
                        "snippet": b_text.replace("\n", " ").strip()[:220],
                        "normalized_box": norm_box,
                    })
                    if len(matches) >= max_matches_per_pdf:
                        break
            if len(matches) >= max_matches_per_pdf:
                break
        if len(matches) >= max_matches_per_pdf:
            break

    doc.close()
    return {
        "filename": pdf_path.name,
        "path": str(pdf_path),
        "total_pages": total_pages,
        "vector_pages": vector_pages,
        "raster_pages": raster_pages,
        "match_count": len(matches),
        "matched_pages": sorted({m["page"] for m in matches}),
        "matches": matches,
    }


def cmd_search(args: argparse.Namespace) -> dict[str, Any]:
    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if not keywords:
        raise ValueError("Provide at least one keyword via --keywords")

    targets: list[Path] = []
    if args.pdf:
        p = Path(args.pdf).resolve()
        if not p.is_file():
            raise FileNotFoundError(f"PDF not found: {p}")
        targets.append(p)
    elif args.dir:
        d = Path(args.dir).resolve()
        if not d.is_dir():
            raise FileNotFoundError(f"Directory not found: {d}")
        targets = sorted([f for f in d.iterdir() if f.is_file() and f.suffix.lower() == ".pdf" and not f.name.startswith(".")])
    else:
        raise ValueError("Provide either --pdf or --dir")

    results = []
    total_matches = 0
    total_pages_scanned = 0

    for pdf_path in targets:
        res = search_single_pdf(
            pdf_path,
            keywords=keywords,
            ocr_raster_pages=args.ocr_raster,
            max_matches_per_pdf=args.max_matches,
        )
        total_matches += res["match_count"]
        total_pages_scanned += res["total_pages"]
        results.append(res)

    return {
        "ok": True,
        "keywords": keywords,
        "pdfs_scanned": len(targets),
        "total_pages_scanned": total_pages_scanned,
        "total_matches": total_matches,
        "files_with_matches": [r for r in results if r["match_count"] > 0],
        "files_without_matches": [
            {
                "filename": r["filename"],
                "total_pages": r["total_pages"],
                "raster_pages_count": len(r["raster_pages"]),
            }
            for r in results
            if r["match_count"] == 0
        ],
    }


def cmd_extract_text(args: argparse.Namespace) -> dict[str, Any]:
    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    doc = pymupdf.open(str(pdf_path))
    total_pages = len(doc)
    indices = parse_page_range(args.pages, total_pages)
    pages_out = []

    for idx in indices:
        page = doc[idx]
        pw, ph = float(page.rect.width) or 1.0, float(page.rect.height) or 1.0
        raw_text = normalize_text(page.get_text("text") or "")

        if len(raw_text.strip()) < 40 and args.ocr_fallback:
            ocr_txt = normalize_text(ocr_page_image(page, dpi=args.dpi))
            pages_out.append({
                "page": idx + 1,
                "source": "tesseract_ocr",
                "char_count": len(ocr_txt),
                "full_text": ocr_txt[: args.max_chars],
                "headlines": [],
                "blocks": [],
            })
            continue

        d = page.get_text("dict")
        headlines = []
        blocks = []
        for b in d.get("blocks", []):
            if b.get("type") != 0:
                continue
            spans = [s for l in b.get("lines", []) for s in l.get("spans", [])]
            if not spans:
                continue
            txt = normalize_text(" ".join(s.get("text", "") for s in spans)).strip()
            if not txt:
                continue
            max_pt = round(max((float(s.get("size", 0)) for s in spans), default=0.0), 1)
            x0, y0, x1, y1 = b["bbox"]
            box = [round(x0 / pw, 4), round(y0 / ph, 4), round(x1 / pw, 4), round(y1 / ph, 4)]
            blocks.append({"box": box, "max_pt": max_pt, "text": txt[:400]})
            if max_pt >= 15.0 and len(txt) >= 6:
                headlines.append({"box": box, "max_pt": max_pt, "text": txt[:200]})

        pages_out.append({
            "page": idx + 1,
            "source": "vector_pdf",
            "char_count": len(raw_text),
            "headline_count": len(headlines),
            "headlines": headlines[:40],
            "blocks": blocks[:60],
            "full_text": raw_text[: args.max_chars],
        })

    doc.close()
    return {
        "ok": True,
        "filename": pdf_path.name,
        "total_pages": total_pages,
        "pages": pages_out,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Ampio ePaper PDF Search & Text Extractor")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("search")
    p_search.add_argument("--pdf", default=None)
    p_search.add_argument("--dir", default=None)
    p_search.add_argument("--keywords", required=True, help="Comma-separated keywords")
    p_search.add_argument("--ocr-raster", action="store_true")
    p_search.add_argument("--max-matches", type=int, default=25)

    p_text = sub.add_parser("extract-text")
    p_text.add_argument("--pdf", required=True)
    p_text.add_argument("--pages", default="1")
    p_text.add_argument("--ocr-fallback", action="store_true", default=True)
    p_text.add_argument("--dpi", type=int, default=180)
    p_text.add_argument("--max-chars", type=int, default=8000)

    args = parser.parse_args()
    try:
        res = cmd_search(args) if args.cmd == "search" else cmd_extract_text(args)
        print(json.dumps(res, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
