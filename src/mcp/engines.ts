import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { join, relative, resolve } from 'node:path';
import { clipFromCoords, renderPdfPages } from '../epaper/providers/clipper.ts';
import { listJagranCities } from '../epaper/providers/dainik-jagran.ts';
import { listAmarUjalaCities } from '../epaper/providers/amar-ujala.ts';
import { TARGET_PRESETS } from '../epaper/epaper.ts';
import {
  DATA_DIR,
  TOPICS_DIR,
  WORKSPACE_ROOT,
  getTopicDb,
  getTopicDbPath,
  insertTopicClipping,
  listTopicDbs,
  sanitizeTopic,
  upsertTopicItems,
  type TopicItemInput,
} from './db.ts';

export const EPAPERS_DIR = join(os.homedir(), 'Downloads', 'epapers');
export const RENDERED_DIR = join(DATA_DIR, 'rendered');
export const CLIPS_DIR = join(WORKSPACE_ROOT, 'clips');
export const OUTPUTS_DIR = join(WORKSPACE_ROOT, 'outputs');
export const DOCS_DIR = join(WORKSPACE_ROOT, 'docs');

mkdirSync(RENDERED_DIR, { recursive: true });
mkdirSync(CLIPS_DIR, { recursive: true });
mkdirSync(OUTPUTS_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function runSubprocess(
  cmd: string,
  args: string[],
  timeoutMs = 180_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: WORKSPACE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s: ${cmd} ${args.join(' ')}`));
        return;
      }
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function toPublicAssetUrl(filePath: string | null | undefined, publicBaseUrl: string): string | null {
  if (!filePath) return null;
  const abs = resolve(WORKSPACE_ROOT, filePath);
  const base = publicBaseUrl.replace(/\/$/, '');

  const mappings: Array<[string, string]> = [
    [resolve(CLIPS_DIR), '/assets/clips'],
    [resolve(RENDERED_DIR), '/assets/rendered'],
    [resolve(OUTPUTS_DIR), '/assets/outputs'],
    [resolve(EPAPERS_DIR), '/assets/epapers'],
    [resolve(DOCS_DIR), '/assets/docs'],
  ];

  for (const [root, prefix] of mappings) {
    if (abs.startsWith(root + path.sep) || abs === root) {
      const rel = relative(root, abs).split(path.sep).map(encodeURIComponent).join('/');
      return `${base}${prefix}/${rel}`;
    }
  }
  return null;
}

export function resolvePdfPath(inputPath: string): string {
  if (existsSync(inputPath)) return resolve(inputPath);
  const inEpapers = join(EPAPERS_DIR, inputPath);
  if (existsSync(inEpapers)) return inEpapers;
  const inEpapersPdf = join(EPAPERS_DIR, `${inputPath}.pdf`);
  if (existsSync(inEpapersPdf)) return inEpapersPdf;

  // Fuzzy match by filename stem inside ~/Downloads/epapers
  if (existsSync(EPAPERS_DIR)) {
    const q = inputPath.toLowerCase().replace(/\.pdf$/, '');
    const files = readdirSync(EPAPERS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .sort()
      .reverse();
    const hit = files.find((f) => f.toLowerCase().includes(q));
    if (hit) return join(EPAPERS_DIR, hit);
  }
  throw new Error(`PDF not found: "${inputPath}". Check epaper_list_sources for available files in ${EPAPERS_DIR}.`);
}

function extractLastJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Find last JSON object or array block
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // ignore
      }
    }
    return null;
  }
}

async function runOcrOnImage(imagePath: string): Promise<string> {
  try {
    const { stdout, code } = await runSubprocess('tesseract', [imagePath, 'stdout', '-l', 'eng+hin'], 20_000);
    if (code === 0 && stdout.trim()) return stdout.trim();
  } catch {
    // Fallback to English-only if hin traineddata is missing
    try {
      const { stdout, code } = await runSubprocess('tesseract', [imagePath, 'stdout', '-l', 'eng'], 20_000);
      if (code === 0) return stdout.trim();
    } catch {
      // OCR unavailable
    }
  }
  return '';
}

async function createCompactBase64Jpeg(pngPath: string, maxDim = 1100): Promise<string | null> {
  try {
    const pyCode = `
import base64, io, sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
im.thumbnail((int(sys.argv[2]), int(sys.argv[2])))
buf = io.BytesIO()
im.save(buf, format="JPEG", quality=78, optimize=True)
print(base64.b64encode(buf.getvalue()).decode("ascii"))
`;
    const { stdout, code } = await runSubprocess('python3', ['-c', pyCode, pngPath, String(maxDim)], 15_000);
    if (code === 0 && stdout.trim().length > 100) return stdout.trim();
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. ePaper Sources, Catalog Browser, Issues, Download, Render & Clipping
// ---------------------------------------------------------------------------
let cachedCatalog: { fetchedAt: number; papers: any[] } | null = null;

async function fetchFullEpaperCatalog(): Promise<any[]> {
  if (cachedCatalog && Date.now() - cachedCatalog.fetchedAt < 10 * 60 * 1000) {
    return cachedCatalog.papers;
  }
  const { stdout } = await runSubprocess('bun', ['run', 'src/epaper/epaper.ts', 'list', '--json'], 25_000);
  const parsed = extractLastJson(stdout);
  const papers: any[] = Array.isArray(parsed?.papers) ? parsed.papers : [];

  // Ensure dainik-jagran and amar-ujala multi-city direct adapters are always clearly listed
  const existingSlugs = new Set(papers.map((p) => String(p.slug || '').toLowerCase()));
  if (!existingSlugs.has('dainik-jagran')) {
    papers.unshift({
      source: 'official-jagran',
      slug: 'dainik-jagran',
      name: 'Dainik Jagran (42+ City Editions)',
      date: 'today',
      supports_city_edition: true,
    });
  }
  if (!existingSlugs.has('amar-ujala')) {
    papers.unshift({
      source: 'official-amar-ujala',
      slug: 'amar-ujala',
      name: 'Amar Ujala (141 City Editions)',
      date: 'today',
      supports_city_edition: true,
    });
  }

  cachedCatalog = { fetchedAt: Date.now(), papers };
  return papers;
}

export async function listEpaperSources(
  opts: {
    search?: string;
    category?: 'all' | 'hindi' | 'english' | 'financial' | 'official' | 'readwhere' | 'dailyepaper' | 'indiags';
    citiesFor?: 'dainik-jagran' | 'amar-ujala';
    includeDownloaded?: boolean;
  } = {},
  publicBaseUrl = ''
) {
  // Dedicated city-edition explorer for multi-city papers
  if (opts.citiesFor === 'dainik-jagran') {
    const raw = listJagranCities();
    const seen = new Set<string>();
    let cities = raw.filter((c: any) => {
      const k = `${c.name}|${c.state}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (opts.search) {
      const q = opts.search.toLowerCase();
      cities = cities.filter((c: any) => `${c.key} ${c.name} ${c.state}`.toLowerCase().includes(q));
    }
    return {
      paper: 'dainik-jagran',
      total_cities: cities.length,
      usage_hint: 'Pass papers: ["dainik-jagran"] and city: "<key>" to epaper_download.',
      cities,
    };
  }

  if (opts.citiesFor === 'amar-ujala') {
    let cities = listAmarUjalaCities();
    if (opts.search) {
      const q = opts.search.toLowerCase();
      cities = cities.filter((c: any) => `${c.slug} ${c.title} ${c.city_slug}`.toLowerCase().includes(q));
    }
    return {
      paper: 'amar-ujala',
      total_cities: cities.length,
      usage_hint: 'Pass papers: ["amar-ujala"] and city: "<slug>" to epaper_download.',
      cities: cities.slice(0, 150),
    };
  }

  const downloadedPdfs =
    (opts.includeDownloaded ?? true) && existsSync(EPAPERS_DIR)
      ? readdirSync(EPAPERS_DIR)
          .filter((f) => f.toLowerCase().endsWith('.pdf'))
          .map((f) => {
            const full = join(EPAPERS_DIR, f);
            const st = statSync(full);
            return {
              filename: f,
              path: full,
              download_url: publicBaseUrl ? toPublicAssetUrl(full, publicBaseUrl) : null,
              size_mb: Number((st.size / (1024 * 1024)).toFixed(2)),
              modified_at: st.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
      : [];

  let allPapers = await fetchFullEpaperCatalog();
  const cat = opts.category || 'all';

  if (cat === 'hindi' || cat === 'english' || cat === 'financial') {
    const presetSet = new Set(TARGET_PRESETS[cat]);
    allPapers = allPapers.filter((p) => presetSet.has(String(p.slug || '').toLowerCase()));
  } else if (cat === 'official' || cat === 'readwhere' || cat === 'dailyepaper' || cat === 'indiags') {
    allPapers = allPapers.filter((p) => String(p.source || '').toLowerCase().includes(cat));
  }

  if (opts.search) {
    const q = opts.search.toLowerCase();
    allPapers = allPapers.filter((p) =>
      `${p.slug || ''} ${p.name || ''} ${p.source || ''}`.toLowerCase().includes(q)
    );
  }

  // Deduplicate by slug while preserving source info
  const structuredPapers = allPapers.map((p) => ({
    slug: p.slug,
    name: p.name,
    source: p.source,
    latest_date: p.date || 'today',
    supports_city_edition:
      p.slug === 'dainik-jagran' || p.slug === 'amar-ujala' || Boolean(p.supports_city_edition),
  }));

  return {
    total_available_in_catalog: structuredPapers.length,
    filter_applied: { category: cat, search: opts.search || null },
    presets: {
      financial: TARGET_PRESETS.financial,
      english: TARGET_PRESETS.english,
      hindi: TARGET_PRESETS.hindi,
    },
    multi_city_papers: {
      'dainik-jagran': '42+ city editions (e.g. varanasi, lucknow, delhi, kanpur, prayagraj, patna, gorakhpur). Call epaper_list_sources with cities_for="dainik-jagran" to browse all.',
      'amar-ujala': '141 city editions (e.g. varanasi-city, lucknow-city, agra-city, delhi-city, dehradun). Call epaper_list_sources with cities_for="amar-ujala" to browse all.',
    },
    papers: structuredPapers,
    downloaded_count: downloadedPdfs.length,
    downloaded_pdfs: downloadedPdfs,
  };
}

export async function listEpaperIssues(opts: { paper: string; limit?: number }) {
  const args = [
    'run',
    'src/epaper/epaper.ts',
    'issues',
    opts.paper,
    '--limit',
    String(opts.limit ?? 10),
    '--json',
  ];
  const { stdout, stderr, code } = await runSubprocess('bun', args, 30_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 && !parsed) {
    throw new Error(stderr.trim() || stdout.trim() || `Failed to fetch issues for ${opts.paper}`);
  }
  return parsed || { ok: true, paper: opts.paper, raw: stdout.trim() };
}

export async function downloadEpapers(
  opts: {
    papers?: string[];
    preset?: string;
    date?: string;
    city?: string;
    source?: string;
  },
  publicBaseUrl = ''
) {
  mkdirSync(EPAPERS_DIR, { recursive: true });
  const args: string[] = ['run', 'src/epaper/epaper.ts'];

  if (opts.preset) {
    args.push('batch', '--preset', opts.preset);
  } else if (opts.papers && opts.papers.length > 1) {
    args.push('batch', opts.papers.join(','));
  } else if (opts.papers && opts.papers.length === 1) {
    args.push('download', opts.papers[0]);
  } else {
    throw new Error('Provide either "papers" (e.g. ["vir-arjun"]) or "preset" (hindi/english/financial).');
  }

  if (opts.date) args.push('--date', opts.date);
  if (opts.city) args.push('--city', opts.city);
  if (opts.source) args.push('--source', opts.source);
  args.push('--out', EPAPERS_DIR, '--json');

  const { stdout, stderr, code } = await runSubprocess('bun', args, 240_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 && !parsed) {
    throw new Error(stderr.trim() || stdout.trim() || `epaper download failed (exit ${code})`);
  }

  // Enrich single or batch download results with direct clickable public PDF URLs
  const attachDownloadUrl = (entry: any) => {
    if (!entry || typeof entry !== 'object') return entry;
    const fp = entry.filePath || entry.file_path;
    return {
      ...entry,
      download_url: fp && publicBaseUrl ? toPublicAssetUrl(fp, publicBaseUrl) : null,
    };
  };

  let enriched = parsed || { raw_output: stdout.trim() };
  if (enriched && Array.isArray(enriched.downloaded)) {
    enriched = {
      ...enriched,
      downloaded: enriched.downloaded.map(attachDownloadUrl),
    };
  } else if (enriched && (enriched.filePath || enriched.file_path)) {
    enriched = attachDownloadUrl(enriched);
  }

  return {
    ok: code === 0 || Boolean(enriched?.downloaded?.length) || Boolean(enriched?.filePath),
    result: enriched,
  };
}

export async function renderEpaperPagesForVision(
  opts: {
    pdf: string;
    pages?: string;
    dpi?: number;
    grid?: boolean;
    hints?: boolean;
    includeInlineImage?: boolean;
  },
  publicBaseUrl: string
) {
  const pdfPath = resolvePdfPath(opts.pdf);
  const stem = path.basename(pdfPath, '.pdf').replace(/[^a-zA-Z0-9_-]/g, '_');
  const outDir = join(RENDERED_DIR, stem);

  const manifest = (await renderPdfPages({
    pdfPath,
    outDir,
    dpi: opts.dpi ?? 150,
    pages: opts.pages || '1',
    grid: opts.grid ?? true,
    hints: opts.hints ?? true,
  })) as any;

  const pages = (manifest.pages || []).map((p: any) => ({
    page: p.page,
    pageId: p.pageId,
    width: p.width,
    height: p.height,
    imagePath: p.imagePath,
    imageUrl: toPublicAssetUrl(p.imagePath, publicBaseUrl),
    gridImagePath: p.gridImagePath,
    gridImageUrl: toPublicAssetUrl(p.gridImagePath, publicBaseUrl),
    hints: p.hints,
  }));

  // Optional inline base64 preview for the first rendered grid image so ChatGPT Vision sees it directly
  let inlinePreviewBase64: string | null = null;
  if (opts.includeInlineImage && pages.length > 0) {
    const targetImg = pages[0].gridImagePath || pages[0].imagePath;
    if (targetImg && existsSync(targetImg)) {
      inlinePreviewBase64 = await createCompactBase64Jpeg(targetImg, 1100);
    }
  }

  return {
    ok: true,
    pdf: pdfPath,
    pdfName: path.basename(pdfPath),
    totalPages: manifest.totalPages,
    dpi: manifest.dpi,
    pages,
    inlinePreviewBase64,
  };
}

export async function clipEpaperArticles(
  opts: {
    pdf: string;
    page: number;
    topic: string;
    dpi?: number;
    articles: Array<{
      slug: string;
      headline?: string;
      box: [number, number, number, number]; // [left, top, right, bottom] normalized 0.0-1.0
      exclude?: Array<[number, number, number, number]>;
      snap?: boolean;
    }>;
    runOcr?: boolean;
  },
  publicBaseUrl: string
) {
  const pdfPath = resolvePdfPath(opts.pdf);
  const editionName = path.basename(pdfPath, '.pdf');
  const stem = editionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const topicSlug = sanitizeTopic(opts.topic);

  // Ensure page is rendered at high resolution (default 200 DPI for crisp clippings)
  const renderOutDir = join(RENDERED_DIR, `${stem}_hd`);
  const pageId = `page_${String(opts.page).padStart(3, '0')}`;
  let pageImgPath = join(renderOutDir, `${pageId}.png`);

  if (!existsSync(pageImgPath)) {
    await renderPdfPages({
      pdfPath,
      outDir: renderOutDir,
      dpi: opts.dpi ?? 200,
      pages: String(opts.page),
      grid: false,
      hints: false,
    });
  }

  if (!existsSync(pageImgPath)) {
    throw new Error(`Failed to render page ${opts.page} from ${pdfPath}`);
  }

  // Build coords JSON expected by src/epaper/clipper.py
  const articlesMap: Record<string, any> = {};
  const headlineBySlug = new Map<string, string>();
  for (const art of opts.articles) {
    articlesMap[art.slug] = {
      box: art.box,
      exclude: art.exclude || [],
      snap: art.snap ?? true,
    };
    if (art.headline) headlineBySlug.set(art.slug, art.headline);
  }

  const coordsSpec = {
    [`${stem}_p${opts.page}`]: {
      image_path: pageImgPath,
      articles: articlesMap,
    },
  };

  const clipsOutDir = join(CLIPS_DIR, 'mcp_clippings', topicSlug);
  mkdirSync(clipsOutDir, { recursive: true });
  const coordsFile = join(clipsOutDir, `coords_${stem}_p${opts.page}_${Date.now()}.json`);
  writeFileSync(coordsFile, JSON.stringify(coordsSpec, null, 2), 'utf-8');

  const clipRes = (await clipFromCoords(coordsFile, clipsOutDir)) as any;
  const doOcr = opts.runOcr ?? true;

  const enrichedClips = [];
  for (const c of clipRes.clips || []) {
    const ocrText = doOcr ? await runOcrOnImage(c.filePath) : '';
    const relPath = relative(WORKSPACE_ROOT, c.filePath);
    const hl = headlineBySlug.get(c.slug) || ocrText.split('\n')[0]?.slice(0, 140) || c.slug;

    const clipId = insertTopicClipping(topicSlug, {
      edition: editionName,
      pdf_path: pdfPath,
      page_number: opts.page,
      slug: c.slug,
      headline: hl,
      ocr_text: ocrText,
      bbox: c.snappedBox,
      exclude: articlesMap[c.slug]?.exclude || [],
      file_path: relPath,
      width: c.width,
      height: c.height,
    });

    enrichedClips.push({
      clip_id: clipId,
      slug: c.slug,
      headline: hl,
      page: opts.page,
      width: c.width,
      height: c.height,
      snapped_box: c.snappedBox,
      excluded_boxes: c.excludedCount,
      file_path: relPath,
      public_url: toPublicAssetUrl(c.filePath, publicBaseUrl),
      ocr_text: ocrText,
    });
  }

  return {
    ok: true,
    topic: topicSlug,
    edition: editionName,
    page: opts.page,
    count: enrichedClips.length,
    clips: enrichedClips,
  };
}

// ---------------------------------------------------------------------------
// 2. Universal Google All-Search Harvester
// ---------------------------------------------------------------------------
export async function runGoogleHarvest(opts: {
  query: string;
  topic: string;
  timeWindow?: '1h' | '24h' | '48h' | '7d' | '30d' | 'any';
  dateFrom?: string;
  dateTo?: string;
  site?: string;
  maxPages?: number;
}) {
  const topicSlug = sanitizeTopic(opts.topic);
  const outJson = join(TOPICS_DIR, `${topicSlug}_index.json`);
  const outCsv = join(TOPICS_DIR, `${topicSlug}_index.csv`);

  const args = [
    'scripts/google_universal_harvester.py',
    '--query',
    opts.query,
    '--window',
    opts.timeWindow || '24h',
    '--max-pages',
    String(opts.maxPages ?? 2),
    '--out',
    outJson,
    '--out-csv',
    outCsv,
  ];
  if (opts.dateFrom) args.push('--date-from', opts.dateFrom);
  if (opts.dateTo) args.push('--date-to', opts.dateTo);
  if (opts.site) args.push('--site', opts.site);

  const { stdout, stderr, code } = await runSubprocess('python3', args, 180_000);
  if (code !== 0 && !existsSync(outJson)) {
    throw new Error(`Google harvester failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }

  const data = JSON.parse(readFileSync(outJson, 'utf-8'));
  const rawItems: any[] = data.items || [];

  const toUpsert: TopicItemInput[] = rawItems.map((it) => ({
    headline: it.headline || it.url,
    url: it.url,
    source: it.source || it.domain || '',
    domain: it.domain || '',
    category: it.category || 'Print & Digital News',
    media_type: it.media_type || 'news_article',
    snippet: it.snippet || '',
    relative_time: it.time_text || null,
    timestamp_confidence: it.time_text && it.time_text !== 'Recent (Past 24-48h)' ? 85 : 0,
    time_source: it.time_text && it.time_text !== 'Recent (Past 24-48h)' ? 'serp_snippet' : null,
    screenshot_status: 'PENDING',
    harvested_at: it.harvested_at || new Date().toISOString(),
  }));

  const dbStats = upsertTopicItems(topicSlug, toUpsert);

  // Category breakdown
  const categories: Record<string, number> = {};
  for (const it of rawItems) {
    const cat = it.category || 'Other';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  const combinedLog = `${stdout}\n${stderr}`;
  let diagnostic: string | undefined;
  if (rawItems.length === 0) {
    if (/isn't connected|not connected|browse error|ECONNREFUSED/i.test(combinedLog)) {
      diagnostic =
        'Chrome "browse" extension relay is disconnected on the host Mac. Open the paired Chrome profile so Google Universal Harvester can browse, OR use digital_news_search (47 Indian outlets, works headless without Chrome).';
    } else if (/captcha|unusual traffic|sorry\/index/i.test(combinedLog)) {
      diagnostic = 'Google requested human verification (CAPTCHA). Do not bypass; wait or use digital_news_search.';
    }
  }

  return {
    ok: true,
    topic: topicSlug,
    query: opts.query,
    time_window: opts.timeWindow || '24h',
    total_harvested: rawItems.length,
    diagnostic,
    db_sync: dbStats,
    categories,
    index_json: relative(WORKSPACE_ROOT, outJson),
    index_csv: relative(WORKSPACE_ROOT, outCsv),
    items: rawItems.slice(0, 30),
  };
}

// ---------------------------------------------------------------------------
// 3. Digital 47-Outlet News Search
// ---------------------------------------------------------------------------
export async function runDigitalSearch(opts: {
  query: string;
  topic?: string;
  hours?: number;
  outlets?: string;
}) {
  const args = ['run', 'src/digital/digital.ts', 'search', opts.query, '--hours', String(opts.hours ?? 48), '--json'];
  if (opts.outlets) args.push('--outlets', opts.outlets);

  const { stdout, stderr, code } = await runSubprocess('bun', args, 120_000);
  const parsed = extractLastJson(stdout);
  if (code !== 0 && !parsed) {
    throw new Error(`Digital search failed: ${stderr.trim() || stdout.trim()}`);
  }

  const articles: any[] = Array.isArray(parsed) ? parsed : parsed?.articles || parsed?.results || [];

  let dbSync = null;
  if (opts.topic && articles.length > 0) {
    const topicSlug = sanitizeTopic(opts.topic);
    dbSync = upsertTopicItems(
      topicSlug,
      articles.map((a: any) => ({
        headline: a.title || a.headline || a.url,
        url: a.url || a.link,
        source: a.publication || a.outlet || a.source || '',
        domain: a.domain || '',
        category: 'Print & Digital News',
        media_type: 'news_article',
        snippet: a.description || a.snippet || '',
        content_published_at: a.publishedAt || a.published_at || null,
        content_date: (a.publishedAt || a.published_at || '').slice(0, 10) || null,
        timestamp_confidence: a.publishedAt || a.published_at ? 95 : 0,
        time_source: a.publishedAt || a.published_at ? 'outlet_feed' : null,
      }))
    );
  }

  return {
    ok: true,
    query: opts.query,
    hours: opts.hours ?? 48,
    total_found: articles.length,
    db_sync: dbSync,
    articles: articles.slice(0, 30),
  };
}

// ---------------------------------------------------------------------------
// 4. Verified Evidence Screenshot Capture (Modal Annihilator + True Timestamp)
// ---------------------------------------------------------------------------
export async function runCaptureEvidence(
  opts: {
    topic: string;
    urls?: string[];
    facebookOnly?: boolean;
    limit?: number;
  },
  publicBaseUrl: string
) {
  const topicSlug = sanitizeTopic(opts.topic);
  const outDir = join(CLIPS_DIR, 'evidence', topicSlug);
  mkdirSync(outDir, { recursive: true });

  // Resolve target URLs: either explicitly supplied, or pending items from topic DB
  let targetUrls = (opts.urls || []).map((u) => u.trim()).filter(Boolean);

  if (targetUrls.length === 0) {
    const db = getTopicDb(topicSlug);
    const whereClause = opts.facebookOnly
      ? `WHERE (screenshot_status != 'VERIFIED_CLEAN' OR content_published_at IS NULL) AND lower(url) LIKE '%facebook.com%'`
      : `WHERE screenshot_status != 'VERIFIED_CLEAN' OR content_published_at IS NULL`;
    const rows = db
      .query(`SELECT url FROM items ${whereClause} ORDER BY id ASC LIMIT ?`)
      .all(opts.limit ?? 10) as Array<{ url: string }>;
    targetUrls = rows.map((r) => r.url);
  }

  if (targetUrls.length === 0) {
    return {
      ok: true,
      topic: topicSlug,
      message: 'No pending URLs to capture. Supply "urls" or run google_universal_harvest first.',
      total: 0,
      verified: 0,
      failed: 0,
      results: [],
    };
  }

  const reportPath = join(TOPICS_DIR, `${topicSlug}_capture_${Date.now()}.json`);
  const noopDb = join(os.tmpdir(), `ampio_noop_${Date.now()}.db`);

  const args = [
    'scripts/capture_evidence_screenshots.py',
    '--urls',
    targetUrls.join(','),
    '--out-dir',
    outDir,
    '--db',
    noopDb,
    '--json-report',
    reportPath,
  ];

  const { stdout, stderr, code } = await runSubprocess('python3', args, Math.max(120_000, targetUrls.length * 45_000));
  if (!existsSync(reportPath)) {
    throw new Error(`Evidence capture failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const rawResults: any[] = report.results || [];

  // Upsert verified screenshots + Source-of-Truth timestamps back into isolated Topic DB
  const upsertRows: TopicItemInput[] = rawResults.map((r) => {
    const isClean = r.status === 'VERIFIED_CLEAN' || r.status === 'RETRIED_REPAIRED';
    const relClip = r.output_path ? relative(WORKSPACE_ROOT, r.output_path) : null;
    const hasExactTs = Boolean(r.content_published_at);
    return {
      headline: r.detected_headline || r.headline || r.url,
      url: r.url,
      source: r.publication || '',
      domain: (() => {
        try {
          return new URL(r.url).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })(),
      content_published_at: r.content_published_at || null,
      content_date: r.content_date || null,
      relative_time: r.relative_time || null,
      timestamp_confidence: hasExactTs ? (r.relative_time ? 95 : 100) : 0,
      time_source: hasExactTs ? (r.relative_time ? 'relative_dom' : 'meta_tag') : null,
      screenshot_status: isClean ? 'VERIFIED_CLEAN' : 'FAILED',
      clip_path: isClean ? relClip : null,
      quality_score: r.quality_score || 0,
    };
  });

  const dbSync = upsertTopicItems(topicSlug, upsertRows);

  const enriched = rawResults.map((r) => ({
    url: r.url,
    resolved_url: r.resolved_url,
    headline: r.detected_headline || r.headline,
    publication: r.publication,
    status: r.status,
    quality_score: r.quality_score,
    popups_removed: r.popups_removed,
    content_published_at: r.content_published_at || null,
    content_date: r.content_date || null,
    relative_time: r.relative_time || null,
    screenshot_url: r.output_path && existsSync(r.output_path) ? toPublicAssetUrl(r.output_path, publicBaseUrl) : null,
    file_path: r.output_path ? relative(WORKSPACE_ROOT, r.output_path) : null,
    error: r.error || null,
  }));

  return {
    ok: true,
    topic: topicSlug,
    total: report.total,
    verified: report.succeeded,
    failed: report.failed,
    avg_quality_score: report.avg_quality_score,
    db_sync: dbSync,
    results: enriched,
  };
}

// ---------------------------------------------------------------------------
// 5. Query Topic Media (Topic DB + Fallback to legacy KTS index)
// ---------------------------------------------------------------------------
export function queryTopicMedia(
  opts: {
    topic?: string;
    query?: string;
    category?: string;
    screenshotStatus?: string;
    includeClippings?: boolean;
    limit?: number;
  },
  publicBaseUrl: string
) {
  const limit = opts.limit ?? 20;
  const topicSlug = opts.topic ? sanitizeTopic(opts.topic) : '';

  // Check if isolated topic DB exists
  const topicDbPath = topicSlug ? join(TOPICS_DIR, `${topicSlug}.db`) : '';
  if (topicSlug && existsSync(topicDbPath)) {
    const db = getTopicDb(topicSlug);
    const clauses: string[] = ['flagged_irrelevant = 0'];
    const params: any[] = [];

    if (opts.query) {
      clauses.push(`(lower(headline) LIKE ? OR lower(snippet) LIKE ? OR lower(source) LIKE ? OR lower(url) LIKE ?)`);
      const q = `%${opts.query.toLowerCase()}%`;
      params.push(q, q, q, q);
    }
    if (opts.category) {
      clauses.push(`(lower(category) LIKE ? OR lower(media_type) LIKE ? OR lower(domain) LIKE ?)`);
      const c = `%${opts.category.toLowerCase()}%`;
      params.push(c, c, c);
    }
    if (opts.screenshotStatus) {
      clauses.push(`upper(screenshot_status) = ?`);
      params.push(opts.screenshotStatus.toUpperCase());
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = db.query(`SELECT COUNT(*) as cnt FROM items ${where}`).get(...params) as { cnt: number };
    const rows = db
      .query(`SELECT * FROM items ${where} ORDER BY COALESCE(content_published_at, harvested_at) DESC LIMIT ?`)
      .all(...params, limit) as any[];

    const items = rows.map((r) => ({
      ...r,
      screenshot_url: toPublicAssetUrl(r.clip_path, publicBaseUrl),
    }));

    let clippings: any[] = [];
    if (opts.includeClippings ?? true) {
      const clipRows = db.query(`SELECT * FROM clippings ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
      clippings = clipRows.map((c) => ({
        ...c,
        public_url: toPublicAssetUrl(c.file_path, publicBaseUrl),
      }));
    }

    const catBreakdown = db
      .query(`SELECT category, COUNT(*) as count FROM items WHERE flagged_irrelevant = 0 GROUP BY category`)
      .all();

    return {
      source: `topic_db:${topicSlug}`,
      total_items_matched: totalRow.cnt,
      returned_items: items.length,
      category_breakdown: catBreakdown,
      items,
      clippings,
    };
  }

  // Fallback to legacy kashi_tamil_sangamam_index.json if present
  const legacyPath = join(DATA_DIR, 'kashi_tamil_sangamam_index.json');
  if (existsSync(legacyPath)) {
    const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    let items: any[] = Array.isArray(raw) ? raw : raw.items || [];
    if (opts.query) {
      const q = opts.query.toLowerCase();
      items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
    }
    if (opts.category) {
      const c = opts.category.toLowerCase();
      items = items.filter((it) =>
        `${it.category || ''} ${it.media_type || ''} ${it.source || ''} ${it.url || ''}`.toLowerCase().includes(c)
      );
    }
    if (opts.screenshotStatus) {
      const s = opts.screenshotStatus.toUpperCase();
      items = items.filter((it) => String(it.screenshot_status || '').toUpperCase() === s);
    }

    return {
      source: 'legacy:kashi_tamil_sangamam_index.json',
      total_items_matched: items.length,
      returned_items: Math.min(items.length, limit),
      items: items.slice(0, limit).map((it) => ({
        ...it,
        screenshot_url: toPublicAssetUrl(it.clip_path, publicBaseUrl),
      })),
      clippings: [],
    };
  }

  return { source: 'none', total_items_matched: 0, returned_items: 0, items: [], clippings: [] };
}

// ---------------------------------------------------------------------------
// 6. Fast Multilingual Full-PDF Keyword Search & Structured Page Text Extractor
// ---------------------------------------------------------------------------
async function runUvPython(withPackages: string[], scriptArgs: string[], timeoutMs = 120_000) {
  const uvCandidates = [join(os.homedir(), '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', 'uv'];
  let uvCmd: string | null = null;
  for (const c of uvCandidates) {
    if (c === 'uv') {
      try {
        const w = await runSubprocess('which', ['uv'], 3000);
        if (w.code === 0) {
          uvCmd = 'uv';
          break;
        }
      } catch {
        continue;
      }
    } else if (existsSync(c)) {
      uvCmd = c;
      break;
    }
  }

  if (uvCmd) {
    const args = ['run', '--quiet'];
    for (const pkg of withPackages) args.push('--with', pkg);
    args.push('python3', ...scriptArgs);
    return runSubprocess(uvCmd, args, timeoutMs);
  }
  return runSubprocess('python3', scriptArgs, timeoutMs);
}

export async function searchEpaperPdf(opts: {
  keywords: string[];
  pdf?: string;
  ocrRaster?: boolean;
  maxMatches?: number;
}) {
  const script = join(WORKSPACE_ROOT, 'scripts', 'mcp_helpers', 'epaper_pdf_tools.py');
  const args = [script, 'search', '--keywords', opts.keywords.join(','), '--max-matches', String(opts.maxMatches ?? 25)];
  if (opts.pdf) {
    args.push('--pdf', resolvePdfPath(opts.pdf));
  } else {
    args.push('--dir', EPAPERS_DIR);
  }
  if (opts.ocrRaster) args.push('--ocr-raster');

  const { stdout, stderr, code } = await runUvPython(['pymupdf'], args, 120_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 && !parsed) {
    throw new Error(`epaper_search_pdf failed: ${stderr.trim() || stdout.trim()}`);
  }
  return parsed;
}

export async function extractEpaperPageText(opts: {
  pdf: string;
  pages?: string;
  ocrFallback?: boolean;
  dpi?: number;
  maxChars?: number;
}) {
  const script = join(WORKSPACE_ROOT, 'scripts', 'mcp_helpers', 'epaper_pdf_tools.py');
  const args = [
    script,
    'extract-text',
    '--pdf',
    resolvePdfPath(opts.pdf),
    '--pages',
    opts.pages || '1',
    '--dpi',
    String(opts.dpi ?? 180),
    '--max-chars',
    String(opts.maxChars ?? 8000),
  ];
  if (opts.ocrFallback ?? true) args.push('--ocr-fallback');

  const { stdout, stderr, code } = await runUvPython(['pymupdf'], args, 90_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 && !parsed) {
    throw new Error(`epaper_extract_page_text failed: ${stderr.trim() || stdout.trim()}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 7. 47 Indian Digital News Outlets Catalog
// ---------------------------------------------------------------------------
export function listDigitalOutlets(opts: { category?: string; language?: string; search?: string } = {}) {
  const pubPath = join(WORKSPACE_ROOT, 'src', 'digital', 'publications.json');
  if (!existsSync(pubPath)) {
    throw new Error('publications.json not found');
  }
  const raw = JSON.parse(readFileSync(pubPath, 'utf-8'));
  let list: any[] = Array.isArray(raw) ? raw : raw.publications || raw.outlets || [];

  if (opts.category) {
    const c = opts.category.toLowerCase();
    list = list.filter((o) => String(o.category || '').toLowerCase().includes(c));
  }
  if (opts.language) {
    const l = opts.language.toLowerCase();
    list = list.filter((o) => String(o.language || '').toLowerCase().includes(l));
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    list = list.filter((o) => JSON.stringify(o).toLowerCase().includes(q));
  }

  return {
    total_outlets: list.length,
    outlets: list.map((o) => ({
      slug: o.slug || o.id,
      name: o.name,
      category: o.category,
      language: o.language,
      domain: o.domain || o.baseUrl || '',
    })),
  };
}

// ---------------------------------------------------------------------------
// 8. Dedicated Instagram Social Monitor (Authenticated Chrome Relay)
// ---------------------------------------------------------------------------
export async function runInstagramMonitor(
  opts: {
    mode: 'status' | 'handle' | 'search';
    handles?: string[];
    query?: string;
    hours?: number;
    limit?: number;
    screenshot?: boolean;
    topic?: string;
  },
  publicBaseUrl: string
) {
  const args = ['run', 'src/social/instagram.ts', opts.mode];

  if (opts.mode === 'handle' && opts.handles && opts.handles.length > 0) {
    args.push(opts.handles.map((h) => h.replace(/^@/, '').trim()).join(','));
  } else if (opts.mode === 'search') {
    if (!opts.query) throw new Error('Provide "query" when mode="search"');
    args.push(opts.query);
  }

  if (opts.mode !== 'status') {
    args.push('--hours', String(opts.hours ?? 48), '--limit', String(opts.limit ?? 6));
    if (opts.screenshot ?? true) args.push('--screenshot');
  }
  args.push('--json');

  const { stdout, stderr, code } = await runSubprocess('bun', args, 150_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 && !parsed) {
    throw new Error(`Instagram monitor failed: ${stderr.trim() || stdout.trim()}`);
  }

  if (opts.mode === 'status') {
    return { ok: true, status: parsed };
  }

  const posts: any[] = Array.isArray(parsed) ? parsed : [];
  let dbSync = null;
  if (opts.topic && posts.length > 0) {
    const topicSlug = sanitizeTopic(opts.topic);
    dbSync = upsertTopicItems(
      topicSlug,
      posts.map((p) => ({
        headline: (p.caption || `Instagram post by @${p.author}`).split('\n')[0].slice(0, 140),
        url: p.url,
        source: `Instagram (@${p.author})`,
        domain: 'instagram.com',
        category: 'Social Media',
        media_type: p.type === 'reel' ? 'instagram_reel' : 'instagram_post',
        snippet: (p.caption || '').slice(0, 300),
        content_published_at: p.published_at || null,
        content_date: (p.published_at || '').slice(0, 10) || null,
        relative_time: p.hours_ago !== undefined ? `${p.hours_ago}h ago` : null,
        timestamp_confidence: p.published_at ? 100 : 0,
        time_source: p.published_at ? 'meta_tag' : null,
        screenshot_status: p.clip_path && existsSync(p.clip_path) ? 'VERIFIED_CLEAN' : 'PENDING',
        clip_path: p.clip_path ? relative(WORKSPACE_ROOT, p.clip_path) : null,
        quality_score: p.clip_path && existsSync(p.clip_path) ? 92 : 0,
      }))
    );
  }

  return {
    ok: true,
    mode: opts.mode,
    total_posts: posts.length,
    db_sync: dbSync,
    posts: posts.map((p) => ({
      ...p,
      screenshot_url: toPublicAssetUrl(p.clip_path, publicBaseUrl),
    })),
  };
}

// ---------------------------------------------------------------------------
// 9. Fast Lightweight URL Metadata, True Timestamp & Clean Text Extractor
// ---------------------------------------------------------------------------
export async function fetchUrlMetadata(opts: { url: string; maxTextChars?: number }) {
  const maxChars = opts.maxTextChars ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(opts.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const html = await resp.text();
    const finalUrl = resp.url;

    const getMeta = (attr: string, val: string): string | null => {
      const re1 = new RegExp(`<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"']+)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${val}["']`, 'i');
      return html.match(re1)?.[1]?.trim() || html.match(re2)?.[1]?.trim() || null;
    };

    const title =
      getMeta('property', 'og:title') ||
      getMeta('name', 'twitter:title') ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
      null;
    const description =
      getMeta('property', 'og:description') ||
      getMeta('name', 'description') ||
      getMeta('name', 'twitter:description') ||
      null;
    const siteName = getMeta('property', 'og:site_name') || null;
    const ogImage = getMeta('property', 'og:image') || null;
    const canonical =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]?.trim() || finalUrl;

    // 1. Extract JSON-LD datePublished / author / headline
    let jsonLdDate: string | null = null;
    let jsonLdAuthor: string | null = null;
    let jsonLdHeadline: string | null = null;
    const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
        for (const node of nodes) {
          if (!jsonLdDate && typeof node?.datePublished === 'string') jsonLdDate = node.datePublished;
          if (!jsonLdHeadline && typeof node?.headline === 'string') jsonLdHeadline = node.headline;
          if (!jsonLdAuthor && node?.author) {
            jsonLdAuthor =
              typeof node.author === 'string'
                ? node.author
                : Array.isArray(node.author)
                  ? node.author[0]?.name || null
                  : node.author.name || null;
          }
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }

    const metaDate =
      getMeta('property', 'article:published_time') ||
      getMeta('property', 'og:article:published_time') ||
      getMeta('name', 'publish-date') ||
      getMeta('name', 'pubdate') ||
      getMeta('name', 'date') ||
      html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]?.trim() ||
      null;

    const rawPublished = jsonLdDate || metaDate;
    let contentPublishedIst: string | null = null;
    let contentDate: string | null = null;
    if (rawPublished) {
      const dt = new Date(rawPublished);
      if (!Number.isNaN(dt.getTime())) {
        const istStr = dt.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
        contentPublishedIst = `${istStr} IST`;
        contentDate = istStr.slice(0, 10);
      } else {
        contentPublishedIst = rawPublished;
      }
    }

    // Strip scripts/styles and extract clean body text excerpt
    const cleanBody = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);

    return {
      ok: resp.ok,
      http_status: resp.status,
      url: opts.url,
      final_url: finalUrl,
      canonical_url: canonical,
      title: jsonLdHeadline || title,
      site_name: siteName,
      author: jsonLdAuthor,
      description,
      og_image: ogImage,
      content_published_at: contentPublishedIst,
      content_date: contentDate,
      raw_published_timestamp: rawPublished,
      timestamp_source: jsonLdDate ? 'json_ld' : metaDate ? 'meta_tag' : null,
      timestamp_confidence: rawPublished ? 100 : 0,
      text_excerpt: cleanBody,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 10. Visual QC Asset Inspector (Returns Inline Vision Image for ChatGPT)
// ---------------------------------------------------------------------------
export async function inspectAssetImage(opts: { asset: string; maxDim?: number }, publicBaseUrl: string) {
  let targetPath = opts.asset.trim();

  // Accept full public /assets/... URLs as well as workspace-relative paths
  const assetRouteMap: Array<[string, string]> = [
    ['/assets/clips/', CLIPS_DIR],
    ['/assets/rendered/', RENDERED_DIR],
    ['/assets/outputs/', OUTPUTS_DIR],
  ];

  if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
    const parsedUrl = new URL(targetPath);
    let resolved: string | null = null;
    for (const [prefix, root] of assetRouteMap) {
      if (parsedUrl.pathname.startsWith(prefix)) {
        const rel = decodeURIComponent(parsedUrl.pathname.slice(prefix.length));
        resolved = resolve(root, rel);
        break;
      }
    }
    if (!resolved) throw new Error(`Unsupported asset URL path: ${parsedUrl.pathname}`);
    targetPath = resolved;
  } else {
    targetPath = resolve(WORKSPACE_ROOT, targetPath);
  }

  // Strict sandbox check: only allow files inside clips/, data/rendered/, outputs/, or assets/
  const allowedRoots = [resolve(CLIPS_DIR), resolve(RENDERED_DIR), resolve(OUTPUTS_DIR), resolve(WORKSPACE_ROOT, 'assets')];
  const isAllowed = allowedRoots.some((r) => targetPath.startsWith(r + path.sep) || targetPath === r);
  if (!isAllowed) {
    throw new Error('Access denied: Asset must reside inside clips/, data/rendered/, outputs/, or assets/.');
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Asset image not found: ${opts.asset}`);
  }

  const st = statSync(targetPath);
  const base64 = await createCompactBase64Jpeg(targetPath, opts.maxDim ?? 1100);
  if (!base64) {
    throw new Error(`Failed to decode image for inspection: ${targetPath}`);
  }

  return {
    metadata: {
      ok: true,
      file_path: relative(WORKSPACE_ROOT, targetPath),
      public_url: toPublicAssetUrl(targetPath, publicBaseUrl),
      size_kb: Math.round(st.size / 1024),
      inspected_at: new Date().toISOString(),
    },
    base64,
  };
}

// ---------------------------------------------------------------------------
// 11. List All Topics & Live Statistics
// ---------------------------------------------------------------------------
export function listTopicsAndStats() {
  const topics = listTopicDbs();
  const details = topics.map((slug) => {
    const db = getTopicDb(slug);
    const totalItems = (db.query(`SELECT COUNT(*) as c FROM items WHERE flagged_irrelevant = 0`).get() as any)?.c ?? 0;
    const verified = (db.query(`SELECT COUNT(*) as c FROM items WHERE flagged_irrelevant = 0 AND screenshot_status = 'VERIFIED_CLEAN'`).get() as any)?.c ?? 0;
    const pending = (db.query(`SELECT COUNT(*) as c FROM items WHERE flagged_irrelevant = 0 AND screenshot_status = 'PENDING'`).get() as any)?.c ?? 0;
    const failed = (db.query(`SELECT COUNT(*) as c FROM items WHERE flagged_irrelevant = 0 AND screenshot_status = 'FAILED'`).get() as any)?.c ?? 0;
    const clippings = (db.query(`SELECT COUNT(*) as c FROM clippings`).get() as any)?.c ?? 0;
    const sentiments = db.query(`SELECT sentiment, COUNT(*) as count FROM items WHERE flagged_irrelevant = 0 GROUP BY sentiment`).all();
    const categories = db.query(`SELECT category, COUNT(*) as count FROM items WHERE flagged_irrelevant = 0 GROUP BY category`).all();
    const latest = (db.query(`SELECT MAX(COALESCE(content_published_at, harvested_at)) as ts FROM items WHERE flagged_irrelevant = 0`).get() as any)?.ts ?? null;

    return {
      topic: slug,
      db_path: relative(WORKSPACE_ROOT, getTopicDbPath(slug)),
      total_items: totalItems,
      verified_screenshots: verified,
      pending_screenshots: pending,
      failed_screenshots: failed,
      print_clippings: clippings,
      sentiments,
      categories,
      latest_activity: latest,
    };
  });

  return {
    total_topics: details.length,
    topics: details,
  };
}

// ---------------------------------------------------------------------------
// 12. Branded Dossier & Ground-Truth Export Factory (DOCX / HTML / CSV / JSON)
// ---------------------------------------------------------------------------
export async function exportTopicDossier(
  opts: {
    topic: string;
    format: 'docx' | 'html' | 'csv' | 'json';
    title?: string;
    clientName?: string;
    executiveSummary?: string;
    includeInlineContent?: boolean;
  },
  publicBaseUrl: string
) {
  const topicSlug = sanitizeTopic(opts.topic);
  const dbPath = getTopicDbPath(topicSlug);
  if (!existsSync(dbPath)) {
    throw new Error(`Topic DB "${topicSlug}" does not exist yet. Harvest or clip content into this topic first.`);
  }

  const dossiersDir = join(OUTPUTS_DIR, 'dossiers');
  mkdirSync(dossiersDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = join(dossiersDir, `${topicSlug}_${stamp}.${opts.format}`);

  const script = join(WORKSPACE_ROOT, 'scripts', 'mcp_helpers', 'export_topic_dossier.py');
  const args = [
    script,
    '--db',
    dbPath,
    '--format',
    opts.format,
    '--out',
    outFile,
    '--workspace',
    WORKSPACE_ROOT,
    '--public-base',
    publicBaseUrl,
    '--title',
    opts.title || `${topicSlug.replace(/_/g, ' ').toUpperCase()} — Media Intelligence Dossier`,
    '--client',
    opts.clientName || 'Ampio Labs Client',
    '--summary',
    opts.executiveSummary || '',
  ];

  const pkgs = opts.format === 'docx' ? ['python-docx', 'pillow'] : [];
  const { stdout, stderr, code } = await runUvPython(pkgs, args, 120_000);
  const parsed = extractLastJson(stdout) || extractLastJson(stderr);
  if (code !== 0 || !parsed?.ok) {
    throw new Error(`Export failed (${opts.format}): ${stderr.trim() || stdout.trim()}`);
  }

  const downloadUrl = toPublicAssetUrl(outFile, publicBaseUrl);
  let inlineContent: string | undefined;
  if (opts.includeInlineContent && (opts.format === 'csv' || opts.format === 'json') && existsSync(outFile)) {
    const txt = readFileSync(outFile, 'utf-8');
    inlineContent = txt.length > 45_000 ? `${txt.slice(0, 45_000)}\n... [truncated; use download_url for full file]` : txt;
  }

  return {
    ok: true,
    topic: topicSlug,
    format: opts.format,
    download_url: downloadUrl,
    file_path: relative(WORKSPACE_ROOT, outFile),
    size_kb: parsed.size_kb,
    rows: parsed.rows,
    clippings_count: parsed.clippings_count,
    images_embedded: parsed.images_embedded ?? undefined,
    inline_content: inlineContent,
  };
}
