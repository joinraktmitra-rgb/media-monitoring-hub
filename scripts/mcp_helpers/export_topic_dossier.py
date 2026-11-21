#!/usr/bin/env python3
"""
Ampio Media Intelligence — Topic Dossier & Export Factory.
Generates client-ready deliverables from any isolated topic SQLite DB (data/topics/<topic>.db):
  - docx : Branded Executive Word Dossier with embedded HD print clippings & verified screenshots
  - html : Interactive standalone HTML Media Intelligence Dashboard
  - csv  : Strict Source-of-Truth CSV (with content_published_at, NOT scrape time)
  - json : Complete structured ground-truth JSON bundle
"""

import argparse
import csv
import html as html_lib
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

IST = timezone(timedelta(hours=5, minutes=30))


def load_topic_data(db_path: Path) -> dict[str, Any]:
    if not db_path.is_file():
        raise FileNotFoundError(f"Topic DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    items = [
        dict(r)
        for r in cur.execute(
            "SELECT * FROM items WHERE flagged_irrelevant = 0 ORDER BY COALESCE(content_published_at, harvested_at) DESC"
        ).fetchall()
    ]
    clippings = [
        dict(r)
        for r in cur.execute("SELECT * FROM clippings ORDER BY created_at DESC").fetchall()
    ]
    conn.close()
    return {"items": items, "clippings": clippings}


def make_public_url(file_path: str | None, workspace_root: Path, public_base: str) -> str | None:
    if not file_path or not public_base:
        return None
    abs_p = (workspace_root / file_path).resolve() if not os.path.isabs(file_path) else Path(file_path).resolve()
    base = public_base.rstrip("/")
    for folder, prefix in [
        (workspace_root / "clips", "/assets/clips"),
        (workspace_root / "data" / "rendered", "/assets/rendered"),
        (workspace_root / "outputs", "/assets/outputs"),
    ]:
        try:
            rel = abs_p.relative_to(folder.resolve())
            return f"{base}{prefix}/" + "/".join(rel.parts)
        except ValueError:
            continue
    return None


def export_csv(data: dict[str, Any], out_path: Path, workspace_root: Path, public_base: str) -> dict[str, Any]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "id",
        "headline",
        "url",
        "source",
        "domain",
        "content_published_at",
        "content_date",
        "relative_time",
        "timestamp_confidence",
        "time_source",
        "category",
        "media_type",
        "sentiment",
        "screenshot_status",
        "quality_score",
        "screenshot_url",
        "clip_path",
        "notes",
        "snippet",
        "harvested_at",
    ]
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in data["items"]:
            enriched = dict(row)
            enriched["screenshot_url"] = make_public_url(row.get("clip_path"), workspace_root, public_base) or ""
            writer.writerow(enriched)
    return {"rows": len(data["items"]), "clippings_count": len(data["clippings"])}


def export_json(data: dict[str, Any], out_path: Path, workspace_root: Path, public_base: str, title: str) -> dict[str, Any]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "title": title,
        "generated_at_ist": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S IST"),
        "total_items": len(data["items"]),
        "total_clippings": len(data["clippings"]),
        "items": [
            {**it, "screenshot_url": make_public_url(it.get("clip_path"), workspace_root, public_base)}
            for it in data["items"]
        ],
        "clippings": [
            {**cl, "public_url": make_public_url(cl.get("file_path"), workspace_root, public_base)}
            for cl in data["clippings"]
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"rows": len(data["items"]), "clippings_count": len(data["clippings"])}


def export_html(
    data: dict[str, Any],
    out_path: Path,
    workspace_root: Path,
    public_base: str,
    title: str,
    client_name: str,
    executive_summary: str,
) -> dict[str, Any]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gen_time = datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")

    items_js = []
    for it in data["items"]:
        items_js.append({
            "headline": it.get("headline") or "",
            "url": it.get("url") or "",
            "source": it.get("source") or it.get("domain") or "Web",
            "category": it.get("category") or "Digital News",
            "sentiment": it.get("sentiment") or "Neutral",
            "published_at": it.get("content_published_at") or "Unverified Timestamp",
            "relative_time": it.get("relative_time") or "",
            "status": it.get("screenshot_status") or "PENDING",
            "score": it.get("quality_score") or 0,
            "snippet": it.get("snippet") or "",
            "notes": it.get("notes") or "",
            "img": make_public_url(it.get("clip_path"), workspace_root, public_base) or "",
        })

    clips_js = []
    for cl in data["clippings"]:
        clips_js.append({
            "edition": cl.get("edition") or "Print",
            "page": cl.get("page_number") or 1,
            "headline": cl.get("headline") or cl.get("slug") or "Print Clipping",
            "ocr": (cl.get("ocr_text") or "")[:400],
            "img": make_public_url(cl.get("file_path"), workspace_root, public_base) or "",
        })

    verified_cnt = sum(1 for it in items_js if it["status"] == "VERIFIED_CLEAN")
    pos_cnt = sum(1 for it in items_js if it["sentiment"].lower() == "positive")

    html_doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{html_lib.escape(title)} — Ampio Media Intelligence</title>
<style>
  :root {{ --bg:#0b1120; --card:#111827; --border:#1f2937; --text:#f8fafc; --muted:#94a3b8; --accent:#38bdf8; --green:#22c55e; --amber:#f59e0b; --red:#ef4444; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.5; }}
  .wrap {{ max-width:1280px; margin:0 auto; padding:28px 20px 60px; }}
  header {{ display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-end; gap:16px; border-bottom:1px solid var(--border); padding-bottom:20px; margin-bottom:24px; }}
  h1 {{ margin:0; font-size:26px; letter-spacing:-0.02em; }}
  .sub {{ color:var(--muted); font-size:14px; margin-top:4px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px; margin-bottom:24px; }}
  .kpi {{ background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }}
  .kpi .val {{ font-size:28px; font-weight:700; color:var(--accent); }}
  .kpi .lbl {{ font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; }}
  .summary {{ background:var(--card); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:10px; padding:16px 18px; margin-bottom:24px; white-space:pre-wrap; }}
  .controls {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:20px; }}
  input[type=search], select {{ background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px 14px; font-size:14px; }}
  input[type=search] {{ flex:1; min-width:240px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:16px; }}
  .card {{ background:var(--card); border:1px solid var(--border); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }}
  .card img {{ width:100%; height:200px; object-fit:cover; object-position:top; cursor:pointer; background:#020617; }}
  .card-body {{ padding:14px 16px; display:flex; flex-direction:column; gap:8px; flex:1; }}
  .badges {{ display:flex; flex-wrap:wrap; gap:6px; font-size:11px; }}
  .badge {{ padding:3px 8px; border-radius:999px; background:#1e293b; color:#cbd5e1; font-weight:600; }}
  .badge.clean {{ background:rgba(34,197,94,.15); color:var(--green); }}
  .badge.pos {{ background:rgba(56,189,248,.15); color:var(--accent); }}
  .badge.neg {{ background:rgba(239,68,68,.15); color:var(--red); }}
  .title {{ font-weight:600; font-size:15px; color:var(--text); text-decoration:none; }}
  .title:hover {{ color:var(--accent); }}
  .meta {{ font-size:12px; color:var(--muted); }}
  .snip {{ font-size:13px; color:#cbd5e1; }}
  h2 {{ margin:32px 0 14px; font-size:19px; border-bottom:1px solid var(--border); padding-bottom:8px; }}
  #lightbox {{ display:none; position:fixed; inset:0; background:rgba(0,0,0,.9); z-index:999; align-items:center; justify-content:center; padding:24px; }}
  #lightbox img {{ max-width:95vw; max-height:92vh; border-radius:8px; }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>{html_lib.escape(title)}</h1>
      <div class="sub">{html_lib.escape(client_name)} &bull; Generated {html_lib.escape(gen_time)}</div>
    </div>
    <div class="sub">Ampio Labs Media Intelligence Platform</div>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="val">{len(items_js) + len(clips_js)}</div><div class="lbl">Total Coverage</div></div>
    <div class="kpi"><div class="val">{len(clips_js)}</div><div class="lbl">Print Clippings</div></div>
    <div class="kpi"><div class="val">{len(items_js)}</div><div class="lbl">Digital &amp; Social</div></div>
    <div class="kpi"><div class="val">{verified_cnt}</div><div class="lbl">Verified Screenshots</div></div>
    <div class="kpi"><div class="val">{pos_cnt}</div><div class="lbl">Positive Mentions</div></div>
  </div>

  {f'<div class="summary"><strong>Executive Summary</strong><br/>{html_lib.escape(executive_summary)}</div>' if executive_summary else ''}

  <div id="clips-section"></div>

  <h2>Digital, Social &amp; Video Coverage</h2>
  <div class="controls">
    <input id="q" type="search" placeholder="Search headlines, outlets, snippets..." />
    <select id="cat"><option value="">All Categories</option></select>
    <select id="sent">
      <option value="">All Sentiments</option>
      <option value="Positive">Positive</option>
      <option value="Neutral">Neutral</option>
      <option value="Negative">Negative</option>
    </select>
  </div>
  <div class="grid" id="items-grid"></div>
</div>
<div id="lightbox" onclick="this.style.display='none'"><img id="lb-img" src="" /></div>
<script>
const ITEMS = {json.dumps(items_js, ensure_ascii=False)};
const CLIPS = {json.dumps(clips_js, ensure_ascii=False)};
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lb-img');
function openImg(src) {{ lbImg.src = src; lb.style.display = 'flex'; }}

if (CLIPS.length) {{
  document.getElementById('clips-section').innerHTML = `<h2>Print ePaper Clippings (${{CLIPS.length}})</h2><div class="grid">${{
    CLIPS.map(c => `<div class="card">
      ${{c.img ? `<img src="${{c.img}}" onclick="openImg('${{c.img}}')" />` : ''}}
      <div class="card-body">
        <div class="badges"><span class="badge pos">${{c.edition}}</span><span class="badge">Page ${{c.page}}</span></div>
        <div class="title">${{c.headline}}</div>
        <div class="snip">${{c.ocr}}</div>
      </div>
    </div>`).join('')
  }}</div>`;
}}

const cats = [...new Set(ITEMS.map(i => i.category))].sort();
const catSel = document.getElementById('cat');
cats.forEach(c => {{ const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); }});

function render() {{
  const q = document.getElementById('q').value.toLowerCase();
  const c = catSel.value;
  const s = document.getElementById('sent').value;
  const filtered = ITEMS.filter(i => (!c || i.category === c) && (!s || i.sentiment === s) && (!q || (i.headline + i.source + i.snippet).toLowerCase().includes(q)));
  document.getElementById('items-grid').innerHTML = filtered.map(i => `<div class="card">
    ${{i.img ? `<img src="${{i.img}}" onclick="openImg('${{i.img}}')" />` : ''}}
    <div class="card-body">
      <div class="badges">
        <span class="badge">${{i.category}}</span>
        <span class="badge ${{i.sentiment==='Positive'?'pos':i.sentiment==='Negative'?'neg':''}}">${{i.sentiment}}</span>
        ${{i.status==='VERIFIED_CLEAN' ? `<span class="badge clean">✓ Clean (${{i.score}})</span>` : `<span class="badge">${{i.status}}</span>`}}
      </div>
      <a class="title" href="${{i.url}}" target="_blank" rel="noopener">${{i.headline}}</a>
      <div class="meta">${{i.source}} &bull; Published: <strong>${{i.published_at}}</strong></div>
      ${{i.notes ? `<div class="snip"><em>Note: ${{i.notes}}</em></div>` : ''}}
      <div class="snip">${{i.snippet.slice(0, 200)}}</div>
    </div>
  </div>`).join('');
}}
['q','cat','sent'].forEach(id => document.getElementById(id).addEventListener('input', render));
render();
</script>
</body>
</html>"""

    out_path.write_text(html_doc, encoding="utf-8")
    return {"rows": len(items_js), "clippings_count": len(clips_js)}


def export_docx(
    data: dict[str, Any],
    out_path: Path,
    workspace_root: Path,
    title: str,
    client_name: str,
    executive_summary: str,
) -> dict[str, Any]:
    import docx
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls, qn
    from docx.shared import Inches, Pt, RGBColor

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = docx.Document()
    for s in doc.sections:
        s.top_margin = Inches(0.7)
        s.bottom_margin = Inches(0.7)
        s.left_margin = Inches(0.7)
        s.right_margin = Inches(0.7)

    def shade_cell(cell, hex_color: str):
        tc_pr = cell._tc.get_or_add_tcPr()
        tc_pr.append(parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>'))

    def add_hyperlink(paragraph, url: str, text: str):
        part = paragraph.part
        r_id = part.relate_to(url, docx.opc.constants.RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
        hl = parse_xml(f'<w:hyperlink {nsdecls("w", "r")} r:id="{r_id}"/>')
        run = parse_xml(f'<w:r {nsdecls("w")}><w:rPr><w:color w:val="0284C7"/><w:u w:val="single"/></w:rPr><w:t>{html_lib.escape(text)}</w:t></w:r>')
        hl.append(run)
        paragraph._p.append(hl)

    items = data["items"]
    clips = data["clippings"]
    gen_time = datetime.now(IST).strftime("%d %B %Y, %I:%M %p IST")

    # Cover Header
    p_brand = doc.add_paragraph()
    p_brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_b = p_brand.add_run("AMPIO LABS • MEDIA INTELLIGENCE DOSSIER")
    r_b.bold = True
    r_b.font.size = Pt(11)
    r_b.font.color.rgb = RGBColor(2, 132, 199)

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_t = p_title.add_run(title)
    r_t.bold = True
    r_t.font.size = Pt(24)
    r_t.font.color.rgb = RGBColor(30, 58, 138)

    p_meta = doc.add_paragraph()
    p_meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_m = p_meta.add_run(f"Prepared for: {client_name}  |  Generated: {gen_time}")
    r_m.font.size = Pt(10.5)
    r_m.font.color.rgb = RGBColor(100, 116, 139)

    # KPI Table
    verified_cnt = sum(1 for it in items if it.get("screenshot_status") == "VERIFIED_CLEAN")
    pos_cnt = sum(1 for it in items if str(it.get("sentiment", "")).lower() == "positive")

    tbl = doc.add_table(rows=2, cols=4)
    tbl.style = "Table Grid"
    headers = ["Total Coverage", "Print Clippings", "Digital & Social", "Verified Clean Proofs"]
    vals = [str(len(items) + len(clips)), str(len(clips)), str(len(items)), str(verified_cnt)]
    for i, h in enumerate(headers):
        c0 = tbl.rows[0].cells[i]
        shade_cell(c0, "1E3A8A")
        p = c0.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(h)
        r.bold = True
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(255, 255, 255)

        c1 = tbl.rows[1].cells[i]
        shade_cell(c1, "F1F5F9")
        p1 = c1.paragraphs[0]
        p1.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r1 = p1.add_run(vals[i])
        r1.bold = True
        r1.font.size = Pt(14)
        r1.font.color.rgb = RGBColor(30, 58, 138)

    if executive_summary:
        h_sum = doc.add_heading("Executive Summary", level=1)
        doc.add_paragraph(executive_summary)

    # Category breakdown
    cats: dict[str, int] = {}
    for it in items:
        c = it.get("category") or "Other"
        cats[c] = cats.get(c, 0) + 1
    if cats:
        doc.add_heading("Coverage Breakdown by Pillar", level=2)
        ctbl = doc.add_table(rows=1 + len(cats), cols=2)
        ctbl.style = "Table Grid"
        ctbl.rows[0].cells[0].text = "Media Pillar / Category"
        ctbl.rows[0].cells[1].text = "Items"
        shade_cell(ctbl.rows[0].cells[0], "E2E8F0")
        shade_cell(ctbl.rows[0].cells[1], "E2E8F0")
        for idx, (cat, cnt) in enumerate(sorted(cats.items(), key=lambda x: -x[1]), start=1):
            ctbl.rows[idx].cells[0].text = cat
            ctbl.rows[idx].cells[1].text = str(cnt)

    # Print Clippings Section
    images_embedded = 0
    if clips:
        doc.add_page_break()
        doc.add_heading(f"1. Print ePaper Clippings ({len(clips)})", level=1)
        for idx, cl in enumerate(clips, start=1):
            p = doc.add_paragraph()
            r = p.add_run(f"{idx}. [{cl.get('edition', 'Print')} — Page {cl.get('page_number', 1)}] {cl.get('headline') or cl.get('slug')}")
            r.bold = True
            r.font.size = Pt(11)

            fp = cl.get("file_path")
            abs_img = (workspace_root / fp).resolve() if fp and not os.path.isabs(fp) else (Path(fp) if fp else None)
            if abs_img and abs_img.is_file():
                try:
                    doc.add_picture(str(abs_img), width=Inches(6.2))
                    images_embedded += 1
                except Exception:
                    pass

            ocr = (cl.get("ocr_text") or "").strip()
            if ocr:
                po = doc.add_paragraph(ocr[:600])
                po.runs[0].font.size = Pt(9)
                po.runs[0].font.color.rgb = RGBColor(71, 85, 105)

    # Digital & Social Evidence Section
    if items:
        doc.add_page_break()
        doc.add_heading(f"2. Digital, Social & Video Coverage ({len(items)})", level=1)
        for idx, it in enumerate(items, start=1):
            p = doc.add_paragraph()
            r_hl = p.add_run(f"{idx}. {it.get('headline') or it.get('url')}")
            r_hl.bold = True
            r_hl.font.size = Pt(11)

            pub_ts = it.get("content_published_at") or "Not Available (Source-of-Truth Unverified)"
            p_m = doc.add_paragraph()
            r_mm = p_m.add_run(
                f"Outlet: {it.get('source') or it.get('domain')}  |  Pillar: {it.get('category')}  |  "
                f"Sentiment: {it.get('sentiment', 'Neutral')}  |  Published: {pub_ts}"
            )
            r_mm.font.size = Pt(9)
            r_mm.font.color.rgb = RGBColor(71, 85, 105)

            if it.get("url"):
                p_u = doc.add_paragraph()
                p_u.add_run("Source URL: ").font.size = Pt(9)
                add_hyperlink(p_u, it["url"], it["url"][:95])

            if it.get("notes"):
                pn = doc.add_paragraph(f"Editorial Note: {it['notes']}")
                pn.runs[0].italic = True
                pn.runs[0].font.size = Pt(9.5)

            fp = it.get("clip_path")
            abs_img = (workspace_root / fp).resolve() if fp and not os.path.isabs(fp) else (Path(fp) if fp else None)
            if abs_img and abs_img.is_file():
                try:
                    doc.add_picture(str(abs_img), width=Inches(6.2))
                    images_embedded += 1
                except Exception:
                    pass

    doc.save(str(out_path))
    return {"rows": len(items), "clippings_count": len(clips), "images_embedded": images_embedded, "positive_count": pos_cnt}


def main() -> None:
    parser = argparse.ArgumentParser(description="Ampio Topic Dossier Exporter")
    parser.add_argument("--db", required=True)
    parser.add_argument("--format", required=True, choices=["docx", "html", "csv", "json"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--public-base", default="")
    parser.add_argument("--title", default="Media Intelligence Dossier")
    parser.add_argument("--client", default="Ampio Labs Client")
    parser.add_argument("--summary", default="")

    args = parser.parse_args()
    ws = Path(args.workspace).resolve()
    out_path = Path(args.out).resolve()
    data = load_topic_data(Path(args.db).resolve())

    if args.format == "csv":
        stats = export_csv(data, out_path, ws, args.public_base)
    elif args.format == "json":
        stats = export_json(data, out_path, ws, args.public_base, args.title)
    elif args.format == "html":
        stats = export_html(data, out_path, ws, args.public_base, args.title, args.client, args.summary)
    else:
        stats = export_docx(data, out_path, ws, args.title, args.client, args.summary)

    size_kb = round(out_path.stat().st_size / 1024, 1) if out_path.is_file() else 0
    print(json.dumps({"ok": True, "format": args.format, "out_path": str(out_path), "size_kb": size_kb, **stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
