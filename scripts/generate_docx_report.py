#!/usr/bin/env python3
"""
Ampio Labs Media Monitoring Dossier Generator (.docx).
Reads print clippings and online screenshots from data/media_dataset.db (or sample data)
and generates a pixel-perfect, client-facing Word report matching the PR agency format.
"""

import argparse
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
    """Set the background color of a table cell."""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    tc_pr.append(shd)


def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Set cell padding."""
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


import html

def add_hyperlink(paragraph, url: str, text: str, color="004B91", underline=True):
    """Add a clickable hyperlink to a python-docx paragraph."""
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


def build_coverage_dossier(
    db_path: str = "data/media_dataset.db",
    out_path: str = "outputs/Ampio_KTS_Coverage_Report.docx",
    logo_path: str = "assets/kts_logo.png",
    title_text: str = "Kashi Tamil Sangamam 5.0",
    date_str: str = "18-November-2026"
):
    doc = docx.Document()

    # Set 0.75-inch margins
    sections = doc.sections
    for section in sections:
        section.top_margin = Inches(0.75)
        section.bottom_margin = Inches(0.75)
        section.left_margin = Inches(0.75)
        section.right_margin = Inches(0.75)

    # ----------------------------------------------------
    # COVER PAGE
    # ----------------------------------------------------
    p_logo = doc.add_paragraph()
    p_logo.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if os.path.exists(logo_path):
        p_logo.paragraph_format.space_before = Pt(40)
        p_logo.paragraph_format.space_after = Pt(20)
        run_logo = p_logo.add_run()
        run_logo.add_picture(logo_path, width=Inches(2.4))

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(20)
    p_title.paragraph_format.space_after = Pt(6)
    r_title = p_title.add_run(title_text)
    r_title.bold = True
    r_title.font.size = Pt(26)
    r_title.font.name = "Arial"
    r_title.font.color.rgb = RGBColor(30, 58, 138)  # Deep Navy Blue

    p_sub = doc.add_paragraph()
    p_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_sub.paragraph_format.space_before = Pt(0)
    p_sub.paragraph_format.space_after = Pt(6)
    r_sub = p_sub.add_run("Coverage Report")
    r_sub.font.size = Pt(18)
    r_sub.font.name = "Arial"
    r_sub.font.color.rgb = RGBColor(100, 116, 139)  # Slate Gray

    p_date = doc.add_paragraph()
    p_date.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_date.paragraph_format.space_before = Pt(0)
    p_date.paragraph_format.space_after = Pt(140)
    r_date = p_date.add_run(date_str)
    r_date.font.size = Pt(14)
    r_date.font.name = "Arial"
    r_date.font.color.rgb = RGBColor(71, 85, 105)

    p_prep = doc.add_paragraph()
    p_prep.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_prep.paragraph_format.space_after = Pt(4)
    r_prep = p_prep.add_run("Prepared By")
    r_prep.font.size = Pt(12)
    r_prep.font.color.rgb = RGBColor(148, 163, 184)

    # Ampio Labs Agency Branding
    p_brand = doc.add_paragraph()
    p_brand.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_brand1 = p_brand.add_run("AMPIO ")
    r_brand1.bold = True
    r_brand1.font.size = Pt(20)
    r_brand1.font.name = "Arial"
    r_brand1.font.color.rgb = RGBColor(2, 132, 199)  # Sky Blue

    r_brand2 = p_brand.add_run("LABS")
    r_brand2.bold = True
    r_brand2.font.size = Pt(20)
    r_brand2.font.name = "Arial"
    r_brand2.font.color.rgb = RGBColor(30, 41, 59)  # Slate Dark

    doc.add_page_break()

    # ----------------------------------------------------
    # FETCH DATA FROM SQLITE DATABASE
    # ----------------------------------------------------
    print_items = []
    online_items = []

    if os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT headline, publication, edition, page_number, date, major_category, clip_path, raw_json
            FROM clippings_metadata
            ORDER BY id ASC
        """)
        rows = cursor.fetchall()
        conn.close()

        for r in rows:
            headline, pub, edition, page_no, d_str, cat, clip_path, raw_json = r
            url = ""
            try:
                data = json.loads(raw_json) if raw_json else {}
                url = data.get("url", "")
            except Exception:
                pass

            item = {
                "headline": headline,
                "publication": pub,
                "edition": edition or "National",
                "page": page_no or 1,
                "date": d_str or date_str,
                "clip_path": clip_path or "",
                "url": url
            }
            if cat and "online" in cat.lower():
                online_items.append(item)
            else:
                print_items.append(item)

    # Fallback to sample items if database is fresh
    if not print_items:
        print_items = [
            {"date": "18-11-2026", "publication": "Amar Ujala Select", "edition": "New Delhi", "page": "08", "clip_path": "extracted_report_media/image3.png"},
            {"date": "14-11-2026", "publication": "Dewas Doot", "edition": "New Delhi", "page": "07", "clip_path": "extracted_report_media/image4.png"},
            {"date": "18-11-2026", "publication": "Dewas Doot", "edition": "New Delhi", "page": "02", "clip_path": "extracted_report_media/image5.png"},
            {"date": "18-11-2026", "publication": "Amar Ujala", "edition": "Varanasi", "page": "02", "clip_path": "extracted_report_media/image6.png"},
            {"date": "18-11-2026", "publication": "Amar Ujala Select", "edition": "Varanasi", "page": "06", "clip_path": "extracted_report_media/image7.png"},
            {"date": "18-11-2026", "publication": "The Hindu Tamil", "edition": "All Editions", "page": "14", "clip_path": "extracted_report_media/image8.png"},
        ]

    if not online_items:
        online_items = [
            {"date": "17-11-2026", "publication": "Hindustan Times", "url": "https://www.hindustantimes.com/india-news/kts-4-0-outlay-exceeded-govt-s-annual-tamil-language-budget-5-fold-rise-in-4-yrs-101794883982321.html", "clip_path": "extracted_report_media/image9.png"},
            {"date": "17-11-2026", "publication": "News On AIR", "url": "https://newsonair.gov.in/hi/southern-railway-to-run-five-special-trains-for-kashi-tamil-sangamam/", "clip_path": "extracted_report_media/image10.png"},
            {"date": "17-11-2026", "publication": "News18 Tamil", "url": "https://tamil.news18.com/spiritual/kasi-tamil-sangamam-varanasi-special-trains-booking-starts-today-nw-anu-ws-l-2254942.html", "clip_path": "extracted_report_media/image11.png"},
            {"date": "18-11-2026", "publication": "Instagram (@eduminofindia)", "url": "https://www.instagram.com/p/DfzfUd9HwTX/", "clip_path": "extracted_report_media/image26.png"},
        ]

    # ----------------------------------------------------
    # SECTION: PRINT COVERAGE INDEX TABLE
    # ----------------------------------------------------
    h_print = doc.add_heading(level=2)
    r_hp = h_print.add_run("PRINT COVERAGE")
    r_hp.bold = True
    r_hp.font.color.rgb = RGBColor(30, 58, 138)

    tbl_print = doc.add_table(rows=1, cols=4)
    tbl_print.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_print.autofit = False

    hdr_cells = tbl_print.rows[0].cells
    col_names = ["S. No.", "Date", "Publication", "Edition"]
    widths = [Inches(0.8), Inches(1.3), Inches(2.6), Inches(2.0)]

    for idx, (cell, name, w) in enumerate(zip(hdr_cells, col_names, widths)):
        cell.width = w
        cell.text = name
        set_cell_background(cell, "1E3A8A")  # Deep blue header
        set_cell_margins(cell, top=140, bottom=140, left=140, right=140)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.color.rgb = RGBColor(255, 255, 255)
            r.font.size = Pt(10)

    for i, itm in enumerate(print_items):
        row_cells = tbl_print.add_row().cells
        data_vals = [str(i + 1), str(itm.get("date", "")), str(itm.get("publication", "")), str(itm.get("edition", ""))]
        for c_idx, (c, val, w) in enumerate(zip(row_cells, data_vals, widths)):
            c.width = w
            c.text = val
            set_cell_margins(c, top=100, bottom=100, left=120, right=120)
            if i % 2 == 1:
                set_cell_background(c, "F8FAFC")
            p = c.paragraphs[0]
            if c_idx < 2:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"

    doc.add_paragraph().paragraph_format.space_after = Pt(20)

    # ----------------------------------------------------
    # SECTION: ONLINE COVERAGE INDEX TABLE
    # ----------------------------------------------------
    h_onl = doc.add_heading(level=2)
    r_ho = h_onl.add_run("ONLINE COVERAGE")
    r_ho.bold = True
    r_ho.font.color.rgb = RGBColor(30, 58, 138)

    tbl_onl = doc.add_table(rows=1, cols=4)
    tbl_onl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_onl.autofit = False

    onl_hdr_cells = tbl_onl.rows[0].cells
    onl_col_names = ["S. No.", "Date", "Publication", "Link"]
    onl_widths = [Inches(0.8), Inches(1.3), Inches(2.2), Inches(2.5)]

    for idx, (cell, name, w) in enumerate(zip(onl_hdr_cells, onl_col_names, onl_widths)):
        cell.width = w
        cell.text = name
        set_cell_background(cell, "1E3A8A")
        set_cell_margins(cell, top=140, bottom=140, left=140, right=140)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for r in p.runs:
            r.bold = True
            r.font.color.rgb = RGBColor(255, 255, 255)
            r.font.size = Pt(10)

    for i, itm in enumerate(online_items):
        row_cells = tbl_onl.add_row().cells
        url = itm.get("url", "")
        row_cells[0].text = str(i + 1)
        row_cells[1].text = str(itm.get("date", ""))
        row_cells[2].text = str(itm.get("publication", ""))

        for c_idx in range(3):
            set_cell_margins(row_cells[c_idx], top=100, bottom=100, left=120, right=120)
            if i % 2 == 1:
                set_cell_background(row_cells[c_idx], "F8FAFC")
            p = row_cells[c_idx].paragraphs[0]
            if c_idx < 2:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.size = Pt(9.5)
                r.font.name = "Arial"

        # Hyperlink cell
        c_link = row_cells[3]
        set_cell_margins(c_link, top=100, bottom=100, left=120, right=120)
        if i % 2 == 1:
            set_cell_background(c_link, "F8FAFC")
        p_link = c_link.paragraphs[0]
        if url:
            display_text = (url[:35] + "...") if len(url) > 38 else url
            add_hyperlink(p_link, url, display_text, color="0284C7")
        else:
            p_link.text = "Link"

    doc.add_page_break()

    # ----------------------------------------------------
    # SECTION: PRINT CLIPPINGS DOSSIER
    # ----------------------------------------------------
    p_sec_print = doc.add_paragraph()
    r_sp = p_sec_print.add_run("Print Coverage")
    r_sp.bold = True
    r_sp.font.size = Pt(16)
    r_sp.font.color.rgb = RGBColor(30, 58, 138)
    p_sec_print.paragraph_format.space_after = Pt(16)

    for idx, itm in enumerate(print_items):
        # 2x4 standard metadata box
        meta_tbl = doc.add_table(rows=2, cols=4)
        meta_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        meta_tbl.autofit = False

        box_widths = [Inches(1.2), Inches(2.2), Inches(1.2), Inches(2.1)]
        row0 = meta_tbl.rows[0].cells
        row0[0].text = "Date"
        row0[1].text = str(itm.get("date", ""))
        row0[2].text = "Page No."
        row0[3].text = str(itm.get("page", "01"))

        row1 = meta_tbl.rows[1].cells
        row1[0].text = "Publication:"
        row1[1].text = str(itm.get("publication", ""))
        row1[2].text = "Edition"
        row1[3].text = str(itm.get("edition", ""))

        for row_i, r in enumerate([row0, row1]):
            for c_i, cell in enumerate(r):
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

        # Space between metadata box and clipping image
        p_img = doc.add_paragraph()
        p_img.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_img.paragraph_format.space_before = Pt(12)
        p_img.paragraph_format.space_after = Pt(24)

        clip_file = itm.get("clip_path", "")
        if clip_file and os.path.exists(clip_file):
            r_img = p_img.add_run()
            r_img.add_picture(clip_file, width=Inches(6.5))
        else:
            p_img.add_run("[Clipping Image Pending]").font.color.rgb = RGBColor(148, 163, 184)

        if idx < len(print_items) - 1:
            doc.add_page_break()

    doc.add_page_break()

    # ----------------------------------------------------
    # SECTION: ONLINE COVERAGE DOSSIER
    # ----------------------------------------------------
    p_sec_onl = doc.add_paragraph()
    r_so = p_sec_onl.add_run("Online Coverage")
    r_so.bold = True
    r_so.font.size = Pt(16)
    r_so.font.color.rgb = RGBColor(30, 58, 138)
    p_sec_onl.paragraph_format.space_after = Pt(16)

    for idx, itm in enumerate(online_items):
        url = itm.get("url", "")
        p_url = doc.add_paragraph()
        p_url.paragraph_format.space_after = Pt(8)
        if url:
            add_hyperlink(p_url, url, url, color="004B91")
        else:
            p_url.add_run(itm.get("publication", "Online Link"))

        p_scr = doc.add_paragraph()
        p_scr.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_scr.paragraph_format.space_after = Pt(24)

        clip_file = itm.get("clip_path", "")
        if clip_file and os.path.exists(clip_file):
            r_scr = p_scr.add_run()
            r_scr.add_picture(clip_file, width=Inches(6.5))
        else:
            p_scr.add_run("[Web Screenshot Pending]").font.color.rgb = RGBColor(148, 163, 184)

        if idx < len(online_items) - 1:
            doc.add_page_break()

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    doc.save(out_path)
    print(f"\n[SUCCESS] Media Monitoring Dossier successfully generated at: {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate Word (.docx) Coverage Report")
    parser.add_argument("--db", default="data/media_dataset.db", help="Path to SQLite database")
    parser.add_argument("--out", default="outputs/Ampio_KTS_Coverage_Report.docx", help="Output .docx path")
    parser.add_argument("--logo", default="assets/kts_logo.png", help="Path to event logo")
    parser.add_argument("--title", default="Kashi Tamil Sangamam 5.0", help="Report Title")
    parser.add_argument("--date", default=datetime.now().strftime("%d-%B-%Y"), help="Report Date")
    args = parser.parse_args()

    build_coverage_dossier(
        db_path=args.db,
        out_path=args.out,
        logo_path=args.logo,
        title_text=args.title,
        date_str=args.date
    )


if __name__ == "__main__":
    main()
