/**
 * Ampio Media Intelligence — Embedded MCP Server Instructions, Agent Skills & Playbooks.
 * Exposed via:
 *   1. Native MCP `instructions` field (sent automatically to ChatGPT during `initialize`)
 *   2. `get_workflow_playbook` tool (callable on demand by ChatGPT)
 *   3. Standard MCP Resources (`ampio://skills/<id>`) & MCP Prompts
 */

export const AMPIO_MCP_SERVER_INSTRUCTIONS = `You are connected to the Ampio Media Intelligence Execution & Orchestration Layer (v3.0).

CORE DIVISION OF LABOR:
- Ampio MCP Server = Execution Muscle & Ground Truth Factory (downloading 122+ Indian ePapers & 180+ city editions, fast full-PDF multilingual search, 0.0-1.0 Vision grid rendering, DPI-proportional gutter-snapped clipping + white-out masking + OCR, Google Universal 5-pillar harvesting, 47 Indian digital newsrooms search, Instagram monitoring, Playwright modal-free screenshot capture, 3-tier Source-of-Truth publication timestamp extraction, and embedded-image DOCX/HTML/CSV dossier generation).
- Your Own Computer (ChatGPT Vision, Reasoning & Python/Code Interpreter) = Brain, Visual Layout Inspector, Data Analyst & Chart/Slide Builder.

NON-NEGOTIABLE RULES:
1. NEVER report "harvested_at" as an article/post publication time. ALWAYS use "content_published_at" (Source of Truth). If null, explicitly state "Timestamp unverified".
2. NEVER blindly render all 20 pages of an ePaper PDF. ALWAYS call "epaper_search_pdf" first (with Hindi/English/Tamil keywords) to locate exact matching pages in <2s, then render ONLY matched pages with "epaper_render_page".
3. When clipping newspaper articles, inspect the 0.0-1.0 coordinate grid image using your own Vision, define tight [left, top, right, bottom] boxes + white-out "exclude" boxes for L-shaped overlaps/ads, call "epaper_clip_articles" (snap=true), and visually verify critical clippings via "inspect_asset_image".
4. For multi-language digital_news_search, run ONE language per call (e.g. call once for "Kashi Tamil", separately for "काशी तमिल").
5. When generating a Word (.docx) dossier WITH embedded HD clippings & screenshots, ALWAYS use Ampio's "export_topic_dossier(format='docx')" (passing your written executive_summary), because your sandbox cannot fetch remote images. When generating charts, Excel trackers, or statistical analysis on your own computer, call "export_topic_dossier(format='csv', include_inline_content=true)" and process the CSV in Python!
6. For detailed SOPs, recipes, and Python scripts for your own computer, call "get_workflow_playbook".`;

export const WORKFLOW_PLAYBOOKS: Record<string, { title: string; summary: string; content: string }> = {
  overview: {
    title: 'Ampio Media Intelligence — Master Tool Map & Architecture',
    summary: 'Complete guide to all 23 modular tools and how to combine Ampio MCP with ChatGPT Vision & Python Code Interpreter.',
    content: `# Ampio Media Intelligence — Master Skill Overview

## 1. Two-Computer Synergy
You have TWO superpowers working together:
1. **Ampio MCP Server (Host Mac Execution Engine)**: Has live internet, Playwright headless browsers, Chrome relay, 122+ Indian ePaper providers, PyMuPDF, Tesseract Hindi/English OCR, SQLite Multi-DB storage (\`data/topics/<topic>.db\`), and public HTTPS asset delivery (\`/assets/...\`).
2. **Your Own Computer (ChatGPT Vision + Code Interpreter / Python)**: Has superior multimodal vision for reading newspaper layouts, deep multilingual reasoning/sentiment analysis, and local Python (\`pandas\`, \`matplotlib\`, \`openpyxl\`, \`python-pptx\`) for charts, spreadsheets, and executive decks.

## 2. Complete Modular Tool Map (23 Tools)
### A. Skills, System & Jobs
- \`get_workflow_playbook\` — Fetch detailed SOPs (\`overview\`, \`epaper_clipping\`, \`morning_briefing\`, \`visual_qc_and_timestamps\`, \`chatgpt_computer_recipes\`).
- \`get_system_status\` — Check downloaded ePapers, topic DBs, recent async jobs, and public base URL.
- \`list_topics_and_stats\` — Inspect all isolated topic SQLite DBs with verified/pending counts & sentiment breakdown.
- \`check_job_status\` — Poll async jobs (\`job_id\`) every 10-20s until \`completed\`.
- \`ping\` — Quick health & IST clock check.

### B. Print ePaper Intelligence (7 Granular Tools)
- \`epaper_list_sources\` — Browse/search 122+ newspapers, presets (\`hindi\`/\`english\`/\`financial\`), Dainik Jagran 42 cities, Amar Ujala 141 cities, and local PDFs with direct download URLs.
- \`epaper_list_issues\` — Check archive dates available for any newspaper.
- \`epaper_download\` — Download any single paper, city edition, date, or batch preset; returns clickable public PDF \`download_url\`.
- \`epaper_search_pdf\` — Ultra-fast PyMuPDF keyword scan across ALL pages of 1 or ALL downloaded PDFs (Hindi/English/Tamil).
- \`epaper_extract_page_text\` — Read full vector text blocks (with font sizes & normalized bboxes) or automatic Tesseract OCR for scanned pages.
- \`epaper_render_page\` — Render page(s) with 0.0-1.0 coordinate ruler grid (\`_grid.png\`), vector headline hints, public HTTPS URL, and inline Vision JPEG.
- \`epaper_clip_articles\` — Precision crop using normalized \`[left, top, right, bottom]\` + automatic column gutter-snapping + white-out \`exclude\` masks + Hindi/English OCR + SQLite save + public URL.

### C. Digital, Social & Web Harvesters (4 Tools)
- \`google_universal_harvest\` — Google All-Search across 5 pillars (Gov/Diplomatic, Social [FB/YT/X/IG], Rail/Civic, Academic, News) with \`1h/24h/48h/7d/30d/any\`, custom date range, and \`site:\` filter.
- \`digital_list_outlets\` — Browse all 47 monitored Indian digital newsrooms & wire agencies by category/language.
- \`digital_news_search\` — Direct search across the 47 Indian digital newsrooms (run 1 language per call!).
- \`social_instagram_monitor\` — Monitor Instagram handles or search keywords/hashtags via authenticated Chrome relay with exact timestamps & screenshots.

### D. Evidence Capture, Metadata & Visual QC (3 Tools)
- \`fetch_url_metadata\` — Instant (<2s) lightweight metadata/JSON-LD/OG timestamp & article text reader without launching a browser.
- \`capture_verified_evidence\` — Headless Playwright Modal Annihilator (destroys "See more on Facebook" & cookie overlays) + 3-tier Source-of-Truth \`content_published_at\` + PIL/Tesseract OCR QC + public PNG URLs.
- \`inspect_asset_image\` — Load ANY captured screenshot or newspaper clipping as an inline Vision JPEG so YOU can visually audit quality!

### E. Topic Curation, Export & Macro Orchestrator (4 Tools)
- \`query_topic_media\` — Query items + clippings + category/sentiment breakdown from any isolated topic DB.
- \`update_media_item\` — Set sentiment (\`Positive\`/\`Neutral\`/\`Negative\`), category, editorial notes, or \`flagged_irrelevant: true\`.
- \`export_topic_dossier\` — Generate downloadable \`docx\` (with embedded HD clippings & screenshots!), interactive \`html\` dashboard, \`csv\` (with optional inline CSV text for your Python sandbox!), or \`json\`.
- \`run_full_topic_cycle\` — All-in-one async morning orchestrator (Harvest + Evidence Capture + optional ePaper download).`,
  },

  epaper_clipping: {
    title: 'Precision ePaper Acquisition & Vision-Guided Clipping SOP',
    summary: 'Step-by-step protocol for finding, rendering, visually bounding, gutter-snapping, white-out masking, and auditing print newspaper clippings.',
    content: `# Precision ePaper Clipping SOP (Zero Cut-Offs, Zero Ad Bleeding)

## Step 1: Locate or Download the Newspaper
1. Call \`epaper_list_sources(search="<paper_or_city>")\` to check if the PDF is already downloaded or to find the exact slug/city key.
   - Multi-city dailies: call \`epaper_list_sources(cities_for="dainik-jagran", search="varanasi")\` or \`cities_for="amar-ujala"\`.
2. If not downloaded yet, call \`epaper_download(papers=["<slug>"], city="<optional_city>", date="<optional_YYYY-MM-DD>")\`.
   - Always share the returned clickable \`download_url\` if the user wants the full PDF.

## Step 2: Pinpoint Matching Pages in <2 Seconds (NEVER Blind-Render 20 Pages!)
- Call \`epaper_search_pdf(keywords=["Kashi Tamil", "काशी तमिल", "KTS 5.0"], pdf="<optional_filename>")\`.
- If \`pdf\` is omitted, it scans EVERY downloaded PDF in \`~/Downloads/epapers\`.
- Inspect \`files_with_matches\`: you get exact \`matched_pages\` and normalized \`normalized_box\` hints!
- If \`raster_pages\` is non-empty (scanned image PDF without embedded vector text), pass \`ocr_raster: true\` on a single PDF or render Page 1 directly.

## Step 3: Render ONLY Matched Pages with 0.0-1.0 Vision Grid
- Call \`epaper_render_page(pdf="<filename>", pages="<matched_page>", dpi=150, grid=true, hints=true, include_inline_image=true)\`.
- You will receive:
  1. An inline JPEG image WITH cyan 0.1–0.9 X/Y ruler grid lines overlaid.
  2. Native PDF \`hints.headlines\` with exact normalized coordinates.

## Step 4: Calculate Precision Bounding Boxes & Exclude Zones Using YOUR Vision
- Read the 0.0–1.0 rulers on the top (X: left->right) and left edge (Y: top->bottom):
  - \`box: [left, top, right, bottom]\` — Include the full headline, byline, body columns, and any attached photo/caption belonging to the story.
  - Give a tiny ~0.005–0.010 buffer into the white column gutter; \`snap: true\` will automatically snap each edge to the exact center of the white gutter or black divider line!
  - **L-Shaped / T-Shaped Articles & Adjacent Ads:** If the outer rectangle accidentally includes a corner of an unrelated story or an advertisement, add its box to \`exclude: [[ex_l, ex_t, ex_r, ex_b]]\`. The clipper paints exclude zones pure white so the final press clipping is museum-clean!
- **NEVER** split a newspaper page blindly into halves/quarters. Always follow true story boundaries.

## Step 5: Execute Clipping + Hindi/English OCR
- Call \`epaper_clip_articles(pdf="<filename>", page=<N>, topic="<topic_slug>", dpi=200, run_ocr=true, articles=[{ slug: "...", headline: "...", box: [l, t, r, b], exclude: [...], snap: true }])\`
- Every clipping is saved to \`data/topics/<topic_slug>.db\` and gets a public HTTPS \`public_url\`.

## Step 6: Self-Audit with Vision QC
- For high-stakes executive clippings, call \`inspect_asset_image(asset="<file_path_or_url>")\`.
- Visually confirm:
  - No cut-off headline or chopped letters on the left/right edges.
  - No bleeding text from neighboring articles.
- If imperfect, adjust \`box\` or \`exclude\` and re-run \`epaper_clip_articles\`!`,
  },

  morning_briefing: {
    title: 'End-to-End 5-Pillar Morning Media Monitoring Briefing SOP',
    summary: 'Complete workflow to harvest Print + Digital + Social + Video, verify evidence & true timestamps, curate sentiment, and ship a branded DOCX + HTML dossier.',
    content: `# 5-Pillar Morning Media Monitoring Briefing SOP

Use a clean isolated topic slug per campaign/day, e.g. \`kashi_tamil_sangamam_nov20\`.

## Phase 1: Multi-Channel Ingestion (Run in Parallel Where Possible)
1. **Universal Google All-Search (All 5 Pillars):**
   - Call \`google_universal_harvest(query="<Topic>", topic="<slug>", time_window="24h", max_pages=2)\`.
   - For deep dives or regional language buzz, run a second call with Hindi/Tamil query or \`site: "facebook.com"\` / \`site: "x.com"\` / \`site: "youtube.com"\`.
2. **47 Indian Digital Newsrooms (Direct Wire & Press):**
   - Call \`digital_news_search(query="<English Keyword>", hours=24, topic="<slug>")\`.
   - Run a SEPARATE call for Hindi keywords (never mix two languages in one query string!).
3. **Instagram Social Monitoring (Optional):**
   - Call \`social_instagram_monitor(mode="handle", handles=["eduminofindia", "ktsangamam"], hours=48, topic="<slug>")\`.
4. **Print ePapers:**
   - Download morning dailies via \`epaper_download(papers=["dainik-jagran", "navbharat-times", "hindustan", "vir-arjun"])\` (async \`job_id\`), then follow the \`epaper_clipping\` SOP (\`epaper_search_pdf\` -> \`epaper_render_page\` -> \`epaper_clip_articles\`).

## Phase 2: Verified Evidence & Source-of-Truth Timestamps
- Call \`capture_verified_evidence(topic="<slug>", limit=10)\` (runs async for 3+ URLs; poll \`check_job_status\`).
- Every Facebook/Instagram/News URL is captured with modal popups annihilated and true \`content_published_at\` extracted.
- If you want to read full article text quickly before deciding whether to screenshot, use \`fetch_url_metadata(url="...")\`.

## Phase 3: Editorial Curation (Your Intelligence Layer)
- Call \`query_topic_media(topic="<slug>", limit=50)\`.
- Review headlines, snippets, OCR text, and \`content_published_at\`:
  - Call \`update_media_item\` to assign accurate \`sentiment\` (\`Positive\` / \`Neutral\` / \`Negative\`), refine \`category\`, add crisp 1-2 sentence executive \`notes\`, and set \`flagged_irrelevant: true\` on off-topic noise or stale stories outside the requested date window.

## Phase 4: Deliverables & Executive Packaging
1. **Client-Ready Branded Word Dossier (.docx with Embedded HD Images):**
   - Call \`export_topic_dossier(topic="<slug>", format="docx", title="...", client_name="...", executive_summary="<your synthesized executive briefing>")\`.
   - Give the user the clickable \`download_url\`!
2. **Interactive Live HTML Dashboard:**
   - Call \`export_topic_dossier(topic="<slug>", format="html", title="...", executive_summary="...")\` and share the live link!
3. **Charts / Excel / Slides on Your Own Computer:**
   - Call \`export_topic_dossier(topic="<slug>", format="csv", include_inline_content=true)\` and follow \`chatgpt_computer_recipes\`!`,
  },

  visual_qc_and_timestamps: {
    title: 'Source-of-Truth Timestamp Rules & Self-Healing Visual QC',
    summary: 'Strict verification rules for content publication timestamps and visual audit of screenshots & clippings.',
    content: `# Source-of-Truth Timestamps & Visual QC Protocol

## 1. Timestamp Source of Truth (Strict Policy)
- **NEVER** substitute \`harvested_at\` (scrape time) for publication time.
- 3-Tier Extraction Hierarchy enforced by Ampio:
  1. **Tier 1 (100% confidence, \`meta_tag\`)**: JSON-LD \`datePublished\`, \`<meta property="article:published_time">\`, \`<time datetime="...">\`.
  2. **Tier 2 (95% confidence, \`relative_dom\`)**: Social DOM relative timestamps (e.g. \`22h\`, \`13h\`, \`Yesterday\`) converted to exact IST (\`YYYY-MM-DD HH:MM:SS IST\`).
  3. **Tier 3 (85% confidence, \`serp_snippet\`)**: Google SERP snippet date when DOM timestamp is absent.
- If all 3 tiers fail: \`content_published_at\` remains \`null\` (\`timestamp_confidence: 0\`). Use \`fetch_url_metadata(url)\` as a fast second check, or report honestly as "Publication time not exposed by source".

## 2. Self-Healing Visual QC Loop
1. Query failed or low-score items: \`query_topic_media(topic="<slug>", screenshot_status="FAILED")\`.
2. For any critical item (especially Facebook or Instagram), call \`inspect_asset_image(asset="<clip_path_or_url>")\`.
3. Visually check with your own eyes:
   - Is "See more on Facebook" or "Log in" dialog blocking the post?
   - Is a 404 / "Page Not Found" / CAPTCHA / blank white page shown?
   - Is a cookie banner covering the headline?
4. If defective:
   - Retry via \`capture_verified_evidence(topic="<slug>", urls=["<url>"])\`, OR
   - If the link is genuinely a dead 404, mark \`update_media_item(topic="<slug>", url="<url>", flagged_irrelevant=true, notes="Dead 404 link removed during QC")\`.`,
  },

  chatgpt_computer_recipes: {
    title: 'Action Recipes for ChatGPT Own Computer (Code Interpreter / Python)',
    summary: 'How to fetch ground-truth CSV/JSON from Ampio MCP and run Python analytics, charts, Excel trackers, and slides locally on ChatGPT computer.',
    content: `# Recipes for Running Actions on Your Own Computer (Python / Code Interpreter)

Because your Python sandbox does NOT have outbound internet access, ALWAYS pull structured data from Ampio MCP first, then execute local Python scripts on your computer!

## Recipe 1: Executive Analytics Charts (Share-of-Voice, Sentiment & Hourly Timeline)
1. Call \`export_topic_dossier(topic="<slug>", format="csv", include_inline_content=true)\`.
2. In your Python sandbox, load \`inline_content\` into \`pandas.read_csv(io.StringIO(csv_text))\`:
   - Plot **Media Pillar Share-of-Voice** (horizontal bar chart of \`category\`).
   - Plot **Sentiment Distribution** (donut chart of \`sentiment\`: Positive / Neutral / Negative).
   - Plot **True Publication Velocity** (hourly/daily histogram parsed from \`content_published_at\` — NEVER \`harvested_at\`!).
3. Present the high-res PNG charts directly in chat alongside Ampio's clickable clipping & screenshot URLs!

## Recipe 2: Client-Ready Multi-Sheet Excel Tracker (.xlsx)
1. Call \`export_topic_dossier(topic="<slug>", format="csv", include_inline_content=true)\` AND \`query_topic_media(topic="<slug>", include_clippings=true, limit=100)\`.
2. In your Python sandbox using \`openpyxl\`:
   - Sheet 1: **Executive KPI Dashboard** (total print/digital/social counts, verified rate, sentiment % formulas).
   - Sheet 2: **Digital & Social Coverage** (clickable hyperlinks in URL & Screenshot URL columns, color-coded Sentiment cells, strict \`content_published_at\` column).
   - Sheet 3: **Print ePaper Clippings** (edition, page number, headline, OCR excerpt, public clipping URL).

## Recipe 3: Executive Word Dossier (.docx) WITH Embedded High-Res Clippings & Screenshots
- **DO NOT** try to download \`https://.../assets/...\` images inside your Python sandbox (it has no internet).
- Instead:
  1. Curate all items & sentiment via \`update_media_item\`.
  2. Write a sharp, client-tailored \`executive_summary\`.
  3. Call \`export_topic_dossier(topic="<slug>", format="docx", title="...", client_name="...", executive_summary="...")\`.
  4. Ampio's server embeds EVERY full-resolution print clipping and verified clean screenshot directly into the Word document and returns an instant public \`download_url\`!

## Recipe 4: Executive PowerPoint Deck (.pptx)
- Use your local Python \`python-pptx\` to build a 5-slide executive briefing deck (Title, KPI Metrics + Matplotlib Charts, Top Print Highlights from OCR, Top Digital/Social Buzz with \`content_published_at\`, Strategic Recommendations) using the JSON/CSV pulled from Ampio MCP.`,
  },
};
