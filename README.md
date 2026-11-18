# 📰 Media Monitoring Intelligence Setup

A self-contained, end-to-end Media Monitoring, Indian ePaper acquisition, clipping, and analytics workspace.

---

## 🗂️ Workspace Architecture

```
Downloads/media/
├── src/
│   └── epaper/                    # ePaper CLI Engine (Bun / TypeScript)
│       ├── epaper.ts              # Main CLI entrypoint
│       ├── http.ts                # HTTP streaming client & headers
│       ├── pdf-builder.ts         # Native/raster PDF assembly & validation
│       ├── clipper.py             # Precision gutter-snapping & whiteout masking
│       ├── show.py                # Audio show & video triage helpers
│       ├── publishers.json        # 80+ Indian newspaper catalog & direct URL routes
│       └── providers/
│           ├── dailyepaper.ts     # 88+ national & regional papers via dailyepaper.in
│           ├── indiags.ts         # The Hindu, Indian Express, Business Line, etc.
│           ├── official-regional.ts # Official portals (Pragativadi, Loktej, etc.)
│           └── clipper.ts         # Vision AI bridge for coords & page rendering
├── scripts/
│   ├── run_pipeline.ts            # Complete end-to-end pipeline orchestrator
│   ├── ingest_to_db.py            # SQLite ingestion with JSON indexing & deduplication
│   └── generate_dashboard.py      # Interactive HTML intelligence dashboard generator
├── downloads/                     # Incoming downloaded full-issue newspaper PDFs
├── pages/                         # Rendered high-DPI page PNGs & Vision-AI *_grid.png
├── clips/                         # Snapped & whiteout-masked press clippings
├── dataset/                       # Extracted JSON article metadata & taxonomy
├── data/
│   └── media_dataset.db           # Central SQLite database with JSON extraction indexing
├── outputs/
│   ├── dashboard.html             # Generated interactive web report
│   └── vision_memory/             # Learned column & ad boundary layout templates
├── package.json                   # Bun/NPM command shortcuts
├── tsconfig.json                  # Bun TypeScript configuration
└── requirements.txt               # Python dependencies (pymupdf, Pillow, numpy)
```

---

## ⚡ Quick Start

### 1. Check Available Newspapers
```bash
bun run list
# Or search specifically:
bun run epaper list --search hindu --json
```

### 2. Download Daily Issues
```bash
# Download today's paper
bun run download the-hindu --out ./downloads --json

# Download a specific date
bun run download times-of-india --date "18 Nov 2026" --out ./downloads --json

# Batch download multiple papers
bun run batch the-hindu,indian-express,economic-times --out ./downloads --json
```

### 3. Render Pages for Vision AI
Renders 150 DPI page images and overlays normalized `0.1 - 0.9` coordinate grid lines (`*_grid.png`) and native PDF headline bboxes:
```bash
bun run render ./downloads/the-hindu.pdf --pages 1 --grid --hints --out ./pages --json
```

### 4. Gutter-Snap & Crop Articles
Takes Vision AI coordinate JSON (`[ymin, xmin, ymax, xmax]`), calculates column margin averages, and applies clean white-out masking:
```bash
bun run clip ./dataset/coords_sample.json --out ./clips --json
```

### 5. Ingest Metadata into Database
Loads extracted JSONs from `dataset/` into `data/media_dataset.db`:
```bash
bun run ingest
```

### 6. Generate Intelligence Dashboard
Compiles `outputs/dashboard.html` with real-time clipping search, category filters, and sentiment breakdown:
```bash
bun run dashboard
```

---

## 🚀 One-Command End-to-End Run
Run the complete workflow (download -> render -> ingest -> dashboard) in a single command:
```bash
bun run pipeline --papers the-hindu,indian-express --pages 1-2
```
