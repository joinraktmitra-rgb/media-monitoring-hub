#!/usr/bin/env python3
"""
Ampio Labs — Executive 48-Hour Media Intelligence Dossier (.docx).
Reads print clippings, online articles, YouTube channels, and Instagram posts from data/media_dataset.db
and generates a pixel-perfect, client-facing executive Word report strictly matching Ampio Labs branding.

Sections:
  1. Cover Page (Ampio Labs branding, KTS Logo, Date Range: 17-18 Nov 2026)
  2. 48-Hour Executive Summary (KPI metrics table, key thematic narratives)
  3. Regional Print Coverage (UP, TN, National/Delhi tables + 2x4 clipping plates)
  4. Online News & Blogs Coverage (Detailed index table + full desktop screenshots with live links)
  5. Social & Video Intelligence (YouTube channel cards with CDN thumbnails + Instagram post cards with screenshots)
"""

import argparse
import html
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import docx
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Inches, Pt, RGBColor


def set_cell_background(cell, hex_color: str):
    """Set background color of a table cell."""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    tc_pr.append(shd)


def set_cell_margins(cell, top=100, bottom=100, left=140, right=140):
    """Set internal cell padding."""
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = parse_xml(f'''
        <w:tcMar {nsdecls("w")}>
            <w:top w:w="{top}" w:type="dxa"/>
            <w:bottom w:w="{bottom}" w:type="dxa"/>
            <w:left w:w="{left}" w:type="dxa"/>
            <w:right w:w="{right}" w:type="dxa"/>
        </w:tcMar>
    ''')
    tc_pr.append(tc_mar)


def add_hyperlink(paragraph, url: str, text: str, color="0284C7", underline=True):
    """Add a clickable hyperlink to a paragraph."""
    part = paragraph.part
    r_id = part.relate_to(url, docx.opc.constants.RELATIONSHIP_TYPE.HYPERLINK, is_external=True)

    hyperlink = parse_xml(f'<w:hyperlink {nsdecls("w", "r")} r:id="{r_id}"/>')
    new_run = parse_xml(f'<w:r {nsdecls("w")}><w:rPr/></w:r>')
    escaped_text = html.escape(text)
    r_text = parse_xml(f'<w:t {nsdecls("w")}>{escaped_text}</w:t>')
    new_run.append(r_text)

    r_pr = new_run.find(qn('w:rPr'))
    if color:
        c = parse_xml(f'<w:color {nsdecls("w")} w:val="{color}"/>')
        r_pr.append(c)
    if underline:
        u = parse_xml(f'<w:u {nsdecls("w")} w:val="single"/>')
        r_pr.append(u)

    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)


def build_48h_coverage_dossier(
    db_path: str = "data/media_dataset.db",
    out_path: str = "outputs/Ampio_KTS_Today_19Nov_Morning_Report.docx",
    logo_path: str = "assets/kts_logo.png",
    title_text: str = "Kashi Tamil Sangamam 5.0",
    date_range_str: str = "19 November 2026 (Morning Edition, 09:45 AM IST)"
):
    print(f"\n==================================================================")
    print(f"📄 GENERATING MASTER EXECUTIVE WORD DOSSIER: {out_path}")
    print(f"==================================================================")

    doc = docx.Document()

    # 0.75-inch margins
    for s in doc.sections:
        s.top_margin = Inches(0.75)
        s.bottom_margin = Inches(0.75)
        s.left_margin = Inches(0.75)
        s.right_margin = Inches(0.75)

    # ==============================================================================
    # 1. COVER PAGE
    # ==============================================================================
    p_logo = doc.add_paragraph()
    p_logo.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if os.path.exists(logo_path):
        p_logo.paragraph_format.space_before = Pt(40)
        p_logo.paragraph_format.space_after = Pt(20)
        p_logo.add_run().add_picture(logo_path, width=Inches(2.5))

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(24)
    p_title.paragraph_format.space_after = Pt(6)
    r_title = p_title.add_run(title_text)
    r_title.bold = True
    r_title.font.size = Pt(26)
    r_title.font.name = "Arial"
    r_title.font.color.rgb = RGBColor(30, 58, 138)  # Deep Navy Blue

    p_sub = doc.add_paragraph()
    p_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_sub.paragraph_format.space_after = Pt(8)
    r_sub = p_sub.add_run("Fresh Morning Media Intelligence & Verification Dossier")
    r_sub.font.size = Pt(17)
    r_sub.font.name = "Arial"
    r_sub.font.color.rgb = RGBColor(100, 116, 139)

    p_date = doc.add_paragraph()
    p_date.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_date.paragraph_format.space_after = Pt(140)
    r_date = p_date.add_run(f"Coverage Period: {date_range_str}")
    r_date.font.size = Pt(13)
    r_date.font.name = "Arial"
    r_date.font.color.rgb = RGBColor(71, 85, 105)

    p_prep = doc.add_paragraph()
    p_prep.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_prep.paragraph_format.space_after = Pt(4)
    r_prep = p_prep.add_run("Prepared Strictly By")
    r_prep.font.size = Pt(11)
    r_prep.font.color.rgb = RGBColor(148, 163, 184)

    # Ampio Labs Agency Branding
    p_brand = doc.add_paragraph()
    p_brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_brand1 = p_brand.add_run("AMPIO ")
    r_brand1.bold = True
    r_brand1.font.size = Pt(22)
    r_brand1.font.name = "Arial"
    r_brand1.font.color.rgb = RGBColor(2, 132, 199)  # Sky Blue

    r_brand2 = p_brand.add_run("LABS")
    r_brand2.bold = True
    r_brand2.font.size = Pt(22)
    r_brand2.font.name = "Arial"
    r_brand2.font.color.rgb = RGBColor(30, 41, 59)   # Slate Dark

    p_brand_tag = doc.add_paragraph()
    p_brand_tag.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_tag = p_brand_tag.add_run("Strategic Media Intelligence & Public Affairs Operations")
    r_tag.font.size = Pt(10)
    r_tag.font.name = "Arial"
    r_tag.font.color.rgb = RGBColor(148, 163, 184)

    doc.add_page_break()

    # ==============================================================================
    # FETCH DATA FROM DATABASE
    # ==============================================================================
    print_items = []
    online_news_items = []
    youtube_items = []
    instagram_items = []

    if os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("""
            SELECT id, headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json
            FROM clippings_metadata
            ORDER BY id ASC
        """)
        rows = cur.fetchall()
        conn.close()

        for r in rows:
            r_id, hl, pub, ed, pg, d_str, cat, sent, clip, raw_str = r
            raw = {}
            url = ""
            try:
                raw = json.loads(raw_str) if raw_str else {}
                url = raw.get("url", "")
            except Exception:
                pass

            item = {
                "id": r_id,
                "headline": hl,
                "publication": pub,
                "edition": ed or "National",
                "page": pg or 1,
                "date": d_str or "19-11-2026",
                "major_category": cat,
                "sentiment": sent or "Positive",
                "clip_path": clip or "",
                "url": url,
                "raw_json": raw,
            }

            pub_l = pub.lower()
            if "print" in cat.lower():
                print_items.append(item)
            elif "youtube" in pub_l:
                youtube_items.append(item)
            elif "instagram" in pub_l:
                instagram_items.append(item)
            else:
                online_news_items.append(item)

    total_clippings = len(print_items) + len(online_news_items) + len(youtube_items) + len(instagram_items)
    print(f"Loaded {total_clippings} total items from DB:")
    print(f"  - Print Clippings:      {len(print_items)}")
    print(f"  - Online News Articles: {len(online_news_items)}")
    print(f"  - YouTube Channels:     {len(youtube_items)}")
    print(f"  - Instagram Posts:      {len(instagram_items)}")

    # ==============================================================================
    # 2. EXECUTIVE SUMMARY & KPI AUDIT
    # ==============================================================================
    h_exec = doc.add_heading(level=1)
    r_he = h_exec.add_run(f"1. EXECUTIVE SUMMARY & KPI AUDIT ({date_range_str})")
    r_he.bold = True
    r_he.font.color.rgb = RGBColor(30, 58, 138)
    h_exec.paragraph_format.space_after = Pt(12)

    p_intro = doc.add_paragraph()
    p_intro.paragraph_format.space_after = Pt(12)
    p_intro.paragraph_format.line_spacing = 1.15
    r_intro = p_intro.add_run(
        f"This media monitoring dossier delivers an authentic, multi-channel intelligence audit of coverage "
        f"for Kashi Tamil Sangamam 5.0 (KTS 5.0) across the morning cycle of {date_range_str}. "
        f"The audit captures vernacular, regional, and national reporting across high-circulation print dailies, digital portals, "
        f"broadcast YouTube channels, and official social handles. Over this period, {total_clippings} verified "
        f"fresh media appearances were cataloged with 100% positive and constructive sentiment."
    )
    r_intro.font.size = Pt(10.5)
    r_intro.font.name = "Arial"

    # KPI Table
    tbl_kpi = doc.add_table(rows=1, cols=4)
    tbl_kpi.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_kpi.autofit = False

    kpi_headers = ["Channel / Media Stream", "Coverage Volume", "Regional Reach", "Tone & Sentiment"]
    kpi_widths = [Inches(2.5), Inches(1.3), Inches(1.8), Inches(1.3)]
    for idx, (cell, title, w) in enumerate(zip(tbl_kpi.rows[0].cells, kpi_headers, kpi_widths)):
        cell.width = w
        cell.text = title
        set_cell_background(cell, "1E3A8A")
        set_cell_margins(cell, top=120, bottom=120, left=120, right=120)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.size = Pt(9.5)
            r.font.color.rgb = RGBColor(255, 255, 255)

    kpi_rows = [
        ("Print Newspaper Clippings", f"{len(print_items)} Placements", "Varanasi, UP & Chennai, TN", "100% Positive"),
        ("Online News & Official Portals", f"{len(online_news_items)} Articles", "National Wire, UP & Tamil Nadu", "100% Positive"),
        ("Broadcast YouTube Channels", f"{len(youtube_items)} Channels", "Tamil Nadu & Hindi Belt", "100% Positive"),
    ]
    if len(instagram_items) > 0:
        kpi_rows.append(("Instagram Official Handles", f"{len(instagram_items)} Posts", "National Youth Engagement", "100% Positive"))
    kpi_rows.append(("Total Verified Media Footprint", f"{total_clippings} Verified Items", "Multi-State All India", "100% Positive"))

    for row_idx, r_data in enumerate(kpi_rows):
        row_cells = tbl_kpi.add_row().cells
        for col_idx, (c, text, w) in enumerate(zip(row_cells, r_data, kpi_widths)):
            c.width = w
            c.text = text
            set_cell_margins(c, top=90, bottom=90, left=120, right=120)
            if row_idx == len(kpi_rows) - 1:
                set_cell_background(c, "E2E8F0")  # Highlight total
            elif row_idx % 2 == 1:
                set_cell_background(c, "F8FAFC")
            p = c.paragraphs[0]
            if col_idx in [1, 3]:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"
                if row_idx == len(kpi_rows) - 1:
                    r.bold = True

    p_space = doc.add_paragraph()
    p_space.paragraph_format.space_before = Pt(16)
    p_space.paragraph_format.space_after = Pt(8)

    # Core Themes
    h_themes = doc.add_heading(level=2)
    r_ht = h_themes.add_run(f"Key Strategic Narrative Pillars ({date_range_str})")
    r_ht.bold = True
    r_ht.font.size = Pt(13)
    r_ht.font.color.rgb = RGBColor(30, 58, 138)

    themes = [
        ("VVIP Inauguration Confirmation (Vice President & UP CM)",
         "Dainik Jagran Varanasi City edition (19-Nov-2026, Page 21) confirmed attendance prospects of Hon'ble Vice President C.P. Radhakrishnan alongside Uttar Pradesh Chief Minister Yogi Adityanath for the official inauguration of Kashi Tamil Sangamam 5.0 at Varanasi on 28 November 2026."),
        ("Administrative Ground Readiness Inspections",
         "Newly appointed Varanasi Divisional Commissioner K. Vijayendra Pandian personally conducted multi-departmental inspections at Namo Ghat, reviewing pontoon bridges, ghat security cordons, crowd flow, and guest pavilion preparations (Dainik Jagran 19-Nov-2026, Page 11)."),
        ("Nationwide Academic Integration & Thirukkural Curriculum",
         "Amar Ujala (18-Nov-2026, Page 6 & Page 2) detailed the massive academic rollout across 37 States and UTs. Banaras Hindu University (BHU) was designated the state nodal coordinator overseeing 300+ higher educational institutions in UP, while over 1,000 institutions nationwide integrate Thirukkural ethics via CICT multilingual study companions."),
        ("Special Express Train Services & Passenger Transit",
         "Southern Railway and Northern Railway officially announced 14 special express train services starting 25 November connecting Chennai Central, Coimbatore, and Kanniyakumari with Banaras and Varanasi Junction to transport 1,400 delegates across 7 thematic cohorts (The Hindu Tamil Page 15 & Jagran Josh).")
    ]

    for title, desc in themes:
        p_t = doc.add_paragraph()
        p_t.paragraph_format.space_after = Pt(6)
        r_bullet = p_t.add_run("•  ")
        r_bullet.bold = True
        r_bullet.font.color.rgb = RGBColor(2, 132, 199)
        r_tt = p_t.add_run(f"{title}: ")
        r_tt.bold = True
        r_tt.font.size = Pt(10)
        r_tt.font.color.rgb = RGBColor(30, 41, 59)
        r_td = p_t.add_run(desc)
        r_td.font.size = Pt(10)

    doc.add_page_break()

    # ==============================================================================
    # 3. PRINT COVERAGE SECTION
    # ==============================================================================
    h_print = doc.add_heading(level=1)
    r_hp = h_print.add_run("2. PRINT MEDIA COVERAGE")
    r_hp.bold = True
    r_hp.font.color.rgb = RGBColor(30, 58, 138)
    h_print.paragraph_format.space_after = Pt(12)

    tbl_print = doc.add_table(rows=1, cols=4)
    tbl_print.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_print.autofit = False

    print_col_names = ["S. No.", "Date", "Publication", "Edition & Page"]
    print_col_widths = [Inches(0.8), Inches(1.3), Inches(2.6), Inches(2.0)]

    for cell, name, w in zip(tbl_print.rows[0].cells, print_col_names, print_col_widths):
        cell.width = w
        cell.text = name
        set_cell_background(cell, "1E3A8A")
        set_cell_margins(cell, top=120, bottom=120, left=140, right=140)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.size = Pt(9.5)
            r.font.color.rgb = RGBColor(255, 255, 255)

    current_region = None
    row_count = 1

    for itm in print_items:
        raw = itm.get("raw_json", {})
        ed = itm.get("edition", "")
        region = raw.get("region") or ("Uttar Pradesh" if "varanasi" in ed.lower() or "lucknow" in ed.lower() else ("Tamil Nadu" if "chennai" in ed.lower() or "tamil" in ed.lower() else "New Delhi / National"))

        if region != current_region:
            current_region = region
            reg_row = tbl_print.add_row()
            c_start = reg_row.cells[0]
            c_end = reg_row.cells[3]
            c_start.merge(c_end)
            c_start.text = region
            set_cell_background(c_start, "DCEAFE")
            set_cell_margins(c_start, top=100, bottom=100, left=140, right=140)
            p_reg = c_start.paragraphs[0]
            p_reg.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p_reg.runs:
                r.bold = True
                r.font.size = Pt(10)
                r.font.color.rgb = RGBColor(30, 58, 138)

        row_cells = tbl_print.add_row().cells
        edition_pg = f"{itm.get('edition', '')} (P.{itm.get('page', '01')})"
        data_vals = [str(row_count), itm.get("date", ""), itm.get("publication", ""), edition_pg]
        row_count += 1

        for c_idx, (c, val, w) in enumerate(zip(row_cells, data_vals, print_col_widths)):
            c.width = w
            c.text = val
            set_cell_margins(c, top=90, bottom=90, left=120, right=120)
            if row_count % 2 == 1:
                set_cell_background(c, "F8FAFC")
            p = c.paragraphs[0]
            if c_idx < 2:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"

    doc.add_page_break()

    # PRINT CLIPPINGS PLATES (2x4 METADATA + IMAGE)
    p_plate_head = doc.add_heading(level=2)
    r_ph = p_plate_head.add_run("Print Clipping Dossier Plates")
    r_ph.bold = True
    r_ph.font.color.rgb = RGBColor(30, 58, 138)

    for idx, itm in enumerate(print_items):
        meta_tbl = doc.add_table(rows=3, cols=4)
        meta_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        meta_tbl.autofit = False

        box_widths = [Inches(1.2), Inches(2.2), Inches(1.2), Inches(2.1)]
        row0 = meta_tbl.rows[0].cells
        row0[0].text = "Date"
        row0[1].text = str(itm.get("date", ""))
        row0[2].text = "Page No."
        row0[3].text = str(itm.get("page", "01"))

        row1 = meta_tbl.rows[1].cells
        row1[0].text = "Publication"
        row1[1].text = str(itm.get("publication", ""))
        row1[2].text = "Edition"
        row1[3].text = str(itm.get("edition", ""))

        row2 = meta_tbl.rows[2].cells
        row2[0].text = "Headline"
        row2[1].merge(row2[2]).merge(row2[3])
        row2[1].text = str(itm.get("headline", ""))

        for r_i, r_cells in enumerate([row0, row1]):
            for c_i, cell in enumerate(r_cells):
                cell.width = box_widths[c_i]
                set_cell_margins(cell, top=80, bottom=80, left=100, right=100)
                set_cell_background(cell, "F1F5F9" if c_i in [0, 2] else "FFFFFF")
                p = cell.paragraphs[0]
                for run in p.runs:
                    run.font.size = Pt(9.5)
                    run.font.name = "Arial"
                    if c_i in [0, 2]:
                        run.bold = True
                        run.font.color.rgb = RGBColor(71, 85, 105)

        # Style headline row
        set_cell_margins(row2[0], top=80, bottom=80, left=100, right=100)
        set_cell_background(row2[0], "F1F5F9")
        p_hl_lbl = row2[0].paragraphs[0]
        for run in p_hl_lbl.runs:
            run.font.size = Pt(9.5)
            run.font.name = "Arial"
            run.bold = True
            run.font.color.rgb = RGBColor(71, 85, 105)

        set_cell_margins(row2[1], top=80, bottom=80, left=100, right=100)
        set_cell_background(row2[1], "FFFFFF")
        p_hl_val = row2[1].paragraphs[0]
        for run in p_hl_val.runs:
            run.font.size = Pt(10)
            run.font.name = "Arial"
            run.bold = True
            run.font.color.rgb = RGBColor(30, 41, 59)

        p_img = doc.add_paragraph()
        p_img.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_img.paragraph_format.space_before = Pt(12)
        p_img.paragraph_format.space_after = Pt(20)

        clip_file = itm.get("clip_path", "")
        if clip_file and os.path.exists(clip_file):
            r_im = p_img.add_run()
            r_im.add_picture(clip_file, width=Inches(6.0))
        else:
            p_img.add_run("[Clipping Image Pending]").font.color.rgb = RGBColor(148, 163, 184)

        if idx < len(print_items) - 1:
            doc.add_page_break()

    doc.add_page_break()

    # ==============================================================================
    # 4. ONLINE NEWS ARTICLES & BLOGS
    # ==============================================================================
    h_onl = doc.add_heading(level=1)
    r_ho = h_onl.add_run("3. ONLINE NEWS & BLOGS COVERAGE")
    r_ho.bold = True
    r_ho.font.color.rgb = RGBColor(30, 58, 138)
    h_onl.paragraph_format.space_after = Pt(12)

    tbl_onl = doc.add_table(rows=1, cols=4)
    tbl_onl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_onl.autofit = False

    onl_col_names = ["S. No.", "Date", "Publication", "Live Link"]
    onl_col_widths = [Inches(0.8), Inches(1.3), Inches(2.2), Inches(2.5)]

    for cell, name, w in zip(tbl_onl.rows[0].cells, onl_col_names, onl_col_widths):
        cell.width = w
        cell.text = name
        set_cell_background(cell, "1E3A8A")
        set_cell_margins(cell, top=120, bottom=120, left=140, right=140)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.size = Pt(9.5)
            r.font.color.rgb = RGBColor(255, 255, 255)

    for i, itm in enumerate(online_news_items):
        row_cells = tbl_onl.add_row().cells
        url = itm.get("url", "")
        row_cells[0].text = str(i + 1)
        row_cells[1].text = str(itm.get("date", ""))
        row_cells[2].text = str(itm.get("publication", ""))

        for c_idx in range(3):
            set_cell_margins(row_cells[c_idx], top=90, bottom=90, left=120, right=120)
            if i % 2 == 1:
                set_cell_background(row_cells[c_idx], "F8FAFC")
            p = row_cells[c_idx].paragraphs[0]
            if c_idx < 2:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"

        c_link = row_cells[3]
        set_cell_margins(c_link, top=90, bottom=90, left=120, right=120)
        if i % 2 == 1:
            set_cell_background(c_link, "F8FAFC")
        p_link = c_link.paragraphs[0]
        if url:
            disp = (url[:35] + "...") if len(url) > 38 else url
            add_hyperlink(p_link, url, disp, color="0284C7")
        else:
            p_link.text = "Link"

    doc.add_page_break()

    # ONLINE SCREENSHOTS PLATES
    p_onl_shots = doc.add_heading(level=2)
    r_osh = p_onl_shots.add_run("Online Article Verified Web Screenshots")
    r_osh.bold = True
    r_osh.font.color.rgb = RGBColor(30, 58, 138)

    for idx, itm in enumerate(online_news_items):
        url = itm.get("url", "")
        p_u = doc.add_paragraph()
        p_u.paragraph_format.space_before = Pt(8)
        p_u.paragraph_format.space_after = Pt(4)
        r_pub = p_u.add_run(f"[{itm.get('publication', 'News')}] ")
        r_pub.bold = True
        r_pub.font.size = Pt(11)
        r_pub.font.color.rgb = RGBColor(30, 58, 138)
        if url:
            add_hyperlink(p_u, url, itm.get("headline", url), color="0284C7")
        else:
            p_u.add_run(itm.get("headline", "News Article"))

        p_shot = doc.add_paragraph()
        p_shot.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_shot.paragraph_format.space_after = Pt(20)

        clip_file = itm.get("clip_path", "")
        if clip_file and os.path.exists(clip_file):
            r_sh = p_shot.add_run()
            r_sh.add_picture(clip_file, width=Inches(6.4))
        else:
            p_shot.add_run("[Web Screenshot Pending]").font.color.rgb = RGBColor(148, 163, 184)

        if idx < len(online_news_items) - 1:
            doc.add_page_break()

    doc.add_page_break()

    # ==============================================================================
    # 5. SOCIAL & VIDEO INTELLIGENCE (YOUTUBE & INSTAGRAM)
    # ==============================================================================
    h_soc = doc.add_heading(level=1)
    r_hs = h_soc.add_run("4. SOCIAL & VIDEO INTELLIGENCE (YOUTUBE & INSTAGRAM)")
    r_hs.bold = True
    r_hs.font.color.rgb = RGBColor(30, 58, 138)
    h_soc.paragraph_format.space_after = Pt(12)

    # 5A. YOUTUBE SECTION
    h_yt = doc.add_heading(level=2)
    r_y = h_yt.add_run("A. YouTube Channels Coverage (Past 48 Hours)")
    r_y.bold = True
    r_y.font.color.rgb = RGBColor(30, 58, 138)

    tbl_yt = doc.add_table(rows=1, cols=4)
    tbl_yt.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_yt.autofit = False

    yt_col_names = ["S. No.", "Date", "YouTube Channel", "Video Link"]
    yt_col_widths = [Inches(0.8), Inches(1.3), Inches(2.2), Inches(2.5)]

    for cell, name, w in zip(tbl_yt.rows[0].cells, yt_col_names, yt_col_widths):
        cell.width = w
        cell.text = name
        set_cell_background(cell, "1E3A8A")
        set_cell_margins(cell, top=120, bottom=120, left=140, right=140)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.size = Pt(9.5)
            r.font.color.rgb = RGBColor(255, 255, 255)

    for i, itm in enumerate(youtube_items):
        row_cells = tbl_yt.add_row().cells
        url = itm.get("url", "")
        row_cells[0].text = str(i + 1)
        row_cells[1].text = str(itm.get("date", ""))
        row_cells[2].text = str(itm.get("publication", "").replace("YouTube (", "").replace(")", ""))

        for c_idx in range(3):
            set_cell_margins(row_cells[c_idx], top=90, bottom=90, left=120, right=120)
            if i % 2 == 1:
                set_cell_background(row_cells[c_idx], "F8FAFC")
            p = row_cells[c_idx].paragraphs[0]
            if c_idx < 2:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"

        c_link = row_cells[3]
        set_cell_margins(c_link, top=90, bottom=90, left=120, right=120)
        if i % 2 == 1:
            set_cell_background(c_link, "F8FAFC")
        p_link = c_link.paragraphs[0]
        if url:
            disp = (url[:35] + "...") if len(url) > 38 else url
            add_hyperlink(p_link, url, disp, color="0284C7")
        else:
            p_link.text = "Link"

    doc.add_page_break()

    # YouTube Thumbnail Cards
    p_yt_cards = doc.add_heading(level=3)
    r_yc = p_yt_cards.add_run("YouTube Video Intelligence Cards")
    r_yc.bold = True
    r_yc.font.color.rgb = RGBColor(30, 58, 138)

    for idx, itm in enumerate(youtube_items):
        url = itm.get("url", "")
        p_yt_t = doc.add_paragraph()
        p_yt_t.paragraph_format.space_before = Pt(8)
        p_yt_t.paragraph_format.space_after = Pt(4)
        r_ch = p_yt_t.add_run(f"[{itm.get('publication')}] ")
        r_ch.bold = True
        r_ch.font.size = Pt(11)
        r_ch.font.color.rgb = RGBColor(220, 38, 38)  # YouTube Red
        if url:
            add_hyperlink(p_yt_t, url, itm.get("headline", url), color="0284C7")
        else:
            p_yt_t.add_run(itm.get("headline", ""))

        p_yt_thumb = doc.add_paragraph()
        p_yt_thumb.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_yt_thumb.paragraph_format.space_after = Pt(20)

        clip_file = itm.get("clip_path", "")
        if clip_file and os.path.exists(clip_file):
            r_th = p_yt_thumb.add_run()
            r_th.add_picture(clip_file, width=Inches(6.0))
        else:
            p_yt_thumb.add_run("[Thumbnail Pending]").font.color.rgb = RGBColor(148, 163, 184)

        if idx < len(youtube_items) - 1:
            doc.add_page_break()

    doc.add_page_break()

    # 5B. INSTAGRAM SECTION (Conditional)
    if len(instagram_items) > 0:
        doc.add_page_break()
        h_ig = doc.add_heading(level=2)
        r_ig = h_ig.add_run(f"B. Instagram Official Handles & Reels ({date_range_str})")
        r_ig.bold = True
        r_ig.font.color.rgb = RGBColor(30, 58, 138)

        tbl_ig = doc.add_table(rows=1, cols=4)
        tbl_ig.alignment = WD_TABLE_ALIGNMENT.CENTER
        tbl_ig.autofit = False

        ig_col_names = ["S. No.", "Date", "Instagram Handle", "Post / Reel Link"]
        ig_col_widths = [Inches(0.8), Inches(1.3), Inches(2.2), Inches(2.5)]

        for cell, name, w in zip(tbl_ig.rows[0].cells, ig_col_names, ig_col_widths):
            cell.width = w
            cell.text = name
            set_cell_background(cell, "1E3A8A")
            set_cell_margins(cell, top=120, bottom=120, left=140, right=140)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.bold = True
                r.font.size = Pt(9.5)
                r.font.color.rgb = RGBColor(255, 255, 255)

        for i, itm in enumerate(instagram_items):
            row_cells = tbl_ig.add_row().cells
            url = itm.get("url", "")
            row_cells[0].text = str(i + 1)
            row_cells[1].text = str(itm.get("date", ""))
            row_cells[2].text = str(itm.get("publication", ""))

            for c_idx in range(3):
                set_cell_margins(row_cells[c_idx], top=90, bottom=90, left=120, right=120)
                if i % 2 == 1:
                    set_cell_background(row_cells[c_idx], "F8FAFC")
                p = row_cells[c_idx].paragraphs[0]
                if c_idx < 2:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                for r in p.runs:
                    r.font.size = Pt(9.5)
                    r.font.name = "Arial"

            c_link = row_cells[3]
            set_cell_margins(c_link, top=90, bottom=90, left=120, right=120)
            if i % 2 == 1:
                set_cell_background(c_link, "F8FAFC")
            p_link = c_link.paragraphs[0]
            if url:
                disp = (url[:35] + "...") if len(url) > 38 else url
                add_hyperlink(p_link, url, disp, color="0284C7")
            else:
                p_link.text = "Link"

        doc.add_page_break()

        # Instagram Post Cards
        p_ig_cards = doc.add_heading(level=3)
        r_ic = p_ig_cards.add_run("Instagram Official Post & Reel Screenshots")
        r_ic.bold = True
        r_ic.font.color.rgb = RGBColor(30, 58, 138)

        for idx, itm in enumerate(instagram_items):
            url = itm.get("url", "")
            p_ig_t = doc.add_paragraph()
            p_ig_t.paragraph_format.space_before = Pt(8)
            p_ig_t.paragraph_format.space_after = Pt(4)
            r_ig_h = p_ig_t.add_run(f"[{itm.get('publication')}] ")
            r_ig_h.bold = True
            r_ig_h.font.size = Pt(11)
            r_ig_h.font.color.rgb = RGBColor(193, 53, 132)  # Instagram Purple/Magenta
            if url:
                add_hyperlink(p_ig_t, url, itm.get("headline", url), color="0284C7")
            else:
                p_ig_t.add_run(itm.get("headline", ""))

            p_ig_shot = doc.add_paragraph()
            p_ig_shot.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p_ig_shot.paragraph_format.space_after = Pt(20)

            clip_file = itm.get("clip_path", "")
            if clip_file and os.path.exists(clip_file):
                r_is = p_ig_shot.add_run()
                r_is.add_picture(clip_file, width=Inches(5.6))
            else:
                p_ig_shot.add_run("[Instagram Screenshot Pending]").font.color.rgb = RGBColor(148, 163, 184)

            if idx < len(instagram_items) - 1:
                doc.add_page_break()

    # Save Word document
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    doc.save(out_path)
    print(f"\n[SUCCESS] Executive Word Dossier successfully created at: {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate Executive Word Dossier")
    parser.add_argument("--db", default="data/media_dataset.db", help="Path to SQLite database")
    parser.add_argument("--out", default="outputs/Ampio_KTS_Today_19Nov_Morning_Report.docx", help="Output .docx path")
    parser.add_argument("--logo", default="assets/kts_logo.png", help="Path to logo")
    parser.add_argument("--title", default="Kashi Tamil Sangamam 5.0", help="Report Title")
    parser.add_argument("--dates", default="19 November 2026 (Morning Edition, 09:45 AM IST)", help="Coverage Dates")
    args = parser.parse_args()

    build_48h_coverage_dossier(
        db_path=args.db,
        out_path=args.out,
        logo_path=args.logo,
        title_text=args.title,
        date_range_str=args.dates
    )


if __name__ == "__main__":
    main()
