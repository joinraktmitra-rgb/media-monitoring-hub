#!/usr/bin/env bun
/**
 * Ampio Labs — Unified Digital & Broadcast Media Intelligence CLI
 *
 * Covers 47 Indian Wire Agencies, Digital News Portals, Business Portals,
 * TV News Digital Wings, and Public Broadcasters.
 *
 * Commands:
 *   list      List all 47 outlets (with category/language filters and --json)
 *   check     Live health check of all 47 outlets in parallel (healthy vs unreachable summary)
 *   fetch     Fetch latest articles on demand (--outlets <slugs> | --all) with URL and metadata
 *   search    Search on demand by keyword across any/all outlets within --hours <n>
 *   help      Show help and usage examples
 *
 * Flags:
 *   --ingest  Syncs verified search/fetch results into SQLite (default: data/media_dataset.db)
 *   --json    Output pure JSON to stdout
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import rawCatalog from "./publications.json";
import type {
  Category,
  DigitalArticle,
  FetchOptions,
  HealthCheckResult,
  PublicationConfig,
  PublicationsCatalog,
  SearchOptions,
  StrategyName,
} from "./types.ts";
import {
  canonicalizeUrl,
  deduplicateArticles,
  matchKeywords,
  runWithConcurrency,
} from "./utils.ts";

import { enrichArticles } from "./engines/article-extract.ts";
import { fetchGnewsSite } from "./engines/gnews-site.ts";
import { fetchRss } from "./engines/rss.ts";
import { fetchNewsSitemap } from "./engines/sitemap.ts";
import { fetchWpApi } from "./engines/wp-api.ts";
import { fetchYouTubeFeed } from "./engines/youtube-feed.ts";

const catalog = rawCatalog as unknown as PublicationsCatalog;
const PUBLICATIONS: PublicationConfig[] = catalog.publications;

// ANSI Colors (disabled if not a TTY or when JSON output is requested)
const isColorSupported =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  !process.argv.includes("--json");

const colors = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  blue: isColorSupported ? "\x1b[34m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  magenta: isColorSupported ? "\x1b[35m" : "",
  gray: isColorSupported ? "\x1b[90m" : "",
};

// ============================================================================
// CLI ARGUMENT PARSER
// ============================================================================

interface ParsedArgs {
  command: string;
  positional: string[];
  json: boolean;
  outlets?: string[];
  all: boolean;
  category?: Category;
  lang?: string;
  hours?: number;
  limit?: number;
  concurrency: number;
  timeoutMs: number;
  enrich: boolean;
  ingest: boolean;
  dbPath: string;
  outFile?: string;
  keywords?: string[];
  verbose: boolean;
  help: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command = "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  if (args.length > 0 && !args[0].startsWith("-")) {
    command = args[0].toLowerCase();
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k] = v;
      } else if (
        i + 1 < args.length &&
        !args[i + 1].startsWith("-") &&
        ![
          "json",
          "all",
          "enrich",
          "ingest",
          "verbose",
          "help",
        ].includes(key)
      ) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      if (
        i + 1 < args.length &&
        !args[i + 1].startsWith("-") &&
        !["j", "a", "v", "h"].includes(key)
      ) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
    i++;
  }

  // Handle shorthand aliases
  const isJson = Boolean(flags.json || flags.j);
  const isAll = Boolean(flags.all || flags.a);
  const isEnrich = Boolean(flags.enrich);
  const isIngest = Boolean(flags.ingest);
  const isVerbose = Boolean(flags.verbose || flags.v);
  const isHelp = Boolean(flags.help || flags.h || command === "help");

  let outlets: string[] | undefined;
  const rawOutlets = flags.outlets || flags.outlet || flags.o;
  if (typeof rawOutlets === "string") {
    outlets = rawOutlets
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  const category = (flags.category || flags.c) as Category | undefined;
  const lang = (flags.lang || flags.language || flags.l) as string | undefined;

  let hours: number | undefined;
  const rawHours = flags.hours || flags.H;
  if (typeof rawHours === "string" || typeof rawHours === "number") {
    const parsed = Number(rawHours);
    if (!Number.isNaN(parsed) && parsed > 0) hours = parsed;
  }

  let limit: number | undefined;
  const rawLimit = flags.limit;
  if (typeof rawLimit === "string" || typeof rawLimit === "number") {
    const parsed = Number(rawLimit);
    if (!Number.isNaN(parsed) && parsed > 0) limit = parsed;
  }

  let concurrency = 8;
  const rawConcurrency = flags.concurrency;
  if (typeof rawConcurrency === "string" || typeof rawConcurrency === "number") {
    const parsed = Number(rawConcurrency);
    if (!Number.isNaN(parsed) && parsed > 0) concurrency = parsed;
  }

  let timeoutMs = 10000;
  const rawTimeout = flags.timeout;
  if (typeof rawTimeout === "string" || typeof rawTimeout === "number") {
    const parsed = Number(rawTimeout);
    if (!Number.isNaN(parsed) && parsed > 0) timeoutMs = parsed;
  }

  const dbPath = (flags.db || "data/media_dataset.db") as string;
  const outFile = (flags.out || flags["out-file"]) as string | undefined;

  let keywords: string[] | undefined;
  const rawKeyword = flags.keyword || flags.keywords || flags.k || flags.query || flags.q;
  if (typeof rawKeyword === "string") {
    keywords = rawKeyword
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  } else if (positional.length > 0 && command === "search") {
    const joined = positional.join(" ").trim();
    if (joined.includes(",")) {
      keywords = joined
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    } else {
      keywords = [joined];
    }
  }

  return {
    command,
    positional,
    json: isJson,
    outlets,
    all: isAll,
    category,
    lang,
    hours,
    limit,
    concurrency,
    timeoutMs,
    enrich: isEnrich,
    ingest: isIngest,
    dbPath,
    outFile,
    keywords,
    verbose: isVerbose,
    help: isHelp,
  };
}

// ============================================================================
// OUTLET SELECTION & FILTERING
// ============================================================================

function filterPublications(args: ParsedArgs): {
  selected: PublicationConfig[];
  warnings: string[];
} {
  let list = [...PUBLICATIONS];
  const warnings: string[] = [];

  if (args.category) {
    const targetCat = String(args.category).toLowerCase().replace(/_/g, "-");
    list = list.filter((p) => p.category.toLowerCase() === targetCat);
  }

  if (args.lang) {
    const target = args.lang.toLowerCase();
    list = list.filter((p) => p.lang.toLowerCase() === target);
  }

  if (args.outlets && args.outlets.length > 0) {
    const outletSet = new Set(args.outlets.map((o) => o.toLowerCase()));
    const matched = list.filter((p) => outletSet.has(p.slug.toLowerCase()));
    const foundSlugs = new Set(matched.map((p) => p.slug.toLowerCase()));

    for (const requested of args.outlets) {
      if (!foundSlugs.has(requested)) {
        warnings.push(`Outlet slug '${requested}' not found in catalog.`);
      }
    }
    list = matched;
  }

  return { selected: list, warnings };
}

// ============================================================================
// DATABASE INGESTION (bun:sqlite)
// ============================================================================

export interface IngestSummary {
  total: number;
  clippingsInserted: number;
  clippingsUpdated: number;
  digitalUpserted: number;
  dbPath: string;
}

export function ingestArticlesToDatabase(
  articles: DigitalArticle[],
  dbPath = "data/media_dataset.db"
): IngestSummary {
  if (!articles.length) {
    return {
      total: 0,
      clippingsInserted: 0,
      clippingsUpdated: 0,
      digitalUpserted: 0,
      dbPath,
    };
  }

  const absPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const db = new Database(absPath);
  db.run("PRAGMA journal_mode = WAL;");

  // 1. Maintain backward-compatible clippings_metadata for dashboard and docx reports
  db.run(`
    CREATE TABLE IF NOT EXISTS clippings_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT,
      publication TEXT,
      edition TEXT,
      page_number INTEGER,
      date TEXT,
      major_category TEXT,
      sentiment TEXT,
      clip_path TEXT,
      raw_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_clippings_date ON clippings_metadata(date);");
  db.run("CREATE INDEX IF NOT EXISTS idx_clippings_pub ON clippings_metadata(publication);");
  db.run("CREATE INDEX IF NOT EXISTS idx_clippings_cat ON clippings_metadata(major_category);");

  // 2. Dedicated digital_articles table with URL as primary key
  db.run(`
    CREATE TABLE IF NOT EXISTS digital_articles (
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
      matched_keywords TEXT,
      raw_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_digital_pub ON digital_articles(slug);");
  db.run("CREATE INDEX IF NOT EXISTS idx_digital_date ON digital_articles(published_at);");

  let clippingsInserted = 0;
  let clippingsUpdated = 0;
  let digitalUpserted = 0;

  const selectExisting = db.prepare(
    "SELECT id, clip_path FROM clippings_metadata WHERE headline = ? AND publication = ?"
  );
  const updateClipping = db.prepare(
    "UPDATE clippings_metadata SET edition = ?, date = ?, major_category = ?, clip_path = ?, raw_json = ? WHERE id = ?"
  );
  const insertClipping = db.prepare(`
    INSERT INTO clippings_metadata (headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDigital = db.prepare(`
    INSERT INTO digital_articles (
      url, headline, publication, slug, category, language,
      published_at, author, description, image_url, source_engine,
      matched_keywords, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      headline = excluded.headline,
      publication = excluded.publication,
      slug = excluded.slug,
      category = excluded.category,
      language = excluded.language,
      published_at = coalesce(excluded.published_at, digital_articles.published_at),
      author = coalesce(excluded.author, digital_articles.author),
      description = coalesce(excluded.description, digital_articles.description),
      image_url = coalesce(excluded.image_url, digital_articles.image_url),
      source_engine = excluded.source_engine,
      matched_keywords = excluded.matched_keywords,
      raw_json = excluded.raw_json
  `);

  const runTransaction = db.transaction((items: DigitalArticle[]) => {
    for (const art of items) {
      const headline = (art.headline || "").trim();
      const pub = (art.publication || "Digital Media").trim();
      if (!headline) continue;
      const targetUrl = (art.canonical_url || art.url || "").trim();
      if (!targetUrl) continue;

      let dateStr = "";
      if (art.published_at) {
        const d = new Date(art.published_at);
        if (!Number.isNaN(d.getTime())) {
          const day = String(d.getDate()).padStart(2, "0");
          const month = String(d.getMonth() + 1).padStart(2, "0");
          const year = d.getFullYear();
          dateStr = `${day}-${month}-${year}`;
        }
      }
      if (!dateStr) {
        const d = new Date();
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear();
        dateStr = `${day}-${month}-${year}`;
      }

      const edition = "Digital Edition";
      const majorCategory = "Online Coverage";
      const sentiment = "Neutral";
      const clipPath = art.image_url || "";
      const rawJson = JSON.stringify(art);

      // clippings_metadata sync
      const existing = selectExisting.get(headline, pub) as { id: number; clip_path?: string } | undefined;
      if (existing) {
        const finalClipPath = (existing.clip_path && !existing.clip_path.startsWith("http"))
          ? existing.clip_path
          : clipPath;
        updateClipping.run(edition, dateStr, majorCategory, finalClipPath, rawJson, existing.id);
        clippingsUpdated++;
      } else {
        insertClipping.run(
          headline,
          pub,
          edition,
          1,
          dateStr,
          majorCategory,
          sentiment,
          clipPath,
          rawJson
        );
        clippingsInserted++;
      }

      // digital_articles sync
      upsertDigital.run(
        targetUrl,
        headline,
        pub,
        art.slug,
        art.category,
        art.language,
        art.published_at,
        art.author,
        art.description || art.summary || null,
        art.image_url,
        art.source_engine,
        art.matched_keywords?.join(",") || null,
        rawJson
      );
      digitalUpserted++;
    }
  });

  runTransaction(articles);
  db.close();

  return {
    total: articles.length,
    clippingsInserted,
    clippingsUpdated,
    digitalUpserted,
    dbPath: absPath,
  };
}

// ============================================================================
// ENGINE PROBE & FETCH LOGIC
// ============================================================================

async function probePublication(
  pub: PublicationConfig,
  timeoutMs = 9000
): Promise<HealthCheckResult> {
  const start = Date.now();
  let lastError: string | null = null;

  for (const strategy of pub.strategies) {
    try {
      let items: DigitalArticle[] = [];
      if (strategy === "rss" && pub.endpoints.rss) {
        items = await fetchRss(pub, { limit: 3, timeoutMs });
      } else if (strategy === "news-sitemap" && pub.endpoints.sitemap) {
        items = await fetchNewsSitemap(pub, { limit: 3, timeoutMs });
      } else if (strategy === "wp-api" && pub.endpoints.wpApi) {
        items = await fetchWpApi(pub, { limit: 3, timeoutMs });
      } else if (strategy === "youtube-rss" && pub.endpoints.youtubeChannelId) {
        items = await fetchYouTubeFeed(pub, { limit: 3, timeoutMs });
      } else if (strategy === "gnews-rss") {
        items = await fetchGnewsSite(pub, { limit: 3, timeoutMs });
      }

      if (items.length > 0) {
        return {
          slug: pub.slug,
          name: pub.name,
          category: pub.category,
          lang: pub.lang,
          domain: pub.domain,
          ok: true,
          engine: strategy,
          item_count: items.length,
          latency_ms: Date.now() - start,
          sample_headline: items[0].headline,
          sample_url: items[0].url,
          error: null,
        };
      }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    slug: pub.slug,
    name: pub.name,
    category: pub.category,
    lang: pub.lang,
    domain: pub.domain,
    ok: false,
    engine: null,
    item_count: 0,
    latency_ms: Date.now() - start,
    sample_headline: null,
    sample_url: null,
    error: lastError || "All configured strategies failed or returned 0 items",
  };
}

async function fetchFromPublication(
  pub: PublicationConfig,
  opts: FetchOptions
): Promise<DigitalArticle[]> {
  const collected: DigitalArticle[] = [];
  const limit = opts.limitPerOutlet ?? 30;

  // Primary attempt: RSS
  if (pub.strategies.includes("rss") && pub.endpoints.rss) {
    try {
      const rssItems = await fetchRss(pub, {
        hours: opts.hours,
        limit,
        timeoutMs: opts.timeoutMs,
      });
      collected.push(...rssItems);
    } catch {
      // Continue to next strategy
    }
  }

  // Secondary attempt: News Sitemap
  if (collected.length < limit && pub.strategies.includes("news-sitemap") && pub.endpoints.sitemap) {
    try {
      const sitemapItems = await fetchNewsSitemap(pub, {
        hours: opts.hours,
        limit: limit - collected.length,
        timeoutMs: opts.timeoutMs,
      });
      collected.push(...sitemapItems);
    } catch {
      // Continue to next strategy
    }
  }

  // Tertiary attempt: WordPress REST API
  if (collected.length < limit && pub.strategies.includes("wp-api") && pub.endpoints.wpApi) {
    try {
      const wpItems = await fetchWpApi(pub, {
        hours: opts.hours,
        limit: limit - collected.length,
        timeoutMs: opts.timeoutMs,
      });
      collected.push(...wpItems);
    } catch {
      // Continue to next strategy
    }
  }

  // Quaternary attempt: YouTube Feed
  if (collected.length < limit && pub.strategies.includes("youtube-rss") && pub.endpoints.youtubeChannelId) {
    try {
      const ytItems = await fetchYouTubeFeed(pub, {
        hours: opts.hours,
        limit: limit - collected.length,
        timeoutMs: opts.timeoutMs,
      });
      collected.push(...ytItems);
    } catch {
      // Continue to next strategy
    }
  }

  // Fallback: Google News RSS site search if direct endpoints were empty
  if (collected.length === 0 && pub.strategies.includes("gnews-rss")) {
    try {
      const gnewsItems = await fetchGnewsSite(pub, {
        hours: opts.hours,
        limit,
        timeoutMs: opts.timeoutMs,
      });
      collected.push(...gnewsItems);
    } catch {
      // Ignored
    }
  }

  return deduplicateArticles(collected).slice(0, limit);
}

async function searchInPublication(
  pub: PublicationConfig,
  keywords: string[],
  opts: SearchOptions
): Promise<DigitalArticle[]> {
  const collected: DigitalArticle[] = [];
  const limit = opts.limitPerOutlet ?? 30;
  const keywordQuery = keywords.join(" ");

  // 1. Direct RSS feeds keyword match (fastest, direct from publisher)
  if (pub.strategies.includes("rss") && pub.endpoints.rss) {
    try {
      const rssItems = await fetchRss(pub, {
        hours: opts.hours,
        limit: 100,
        timeoutMs: opts.timeoutMs,
      });
      for (const item of rssItems) {
        const matched = matchKeywords(item, keywords, opts.matchAll);
        if (matched.length > 0) {
          item.matched_keywords = matched;
          collected.push(item);
          if (collected.length >= limit) break;
        }
      }
    } catch {
      // Continue
    }
  }

  // 2. News Sitemap keyword match (comprehensive archive from last 48h)
  if (collected.length < limit && pub.strategies.includes("news-sitemap") && pub.endpoints.sitemap) {
    try {
      const sitemapItems = await fetchNewsSitemap(pub, {
        hours: opts.hours,
        limit: 250,
        timeoutMs: opts.timeoutMs,
      });
      for (const item of sitemapItems) {
        const matched = matchKeywords(item, keywords, opts.matchAll);
        if (matched.length > 0) {
          item.matched_keywords = matched;
          collected.push(item);
          if (collected.length >= limit) break;
        }
      }
    } catch {
      // Continue
    }
  }

  // 3. WordPress REST API keyword search (server-side query)
  if (collected.length < limit && pub.strategies.includes("wp-api") && pub.endpoints.wpApi) {
    try {
      const wpItems = await fetchWpApi(pub, {
        keyword: keywordQuery,
        hours: opts.hours,
        limit,
        timeoutMs: opts.timeoutMs,
      });
      for (const item of wpItems) {
        const matched = matchKeywords(item, keywords, opts.matchAll);
        item.matched_keywords = matched.length ? matched : keywords;
        collected.push(item);
        if (collected.length >= limit) break;
      }
    } catch {
      // Continue
    }
  }

  // 4. YouTube Channel Feed keyword match (for broadcast & video portals)
  if (collected.length < limit && pub.strategies.includes("youtube-rss") && pub.endpoints.youtubeChannelId) {
    try {
      const ytItems = await fetchYouTubeFeed(pub, {
        hours: opts.hours,
        limit: 50,
        timeoutMs: opts.timeoutMs,
      });
      for (const item of ytItems) {
        const matched = matchKeywords(item, keywords, opts.matchAll);
        if (matched.length > 0) {
          item.matched_keywords = matched;
          collected.push(item);
          if (collected.length >= limit) break;
        }
      }
    } catch {
      // Continue
    }
  }

  // 5. Fallback: Google News RSS site search if direct publisher endpoints yielded 0 items
  if (collected.length === 0 && pub.strategies.includes("gnews-rss")) {
    try {
      const gnewsItems = await fetchGnewsSite(pub, {
        keyword: keywordQuery,
        hours: opts.hours,
        limit,
        timeoutMs: opts.timeoutMs,
      });
      for (const item of gnewsItems) {
        const matched = matchKeywords(item, keywords, opts.matchAll);
        item.matched_keywords = matched.length ? matched : keywords;
        collected.push(item);
      }
    } catch {
      // Continue
    }
  }

  return deduplicateArticles(collected).slice(0, limit);
}

// ============================================================================
// STDOUT DRAIN SAFE JSON WRITER
// ============================================================================

async function writeJsonToStdout(data: unknown): Promise<void> {
  const jsonStr = JSON.stringify(data, null, 2) + "\n";
  await new Promise<void>((resolve) => {
    if (process.stdout.write(jsonStr)) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
    }
  });
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

async function handleList(args: ParsedArgs): Promise<void> {
  const { selected } = filterPublications(args);

  if (args.json) {
    await writeJsonToStdout(selected);
    return;
  }

  console.log(
    `\n${colors.bold}${colors.cyan}Ampio Labs — Digital & Broadcast News Catalog${colors.reset}`
  );
  console.log(
    `${colors.gray}Showing ${selected.length} of ${PUBLICATIONS.length} outlets across India${colors.reset}\n`
  );

  const colWidths = {
    slug: 24,
    name: 24,
    category: 18,
    lang: 6,
    domain: 26,
    strategies: 28,
  };

  const header =
    `${colors.bold}` +
    "SLUG".padEnd(colWidths.slug) +
    "NAME".padEnd(colWidths.name) +
    "CATEGORY".padEnd(colWidths.category) +
    "LANG".padEnd(colWidths.lang) +
    "DOMAIN".padEnd(colWidths.domain) +
    "STRATEGIES" +
    `${colors.reset}`;

  console.log(header);
  console.log("─".repeat(128));

  for (const pub of selected) {
    const slugStr = colors.cyan + pub.slug.padEnd(colWidths.slug) + colors.reset;
    const nameStr = pub.name.padEnd(colWidths.name);
    const catStr = colors.magenta + pub.category.padEnd(colWidths.category) + colors.reset;
    const langStr = colors.yellow + pub.lang.padEnd(colWidths.lang) + colors.reset;
    const domainStr = pub.domain.padEnd(colWidths.domain);
    const stratStr = colors.gray + pub.strategies.join(", ") + colors.reset;

    console.log(`${slugStr}${nameStr}${catStr}${langStr}${domainStr}${stratStr}`);
  }

  // Category counts
  const catCounts: Record<string, number> = {};
  for (const p of selected) {
    catCounts[p.category] = (catCounts[p.category] || 0) + 1;
  }

  console.log("\n" + "─".repeat(128));
  console.log(`${colors.bold}Category Breakdown:${colors.reset}`);
  for (const [cat, count] of Object.entries(catCounts)) {
    console.log(`  • ${colors.magenta}${cat.padEnd(20)}${colors.reset}: ${count} outlets`);
  }
  console.log("");
}

async function handleCheck(args: ParsedArgs): Promise<void> {
  const { selected, warnings } = filterPublications(args);

  if (args.outlets && args.outlets.length > 0 && selected.length === 0) {
    console.error(
      `${colors.red}[ERROR] None of the requested outlets (${args.outlets.join(", ")}) were found in catalog.${colors.reset}`
    );
    process.exit(1);
  }

  if (warnings.length > 0 && !args.json) {
    for (const w of warnings) console.error(`${colors.yellow}[WARN] ${w}${colors.reset}`);
  }

  if (!args.json) {
    console.log(
      `\n${colors.bold}${colors.cyan}Running Live Health Check across ${selected.length} Outlets...${colors.reset}`
    );
    console.log(`${colors.gray}Concurrency: ${args.concurrency} | Timeout: ${args.timeoutMs}ms${colors.reset}\n`);
  }

  let completedCount = 0;
  const results = await runWithConcurrency(
    selected,
    args.concurrency,
    async (pub, idx) => {
      const res = await probePublication(pub, args.timeoutMs);
      completedCount++;

      if (!args.json) {
        const mark = res.ok
          ? `${colors.green}[✓]${colors.reset}`
          : `${colors.red}[✗]${colors.reset}`;
        const countStr = res.ok
          ? `${colors.gray}(${res.item_count} items, ${res.latency_ms}ms, via ${res.engine})${colors.reset}`
          : `${colors.red}(FAILED: ${res.error || "unreachable"})${colors.reset}`;
        const prefix = `[${completedCount}/${selected.length}]`.padEnd(9);
        console.log(
          `${prefix} ${mark} ${colors.bold}${pub.name.padEnd(22)}${colors.reset} ${pub.domain.padEnd(24)} ${countStr}`
        );
      }
      return res;
    }
  );

  if (args.json) {
    await writeJsonToStdout(results);
    return;
  }

  // Print Summary Table
  const healthy = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const healthRate = ((healthy.length / results.length) * 100).toFixed(1);

  console.log("\n" + "═".repeat(80));
  console.log(
    `${colors.bold}Health Check Summary: ${colors.green}${healthy.length} Healthy${colors.reset} / ` +
      `${colors.red}${failed.length} Unreachable${colors.reset} (${healthRate}% operational)`
  );
  console.log("═".repeat(80));

  const engineCounts: Record<string, number> = {};
  for (const h of healthy) {
    if (h.engine) engineCounts[h.engine] = (engineCounts[h.engine] || 0) + 1;
  }

  console.log(`${colors.bold}Active Strategies Verified:${colors.reset}`);
  for (const [eng, count] of Object.entries(engineCounts)) {
    console.log(`  • ${colors.cyan}${eng.padEnd(16)}${colors.reset}: ${count} outlets`);
  }

  if (failed.length > 0) {
    console.log(`\n${colors.bold}${colors.red}Unreachable Outlets (${failed.length}):${colors.reset}`);
    for (const f of failed) {
      console.log(`  • ${f.name} (${f.slug}) [${f.domain}]: ${f.error}`);
    }
  }
  console.log("");
}

async function handleFetch(args: ParsedArgs): Promise<void> {
  if (!args.all && (!args.outlets || args.outlets.length === 0) && !args.category && !args.lang) {
    console.error(
      `${colors.red}[ERROR] Missing target outlets. Please specify --outlets <slugs> (e.g. --outlets pti,ani) or --all to fetch across all 47 outlets.${colors.reset}`
    );
    process.exit(1);
  }

  const { selected, warnings } = filterPublications(args);

  if (args.outlets && args.outlets.length > 0 && selected.length === 0) {
    console.error(
      `${colors.red}[ERROR] None of the requested outlets (${args.outlets.join(", ")}) were found in catalog.${colors.reset}`
    );
    process.exit(1);
  }

  if (warnings.length > 0 && !args.json) {
    for (const w of warnings) console.error(`${colors.yellow}[WARN] ${w}${colors.reset}`);
  }

  if (selected.length === 0) {
    console.error(
      `${colors.red}[ERROR] No outlets matched your criteria. Use 'digital list' to see available outlets.${colors.reset}`
    );
    process.exit(1);
  }

  const hours = args.hours ?? 24;

  if (!args.json) {
    console.log(
      `\n${colors.bold}${colors.cyan}Fetching latest articles from ${selected.length} outlet(s) within ${hours}h window...${colors.reset}\n`
    );
  }

  const fetchOptions: FetchOptions = {
    hours,
    limitPerOutlet: args.limit ?? 30,
    timeoutMs: args.timeoutMs,
  };

  const articleLists = await runWithConcurrency(
    selected,
    args.concurrency,
    async (pub) => {
      try {
        return await fetchFromPublication(pub, fetchOptions);
      } catch (err) {
        if (args.verbose) {
          console.error(`[WARN] Failed to fetch ${pub.slug}: ${err}`);
        }
        return [];
      }
    }
  );

  let allArticles = deduplicateArticles(articleLists.flat());

  // Optional metadata enrichment
  if (args.enrich && allArticles.length > 0) {
    if (!args.json) {
      console.log(`${colors.gray}Enriching ${allArticles.length} articles with full page metadata...${colors.reset}`);
    }
    allArticles = await enrichArticles(allArticles, args.concurrency);
  }

  // Optional database ingestion
  let ingestSummary: IngestSummary | null = null;
  if (args.ingest && allArticles.length > 0) {
    ingestSummary = ingestArticlesToDatabase(allArticles, args.dbPath);
    if (!args.json) {
      console.log(
        `\n${colors.green}[INGEST] Synced ${allArticles.length} articles into ${ingestSummary.dbPath} ` +
          `(+${ingestSummary.clippingsInserted} new, ~${ingestSummary.clippingsUpdated} updated)${colors.reset}`
      );
    }
  }

  // Optional write to file
  if (args.outFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.outFile)), { recursive: true });
    fs.writeFileSync(args.outFile, JSON.stringify(allArticles, null, 2), "utf-8");
    if (!args.json) {
      console.log(`${colors.green}[OUT] Saved results to ${args.outFile}${colors.reset}`);
    }
  }

  if (args.json) {
    await writeJsonToStdout(allArticles);
    return;
  }

  // Pretty output
  console.log("\n" + "═".repeat(90));
  console.log(
    `${colors.bold}Fetched ${colors.green}${allArticles.length} articles${colors.reset} across ${selected.length} outlet(s)`
  );
  console.log("═".repeat(90));

  for (const art of allArticles.slice(0, 20)) {
    console.log(
      `\n${colors.bold}${colors.cyan}[${art.publication}]${colors.reset} ${art.headline}`
    );
    console.log(`  ${colors.gray}URL:${colors.reset} ${art.url}`);
    console.log(
      `  ${colors.gray}Date:${colors.reset} ${art.published_at || "N/A"} | ` +
        `${colors.gray}Engine:${colors.reset} ${art.source_engine} | ` +
        `${colors.gray}Category:${colors.reset} ${art.category}`
    );
  }

  if (allArticles.length > 20) {
    console.log(`\n${colors.gray}... and ${allArticles.length - 20} more articles.${colors.reset}`);
  }
  console.log("");
}

async function handleSearch(args: ParsedArgs): Promise<void> {
  const keywords = args.keywords;
  if (!keywords || keywords.length === 0) {
    console.error(
      `${colors.red}[ERROR] No search keyword provided. Usage: bun run digital search "<keyword>" [options]${colors.reset}`
    );
    process.exit(1);
  }

  const { selected, warnings } = filterPublications(args);

  if (args.outlets && args.outlets.length > 0 && selected.length === 0) {
    console.error(
      `${colors.red}[ERROR] None of the requested outlets (${args.outlets.join(", ")}) were found in catalog.${colors.reset}`
    );
    process.exit(1);
  }

  if (warnings.length > 0 && !args.json) {
    for (const w of warnings) console.error(`${colors.yellow}[WARN] ${w}${colors.reset}`);
  }

  const targetPubs = selected.length > 0 ? selected : PUBLICATIONS;
  const hours = args.hours ?? 48;
  const keywordQuery = keywords.join(", ");

  if (!args.json) {
    console.log(
      `\n${colors.bold}${colors.cyan}Searching for "${keywordQuery}" across ${targetPubs.length} outlet(s) (window: ${hours}h)...${colors.reset}\n`
    );
  }

  const searchOptions: SearchOptions = {
    keywords,
    hours,
    limitPerOutlet: args.limit ?? 30,
    timeoutMs: args.timeoutMs,
  };

  const resultsByPub = await runWithConcurrency(
    targetPubs,
    args.concurrency,
    async (pub) => {
      try {
        return await searchInPublication(pub, keywords, searchOptions);
      } catch (err) {
        if (args.verbose) {
          console.error(`[WARN] Search failed on ${pub.slug}: ${err}`);
        }
        return [];
      }
    }
  );

  let matchedArticles = deduplicateArticles(resultsByPub.flat());

  // Optional enrichment
  if (args.enrich && matchedArticles.length > 0) {
    if (!args.json) {
      console.log(`${colors.gray}Enriching ${matchedArticles.length} articles with full page metadata...${colors.reset}`);
    }
    matchedArticles = await enrichArticles(matchedArticles, args.concurrency);
  }

  // Optional database ingestion
  let ingestSummary: IngestSummary | null = null;
  if (args.ingest && matchedArticles.length > 0) {
    ingestSummary = ingestArticlesToDatabase(matchedArticles, args.dbPath);
    if (!args.json) {
      console.log(
        `\n${colors.green}[INGEST] Synced ${matchedArticles.length} matched articles into ${ingestSummary.dbPath} ` +
          `(+${ingestSummary.clippingsInserted} new, ~${ingestSummary.clippingsUpdated} updated)${colors.reset}`
      );
    }
  }

  // Optional write to file
  if (args.outFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.outFile)), { recursive: true });
    fs.writeFileSync(args.outFile, JSON.stringify(matchedArticles, null, 2), "utf-8");
    if (!args.json) {
      console.log(`${colors.green}[OUT] Saved search results to ${args.outFile}${colors.reset}`);
    }
  }

  if (args.json) {
    await writeJsonToStdout(matchedArticles);
    return;
  }

  // Human readable output
  console.log("\n" + "═".repeat(90));
  console.log(
    `${colors.bold}Search Results: ${colors.green}${matchedArticles.length} articles found${colors.reset} ` +
      `for "${keywordQuery}" across ${targetPubs.length} outlet(s)`
  );
  console.log("═".repeat(90));

  const pubCounts: Record<string, number> = {};
  for (const art of matchedArticles) {
    pubCounts[art.publication] = (pubCounts[art.publication] || 0) + 1;
  }

  if (Object.keys(pubCounts).length > 0) {
    console.log(`${colors.bold}Outlets with matches:${colors.reset}`);
    for (const [pub, cnt] of Object.entries(pubCounts)) {
      console.log(`  • ${colors.cyan}${pub.padEnd(24)}${colors.reset}: ${cnt} article(s)`);
    }
  }

  for (const art of matchedArticles.slice(0, 25)) {
    console.log(
      `\n${colors.bold}${colors.cyan}[${art.publication}]${colors.reset} ${art.headline}`
    );
    console.log(`  ${colors.gray}URL:${colors.reset} ${art.url}`);
    console.log(
      `  ${colors.gray}Published:${colors.reset} ${art.published_at || "N/A"} | ` +
        `${colors.gray}Engine:${colors.reset} ${art.source_engine} | ` +
        `${colors.gray}Author:${colors.reset} ${art.author || "Editorial Team"}`
    );
    if (art.description || art.summary) {
      const summaryText = (art.description || art.summary || "").slice(0, 140);
      console.log(`  ${colors.gray}Snippet:${colors.reset} ${summaryText}...`);
    }
  }

  if (matchedArticles.length > 25) {
    console.log(`\n${colors.gray}... and ${matchedArticles.length - 25} more matches.${colors.reset}`);
  }
  console.log("");
}

function handleHelp(): void {
  console.log(`
${colors.bold}${colors.cyan}Ampio Labs — Unified Digital Media Monitoring CLI${colors.reset}
Indian Wire Agencies, Digital News Portals, Business Portals, TV Digital & Public Broadcasters

${colors.bold}USAGE:${colors.reset}
  bun run digital <command> [options]

${colors.bold}COMMANDS:${colors.reset}
  ${colors.cyan}list${colors.reset}       List all 47 configured news outlets with category, language, and strategies
  ${colors.cyan}check${colors.reset}      Run live health checks in parallel across all 47 outlets (or subset)
  ${colors.cyan}fetch${colors.reset}      Fetch latest published articles on demand from specific outlets or all
  ${colors.cyan}search${colors.reset}     Search on demand by keyword across all 47 outlets within strict time window
  ${colors.cyan}help${colors.reset}       Display this help message

${colors.bold}OPTIONS:${colors.reset}
  ${colors.yellow}-o, --outlets <slugs>${colors.reset} Com-separated list of publication slugs (e.g. pti,ani,ndtv,moneycontrol)
  ${colors.yellow}-a, --all${colors.reset}             Target all 47 publications
  ${colors.yellow}-c, --category <cat>${colors.reset}  Filter by category (wire, business, english-digital, hindi-digital, broadcast-english, broadcast-hindi, public-broadcaster)
  ${colors.yellow}-l, --lang <lang>${colors.reset}      Filter by language (en, hi)
  ${colors.yellow}-H, --hours <n>${colors.reset}        Time window in hours (default: 24 for fetch, 48 for search)
  ${colors.yellow}--limit <n>${colors.reset}           Max articles per outlet (default: 30)
  ${colors.yellow}--concurrency <n>${colors.reset}     Concurrent HTTP requests (default: 8)
  ${colors.yellow}--enrich${colors.reset}             Fetch full-page HTML to extract JSON-LD, og:tags, author, image
  ${colors.yellow}--ingest${colors.reset}             Sync articles into SQLite database (default: data/media_dataset.db)
  ${colors.yellow}--db <path>${colors.reset}           Custom SQLite database path (default: data/media_dataset.db)
  ${colors.yellow}--out <file>${colors.reset}          Save JSON output to disk
  ${colors.yellow}-j, --json${colors.reset}            Output pure JSON to stdout (pipeable to jq)
  ${colors.yellow}-v, --verbose${colors.reset}         Verbose warning output
  ${colors.yellow}-h, --help${colors.reset}            Display this help message

${colors.bold}EXAMPLES:${colors.reset}
  # List all wire agencies as JSON
  bun run digital list --category wire --json

  # Live health check across all 47 outlets
  bun run digital check

  # Fetch latest articles from PTI, ANI, NDTV, Moneycontrol in the last 24h as JSON
  bun run digital fetch --outlets pti,ani,ndtv,moneycontrol --hours 24 --json

  # Search "India" across PTI, NDTV, Aaj Tak within 24 hours as JSON
  bun run digital search "India" --outlets pti,ndtv,aaj-tak --hours 24 --json

  # Search "Kashi Tamil Sangamam" across all 47 outlets and ingest directly to database
  bun run digital search "Kashi Tamil Sangamam" --hours 48 --ingest
`);
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);

  if (args.help) {
    handleHelp();
    return;
  }

  switch (args.command) {
    case "list":
      await handleList(args);
      break;

    case "check":
      await handleCheck(args);
      break;

    case "fetch":
      await handleFetch(args);
      break;

    case "search":
      await handleSearch(args);
      break;

    default:
      console.error(
        `${colors.red}Unknown command '${args.command}'. Use 'bun run digital help' for available commands.${colors.reset}`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${colors.red}[FATAL ERROR] ${err instanceof Error ? err.stack : err}${colors.reset}`);
  process.exit(1);
});
