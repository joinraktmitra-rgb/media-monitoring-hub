#!/usr/bin/env bun
/**
 * Unified ePaper CLI Tool (dailyepaper.in + indiags.com)
 * Zero-dependency Bun TypeScript CLI designed for both humans and AI agents.
 */

import os from "node:os";
import path from "node:path";
import {
  type DownloadResult,
  downloadDailyEpaper,
  getDailyEpaperIssues,
  listDailyEpaper,
} from "./providers/dailyepaper.ts";
import {
  clipFromCoords,
  generateAudioShow,
  renderPdfPages,
} from "./providers/clipper.ts";
import { downloadIndiaGs, listIndiaGs } from "./providers/indiags.ts";
import {
  downloadOfficialRegional,
  listOfficialRegional,
} from "./providers/official-regional.ts";

export type SourceOption = "auto" | "dailyepaper" | "indiags" | "official" | "all";

export interface ParsedCliArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const INDIAGS_PREFERRED = new Set(["the-hindu", "hindu", "indian-express", "express", "business-line"]);
const OFFICIAL_PREFERRED = new Set(["pragativadi", "andhra-prabha", "loktej", "dainik-janambhumi"]);

const PAPER_ALIASES: Record<string, string> = {
  hindu: "the-hindu",
  toi: "times-of-india",
  et: "economic-times",
  ie: "indian-express",
  fe: "financial-express",
  bs: "business-standard",
  bl: "business-line",
  ht: "hindustan-times",
  dj: "dainik-jagran",
  db: "dainik-bhaskar",
  nbt: "navbharat-times",
  mint: "live-mint",
};

function expandAlias(paper: string): string {
  const key = paper.trim().toLowerCase();
  return PAPER_ALIASES[key] || paper;
}

/**
 * Parse CLI arguments into command, positionals, and flags.
 */
export function parseArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (token === "-h") {
      flags.help = true;
    } else {
      positionals.push(token);
    }
  }

  const [command = "help", ...rest] = positionals;
  return { command, positionals: rest, flags };
}

function printHelp(): void {
  console.log(`epaper — Unified Indian Newspaper PDF CLI (indiags.com + dailyepaper.in + official)

Usage:
  epaper <command> [args] [options]

Commands:
  list                          List available newspapers
    --source <all|dailyepaper|indiags|official>   Filter by provider (default: all)
    --search <query>                              Filter by paper name or slug
    --json                                        Output JSON

  issues <paper>                List dated issues & direct links (dailyepaper.in)
    --limit <n>                                   Max issues to show (default: 10)
    --json                                        Output JSON

  download <paper>              Download latest (or --date) PDF
    --source <auto|dailyepaper|indiags|official>  Provider selection (default: auto)
    --date <"DD Mon YYYY"|"YYYY-MM-DD">           Specific date (auto checks indiags/dailyepaper)
    --out <dir>                                   Output directory (default: ~/Downloads/epapers)
    --json                                        Output JSON

  batch <p1,p2,...>             Download multiple papers in sequence
    --source <auto|dailyepaper|indiags|official>  Provider selection (default: auto)
    --out <dir>                                   Output directory (default: ~/Downloads/epapers)
    --json                                        Output JSON

  render <pdf>                  Render PDF pages to PNGs + optional Vision-AI grid & layout hints
    --pages <all|1|1-3>                           Page range (default: all)
    --dpi <n>                                     Render DPI (default: 150)
    --grid                                        Overlay 0.1-0.9 coordinate grid (*_grid.png) for Vision AI
    --hints                                       Extract native PDF headline/text bboxes into manifest
    --out <dir>                                   Output directory (default: ./rendered)
    --json                                        Output JSON

  clip <coords.json>            Gutter-snap & white-out crop articles from Vision AI coordinate JSON
    --out <dir>                                   Output directory (default: ./clips)
    --json                                        Output JSON

Examples:
  epaper list --search hindu --json
  epaper issues times-of-india --limit 5 --json
  epaper download the-hindu --date "15 Nov 2026" --out ./epapers --json
  epaper batch the-hindu,indian-express,toi,fe,pragativadi,loktej --out ./epapers --json
  epaper render ./the-hindu-2026-11-15.pdf --pages 1 --grid --hints --out ./pages --json
  epaper clip ./coords.json --out ./clips --json
`);
}

async function resolveDownload(
  paperInput: string,
  outDir: string,
  source: SourceOption,
  date?: string
): Promise<DownloadResult> {
  const paper = expandAlias(paperInput);
  if (source === "official") {
    if (date) {
      throw new Error("--date is only supported with --source dailyepaper or --source auto.");
    }
    return downloadOfficialRegional(paper, outDir);
  }

  if (source === "indiags") {
    return downloadIndiaGs(paper, outDir, date);
  }

  if (source === "dailyepaper") {
    return downloadDailyEpaper(paper, outDir, date);
  }

  const normalized = paper.trim().toLowerCase();
  if (OFFICIAL_PREFERRED.has(normalized) && !date) {
    try {
      return await downloadOfficialRegional(paper, outDir);
    } catch {
      return downloadDailyEpaper(paper, outDir);
    }
  }
  if (INDIAGS_PREFERRED.has(normalized)) {
    try {
      return await downloadIndiaGs(paper, outDir, date);
    } catch (indiagsErr) {
      if (date) {
        return downloadDailyEpaper(paper, outDir, date);
      }
      throw indiagsErr;
    }
  }

  try {
    return await downloadDailyEpaper(paper, outDir, date);
  } catch (dailyErr) {
    // Fallback to indiags if dailyepaper is Telegram-only/DMCA or missing the requested date
    try {
      return await downloadIndiaGs(paper, outDir, date);
    } catch {
      throw dailyErr;
    }
  }
}

async function runList(flags: Record<string, string | boolean>): Promise<void> {
  const source = String(flags.source || "all").toLowerCase();
  const search = typeof flags.search === "string" ? flags.search : undefined;
  const asJson = Boolean(flags.json);

  const results: Array<Record<string, unknown>> = [];
  if (source === "all" || source === "official") {
    const off = listOfficialRegional(search);
    results.push(
      ...off.map((p) => ({
        source: p.source,
        slug: p.slug,
        name: `${p.name} (${p.state})`,
        date: "today",
        ref: p.url,
      }))
    );
  }
  if (source === "all" || source === "indiags") {
    const ig = await listIndiaGs(search);
    results.push(...ig.map((p) => ({ source: p.source, slug: p.slug, name: p.name, date: p.date, ref: p.bookUrl })));
  }
  if (source === "all" || source === "dailyepaper") {
    const de = await listDailyEpaper(search);
    results.push(...de.map((p) => ({ source: p.source, slug: p.slug, name: p.name, date: "archive", ref: p.url })));
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, count: results.length, papers: results }, null, 2));
    return;
  }

  console.log(`Found ${results.length} newspapers:\n`);
  for (const r of results) {
    console.log(
      `${String(r.source).padEnd(12)} | ${String(r.slug).padEnd(28)} | ${String(r.name).padEnd(28)} | ${r.date}`
    );
  }
}

async function runIssues(
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const paper = positionals[0];
  if (!paper) {
    throw new Error("Missing <paper> argument. Example: issues times-of-india");
  }
  const limit = Number(flags.limit || 10);
  const asJson = Boolean(flags.json);

  const data = await getDailyEpaperIssues(paper, limit);
  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...data }, null, 2));
    return;
  }

  console.log(`${data.paper.name} (${data.paper.url})\n`);
  for (const issue of data.issues) {
    console.log(
      `${issue.date.padEnd(14)} | ${issue.host.padEnd(9)} | ${issue.status.padEnd(14)} | ${issue.directDownloadUrl || issue.viewUrl}`
    );
  }
}

async function runDownload(
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const paper = positionals[0];
  if (!paper) {
    throw new Error("Missing <paper> argument. Example: download the-hindu");
  }
  const source = String(flags.source || "auto").toLowerCase() as SourceOption;
  const date = typeof flags.date === "string" ? flags.date : undefined;
  const outDir = path.resolve(
    typeof flags.out === "string" ? flags.out : path.join(os.homedir(), "Downloads", "epapers")
  );
  const asJson = Boolean(flags.json);

  const result = await resolveDownload(paper, outDir, source, date);
  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log(
    `Downloaded [${result.source}] ${result.paper} (${result.date}) -> ${result.filePath} (${result.sizeMB} MB)`
  );
}

async function runBatch(
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const rawList = positionals.join(",");
  const papers = rawList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (papers.length === 0) {
    throw new Error("Missing papers list. Example: batch the-hindu,indian-express,times-of-india");
  }

  const source = String(flags.source || "auto").toLowerCase() as SourceOption;
  const outDir = path.resolve(
    typeof flags.out === "string" ? flags.out : path.join(os.homedir(), "Downloads", "epapers")
  );
  const asJson = Boolean(flags.json);

  const downloaded: DownloadResult[] = [];
  const failed: Array<{ paper: string; error: string }> = [];

  for (const paper of papers) {
    try {
      const res = await resolveDownload(paper, outDir, source);
      downloaded.push(res);
      if (!asJson) {
        console.log(`OK   [${res.source}] ${res.paper} -> ${res.fileName} (${res.sizeMB} MB)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ paper, error: message });
      if (!asJson) {
        console.error(`FAIL ${paper}: ${message}`);
      }
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify({ ok: failed.length === 0, downloaded, failed }, null, 2)
    );
  }
  if (failed.length > 0 && downloaded.length === 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "list":
        await runList(flags);
        break;
      case "issues":
        await runIssues(positionals, flags);
        break;
      case "download":
        await runDownload(positionals, flags);
        break;
      case "batch":
        await runBatch(positionals, flags);
        break;
      case "render": {
        const pdfPath = positionals[0];
        if (!pdfPath) throw new Error("Missing <pdf> argument. Example: render ./paper.pdf --pages 1 --grid");
        const res = await renderPdfPages({
          pdfPath,
          outDir: typeof flags.out === "string" ? flags.out : "./rendered",
          dpi: flags.dpi ? Number(flags.dpi) : 150,
          pages: typeof flags.pages === "string" ? flags.pages : "all",
          grid: Boolean(flags.grid),
          hints: Boolean(flags.hints),
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "clip": {
        const coordsPath = positionals[0];
        if (!coordsPath) throw new Error("Missing <coords.json> argument. Example: clip ./coords.json --out ./clips");
        const res = await clipFromCoords(
          coordsPath,
          typeof flags.out === "string" ? flags.out : "./clips"
        );
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "show": {
        const runSheetPath = positionals[0];
        if (!runSheetPath) throw new Error("Missing <run_sheet.json> argument. Example: show ./run_sheet.json --out ./show --video --reel");
        const res = await generateAudioShow({
          runSheetPath,
          outDir: typeof flags.out === "string" ? flags.out : "./show",
          video: Boolean(flags.video),
          reel: Boolean(flags.reel),
          audioDir: typeof flags["audio-dir"] === "string" ? flags["audio-dir"] : undefined,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        throw new Error(`Unknown command "${command}". Run with --help to see usage.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
