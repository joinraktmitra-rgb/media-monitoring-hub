import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  WORKSPACE_ROOT,
  createJob,
  getJob,
  listRecentJobs,
  listTopicDbs,
  sanitizeTopic,
  updateJob,
  updateTopicItem,
  verifyApiKey,
} from './db.ts';
import {
  CLIPS_DIR,
  DOCS_DIR,
  EPAPERS_DIR,
  OUTPUTS_DIR,
  RENDERED_DIR,
  clipEpaperArticles,
  downloadEpapers,
  exportTopicDossier,
  extractEpaperPageText,
  fetchUrlMetadata,
  inspectAssetImage,
  listDigitalOutlets,
  listEpaperIssues,
  listEpaperSources,
  listTopicsAndStats,
  queryTopicMedia,
  renderEpaperPagesForVision,
  runCaptureEvidence,
  runDigitalSearch,
  runGoogleHarvest,
  runInstagramMonitor,
  searchEpaperPdf,
} from './engines.ts';
import { AMPIO_MCP_SERVER_INSTRUCTIONS, WORKFLOW_PLAYBOOKS } from './skills.ts';

const PORT = Number(process.env.MCP_PORT || 8787);
const ENFORCE_AUTH = process.env.MCP_ENFORCE_AUTH === '1';
const STATIC_API_KEY = process.env.MCP_API_KEY || '';

let latestPublicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

function getPublicBaseUrl(req?: express.Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() || req.headers.host;
    if (host) latestPublicBaseUrl = `${proto}://${host}`;
  }
  return latestPublicBaseUrl;
}

function launchAsyncJob<T>(
  topic: string,
  toolName: string,
  initialProgress: string,
  worker: (setProgress: (msg: string) => void) => Promise<T>
) {
  const job = createJob(topic, toolName, initialProgress);

  (async () => {
    try {
      updateJob(job.id, { status: 'running', progress: initialProgress });
      const result = await worker((msg) => updateJob(job.id, { status: 'running', progress: msg }));
      updateJob(job.id, { status: 'completed', progress: 'Completed', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[JOB ${job.id}] Failed:`, msg);
      updateJob(job.id, { status: 'failed', progress: 'Failed', error: msg });
    }
  })();

  return {
    mode: 'async',
    job_id: job.id,
    topic: job.topic,
    tool: toolName,
    status: 'running',
    progress: initialProgress,
    next_step: `Call check_job_status with job_id="${job.id}" after 10-20 seconds to retrieve progress and results.`,
  };
}

function jsonText(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// 1. Per-Session McpServer Factory — 23 Granular Tools + Embedded Instructions,
//    Resources & Prompts
// ---------------------------------------------------------------------------
function createMcpServer(getBaseUrl: () => string): McpServer {
  const server = new McpServer(
    {
      name: 'ampio-media-intelligence',
      version: '3.0.0',
    },
    {
      instructions: AMPIO_MCP_SERVER_INSTRUCTIONS,
    }
  );

  // =========================================================================
  // RESOURCES & PROMPTS (Skills Exposed Over Native MCP Protocol)
  // =========================================================================
  for (const [id, pb] of Object.entries(WORKFLOW_PLAYBOOKS)) {
    server.registerResource(
      `skill-${id}`,
      `ampio://skills/${id}`,
      {
        title: pb.title,
        description: pb.summary,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: pb.content }],
      })
    );
  }

  server.registerPrompt(
    'morning_media_briefing',
    {
      title: 'Run 5-Pillar Morning Media Briefing',
      description: 'Guided prompt to harvest Print, Digital, and Social coverage for a topic, verify screenshots & true timestamps, curate sentiment, and export a branded DOCX dossier.',
      argsSchema: {
        topic: z.string().describe('Topic name or campaign (e.g. Kashi Tamil Sangamam)'),
        window: z.string().optional().describe('Time window (default: 24h)'),
      },
    },
    ({ topic, window }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `First call get_workflow_playbook(playbook="morning_briefing"). Then execute a complete ${window || '24h'} media monitoring briefing for "${topic}" across Print ePapers, 47 Digital Newsrooms, and Universal Google Search. Verify screenshots and Source-of-Truth content_published_at, curate sentiment, and export both a branded DOCX dossier and interactive HTML dashboard.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'clip_newspaper_edition',
    {
      title: 'Find & Clip Articles from an Indian ePaper',
      description: 'Guided prompt to download/search an ePaper PDF, inspect the Vision coordinate grid, and extract gutter-snapped clippings with OCR.',
      argsSchema: {
        paper: z.string().describe('Newspaper name or slug (e.g. dainik-jagran, vir-arjun, the-hindu)'),
        keywords: z.string().describe('Comma-separated multilingual keywords to search'),
        topic: z.string().describe('Topic DB slug to save clippings into'),
      },
    },
    ({ paper, keywords, topic }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `First call get_workflow_playbook(playbook="epaper_clipping"). Then locate or download "${paper}", run epaper_search_pdf for keywords "${keywords}", render ONLY the matched pages with the 0.0-1.0 Vision grid, inspect visually to define tight bounding boxes + white-out exclude zones, clip via epaper_clip_articles into topic "${topic}", and verify quality via inspect_asset_image.`,
          },
        },
      ],
    })
  );

  // =========================================================================
  // GROUP A: Skills, System Health & Async Job Orchestration (5 Tools)
  // =========================================================================

  server.registerTool(
    'ping',
    {
      title: 'Ping Ampio Server',
      description: 'Verify live MCP connection, public base URL, and local machine IST time.',
      inputSchema: {
        message: z.string().optional().describe('Optional echo message'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) =>
      jsonText({
        ok: true,
        echo: message || 'Connection Verified',
        server: 'ampio-media-intelligence v3.0.0',
        public_base_url: getBaseUrl(),
        skill_doc_url: `${getBaseUrl()}/assets/docs/CHATGPT_SKILL.md`,
        machine_time_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        machine_time_iso: new Date().toISOString(),
      })
  );

  server.registerTool(
    'get_workflow_playbook',
    {
      title: 'Get Agent Skill & Workflow Playbook',
      description:
        'Fetch detailed step-by-step SOPs, clipping protocols, timestamp rules, and Python/Code Interpreter recipes you can execute on your own computer using data fetched from Ampio MCP. Call this whenever you need exact operating instructions.',
      inputSchema: {
        playbook: z
          .enum([
            'overview',
            'epaper_clipping',
            'morning_briefing',
            'visual_qc_and_timestamps',
            'chatgpt_computer_recipes',
            'all',
          ])
          .optional()
          .describe('Specific playbook to retrieve (default: "overview")'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ playbook = 'overview' }) => {
      if (playbook === 'all') {
        const combined = Object.entries(WORKFLOW_PLAYBOOKS)
          .map(([k, v]) => `<!-- PLAYBOOK: ${k} -->\n${v.content}`)
          .join('\n\n---\n\n');
        return { content: [{ type: 'text' as const, text: combined }] };
      }
      const entry = WORKFLOW_PLAYBOOKS[playbook] || WORKFLOW_PLAYBOOKS.overview;
      return {
        content: [
          {
            type: 'text' as const,
            text: `${entry.content}\n\n---\nAvailable playbooks: ${Object.keys(WORKFLOW_PLAYBOOKS).join(', ')}, all\nDownloadable ChatGPT Skill Doc: ${getBaseUrl()}/assets/docs/CHATGPT_SKILL.md`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_system_status',
    {
      title: 'Get System Status',
      description:
        'List downloaded ePaper PDFs, isolated topic SQLite databases, recent background jobs, and active media monitoring engines.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const epapers = existsSync(EPAPERS_DIR)
        ? readdirSync(EPAPERS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'))
        : [];
      return jsonText({
        status: 'ready',
        version: '3.0.0',
        tools_count: 23,
        public_base_url: getBaseUrl(),
        skill_doc_url: `${getBaseUrl()}/assets/docs/CHATGPT_SKILL.md`,
        workspace: WORKSPACE_ROOT,
        downloaded_epapers_count: epapers.length,
        downloaded_epapers: epapers.slice(0, 25),
        topic_databases: listTopicDbs(),
        recent_jobs: listRecentJobs(10).map((j) => ({
          id: j.id,
          topic: j.topic,
          tool: j.tool_name,
          status: j.status,
          progress: j.progress,
          updated_at: j.updated_at,
        })),
      });
    }
  );

  server.registerTool(
    'list_topics_and_stats',
    {
      title: 'List All Topic Databases & Coverage KPIs',
      description:
        'Lists all isolated topic SQLite databases (data/topics/*.db) with live item counts, print clipping counts, verified vs pending screenshot counts, sentiment splits, and category breakdowns.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => jsonText(listTopicsAndStats())
  );

  server.registerTool(
    'check_job_status',
    {
      title: 'Check Background Job Status',
      description:
        'Poll status, progress, and final structured output of an asynchronous job (returned by heavy batch downloads, harvests, captures, or full topic cycles).',
      inputSchema: {
        job_id: z.string().describe('The job_id returned by an async tool call (e.g. job_abc123...)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      const job = getJob(job_id);
      if (!job) return jsonText({ ok: false, error: `Job not found: ${job_id}` });
      return jsonText({
        ok: true,
        job_id: job.id,
        topic: job.topic,
        tool: job.tool_name,
        status: job.status,
        progress: job.progress,
        error: job.error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        result: job.result_json ? JSON.parse(job.result_json) : null,
      });
    }
  );

  // =========================================================================
  // GROUP B: Print ePaper Intelligence Suite (7 Granular Tools)
  // =========================================================================

  server.registerTool(
    'epaper_list_sources',
    {
      title: 'Browse Full Indian ePaper Catalog & City Editions',
      description:
        'Browse or search the complete structured catalog of 122+ Indian newspapers (Hindi, English, Financial, Regional), presets, city editions for multi-city dailies (Dainik Jagran: 42 cities; Amar Ujala: 141 cities), and all already-downloaded PDFs with direct clickable download URLs.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Search by paper name, slug, state, or city (e.g. "hindu", "jagran", "varanasi", "tamil", "patrika")'),
        category: z
          .enum(['all', 'hindi', 'english', 'financial', 'official', 'readwhere', 'dailyepaper', 'indiags'])
          .optional()
          .describe('Filter catalog by language/category or provider (default: "all")'),
        cities_for: z
          .enum(['dainik-jagran', 'amar-ujala'])
          .optional()
          .describe('Return complete city/edition directory for Dainik Jagran (42 cities) or Amar Ujala (141 cities)'),
        include_downloaded: z
          .boolean()
          .optional()
          .describe('Include already-downloaded PDFs on disk with direct download URLs (default: true)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ search, category, cities_for, include_downloaded }) =>
      jsonText(
        await listEpaperSources(
          { search, category, citiesFor: cities_for, includeDownloaded: include_downloaded },
          getBaseUrl()
        )
      )
  );

  server.registerTool(
    'epaper_list_issues',
    {
      title: 'List Available Dated Issues for an ePaper',
      description:
        'Check available archive dates and issue links for a specific newspaper slug (e.g. "the-hindu", "indian-express", "economic-times") before downloading a back-issue.',
      inputSchema: {
        paper: z.string().describe('Newspaper slug (e.g. "the-hindu", "economic-times", "hindustan-times")'),
        limit: z.number().int().min(1).max(30).optional().describe('Max recent dates to return (default: 10)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ paper, limit }) => jsonText(await listEpaperIssues({ paper, limit }))
  );

  server.registerTool(
    'epaper_download',
    {
      title: 'Download Any Indian ePaper PDF',
      description:
        'Download ANY Indian ePaper from the 122+ catalog (or multi-city editions like dainik-jagran / amar-ujala with city parameter, or presets hindi/english/financial). Returns structured metadata AND a direct clickable public HTTPS download_url for the PDF. Single paper runs synchronously; 2+ papers or presets run async returning job_id.',
      inputSchema: {
        papers: z
          .array(z.string())
          .optional()
          .describe('One or more newspaper slugs from epaper_list_sources (e.g. ["the-hindu"], ["dainik-jagran"])'),
        preset: z.enum(['hindi', 'english', 'financial', 'all']).optional().describe('Optional batch preset'),
        date: z.string().optional().describe('Optional issue date in YYYY-MM-DD format (defaults to latest edition)'),
        city: z
          .string()
          .optional()
          .describe('City/edition slug for multi-city papers like dainik-jagran ("varanasi", "lucknow") or amar-ujala ("varanasi-city")'),
        source: z
          .enum(['auto', 'dailyepaper', 'indiags', 'official', 'readwhere'])
          .optional()
          .describe('Optional provider override (default: auto)'),
        async: z.boolean().optional().describe('Force async background execution returning job_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ papers, preset, date, city, source, async: forceAsync }) => {
      const baseUrl = getBaseUrl();
      const isBatch = Boolean(forceAsync || preset || (papers && papers.length > 1));
      if (isBatch) {
        const label = preset ? `preset:${preset}` : (papers || []).join(',');
        return jsonText(
          launchAsyncJob('epapers', 'epaper_download', `Downloading ePapers (${label})...`, async () =>
            downloadEpapers({ papers, preset, date, city, source }, baseUrl)
          )
        );
      }
      return jsonText(await downloadEpapers({ papers, preset, date, city, source }, baseUrl));
    }
  );

  server.registerTool(
    'epaper_search_pdf',
    {
      title: 'Search Keywords Across Full ePaper PDFs (Fast Multilingual Scanner)',
      description:
        'Scans EVERY page of 1 or ALL downloaded ePaper PDFs in <2 seconds for Hindi, English, or Tamil keywords (normalizing soft hyphens & zero-width breaks). Returns exact matching page numbers, normalized 0.0-1.0 bounding boxes, and snippets. ALWAYS call this BEFORE epaper_render_page so you only render matched pages!',
      inputSchema: {
        keywords: z
          .array(z.string())
          .min(1)
          .describe('List of keywords to search across pages, e.g. ["Kashi Tamil", "काशी तमिल", "KTS 5.0"]'),
        pdf: z
          .string()
          .optional()
          .describe('Specific PDF filename or fuzzy name to scan. If omitted, scans ALL downloaded PDFs in ~/Downloads/epapers.'),
        ocr_raster: z
          .boolean()
          .optional()
          .describe('Run Tesseract OCR on scanned image-only pages with no vector text (slower; recommended only when pdf is specified; default: false)'),
        max_matches: z.number().int().min(1).max(100).optional().describe('Max matches per PDF (default: 25)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ keywords, pdf, ocr_raster = false, max_matches = 25 }) =>
      jsonText(await searchEpaperPdf({ keywords, pdf, ocrRaster: ocr_raster, maxMatches: max_matches }))
  );

  server.registerTool(
    'epaper_extract_page_text',
    {
      title: 'Extract Structured Text & Headlines from ePaper Page(s)',
      description:
        'Extracts full text, headlines with font sizes, and normalized 0.0-1.0 text block boxes from specified page(s) of a PDF, with automatic Hindi+English Tesseract OCR fallback for scanned/raster pages.',
      inputSchema: {
        pdf: z.string().describe('PDF filename or fuzzy name (e.g. "vir-arjun-2026-11-19.pdf" or "dainik_jagran")'),
        pages: z.string().optional().describe('Page spec like "1", "1-3", or "2,5" (default: "1")'),
        ocr_fallback: z.boolean().optional().describe('Fallback to Tesseract OCR if page has no vector text (default: true)'),
        max_chars: z.number().int().min(500).max(20000).optional().describe('Max characters of full_text per page (default: 8000)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pdf, pages = '1', ocr_fallback = true, max_chars = 8000 }) =>
      jsonText(await extractEpaperPageText({ pdf, pages, ocrFallback: ocr_fallback, maxChars: max_chars }))
  );

  server.registerTool(
    'epaper_render_page',
    {
      title: 'Render ePaper Page with 0.0-1.0 Vision Coordinate Grid',
      description:
        'Renders specific page(s) of a downloaded ePaper PDF into clean PNG + normalized 0.0-1.0 coordinate ruler grid PNG (_grid.png) + native vector headline boxes. Returns public HTTPS URLs AND an inline vision image so you can visually determine exact [left, top, right, bottom] and exclude boxes for epaper_clip_articles.',
      inputSchema: {
        pdf: z.string().describe('PDF filename or fuzzy name in ~/Downloads/epapers (e.g. "vir-arjun")'),
        pages: z.string().optional().describe('Page spec, e.g. "1", "1-3", or "1,4" (default: "1")'),
        dpi: z.number().int().min(72).max(250).optional().describe('Render DPI (default: 150)'),
        grid: z.boolean().optional().describe('Overlay 0.0-1.0 coordinate ruler grid for Vision AI (default: true)'),
        hints: z.boolean().optional().describe('Extract native vector PDF headline bounding boxes (default: true)'),
        include_inline_image: z
          .boolean()
          .optional()
          .describe('Return compact JPEG of first rendered page inline for direct Vision inspection (default: true)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pdf, pages = '1', dpi = 150, grid = true, hints = true, include_inline_image = true }) => {
      const res = await renderEpaperPagesForVision(
        { pdf, pages, dpi, grid, hints, includeInlineImage: include_inline_image },
        getBaseUrl()
      );
      const { inlinePreviewBase64, ...metadata } = res;
      const content: Array<any> = [{ type: 'text', text: JSON.stringify(metadata, null, 2) }];
      if (inlinePreviewBase64) {
        content.push({ type: 'image', data: inlinePreviewBase64, mimeType: 'image/jpeg' });
      }
      return { content };
    }
  );

  server.registerTool(
    'epaper_clip_articles',
    {
      title: 'Clip ePaper Articles with Gutter-Snapping, White-Out Masking & OCR',
      description:
        'Extracts publication-grade newspaper clippings from an ePaper page using normalized 0.0-1.0 coordinates [left, top, right, bottom], automatic DPI-proportional column gutter-snapping, white-out exclude boxes (for L-shaped overlaps/ads), and Hindi+English Tesseract OCR. Saves clippings into the topic SQLite DB and returns public HTTPS image URLs.',
      inputSchema: {
        pdf: z.string().describe('PDF filename or fuzzy name (e.g. "vir-arjun-2026-11-19.pdf")'),
        page: z.number().int().min(1).describe('1-based page number'),
        topic: z.string().describe('Topic database slug to store clippings (e.g. "kashi_tamil_sangamam")'),
        dpi: z.number().int().min(150).max(300).optional().describe('High-res clipping DPI (default: 200)'),
        run_ocr: z.boolean().optional().describe('Run Hindi+English OCR on each clipped image (default: true)'),
        articles: z
          .array(
            z.object({
              slug: z.string().describe('Short safe filename identifier, e.g. "kts_lead_story"'),
              headline: z.string().optional().describe('Optional headline label'),
              box: z
                .array(z.number().min(0).max(1))
                .min(4)
                .max(4)
                .describe('Normalized 4-number array [left, top, right, bottom] from 0.0 to 1.0'),
              exclude: z
                .array(z.array(z.number().min(0).max(1)).min(4).max(4))
                .optional()
                .describe('Optional white-out mask boxes [[left, top, right, bottom], ...] to erase adjacent ads/intrusions'),
              snap: z.boolean().optional().describe('Enable automatic column gutter-snapping (default: true)'),
            })
          )
          .min(1)
          .describe('One or more articles to clip from this page'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ pdf, page, topic, dpi = 200, run_ocr = true, articles }) =>
      jsonText(
        await clipEpaperArticles(
          {
            pdf,
            page,
            topic,
            dpi,
            articles: articles.map((a) => ({
              ...a,
              box: a.box as [number, number, number, number],
              exclude: a.exclude as Array<[number, number, number, number]> | undefined,
            })),
            runOcr: run_ocr,
          },
          getBaseUrl()
        )
      )
  );

  // =========================================================================
  // GROUP C: Universal Google, 47 Digital Outlets & Social Harvesters (4 Tools)
  // =========================================================================

  server.registerTool(
    'google_universal_harvest',
    {
      title: 'Universal Google All-Search Harvester (5 Pillars)',
      description:
        'Harvests Google All-Search results across all 5 media pillars (Diplomatic/Gov, Social Media [Facebook/X/YouTube/IG], Civic/Rail, Academic/Culture, Digital News) with full time-range controls (1h/24h/48h/7d/30d/any or custom dates) and optional site filter. Persists items into isolated data/topics/<topic>.db + JSON/CSV. 1-2 pages run sync; 3+ pages run async returning job_id.',
      inputSchema: {
        query: z.string().describe('Search query (e.g. "Kashi Tamil Sangamam" or "काशी तमिल संगमम")'),
        topic: z.string().describe('Isolated topic DB name (e.g. "kashi_tamil_sangamam")'),
        time_window: z
          .enum(['1h', '24h', '48h', '7d', '30d', 'any'])
          .optional()
          .describe('Google time filter (default: "24h")'),
        date_from: z.string().optional().describe('Optional custom start date MM/DD/YYYY (overrides time_window)'),
        date_to: z.string().optional().describe('Optional custom end date MM/DD/YYYY'),
        site: z.string().optional().describe('Optional site filter (e.g. "facebook.com", "x.com", "youtube.com")'),
        max_pages: z.number().int().min(1).max(10).optional().describe('Google SERP pages to crawl (default: 2)'),
        async: z.boolean().optional().describe('Force async background execution returning job_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ query, topic, time_window = '24h', date_from, date_to, site, max_pages = 2, async: forceAsync }) => {
      if (forceAsync || max_pages > 2) {
        return jsonText(
          launchAsyncJob(
            topic,
            'google_universal_harvest',
            `Harvesting Google "${query}" (${time_window}, ${max_pages} pages)...`,
            async () =>
              runGoogleHarvest({
                query,
                topic,
                timeWindow: time_window,
                dateFrom: date_from,
                dateTo: date_to,
                site,
                maxPages: max_pages,
              })
          )
        );
      }
      return jsonText(
        await runGoogleHarvest({
          query,
          topic,
          timeWindow: time_window,
          dateFrom: date_from,
          dateTo: date_to,
          site,
          maxPages: max_pages,
        })
      );
    }
  );

  server.registerTool(
    'digital_list_outlets',
    {
      title: 'List 47 Monitored Indian Digital News Outlets',
      description:
        'Browse all 47 major Indian wire agencies and digital newsrooms supported by digital_news_search, filterable by category (wire, national, hindi, business, regional) or language.',
      inputSchema: {
        category: z.string().optional().describe('Filter by category, e.g. "wire", "national", "hindi", "business"'),
        language: z.string().optional().describe('Filter by language, e.g. "English", "Hindi", "Tamil"'),
        search: z.string().optional().describe('Search outlet name, slug, or domain'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ category, language, search }) => jsonText(listDigitalOutlets({ category, language, search }))
  );

  server.registerTool(
    'digital_news_search',
    {
      title: 'Search 47 Indian Digital News Outlets',
      description:
        'Directly searches 47 major Indian wire agencies & digital newsrooms (PTI, ANI, NDTV, TOI, Indian Express, Dainik Jagran, Aaj Tak, PIB, etc.) within an hour window and optionally ingests matches into a topic DB. Pass ONE language per call.',
      inputSchema: {
        query: z.string().describe('Single-language keyword to search (e.g. "Kashi Tamil" or separately "काशी तमिल")'),
        hours: z.number().int().min(1).max(168).optional().describe('Lookback window in hours (default: 48)'),
        outlets: z.string().optional().describe('Optional comma-separated outlet slugs from digital_list_outlets'),
        topic: z.string().optional().describe('Optional topic DB slug to save matched articles into'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, hours = 48, outlets, topic }) =>
      jsonText(await runDigitalSearch({ query, hours, outlets, topic }))
  );

  server.registerTool(
    'social_instagram_monitor',
    {
      title: 'Monitor Instagram Handles & Hashtags (Authenticated Chrome Relay)',
      description:
        'Monitors Instagram accounts (e.g. eduminofindia, ktsangamam) or searches keywords/hashtags using the authenticated local Chrome session. Extracts exact ISO publication timestamps, captions, captures clean screenshots, and optionally upserts into a topic DB.',
      inputSchema: {
        mode: z
          .enum(['status', 'handle', 'search'])
          .describe('"status" checks Chrome Instagram auth; "handle" fetches recent posts from specific handles; "search" filters monitored handles/tags by keyword'),
        handles: z
          .array(z.string())
          .optional()
          .describe('Instagram handles without @ (used when mode="handle", e.g. ["eduminofindia", "ktsangamam"])'),
        query: z.string().optional().describe('Keyword to match when mode="search"'),
        hours: z.number().int().min(1).max(336).optional().describe('Lookback window in hours (default: 48)'),
        limit: z.number().int().min(1).max(15).optional().describe('Max recent posts to inspect per handle (default: 5)'),
        screenshot: z.boolean().optional().describe('Capture clean post/reel screenshots (default: true)'),
        topic: z.string().optional().describe('Optional topic DB slug to upsert verified posts into'),
        async: z.boolean().optional().describe('Run in background and return job_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ mode, handles, query, hours = 48, limit = 5, screenshot = true, topic, async: forceAsync }) => {
      const baseUrl = getBaseUrl();
      if (forceAsync || (mode !== 'status' && limit > 6)) {
        return jsonText(
          launchAsyncJob(topic || 'instagram', 'social_instagram_monitor', `Running Instagram monitor (${mode})...`, async () =>
            runInstagramMonitor({ mode, handles, query, hours, limit, screenshot, topic }, baseUrl)
          )
        );
      }
      return jsonText(await runInstagramMonitor({ mode, handles, query, hours, limit, screenshot, topic }, baseUrl));
    }
  );

  // =========================================================================
  // GROUP D: Evidence Capture, Fast Metadata & Vision QC (3 Tools)
  // =========================================================================

  server.registerTool(
    'fetch_url_metadata',
    {
      title: 'Fast URL Metadata, True Timestamp & Article Text Reader',
      description:
        'Lightweight (<2s) HTTP fetcher that extracts canonical URL, headline, author, OpenGraph tags, JSON-LD datePublished / article:published_time (Source-of-Truth IST timestamp), and clean body text excerpt WITHOUT launching a browser. Great for rapidly vetting articles before screenshotting.',
      inputSchema: {
        url: z.string().describe('Full https:// URL of the article or page to inspect'),
        max_text_chars: z
          .number()
          .int()
          .min(200)
          .max(12000)
          .optional()
          .describe('Max characters of clean text excerpt to return (default: 3000)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, max_text_chars = 3000 }) => jsonText(await fetchUrlMetadata({ url, maxTextChars: max_text_chars }))
  );

  server.registerTool(
    'capture_verified_evidence',
    {
      title: 'Capture Verified Clean Screenshots & Source-of-Truth Timestamps',
      description:
        'Visits web or social URLs (Facebook, Instagram, YouTube, X, News sites), destroys login popups ("See more on Facebook" modal annihilator), unlocks scrolling, extracts Source-of-Truth content_published_at (NEVER scrape time), runs PIL+Tesseract visual QC, saves clean PNGs to public URLs, and updates the isolated topic DB. 1-2 URLs run sync; 3+ URLs or batch mode run async returning job_id.',
      inputSchema: {
        topic: z.string().describe('Topic DB slug to save verified screenshots & timestamps (e.g. "kashi_tamil_sangamam")'),
        urls: z
          .array(z.string())
          .max(30)
          .optional()
          .describe('Explicit list of full https:// URLs to capture. If omitted, captures pending items from the topic DB.'),
        facebook_only: z
          .boolean()
          .optional()
          .describe('When capturing from topic DB (urls omitted), only process Facebook URLs'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Max pending items from topic DB when urls omitted (default: 5)'),
        async: z.boolean().optional().describe('Force async background execution returning job_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ topic, urls, facebook_only = false, limit = 5, async: forceAsync }) => {
      const baseUrl = getBaseUrl();
      const urlCount = urls ? urls.length : limit;
      if (forceAsync || urlCount > 2) {
        return jsonText(
          launchAsyncJob(
            topic,
            'capture_verified_evidence',
            `Capturing verified screenshots & true timestamps (${urls ? `${urls.length} URLs` : `up to ${limit} pending items`})...`,
            async () => runCaptureEvidence({ topic, urls, facebookOnly: facebook_only, limit }, baseUrl)
          )
        );
      }
      return jsonText(await runCaptureEvidence({ topic, urls, facebookOnly: facebook_only, limit }, baseUrl));
    }
  );

  server.registerTool(
    'inspect_asset_image',
    {
      title: 'Visually Inspect Screenshot or Newspaper Clipping (Vision QC)',
      description:
        'Loads ANY captured evidence screenshot or newspaper clipping (by file_path or public /assets/... URL) and returns it as an inline Vision JPEG so YOU can visually audit for login popups, 404 pages, cut-off text, or bleeding ads.',
      inputSchema: {
        asset: z
          .string()
          .describe('Workspace relative path (e.g. "clips/evidence/...") or public /assets/... URL'),
        max_dim: z
          .number()
          .int()
          .min(400)
          .max(1600)
          .optional()
          .describe('Max width/height in pixels for compact inline inspection (default: 1100)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ asset, max_dim = 1100 }) => {
      const { metadata, base64 } = await inspectAssetImage({ asset, maxDim: max_dim }, getBaseUrl());
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
          { type: 'image' as const, data: base64, mimeType: 'image/jpeg' },
        ],
      };
    }
  );

  // =========================================================================
  // GROUP E: Topic Curation, Dossier Export Factory & Macro Orchestrator (4 Tools)
  // =========================================================================

  server.registerTool(
    'query_topic_media',
    {
      title: 'Query Topic Media & Clippings Ground Truth',
      description:
        'Retrieves structured, verified media items (with Source-of-Truth content_published_at, public screenshot URLs, snippets, categories, sentiment) AND print newspaper clippings (with public image URLs & OCR text) from an isolated topic DB (or legacy kashi_tamil_sangamam index).',
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe('Topic DB slug (e.g. "kashi_tamil_sangamam"). Falls back to legacy index if DB does not exist yet.'),
        query: z.string().optional().describe('Keyword filter across headlines, snippets, sources, and URLs'),
        category: z.string().optional().describe('Filter by pillar/platform (e.g. "Facebook", "Social Media", "Diplomatic", "News")'),
        screenshot_status: z
          .enum(['VERIFIED_CLEAN', 'PENDING', 'FAILED'])
          .optional()
          .describe('Filter by evidence verification status'),
        include_clippings: z.boolean().optional().describe('Also return print ePaper clippings from this topic (default: true)'),
        limit: z.number().int().min(1).max(100).optional().describe('Max items to return (default: 20)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ topic, query, category, screenshot_status, include_clippings = true, limit = 20 }) =>
      jsonText(
        queryTopicMedia(
          {
            topic,
            query,
            category,
            screenshotStatus: screenshot_status,
            includeClippings: include_clippings,
            limit,
          },
          getBaseUrl()
        )
      )
  );

  server.registerTool(
    'update_media_item',
    {
      title: 'Curate / Annotate Media Item',
      description:
        'Update sentiment (Positive/Neutral/Negative), strategic category, editorial notes, or irrelevant flag on an item in an isolated topic DB.',
      inputSchema: {
        topic: z.string().describe('Topic DB slug'),
        id: z.number().int().optional().describe('Numeric item ID in the topic DB'),
        url: z.string().optional().describe('Item URL (alternative to id)'),
        sentiment: z.enum(['Positive', 'Neutral', 'Negative']).optional().describe('Editorial sentiment'),
        category: z.string().optional().describe('Updated media pillar/category'),
        notes: z.string().optional().describe('Editorial notes or 2-line summary'),
        flagged_irrelevant: z.boolean().optional().describe('Set true to exclude noisy/dead/irrelevant item from queries & exports'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ topic, id, url, sentiment, category, notes, flagged_irrelevant }) => {
      const ok = updateTopicItem(
        sanitizeTopic(topic),
        { id, url },
        { sentiment, category, notes, flagged_irrelevant }
      );
      return jsonText({ ok, topic: sanitizeTopic(topic), updated: ok });
    }
  );

  server.registerTool(
    'export_topic_dossier',
    {
      title: 'Export Branded DOCX Dossier / HTML Dashboard / Source-of-Truth CSV / JSON',
      description:
        'Generates a downloadable client-ready deliverable from an isolated topic DB: "docx" builds a branded Word Executive Dossier WITH embedded HD print clippings & verified screenshots; "html" builds an interactive filterable dashboard; "csv" and "json" produce Source-of-Truth exports (set include_inline_content=true to pull raw CSV/JSON directly into your own Python computer for charts, Excel, or slides!).',
      inputSchema: {
        topic: z.string().describe('Topic DB slug to export (e.g. "kashi_tamil_sangamam")'),
        format: z.enum(['docx', 'html', 'csv', 'json']).describe('Output format'),
        title: z.string().optional().describe('Report title shown on cover/header'),
        client_name: z.string().optional().describe('Client/Ministry name for branding'),
        executive_summary: z
          .string()
          .optional()
          .describe('Your synthesized executive summary to embed at the top of the DOCX or HTML report'),
        include_inline_content: z
          .boolean()
          .optional()
          .describe('For csv/json: return raw file text inline so you can run pandas/matplotlib/openpyxl on your own computer (default: false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ topic, format, title, client_name, executive_summary, include_inline_content = false }) =>
      jsonText(
        await exportTopicDossier(
          {
            topic,
            format,
            title,
            clientName: client_name,
            executiveSummary: executive_summary,
            includeInlineContent: include_inline_content,
          },
          getBaseUrl()
        )
      )
  );

  server.registerTool(
    'run_full_topic_cycle',
    {
      title: 'Macro Orchestrator: Run Full Topic Monitoring Cycle',
      description:
        'All-in-one asynchronous pipeline for a fresh topic or morning briefing: (1) Google Universal Harvest across all 5 pillars, (2) 47-outlet Digital News Search, (3) Verified Evidence Screenshot Capture with Facebook modal killer + Source-of-Truth timestamps, and (4) Optional ePaper download. Returns job_id to poll via check_job_status.',
      inputSchema: {
        topic: z.string().describe('Topic DB slug (e.g. "kashi_tamil_sangamam_nov20")'),
        query: z.string().describe('Primary search query'),
        time_window: z.enum(['1h', '24h', '48h', '7d', '30d', 'any']).optional().describe('Time window (default: "24h")'),
        max_pages: z.number().int().min(1).max(5).optional().describe('Google pages to crawl (default: 2)'),
        include_digital_47: z.boolean().optional().describe('Also search all 47 Indian digital newsrooms (default: true)'),
        capture_evidence_limit: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Number of harvested URLs to screenshot & extract true timestamps for (default: 5)'),
        epapers: z
          .array(z.string())
          .optional()
          .describe('Optional ePapers to download (e.g. ["vir-arjun", "dainik-jagran"])'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({
      topic,
      query,
      time_window = '24h',
      max_pages = 2,
      include_digital_47 = true,
      capture_evidence_limit = 5,
      epapers,
    }) => {
      const baseUrl = getBaseUrl();
      return jsonText(
        launchAsyncJob(
          topic,
          'run_full_topic_cycle',
          `Starting full monitoring cycle for "${query}"...`,
          async (setProgress) => {
            const summary: Record<string, any> = { topic: sanitizeTopic(topic), query };

            setProgress(`Step 1/4: Harvesting Google All-Search (${time_window}, ${max_pages} pages)...`);
            const harvestRes = await runGoogleHarvest({
              query,
              topic,
              timeWindow: time_window,
              maxPages: max_pages,
            });
            summary.google_harvest = {
              total_harvested: harvestRes.total_harvested,
              categories: harvestRes.categories,
              db_sync: harvestRes.db_sync,
            };

            if (include_digital_47) {
              setProgress(`Step 2/4: Searching 47 Indian digital newsrooms for "${query}"...`);
              try {
                const hours = time_window === '1h' ? 2 : time_window === '24h' ? 24 : time_window === '48h' ? 48 : 168;
                const digRes = await runDigitalSearch({ query, hours, topic });
                summary.digital_47 = { total_found: digRes.total_found, db_sync: digRes.db_sync };
              } catch (err) {
                summary.digital_47 = { error: err instanceof Error ? err.message : String(err) };
              }
            }

            if (capture_evidence_limit > 0) {
              setProgress(`Step 3/4: Capturing verified clean screenshots & true timestamps (top ${capture_evidence_limit})...`);
              const evRes = await runCaptureEvidence({ topic, limit: capture_evidence_limit }, baseUrl);
              summary.evidence = {
                total: evRes.total,
                verified: evRes.verified,
                failed: evRes.failed,
                avg_quality_score: evRes.avg_quality_score,
              };
            }

            if (epapers && epapers.length > 0) {
              setProgress(`Step 4/4: Downloading ePapers (${epapers.join(', ')})...`);
              summary.epapers = await downloadEpapers({ papers: epapers }, baseUrl);
            }

            setProgress('Compiling final topic snapshot...');
            summary.snapshot = queryTopicMedia({ topic, limit: 15 }, baseUrl);
            return summary;
          }
        )
      );
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// 2. Express App + CORS + Static Assets + Optional Access Control
// ---------------------------------------------------------------------------
const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'last-event-id',
    ],
    exposedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
  })
);

app.use(express.json({ limit: '8mb' }));

app.use((req, _res, next) => {
  getPublicBaseUrl(req);
  const sid = req.headers['mcp-session-id'] || req.query.sessionId || '-';
  const rpcMethod = (req.body as any)?.method || '-';
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} | method=${rpcMethod} | sid=${sid} | ua=${req.headers['user-agent'] || '-'}`
  );
  next();
});

app.use(['/mcp', '/sse', '/messages'], (req, res, next) => {
  if (!ENFORCE_AUTH && !STATIC_API_KEY) return next();
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = bearer || queryToken;

  if (STATIC_API_KEY && token === STATIC_API_KEY) return next();
  if (ENFORCE_AUTH && verifyApiKey(token).valid) return next();

  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Invalid or missing API key' }, id: null });
});

// Public Static Media Routes
app.use('/assets/clips', express.static(CLIPS_DIR));
app.use('/assets/rendered', express.static(RENDERED_DIR));
app.use('/assets/outputs', express.static(OUTPUTS_DIR));
app.use('/assets/epapers', express.static(EPAPERS_DIR));
app.use('/assets/docs', express.static(DOCS_DIR));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: 'ampio-media-intelligence',
    version: '3.0.0',
    tools_count: 23,
    public_base_url: getPublicBaseUrl(req),
    auth_enforced: ENFORCE_AUTH || Boolean(STATIC_API_KEY),
    active_streamable_sessions: streamableSessions.size,
    active_sse_sessions: sseSessions.size,
    topic_databases: listTopicDbs(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Ampio Media Intelligence MCP Server',
    version: '3.0.0',
    tools_count: 23,
    public_base_url: getPublicBaseUrl(req),
    endpoints: {
      mcp_streamable_http: '/mcp',
      mcp_legacy_sse: '/sse',
      skill_doc: '/assets/docs/CHATGPT_SKILL.md',
      instructions_doc: '/assets/docs/CHATGPT_SYSTEM_INSTRUCTIONS.md',
      assets_clips: '/assets/clips/',
      assets_rendered: '/assets/rendered/',
      assets_epapers: '/assets/epapers/',
      assets_outputs: '/assets/outputs/',
      health: '/health',
    },
  });
});

// ---------------------------------------------------------------------------
// 3. Transport A: Streamable HTTP (/mcp) — Latest MCP Spec (ChatGPT Native)
// ---------------------------------------------------------------------------
const streamableSessions = new Map<
  string,
  { server: McpServer; transport: StreamableHTTPServerTransport }
>();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const baseUrlGetter = () => getPublicBaseUrl(req);

  try {
    if (sessionId && streamableSessions.has(sessionId)) {
      const { transport } = streamableSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = createMcpServer(baseUrlGetter);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          console.log(`[MCP-HTTP] Session initialized: ${sid}`);
          streamableSessions.set(sid, { server, transport });
        },
        onsessionclosed: (sid) => {
          console.log(`[MCP-HTTP] Session closed: ${sid}`);
          streamableSessions.delete(sid);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) streamableSessions.delete(transport.sessionId);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !streamableSessions.has(sessionId)) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Please re-initialize.' },
        id: req.body?.id ?? null,
      });
      return;
    }

    const server = createMcpServer(baseUrlGetter);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP-HTTP] POST /mcp error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: req.body?.id ?? null,
      });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !streamableSessions.has(sessionId)) {
    res.status(405).set('Allow', 'POST, DELETE').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed: POST /mcp to initialize or use /sse for Legacy SSE.' },
      id: null,
    });
    return;
  }
  const { transport } = streamableSessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !streamableSessions.has(sessionId)) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    return;
  }
  const { transport, server } = streamableSessions.get(sessionId)!;
  await transport.handleRequest(req, res);
  streamableSessions.delete(sessionId);
  await server.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// 4. Transport B: Legacy SSE (/sse + /messages) — Per-Connection McpServer
// ---------------------------------------------------------------------------
const sseSessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

app.get('/sse', async (req, res) => {
  res.setHeader('X-Accel-Buffering', 'no');
  const server = createMcpServer(() => getPublicBaseUrl(req));
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, { server, transport });
  console.log(`[MCP-SSE] Session opened: ${transport.sessionId}`);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 20000);

  res.on('close', () => {
    clearInterval(keepAlive);
    sseSessions.delete(transport.sessionId);
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
  } catch (err) {
    clearInterval(keepAlive);
    sseSessions.delete(transport.sessionId);
    console.error('[MCP-SSE] Connect error:', err);
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId || !sseSessions.has(sessionId)) {
    res.status(404).json({ error: 'SSE session not found or expired' });
    return;
  }
  const { transport } = sseSessions.get(sessionId)!;
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error('[MCP-SSE] handlePostMessage error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to handle message' });
  }
});

// ---------------------------------------------------------------------------
// 5. Start Server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ampio Media Intelligence MCP Server v3.0.0 listening on http://0.0.0.0:${PORT}`);
  console.log(`   - Streamable HTTP: http://localhost:${PORT}/mcp  (23 granular tools + skills + prompts + resources)`);
  console.log(`   - Legacy SSE:      http://localhost:${PORT}/sse`);
  console.log(`   - Static Assets:   http://localhost:${PORT}/assets/{clips,rendered,outputs,epapers,docs}/`);
  console.log(`   - Auth Enforced:   ${ENFORCE_AUTH || Boolean(STATIC_API_KEY)}`);
});
