#!/usr/bin/env python3
"""
Ampio Labs — Universal Google All-Search Harvester & Multi-Channel Categorizer.

Captures Google "All" search results across web, social media (X, Facebook, YouTube),
government portals, diplomatic missions, and civic/rail transit within strict time windows
(Past 24 hours: tbs=qdr:d, Past 48 hours: tbs=qdr:d2).

Outputs an Index File (JSON & CSV) with:
  [id, headline, url, source, domain, time_text, snippet, category, media_type, screenshot_status, clip_path, quality_score]
which is passed to downstream subagents to capture and audit evidence screenshots.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime
from typing import Any, Dict, List, Optional


def run_browse_code(js_code: str, timeout_sec: int = 60) -> Any:
    """Execute sandboxed JS in real Chrome via browse CLI."""
    try:
        proc = subprocess.run(
            ["browse", "execute", js_code],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip()
            print(f"[WARN] browse error: {err}")
            return None

        out = proc.stdout.strip()
        for line in out.splitlines():
            line = line.strip()
            if (line.startswith("{") and line.endswith("}")) or (line.startswith("[") and line.endswith("]")):
                try:
                    return json.loads(line)
                except Exception:
                    continue
        return {"raw": out}
    except Exception as e:
        print(f"[ERROR] browse execution failed: {e}")
        return None


def classify_result(item: Dict[str, Any]) -> Dict[str, str]:
    """
    Classify a search result into 5 strategic media intelligence pillars:
      1. 🏛️ Diplomatic & Gov Portals
      2. 📱 Social Media (X, Facebook, YouTube)
      3. 🚆 Civic & Rail Transit
      4. 📚 Academic, Culture & Literature
      5. 📰 Print & Digital News
    """
    url = (item.get("url") or "").lower()
    source = (item.get("source") or "").lower()
    headline = (item.get("headline") or "").lower()
    snippet = (item.get("snippet") or "").lower()
    text_corpus = f"{url} {source} {headline} {snippet}"

    # 1. Civic & Rail Transit
    if any(k in text_corpus for k in ["indiarailinfo.com", "railmitra.com", "irctc.co.in", "railway", "special train", "train service", "trains from", "train schedule", "stoppages"]):
        return {
            "category": "Civic & Rail Transit",
            "media_type": "train_schedule" if "indiarailinfo" in url or "schedule" in text_corpus else "transit_alert"
        }

    # 2. Diplomatic & Gov Portals
    if any(k in text_corpus for k in [".gov.in", ".nic.in", "embassy of india", "consulate general", "cgijeddah", "indiaatun", "permanent mission of india", "pib india", "pib.gov.in"]):
        return {
            "category": "Diplomatic & Gov Portals",
            "media_type": "official_diplomatic" if "embassy" in text_corpus or "consulate" in text_corpus or "indiaatun" in text_corpus else "official_release"
        }

    # 3. Social Media Intelligence (X, Facebook, YouTube, Instagram)
    if "facebook.com" in url or "facebook" in source:
        mtype = "facebook_video" if ("/videos/" in url or "video" in text_corpus) else "facebook_post"
        return {"category": "Social Media", "media_type": mtype}
    if "x.com" in url or "twitter.com" in url or source == "x" or "twitter" in source:
        return {"category": "Social Media", "media_type": "tweet"}
    if "youtube.com" in url or "youtu.be" in url or "youtube" in source:
        return {"category": "Social Media", "media_type": "youtube_video"}
    if "instagram.com" in url or "instagram" in source:
        return {"category": "Social Media", "media_type": "instagram_post"}

    # 4. Academic, Culture & Literature
    if any(k in text_corpus for k in ["cict.in", "iitm.ac.in", "bhu.ac.in", "thirukkural", "couplet", "syllabus", "internship", "hei registration", "curriculum", "upsc"]):
        return {
            "category": "Academic & Literature",
            "media_type": "literature_couplet" if "couplet" in text_corpus or "thirukkural" in text_corpus else "academic_portal"
        }

    # 5. Default to Mainline / Regional Press
    return {
        "category": "Print & Digital News",
        "media_type": "news_article"
    }


def clean_headline(headline: str) -> str:
    """Clean multi-line Google card titles that append domain or relative time."""
    lines = [l.strip() for l in headline.split("\n") if l.strip()]
    if not lines:
        return headline
    # First line is almost always the actual headline
    first = lines[0]
    # Remove trailing ellipsis if followed by metadata
    first = re.sub(r"\s*\.\.\.\s*$", " ...", first)
    return first


class UniversalGoogleHarvester:
    def __init__(
        self,
        query: str,
        time_window: str = "24h",
        max_pages: int = 5,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        site: Optional[str] = None,
    ):
        self.query = f"site:{site.strip()} {query}".strip() if site else query
        self.time_window = time_window
        self.max_pages = max_pages
        self.date_from = date_from
        self.date_to = date_to

        # Google tbs parameter mapping
        # qdr:h  = Past hour
        # qdr:d  = Past 24 hours
        # qdr:d2 = Past 48 hours
        # qdr:w  = Past week
        # qdr:m  = Past month
        # cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY = Custom range
        if date_from or date_to:
            parts = ["cdr:1"]
            if date_from:
                parts.append(f"cd_min:{date_from}")
            if date_to:
                parts.append(f"cd_max:{date_to}")
            self.tbs = ",".join(parts)
        elif time_window in ("1h", "h", "hour", "past1h"):
            self.tbs = "qdr:h"
        elif time_window in ("24h", "d", "day", "past24h"):
            self.tbs = "qdr:d"
        elif time_window in ("48h", "d2", "2d", "past48h"):
            self.tbs = "qdr:d2"
        elif time_window in ("7d", "w", "week"):
            self.tbs = "qdr:w"
        elif time_window in ("30d", "m", "month"):
            self.tbs = "qdr:m"
        elif time_window in ("any", "all", "none"):
            self.tbs = ""
        else:
            self.tbs = "qdr:d"

    def harvest_all_pages(self) -> List[Dict[str, Any]]:
        """Crawl across multiple pages using Google All-Search with time filter."""
        all_results: List[Dict[str, Any]] = []
        seen_urls = set()

        print(f"\n🔍 [HARVESTER] Launching Google Universal Monitor for: '{self.query}'")
        print(f"   Time Window: {self.time_window} (tbs={self.tbs}) | Max Pages: {self.max_pages}")
        print("=" * 80)

        for page_idx in range(self.max_pages):
            start_offset = page_idx * 10
            encoded_query = urllib.parse.quote_plus(self.query)
            tbs_part = f"&tbs={urllib.parse.quote(self.tbs, safe=':,')}" if self.tbs else ""
            search_url = f"https://www.google.com/search?q={encoded_query}{tbs_part}&start={start_offset}"
            print(f"  -> Crawling Page {page_idx + 1} (start={start_offset})...")

            js_scraper = f"""
            const searchUrl = {json.dumps(search_url)};
            await page.goto(searchUrl, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
            await page.waitForTimeout(2200);

            const items = await page.evaluate(() => {{
              const list = [];
              const allAnchors = Array.from(document.querySelectorAll('a[href^="http"]'));
              const seen = new Set();

              for (const a of allAnchors) {{
                const href = a.href;
                if (!href || href.includes('google.com') || href.includes('webcache') || seen.has(href)) continue;

                const h3 = a.querySelector('h3, div[role="heading"]');
                if (!h3) continue;
                const rawHeadline = h3.innerText.trim();
                if (rawHeadline.length < 5) continue;

                seen.add(href);

                // Container extraction
                const container = a.closest('div.g') || a.closest('div[data-sokoban-container]') || a.closest('div.SoaBEf') || a.parentElement?.parentElement;

                let source = '';
                const cite = container ? container.querySelector('cite, .VuuXrf, .NUnG9d span, span.G5UQBc, .OSrXXb') : null;
                if (cite) source = cite.innerText.trim();
                if (!source) {{
                  try {{ source = new URL(href).hostname.replace('www.', ''); }} catch(e) {{}}
                }}

                let snippet = '';
                const snipEl = container ? container.querySelector('div[style*="-webkit-line-clamp"], .VwiC3b, .yXK7lf, span.aCOpRe') : null;
                if (snipEl) snippet = snipEl.innerText.trim();

                let timeText = '';
                const timeEl = container ? container.querySelector('span.r0bn4c, span.OSrXXb, span.S1FAPd, time, .rbYSKb') : null;
                if (timeEl) timeText = timeEl.innerText.trim();

                list.push({{
                  raw_headline: rawHeadline,
                  url: href,
                  source: source,
                  snippet: snippet,
                  time_text: timeText
                }});
              }}
              return list;
            }});

            await page.close();
            return items;
            """

            page_data = run_browse_code(js_scraper)
            if not page_data or not isinstance(page_data, list):
                print(f"     [INFO] Page {page_idx + 1} yielded 0 new results or reached end of pagination.")
                break

            new_on_page = 0
            for raw in page_data:
                url = raw.get("url")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)

                cleaned_hl = clean_headline(raw.get("raw_headline", ""))
                try:
                    domain = urllib.parse.urlparse(url).netloc.replace("www.", "")
                except Exception:
                    domain = "web"

                # Parse classification
                cls_info = classify_result({
                    "url": url,
                    "source": raw.get("source", ""),
                    "headline": cleaned_hl,
                    "snippet": raw.get("snippet", "")
                })

                entry = {
                    "id": len(all_results) + 1,
                    "headline": cleaned_hl,
                    "url": url,
                    "source": raw.get("source") or domain,
                    "domain": domain,
                    "time_text": raw.get("time_text") or "Recent (Past 24-48h)",
                    "snippet": raw.get("snippet", ""),
                    "category": cls_info["category"],
                    "media_type": cls_info["media_type"],
                    "screenshot_status": "PENDING",
                    "clip_path": None,
                    "quality_score": 0,
                    "harvested_at": datetime.now().isoformat()
                }
                all_results.append(entry)
                new_on_page += 1

            print(f"     ✓ Extracted {new_on_page} unique items from Page {page_idx + 1}.")
            if new_on_page == 0:
                print("     [INFO] No further new links discovered. Stopping pagination.")
                break

            time.sleep(1.0)

        print("-" * 80)
        print(f"📊 Total Harvested Results: {len(all_results)} across {page_idx + 1} pages.")

        # Print Category breakdown
        cat_counts: Dict[str, int] = {}
        for r in all_results:
            cat_counts[r["category"]] = cat_counts.get(r["category"], 0) + 1

        print("\n📂 Category Breakdown:")
        for cat, cnt in sorted(cat_counts.items(), key=lambda x: -x[1]):
            print(f"   • {cat.padEnd(30) if hasattr(cat, 'padEnd') else cat:<30}: {cnt} items")
        print("=" * 80 + "\n")

        return all_results

    def save_index_files(self, items: List[Dict[str, Any]], json_path: str, csv_path: str):
        """Save index items to JSON and CSV formats."""
        os.makedirs(os.path.dirname(os.path.abspath(json_path)), exist_ok=True)
        os.makedirs(os.path.dirname(os.path.abspath(csv_path)), exist_ok=True)

        # 1. Save JSON
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump({
                "query": self.query,
                "time_window": self.time_window,
                "tbs": self.tbs,
                "harvested_at": datetime.now().isoformat(),
                "total_items": len(items),
                "items": items
            }, f, indent=2, ensure_ascii=False)
        print(f"📄 Saved JSON Index File: {json_path}")

        # 2. Save CSV
        if items:
            fieldnames = [
                "id", "headline", "url", "source", "domain",
                "time_text", "category", "media_type", "snippet",
                "screenshot_status", "clip_path", "quality_score", "harvested_at"
            ]
            with open(csv_path, "w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
                writer.writeheader()
                for itm in items:
                    writer.writerow(itm)
            print(f"📊 Saved CSV Index File:  {csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Universal Google Search Harvester & Categorizer")
    parser.add_argument("--query", "-q", default="kashi tamil sangamam", help="Search query")
    parser.add_argument("--window", "-w", default="24h", choices=["1h", "24h", "48h", "7d", "30d", "any"], help="Time window")
    parser.add_argument("--date-from", default=None, help="Custom range start (MM/DD/YYYY)")
    parser.add_argument("--date-to", default=None, help="Custom range end (MM/DD/YYYY)")
    parser.add_argument("--site", default=None, help="Optional domain/site filter (e.g. facebook.com)")
    parser.add_argument("--max-pages", "-p", type=int, default=5, help="Max pages to crawl")
    parser.add_argument("--out", default="data/kashi_tamil_sangamam_index.json", help="Output JSON index path")
    parser.add_argument("--out-csv", default="data/kashi_tamil_sangamam_index.csv", help="Output CSV index path")

    args = parser.parse_args()
    harvester = UniversalGoogleHarvester(
        query=args.query,
        time_window=args.window,
        max_pages=args.max_pages,
        date_from=args.date_from,
        date_to=args.date_to,
        site=args.site,
    )
    items = harvester.harvest_all_pages()
    harvester.save_index_files(items, args.out, args.out_csv)


if __name__ == "__main__":
    main()
