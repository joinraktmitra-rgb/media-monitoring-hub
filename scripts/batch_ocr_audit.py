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
OUT_CLIPS = os.path.abspath("clips/print")
os.makedirs(OUT_CLIPS, exist_ok=True)
os.makedirs("data/ocr_tmp", exist_ok=True)

def ocr_page(args):
    pdf_path, page_idx, lang = args
    doc = fitz.open(pdf_path)
    page = doc[page_idx]
    pix = page.get_pixmap(dpi=120)
    img_path = os.path.abspath(f"data/ocr_tmp/page_{os.getpid()}_{page_idx}.png")
    pix.save(img_path)
    doc.close()

    try:
        res = subprocess.run(
            ["tesseract", img_path, "stdout", "-l", lang, "--tessdata-dir", TESSDATA_DIR, "--psm", "3"],
            capture_output=True, text=True, errors="replace", timeout=30
        )
        ocr_text = res.stdout or ""
    except Exception as e:
        ocr_text = ""
    finally:
        if os.path.exists(img_path):
            os.remove(img_path)

    is_match, reason = check_text_match(ocr_text)
    clip_path = None
    if is_match:
        # Save high-res page clip
        paper_slug = re.sub(r'[^a-zA-Z0-9]', '_', os.path.basename(pdf_path).replace('.pdf', ''))[:20]
        clip_path = os.path.join(OUT_CLIPS, f"{paper_slug}_p{page_idx+1}_{int(time.time())}.png")
        doc2 = fitz.open(pdf_path)
        p2 = doc2[page_idx]
        p2.get_pixmap(dpi=150).save(clip_path)
        doc2.close()

    return {
        "page": page_idx + 1,
        "is_match": is_match,
        "reason": reason,
        "text_len": len(ocr_text),
        "snippet": ocr_text[:300].replace("\n", " ") if is_match else "",
        "clip_path": clip_path
    }

def audit_paper(pdf_path, lang="hin+eng", max_workers=6):
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()

    filename = os.path.basename(pdf_path)
    print(f"\n=======================================================")
    print(f"Auditing: {filename} ({total_pages} pages | {lang})")
    print(f"=======================================================")
    t0 = time.time()
    args_list = [(pdf_path, i, lang) for i in range(total_pages)]

    matches = []
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        for res in executor.map(ocr_page, args_list):
            if res["is_match"]:
                print(f"  >>> [PAGE {res['page']}] MATCH FOUND! <<<")
                print(f"      Reason: {res['reason']}")
                print(f"      Snippet: {res['snippet'][:180]}")
                print(f"      Clip saved: {res['clip_path']}")
                matches.append(res)
            else:
                print(f"  [p{res['page']}] scanned ({res['text_len']} chars)")

    print(f"Done in {time.time()-t0:.2f}s. Matches: {len(matches)}")
    return {"file": filename, "total_pages": total_pages, "matches": matches}

if __name__ == "__main__":
    import glob
    target_files = [
        "downloads/Navbharat Times_Delhi_20261118.pdf",
        "downloads/PunjabKesari Jalandhar based_Main Jalandhar_20261118.pdf",
        "downloads/Rajasthan Patrika_rajasthan_jaipur-city_20261118.pdf",
        "downloads/Naidunia_Indore_20261118.pdf",
        "downloads/Lokmat Samachar_Nagpur Main_20261118.pdf",
        "downloads/Hari Bhoomi_दिल्ली मुख्य संस्करण_20261118.pdf"
    ]
    # Add Dainik Bhaskar
    for f in glob.glob("downloads/*Bhaskar*"):
        if f not in target_files:
            target_files.append(f)

    all_matches = []
    for f in target_files:
        if os.path.exists(f):
            res = audit_paper(f, lang="hin+eng", max_workers=6)
            if res["matches"]:
                all_matches.extend(res["matches"])

    print(f"\nBATCH SCAN COMPLETE. Total new matches found: {len(all_matches)}")
