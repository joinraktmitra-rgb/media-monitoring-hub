#!/usr/bin/env python3
"""
Comprehensive Test Suite for Evidence Screenshot & Quality Verification Engine.

Tests:
  1. Undersized image detection (< 25KB).
  2. Blank / solid color page detection (PIL pixel stddev < 10.0).
  3. Visually rich image verification (PIL pixel stddev > 35.0, score >= 65).
  4. Anti-bot, 404, 403, and Cloudflare captcha DOM detection.
  5. Indic Unicode tokenization & headline matching (Hindi, Tamil, English).
  6. Safe JavaScript popup remover syntax and execution (no SyntaxErrors).
  7. Unicode-aware JavaScript headline scroller execution on Indic DOM.
  8. Exact URL database matching (never clobbers sibling / prefix URLs).
  9. New URL upsert into clippings_metadata and digital_articles.
  10. Database pruning for both clippings_metadata and digital_articles.
  11. Self-improving DomainLearningEngine persistence and rule updating.
"""

import json
import os
import sqlite3
import sys
import unittest
from PIL import Image

# Add scripts directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts")))
from capture_evidence_screenshots import (
    AuditResult,
    DomainLearningEngine,
    EvidenceScreenshotEngine,
    HEADLINE_SCROLLER_JS,
    POPUP_CLEANER_JS,
    prune_obsolete_records,
    tokenize_unicode,
)


class TestEvidenceScreenshotEngine(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = "data/test_tmp"
        os.makedirs(self.tmp_dir, exist_ok=True)
        self.learning_file = os.path.join(self.tmp_dir, "test_learning.json")
        self.learning_engine = DomainLearningEngine(filepath=self.learning_file)
        self.engine = EvidenceScreenshotEngine(
            output_dir=self.tmp_dir,
            learning_engine=self.learning_engine,
        )
        self.temp_files = [self.learning_file]

    def tearDown(self):
        for p in self.temp_files:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass

    def _create_synthetic_image(self, filename: str, is_blank: bool = False) -> str:
        path = os.path.join(self.tmp_dir, filename)
        if is_blank:
            im = Image.new("RGB", (1440, 900), color=(255, 255, 255))
            im.save(path, format="PNG")
            # Pad with zeros to exceed 25KB threshold to strictly test pixel stddev
            with open(path, "ab") as f:
                f.write(b"\x00" * 30000)
        else:
            im = Image.frombytes("RGB", (1440, 900), os.urandom(1440 * 900 * 3))
            im.save(path, format="PNG")

        self.temp_files.append(path)
        return path

    def test_audit_rejects_undersized_file(self):
        tiny_path = os.path.join(self.tmp_dir, "tiny.png")
        im = Image.new("RGB", (2, 2), color=(255, 255, 255))
        im.save(tiny_path, format="PNG")
        self.temp_files.append(tiny_path)

        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            tiny_path, "Test Headline", "Normal Title", "Article text"
        )
        self.assertFalse(is_valid)
        self.assertIn("File size too small", err)

    def test_audit_rejects_blank_image(self):
        blank_path = self._create_synthetic_image("test_blank.png", is_blank=True)
        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            blank_path, "Test Headline", "Normal Title", "Article text"
        )
        self.assertFalse(is_valid)
        self.assertIn("Blank/solid page detected", err)
        self.assertLess(stddev, 5.0)

    def test_audit_passes_rich_image(self):
        rich_path = self._create_synthetic_image("test_rich.png", is_blank=False)
        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            rich_path, "Test Headline", "Normal Title", "Some article content with Test Headline words"
        )
        self.assertTrue(is_valid)
        self.assertGreater(score, 60)
        self.assertGreater(stddev, 20.0)
        self.assertIsNone(err)

    def test_audit_rejects_error_page_dom(self):
        rich_path = self._create_synthetic_image("test_error_dom.png", is_blank=False)
        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            rich_path, "Test Headline", "404 Not Found - Error", "The page you requested does not exist."
        )
        self.assertFalse(is_valid)
        self.assertIn("Error/Anti-bot page detected in DOM", err)

    def test_audit_rejects_cloudflare_captcha(self):
        rich_path = self._create_synthetic_image("test_captcha.png", is_blank=False)
        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            rich_path, "Test Headline", "Attention Required! | Cloudflare", "Please complete the security check to access."
        )
        self.assertFalse(is_valid)
        self.assertIn("Error/Anti-bot page detected in DOM", err)

    def test_unicode_indic_tokenization(self):
        # English
        eng_tokens = tokenize_unicode("Southern Railway announces five special trains")
        self.assertIn("railway", eng_tokens)
        self.assertIn("trains", eng_tokens)

        # Hindi
        hindi_text = "काशी तमिल संगमम के लिए दक्षिण रेलवे चलाएगा पांच विशेष रेलगाड़ियां"
        hindi_tokens = tokenize_unicode(hindi_text)
        self.assertIn("काशी", hindi_tokens)
        self.assertIn("तमिल", hindi_tokens)
        self.assertIn("रेलगाड़ियां", hindi_tokens)
        self.assertGreaterEqual(len(hindi_tokens), 6)

        # Tamil
        tamil_text = "காசி தமிழ் சங்கமம் 5.0 சிறப்பு ரயில்கள் முன்பதிவு"
        tamil_tokens = tokenize_unicode(tamil_text)
        self.assertIn("காசி", tamil_tokens)
        self.assertIn("தமிழ்", tamil_tokens)
        self.assertIn("ரயில்கள்", tamil_tokens)
        self.assertGreaterEqual(len(tamil_tokens), 4)

    def test_audit_scores_indic_headline_matches(self):
        rich_path = self._create_synthetic_image("test_hindi_match.png", is_blank=False)
        is_valid, score, stddev, mean, err = self.engine.audit_screenshot_file(
            image_path=rich_path,
            expected_headline="काशी तमिल संगमम विशेष रेलगाड़ियां",
            page_title="काशी तमिल संगमम - आधिकारिक सूचना",
            page_text_sample="काशी तमिल संगमम के लिए रेलवे चलाएगा विशेष रेलगाड़ियां।"
        )
        self.assertTrue(is_valid)
        # Should have received bonus for headline match
        self.assertGreaterEqual(score, 75)

    def test_domain_learning_engine(self):
        domain = "kashitamil.iitm.ac.in"
        # Initial rule should have defaults
        initial = self.learning_engine.get_domain_rules(domain)
        self.assertEqual(initial["success_count"], 0)

        # Record a success
        self.learning_engine.record_outcome(
            domain=domain,
            is_success=True,
            quality_score=95,
            wait_ms=1500,
            headline_tag="H2",
            blocked_trackers=False
        )

        updated = self.learning_engine.get_domain_rules(domain)
        self.assertEqual(updated["success_count"], 1)
        self.assertEqual(updated["avg_quality_score"], 95.0)
        self.assertEqual(updated["custom_headline_selector"], "h2")

        # Verify disk persistence
        new_instance = DomainLearningEngine(filepath=self.learning_file)
        persisted = new_instance.get_domain_rules(domain)
        self.assertEqual(persisted["success_count"], 1)
        self.assertEqual(persisted["avg_quality_score"], 95.0)

    def test_sync_exact_url_does_not_corrupt_siblings(self):
        test_db = os.path.join(self.tmp_dir, "test_sync_exact.db")
        self.temp_files.append(test_db)
        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE clippings_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                headline TEXT,
                publication TEXT,
                edition TEXT,
                page_number INTEGER,
                date TEXT,
                major_category TEXT,
                sentiment TEXT,
                clip_path TEXT,
                raw_json JSON
            )
        """)
        cur.execute("""
            CREATE TABLE digital_articles (
                url TEXT PRIMARY KEY,
                headline TEXT,
                publication TEXT,
                slug TEXT,
                category TEXT,
                language TEXT,
                published_at TEXT,
                author TEXT,
                description TEXT,
                image_url TEXT,
                source_engine TEXT,
                raw_json JSON
            )
        """)

        # Insert parent URL: https://kashitamil.iitm.ac.in
        cur.execute("""
            INSERT INTO clippings_metadata VALUES (
                1, 'KTS Portal', 'IIT Madras', 'Digital Edition', 1, '19-11-2026',
                'Online Coverage', 'Positive', 'clips/online/parent.png',
                '{"url": "https://kashitamil.iitm.ac.in"}'
            )
        """)
        # Insert sibling URL: https://kashitamil.iitm.ac.in/registration
        cur.execute("""
            INSERT INTO clippings_metadata VALUES (
                2, 'KTS Registration', 'IIT Madras', 'Digital Edition', 1, '19-11-2026',
                'Online Coverage', 'Positive', 'clips/online/registration.png',
                '{"url": "https://kashitamil.iitm.ac.in/registration"}'
            )
        """)
        conn.commit()
        conn.close()

        # Update parent URL with new screenshot
        fake_result = AuditResult(
            url="https://kashitamil.iitm.ac.in",
            resolved_url="https://kashitamil.iitm.ac.in",
            headline="KTS Portal New",
            publication="IIT Madras",
            output_path="clips/online/new_parent.png",
            status="VERIFIED_CLEAN",
            http_status=200,
            file_size_bytes=50000,
            image_width=1440,
            image_height=900,
            pixel_stddev=50.0,
            pixel_mean=180.0,
            popups_removed=0,
            headline_matched=True,
            headline_score=1.0,
            headline_tag="H1",
            detected_headline="KTS Portal New",
            scroll_offset=50.0,
            quality_score=90,
            attempt_used=1,
        )

        self.engine.sync_results_to_db([fake_result], test_db)

        # Verify that sibling registration URL (ID 2) was NOT modified
        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("SELECT id, clip_path FROM clippings_metadata WHERE id = 2")
        row2 = cur.fetchone()
        conn.close()

        self.assertEqual(row2[1], "clips/online/registration.png")

    def test_sync_upserts_new_urls(self):
        test_db = os.path.join(self.tmp_dir, "test_upsert.db")
        self.temp_files.append(test_db)
        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE clippings_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                headline TEXT,
                publication TEXT,
                edition TEXT,
                page_number INTEGER,
                date TEXT,
                major_category TEXT,
                sentiment TEXT,
                clip_path TEXT,
                raw_json JSON
            )
        """)
        cur.execute("""
            CREATE TABLE digital_articles (
                url TEXT PRIMARY KEY,
                headline TEXT,
                publication TEXT,
                slug TEXT,
                category TEXT,
                language TEXT,
                published_at TEXT,
                author TEXT,
                description TEXT,
                image_url TEXT,
                source_engine TEXT,
                raw_json JSON
            )
        """)
        conn.commit()
        conn.close()

        new_result = AuditResult(
            url="https://brandnewnews.com/kts-story",
            resolved_url="https://brandnewnews.com/kts-story",
            headline="Brand New KTS Story",
            publication="brandnewnews.com",
            output_path="clips/online/brand_new.png",
            status="VERIFIED_CLEAN",
            http_status=200,
            file_size_bytes=80000,
            image_width=1440,
            image_height=900,
            pixel_stddev=45.0,
            pixel_mean=190.0,
            popups_removed=1,
            headline_matched=True,
            headline_score=0.9,
            headline_tag="H1",
            detected_headline="Brand New KTS Story Headline",
            scroll_offset=90.0,
            quality_score=95,
            attempt_used=1,
        )

        self.engine.sync_results_to_db([new_result], test_db)

        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("SELECT headline, publication, clip_path FROM clippings_metadata")
        clip_row = cur.fetchone()
        cur.execute("SELECT headline, image_url FROM digital_articles")
        digital_row = cur.fetchone()
        conn.close()

        self.assertIsNotNone(clip_row)
        self.assertEqual(clip_row[0], "Brand New KTS Story Headline")
        self.assertIsNotNone(digital_row)
        self.assertEqual(digital_row[0], "Brand New KTS Story Headline")

    def test_prune_cleans_both_clippings_and_digital_tables(self):
        test_db = os.path.join(self.tmp_dir, "test_full_prune.db")
        self.temp_files.append(test_db)
        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE clippings_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                headline TEXT,
                publication TEXT,
                major_category TEXT,
                clip_path TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE digital_articles (
                url TEXT PRIMARY KEY,
                headline TEXT,
                publication TEXT,
                image_url TEXT
            )
        """)

        # Valid clipping file
        valid_file = self._create_synthetic_image("valid_clip.png", is_blank=False)
        cur.execute("INSERT INTO clippings_metadata VALUES (1, 'KTS Sangam', 'The Hindu', 'Online Coverage', ?)", (valid_file,))
        cur.execute("INSERT INTO clippings_metadata VALUES (2, 'Missing Clip', 'PTI', 'Online Coverage', 'nonexistent.png')")
        cur.execute("INSERT INTO clippings_metadata VALUES (3, 'Corrupted \ufffd Headline', 'TH', 'Online Coverage', ?)", (valid_file,))

        # Digital articles
        cur.execute("INSERT INTO digital_articles VALUES ('https://valid.com', 'KTS Sangamam 5.0 Event', 'Hindu', ?)", (valid_file,))
        cur.execute("INSERT INTO digital_articles VALUES ('https://stale.com', 'Palestine UNGA Vote', 'PTI', NULL)")
        cur.execute("INSERT INTO digital_articles VALUES ('https://stale2.com', 'Scotch Whisky Imports', 'PTI', '')")
        conn.commit()
        conn.close()

        res = prune_obsolete_records(test_db)
        self.assertEqual(res["clippings_deleted"], 2)  # IDs 2 and 3 deleted
        self.assertEqual(res["digital_deleted"], 2)    # Palestine and Scotch whisky deleted

        conn = sqlite3.connect(test_db)
        cur = conn.cursor()
        cur.execute("SELECT id FROM clippings_metadata")
        remaining_clip_ids = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT url FROM digital_articles")
        remaining_urls = [r[0] for r in cur.fetchall()]
        conn.close()

        self.assertEqual(remaining_clip_ids, [1])
        self.assertEqual(remaining_urls, ["https://valid.com"])

    def test_playwright_dom_popup_and_headline_execution(self):
        """Execute JS snippets in real Playwright browser to ensure zero syntax or DOM errors."""
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(channel="chrome")
            except Exception:
                browser = p.chromium.launch()
            page = browser.new_page()
            page.set_content("""
                <html>
                    <body>
                        <div id="onetrust-consent-sdk">Cookie banner</div>
                        <button aria-label="Accept Cookies">Accept All</button>
                        <div style="position: fixed; bottom: 0; height: 50px;">Floating ad</div>
                        <h1>काशी तमिल संगमम 5.0</h1>
                        <p>दक्षिण रेलवे ने विशेष रेलगाड़ियों की घोषणा की।</p>
                    </body>
                </html>
            """)
            removed = page.evaluate(POPUP_CLEANER_JS)
            self.assertGreaterEqual(removed, 2)

            res = page.evaluate(f"([h, sel]) => ({HEADLINE_SCROLLER_JS})(h, sel)", ["काशी तमिल संगमम", None])
            self.assertTrue(res["found"])
            self.assertEqual(res["tag"], "H1")
            self.assertIn("काशी", res["text"])
            browser.close()


if __name__ == "__main__":
    unittest.main()
