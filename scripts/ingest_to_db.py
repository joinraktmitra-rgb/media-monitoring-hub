#!/usr/bin/env python3
"""
Media Deep Categorization Database Ingestion Script.
Ingests JSON article extractions from dataset_root or dataset/ into SQLite database (data/media_dataset.db).
"""

import argparse
import json
import os
import sqlite3
from pathlib import Path


def find_json_files(root_dir: str) -> list[str]:
    json_files = []
    for dirpath, _, filenames in os.walk(root_dir):
        for f in filenames:
            if f.endswith(".json") and not f.startswith("."):
                json_files.append(os.path.join(dirpath, f))
    return sorted(json_files)


def setup_database(db_path: str = "data/media_dataset.db") -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS clippings_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            headline TEXT,
            publication TEXT,
            edition TEXT,
            page_number INTEGER,
            date TEXT,
            major_category TEXT,
            sentiment TEXT,
            clip_path TEXT,
            raw_json JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_clippings_date ON clippings_metadata(date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_clippings_pub ON clippings_metadata(publication)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_clippings_cat ON clippings_metadata(major_category)")
    conn.commit()
    return conn


def ingest_data(json_paths: list[str], conn: sqlite3.Connection):
    cursor = conn.cursor()
    ingested_count = 0
    skipped_count = 0

    for path in json_paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"[WARN] Failed to read {path}: {e}")
            continue

        # Handle both single-story JSON and container with multiple stories
        stories = []
        if isinstance(data, dict):
            if "stories" in data and isinstance(data["stories"], list):
                base_pub = data.get("newspaper") or data.get("publication", "")
                base_edition = data.get("edition", "")
                base_page = data.get("page_number", 1)
                base_date = data.get("date", "")
                for s in data["stories"]:
                    s.setdefault("publication", base_pub)
                    s.setdefault("edition", base_edition)
                    s.setdefault("page_number", base_page)
                    s.setdefault("date", base_date)
                    stories.append(s)
            else:
                stories.append(data)
        elif isinstance(data, list):
            stories.extend(data)

        for s in stories:
            headline = s.get("headline", "").strip()
            if not headline:
                continue

            pub = s.get("newspaper") or s.get("publication", "")
            edition = s.get("edition", "")
            page_no = s.get("page_number") or s.get("page", 1)
            date_str = s.get("date", "")
            taxonomy = s.get("taxonomy") or {}
            major_category = taxonomy.get("major_category") or s.get("major_category", "General")
            sentiment = taxonomy.get("sentiment") or s.get("sentiment", "Neutral")
            clip_path = s.get("clip_path") or s.get("image_path", "")
            raw_json_str = json.dumps(s, ensure_ascii=False)

            # Prevent duplicate inserts based on headline + publication + date
            cursor.execute(
                "SELECT id FROM clippings_metadata WHERE headline=? AND publication=? AND date=?",
                (headline, pub, date_str),
            )
            if cursor.fetchone():
                skipped_count += 1
                continue

            cursor.execute(
                """
                INSERT INTO clippings_metadata (headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (headline, pub, edition, page_no, date_str, major_category, sentiment, clip_path, raw_json_str),
            )
            ingested_count += 1
            print(f"  + [{pub}] {headline[:60]}... ({sentiment})")

    conn.commit()
    print(f"\n[DONE] Ingestion complete. Ingested: {ingested_count}, Skipped duplicates: {skipped_count}")


def main():
    parser = argparse.ArgumentParser(description="Ingest newspaper extractions into SQLite")
    parser.add_argument("--dir", default="dataset", help="Directory containing JSON files (default: dataset)")
    parser.add_argument("--db", default="data/media_dataset.db", help="SQLite DB path (default: data/media_dataset.db)")
    args = parser.parse_args()

    # Fallback to dataset_root if dataset directory is empty/non-existent
    target_dir = args.dir
    if not os.path.exists(target_dir) or not os.listdir(target_dir):
        if os.path.exists("dataset_root") and os.listdir("dataset_root"):
            target_dir = "dataset_root"

    print(f"Scanning '{target_dir}' for JSON extractions...")
    json_paths = find_json_files(target_dir)
    print(f"Found {len(json_paths)} JSON file(s).")

    if json_paths:
        conn = setup_database(args.db)
        ingest_data(json_paths, conn)

        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM clippings_metadata")
        total = cursor.fetchone()[0]
        print(f"Total articles in database: {total}")
        conn.close()
    else:
        # Initialize empty database schema
        conn = setup_database(args.db)
        conn.close()
        print(f"Database schema initialized at {args.db}. Add JSON files to '{args.dir}' to ingest.")


if __name__ == "__main__":
    main()
