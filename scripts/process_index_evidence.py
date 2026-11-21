#!/usr/bin/env python3
"""
Ampio Labs — Evidence Screenshot Collector & Publication Timestamp Auditor Subagent.

Consumes the Harvester Index File (JSON/CSV), processes each URL through the
EvidenceScreenshotEngine (1440x900 full viewport, popup annihilation, headline centering,
true content publication timestamp extraction, and PIL/Tesseract OCR quality audit),
and updates the index file with:
  - screenshot_status ("VERIFIED_CLEAN" / "FAILED")
  - clip_path (local path to verified PNG)
  - quality_score (0 - 100)
  - content_published_at (e.g. "2026-11-19 19:37:19 IST" - Source of Truth)
  - content_date (e.g. "2026-11-19")
  - relative_time (e.g. "6 hours ago" / "22h")
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional

from playwright.sync_api import sync_playwright

# Import the core engine
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from capture_evidence_screenshots import EvidenceScreenshotEngine


def process_index_file(
    index_json_path: str,
    output_dir: str = "clips/evidence_harvested",
    limit: Optional[int] = None,
    facebook_only: bool = False,
    sync_csv: bool = True,
    timeout_ms: int = 35000,
) -> Dict[str, Any]:
    if not os.path.exists(index_json_path):
        raise FileNotFoundError(f"Index file not found: {index_json_path}")

    with open(index_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    items: List[Dict[str, Any]] = data.get("items", [])
    if not items:
        print(f"[INFO] No items found in {index_json_path}")
        return {"total": 0, "verified": 0, "failed": 0}

    # Filter items
    if facebook_only:
        target_items = [itm for itm in items if "facebook.com" in itm.get("url", "").lower()]
    else:
        target_items = items

    pending_items = [itm for itm in target_items if itm.get("screenshot_status") != "VERIFIED_CLEAN" or not itm.get("content_published_at")]
    if limit:
        pending_items = pending_items[:limit]

    print(f"\n📸 [EVIDENCE COLLECTOR SUBAGENT] Processing {len(pending_items)} item(s) from index...")
    print(f"   Facebook Only:    {facebook_only}")
    print(f"   Timeout per Page: {timeout_ms} ms")
    print(f"   Output Directory: {output_dir}")
    print("=" * 80)

    engine = EvidenceScreenshotEngine(
        viewport_width=1440,
        viewport_height=900,
        output_dir=output_dir,
        timeout_ms=timeout_ms,
        headless=True,
    )

    verified_count = 0
    failed_count = 0

    with sync_playwright() as p:
        browser = engine._create_browser(p)

        for idx, itm in enumerate(pending_items):
            url = itm.get("url", "")
            hl = itm.get("headline", "")
            source = itm.get("source", "Web")
            itm_id = itm.get("id", idx + 1)
            slug = f"{itm_id:03d}_{re.sub(r'[^a-zA-Z0-9_-]', '_', source)[:18]}"

            print(f"[{idx+1}/{len(pending_items)}] Processing ID {itm_id:02d}: [{source}] {hl[:45]}...")

            res = engine.capture_single(
                browser=browser,
                url=url,
                headline=hl,
                publication=source,
                slug=slug,
            )

            # Record true content publication timestamps
            if res.content_published_at:
                itm["content_published_at"] = res.content_published_at
            if res.content_date:
                itm["content_date"] = res.content_date
            if res.relative_time:
                itm["relative_time"] = res.relative_time

            if res.status in ("VERIFIED_CLEAN", "RETRIED_REPAIRED"):
                itm["screenshot_status"] = "VERIFIED_CLEAN"
                itm["clip_path"] = res.output_path
                itm["quality_score"] = res.quality_score
                sz_kb = res.file_size_bytes // 1024
                print(f"    ✓ VERIFIED_CLEAN | {sz_kb} KB | Score: {res.quality_score}/100 | Popups: {res.popups_removed}")
                print(f"    🕒 Content Published: {res.content_published_at or 'N/A'} (Relative: {res.relative_time or 'N/A'})")
                verified_count += 1
            else:
                itm["screenshot_status"] = "FAILED"
                itm["error"] = res.error
                itm["quality_score"] = res.quality_score
                print(f"    ⚠️ FAILED: {res.error}")
                failed_count += 1

            # Incremental save every 2 items so progress is never lost
            if (idx + 1) % 2 == 0 or (idx + 1) == len(pending_items):
                with open(index_json_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)

        browser.close()

    # Final Save JSON
    with open(index_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\n💾 Saved JSON Index: {index_json_path}")

    # Sync updated CSV with source-of-truth publication timestamp columns
    if sync_csv:
        csv_path = index_json_path.replace(".json", ".csv")
        fieldnames = [
            "id",
            "headline",
            "url",
            "source",
            "domain",
            "content_published_at",
            "content_date",
            "relative_time",
            "category",
            "media_type",
            "snippet",
            "screenshot_status",
            "clip_path",
            "quality_score",
            "harvested_at",
        ]
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for row in items:
                writer.writerow(row)
        print(f"📊 Saved CSV Index (with true content timestamps): {csv_path}")

    print("=" * 80)
    print(f"📊 SUMMARY: {verified_count} Verified Clean | {failed_count} Failed | Total: {len(pending_items)}")
    print("=" * 80 + "\n")

    return {
        "total": len(pending_items),
        "verified": verified_count,
        "failed": failed_count,
        "json_path": index_json_path,
    }


def main():
    parser = argparse.ArgumentParser(description="Evidence Screenshot Collector & Timestamp Subagent")
    parser.add_argument("index", help="Path to index.json")
    parser.add_argument("--out-dir", default="clips/evidence_harvested", help="Output directory for screenshots")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of items to capture")
    parser.add_argument("--facebook-only", action="store_true", help="Filter and process only Facebook items")
    parser.add_argument("--timeout", type=int, default=35000, help="Navigation timeout in milliseconds")

    args = parser.parse_args()
    process_index_file(
        index_json_path=args.index,
        output_dir=args.out_dir,
        limit=args.limit,
        facebook_only=args.facebook_only,
        timeout_ms=args.timeout,
    )


if __name__ == "__main__":
    main()
