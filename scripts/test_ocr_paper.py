import fitz
import subprocess
import os
import sys
import time
import re
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.abspath("."))
from scripts.scan_all_epapers import check_text_match, normalize_text

TESSDATA_DIR = os.path.abspath("assets/tessdata")

def ocr_page(args):
    pdf_path, page_idx, lang = args
    doc = fitz.open(pdf_path)
    page = doc[page_idx]
    pix = page.get_pixmap(dpi=120)
    os.makedirs("data/ocr_tmp", exist_ok=True)
    img_path = os.path.abspath(f"data/ocr_tmp/page_{os.getpid()}_{page_idx}.png")
    pix.save(img_path)
    doc.close()

    try:
        res = subprocess.run(
            ["tesseract", img_path, "stdout", "-l", lang, "--tessdata-dir", TESSDATA_DIR, "--psm", "3"],
            capture_output=True, text=True, errors="replace", timeout=25
        )
        ocr_text = res.stdout or ""
    except Exception as e:
        ocr_text = ""
    finally:
        if os.path.exists(img_path):
            os.remove(img_path)

    is_match, reason = check_text_match(ocr_text)
    return {
        "page": page_idx + 1,
        "is_match": is_match,
        "reason": reason,
        "text_len": len(ocr_text),
        "snippet": ocr_text[:300].replace("\n", " ") if is_match else ""
    }

def scan_pdf_with_ocr(pdf_path, lang="hin+eng", max_workers=6):
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()

    print(f"Auditing with OCR: {os.path.basename(pdf_path)} ({total_pages} pages, lang={lang}, workers={max_workers})...")
    t0 = time.time()
    args_list = [(pdf_path, i, lang) for i in range(total_pages)]

    matches = []
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        for res in executor.map(ocr_page, args_list):
            if res["is_match"]:
                print(f"  [+] PAGE {res['page']} MATCH: {res['reason']}")
                print(f"      Snippet: {res['snippet'][:150]}")
                matches.append(res)
            else:
                print(f"  [-] Page {res['page']}: {res['text_len']} chars (no match)")

    print(f"Audit completed in {time.time()-t0:.2f}s. Total matches: {len(matches)}")
    return matches

if __name__ == "__main__":
    scan_pdf_with_ocr("downloads/Dainik Jagran_National_20261118.pdf", lang="hin+eng", max_workers=6)
