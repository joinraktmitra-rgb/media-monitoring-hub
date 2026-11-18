#!/usr/bin/env python3
"""
Interactive Media Monitoring Dashboard Generator.
Queries data/media_dataset.db and compiles a responsive HTML report with clippings, categories, sentiment breakdown, and search.
"""

import argparse
import html
import json
import os
import sqlite3
from datetime import datetime


def generate_dashboard(db_path: str = "data/media_dataset.db", out_path: str = "outputs/dashboard.html"):
    if not os.path.exists(db_path):
        print(f"[ERROR] Database {db_path} not found. Run ingest_to_db.py first.")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM clippings_metadata")
    total_articles = cursor.fetchone()[0]

    cursor.execute("SELECT major_category, COUNT(*) FROM clippings_metadata GROUP BY major_category ORDER BY COUNT(*) DESC")
    categories = cursor.fetchall()

    cursor.execute("SELECT sentiment, COUNT(*) FROM clippings_metadata GROUP BY sentiment ORDER BY COUNT(*) DESC")
    sentiments = cursor.fetchall()

    cursor.execute("SELECT publication, COUNT(*) FROM clippings_metadata GROUP BY publication ORDER BY COUNT(*) DESC")
    publications = cursor.fetchall()

    cursor.execute("""
        SELECT id, headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json
        FROM clippings_metadata
        ORDER BY date DESC, id DESC
        LIMIT 500
    """)
    articles = cursor.fetchall()
    conn.close()

    cards_html = []
    for art in articles:
        (art_id, headline, pub, edition, page_no, date_str, cat, sent, clip_path, raw_json_str) = art
        sent_color = "#10b981" if sent.lower() == "positive" else ("#ef4444" if sent.lower() == "negative" else "#6b7280")
        
        transcript = ""
        entities = []
        try:
            raw = json.loads(raw_json_str) if raw_json_str else {}
            transcript = raw.get("transcript") or raw.get("summary") or ""
            ent_dict = raw.get("entities") or {}
            if isinstance(ent_dict, dict):
                for k, v in ent_dict.items():
                    if isinstance(v, list):
                        entities.extend([str(item) for item in v])
                    elif isinstance(v, str):
                        entities.append(v)
        except Exception:
            pass

        img_html = ""
        if clip_path and os.path.exists(clip_path):
            rel_clip = os.path.relpath(clip_path, os.path.dirname(os.path.abspath(out_path)))
            img_html = f'<div class="clip-container"><img src="{html.escape(rel_clip)}" alt="Clipping" loading="lazy" class="clip-img"/></div>'

        entity_pills = "".join([f'<span class="pill pill-entity">{html.escape(e)}</span>' for e in entities[:6]])

        card = f"""
        <div class="card" data-category="{html.escape(cat or '')}" data-sentiment="{html.escape(sent or '')}" data-pub="{html.escape(pub or '')}">
            <div class="card-header">
                <span class="pub-badge">{html.escape(pub or 'Press')}</span>
                <span class="date-badge">{html.escape(date_str or 'Today')} • P.{page_no or 1}</span>
                <span class="sent-badge" style="background:{sent_color}22; color:{sent_color}; border: 1px solid {sent_color}44;">{html.escape(sent or 'Neutral')}</span>
            </div>
            <h3 class="card-title">{html.escape(headline)}</h3>
            {f'<p class="card-excerpt">{html.escape(transcript[:220])}...</p>' if transcript else ''}
            {img_html}
            <div class="pills-container">
                <span class="pill pill-cat">{html.escape(cat or 'General')}</span>
                {entity_pills}
            </div>
        </div>
        """
        cards_html.append(card)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Monitoring Intelligence Hub</title>
    <style>
        :root {{
            --bg: #0f172a;
            --surface: #1e293b;
            --surface-hover: #334155;
            --border: #334155;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --primary: #38bdf8;
            --accent: #6366f1;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
        body {{ background: var(--bg); color: var(--text-main); padding: 24px; min-height: 100vh; }}
        .header {{ display: flex; justify-content: space-between; align-items: center; padding-bottom: 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }}
        .header h1 {{ font-size: 24px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 10px; }}
        .stats-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }}
        .stat-card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }}
        .stat-card .label {{ font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }}
        .stat-card .val {{ font-size: 28px; font-weight: 700; color: var(--primary); margin-top: 6px; }}
        .controls {{ display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }}
        .search-box {{ flex: 1; min-width: 260px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; color: #fff; font-size: 14px; outline: none; }}
        .search-box:focus {{ border-color: var(--primary); }}
        .filter-select {{ background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; color: #fff; font-size: 14px; outline: none; cursor: pointer; }}
        .cards-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }}
        .card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 12px; transition: transform 0.15s, border-color 0.15s; }}
        .card:hover {{ border-color: var(--primary); transform: translateY(-2px); }}
        .card-header {{ display: flex; align-items: center; justify-content: space-between; font-size: 12px; gap: 8px; }}
        .pub-badge {{ background: #0284c722; color: #38bdf8; padding: 3px 8px; border-radius: 6px; font-weight: 600; }}
        .date-badge {{ color: var(--text-muted); }}
        .sent-badge {{ padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; text-transform: capitalize; }}
        .card-title {{ font-size: 16px; font-weight: 600; line-height: 1.4; color: #fff; }}
        .card-excerpt {{ font-size: 13px; color: var(--text-muted); line-height: 1.5; }}
        .clip-container {{ max-height: 220px; overflow: hidden; border-radius: 8px; border: 1px solid var(--border); }}
        .clip-img {{ width: 100%; height: auto; display: block; object-fit: cover; }}
        .pills-container {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 8px; }}
        .pill {{ font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 500; }}
        .pill-cat {{ background: #334155; color: #cbd5e1; }}
        .pill-entity {{ background: #1e1b4b; color: #a5b4fc; border: 1px solid #4338ca55; }}
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>📰 Media Monitoring Intelligence Hub</h1>
            <p style="color:var(--text-muted); font-size:13px; margin-top:4px;">Generated {datetime.now().strftime("%d %b %Y, %I:%M %p")}</p>
        </div>
        <div style="font-size:13px; color:var(--text-muted)">Workspace: <code>Downloads/media</code></div>
    </div>

    <div class="stats-grid">
        <div class="stat-card">
            <div class="label">Total Clippings</div>
            <div class="val">{total_articles}</div>
        </div>
        <div class="stat-card">
            <div class="label">Publications Monitored</div>
            <div class="val">{len(publications)}</div>
        </div>
        <div class="stat-card">
            <div class="label">Key Categories</div>
            <div class="val">{len(categories)}</div>
        </div>
    </div>

    <div class="controls">
        <input type="text" id="searchInput" class="search-box" placeholder="Search headlines, entities, text..." oninput="filterCards()">
        <select id="catFilter" class="filter-select" onchange="filterCards()">
            <option value="">All Categories</option>
            {''.join([f'<option value="{html.escape(c[0] or "")}">{html.escape(c[0] or "General")} ({c[1]})</option>' for c in categories])}
        </select>
        <select id="sentFilter" class="filter-select" onchange="filterCards()">
            <option value="">All Sentiments</option>
            {''.join([f'<option value="{html.escape(s[0] or "")}">{html.escape(s[0] or "Neutral")} ({s[1]})</option>' for s in sentiments])}
        </select>
    </div>

    <div class="cards-grid" id="cardsGrid">
        {''.join(cards_html) if cards_html else '<p style="color:var(--text-muted)">No clippings found in database yet. Ingest clippings via ingest_to_db.py</p>'}
    </div>

    <script>
        function filterCards() {{
            const query = document.getElementById('searchInput').value.toLowerCase();
            const cat = document.getElementById('catFilter').value.toLowerCase();
            const sent = document.getElementById('sentFilter').value.toLowerCase();
            const cards = document.querySelectorAll('.card');

            cards.forEach(card => {{
                const text = card.innerText.toLowerCase();
                const cardCat = (card.dataset.category || '').toLowerCase();
                const cardSent = (card.dataset.sentiment || '').toLowerCase();

                const matchQuery = !query || text.includes(query);
                const matchCat = !cat || cardCat === cat;
                const matchSent = !sent || cardSent === sent;

                card.style.display = (matchQuery && matchCat && matchSent) ? 'flex' : 'none';
            }});
        }}
    </script>
</body>
</html>
    """

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    print(f"[SUCCESS] Dashboard generated at {out_path} with {len(cards_html)} clippings.")


def main():
    parser = argparse.ArgumentParser(description="Generate Media Monitoring Dashboard HTML")
    parser.add_argument("--db", default="data/media_dataset.db", help="Path to SQLite database")
    parser.add_argument("--out", default="outputs/dashboard.html", help="Path to output HTML file")
    args = parser.parse_args()
    generate_dashboard(args.db, args.out)


if __name__ == "__main__":
    main()
