import path from "node:path";
import { fetchWithRetry } from "../http.ts";
import { downloadTiledPagesToPdf, type TiledPageSpec } from "../pdf-builder.ts";
import type { DownloadResult } from "./dailyepaper.ts";

export interface ReadwhereEntry {
  source: "readwhere";
  slug: string;
  name: string;
  language: string;
  host: string;
  editionPath: string;
  editionLabel: string;
}

export const READWHERE_PAPERS: ReadwhereEntry[] = [
  {
    source: "readwhere",
    slug: "new-indian-express",
    name: "The New Indian Express",
    language: "English",
    host: "https://epaper.newindianexpress.com",
    editionPath: "/t/3353",
    editionLabel: "Chennai",
  },
  {
    source: "readwhere",
    slug: "morning-standard",
    name: "The Morning Standard",
    language: "English",
    host: "https://epaper.morningstandard.in",
    editionPath: "/t/26003",
    editionLabel: "Delhi",
  },
  {
    source: "readwhere",
    slug: "dainik-tribune",
    name: "Dainik Tribune",
    language: "Hindi",
    host: "https://epaper.dainiktribuneonline.com",
    editionPath: "/t/6019",
    editionLabel: "Gurgaon",
  },
  {
    source: "readwhere",
    slug: "dainik-savera",
    name: "Dainik Savera",
    language: "Hindi",
    host: "https://epaper.dainiksaveratimes.in",
    editionPath: "/edition/delhi-main/9651",
    editionLabel: "Delhi Main",
  },
];

interface ReadwhereChunk {
  tx: number;
  ty: number;
  width: number;
  height: number;
  url: string;
}

interface ReadwhereLevel {
  width: number;
  height: number;
  chunks?: ReadwhereChunk[];
}

interface ReadwherePageMeta {
  key: string;
  pagenum: number;
  levels?: Record<string, ReadwhereLevel>;
}

function todayIsoIst(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

/**
 * List Readwhere-backed official ePapers.
 */
export function listReadwhere(search?: string): ReadwhereEntry[] {
  const q = search ? search.trim().toLowerCase() : "";
  return q
    ? READWHERE_PAPERS.filter(
        (p) =>
          p.slug.includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.language.toLowerCase().includes(q)
      )
    : READWHERE_PAPERS;
}

async function discoverLatestIssue(entry: ReadwhereEntry): Promise<{
  issueId: string;
  numPages: number;
  date: string;
}> {
  const listingUrl = `${entry.host}${entry.editionPath}`;
  const res = await fetchWithRetry(listingUrl);
  if (!res.ok) {
    throw new Error(`${entry.name} listing HTTP ${res.status} (${listingUrl})`);
  }
  const html = await res.text();

  const issueId =
    html.match(/\/read\/r\/(\d+)/i)?.[1] ||
    html.match(/issue[_-]?id["']?\s*[:=]\s*["']?(\d{5,9})/i)?.[1];
  if (!issueId) {
    throw new Error(`Could not find latest Readwhere issue ID on ${listingUrl}`);
  }

  // Follow /read/r/<issueId> to read DEConfig (numPages & publish date)
  let numPages = 0;
  let date = todayIsoIst();
  try {
    const readerRes = await fetchWithRetry(`https://www.readwhere.com/read/r/${issueId}`, {
      redirect: "follow",
    });
    if (readerRes.ok) {
      const readerHtml = await readerRes.text();
      const pagesMatch =
        readerHtml.match(/['"]numPages['"]\s*:\s*(\d+)/) ||
        readerHtml.match(/numPages\s*=\s*(\d+)/);
      if (pagesMatch) {
        numPages = Number(pagesMatch[1]);
      }
      const dateMatch =
        readerHtml.match(/['"]published['"]\s*:\s*["'](\d{4}-\d{2}-\d{2})/) ||
        readerRes.url.match(/(\d{2}-\d{2}-\d{4})/);
      if (dateMatch) {
        date = dateMatch[1];
      }
    }
  } catch {
    // Fall back to pagemeta discovery below
  }

  return { issueId, numPages, date };
}

async function fetchPageMetaRange(
  host: string,
  issueId: string,
  startPage: number,
  endPage: number
): Promise<Record<string, ReadwherePageMeta>> {
  const url = `${host}/pagemeta/get/${issueId}/${startPage}-${endPage}`;
  const res = await fetchWithRetry(url, {
    headers: {
      Accept: "application/json",
      Referer: `${host}/`,
    },
  });
  if (!res.ok) {
    throw new Error(`Readwhere pagemeta HTTP ${res.status} for ${url}`);
  }
  const text = await res.text();
  if (!text.trim().startsWith("{")) {
    throw new Error(`Readwhere pagemeta returned non-JSON for issue ${issueId}`);
  }
  return JSON.parse(text) as Record<string, ReadwherePageMeta>;
}

/**
 * Download today's edition from a Readwhere-powered official ePaper portal and
 * composite its HD JPEG tiles directly into a PDF.
 */
export async function downloadReadwhere(
  paperInput: string,
  outDir: string
): Promise<DownloadResult & { pages: number }> {
  const q = paperInput.trim().toLowerCase();
  const entry =
    READWHERE_PAPERS.find((p) => p.slug === q || p.name.toLowerCase() === q) ||
    READWHERE_PAPERS.find((p) => p.slug.includes(q) || p.name.toLowerCase().includes(q));

  if (!entry) {
    throw new Error(
      `Paper "${paperInput}" is not in the Readwhere provider. Available: ${READWHERE_PAPERS.map((p) => p.slug).join(", ")}`
    );
  }

  const { issueId, numPages, date } = await discoverLatestIssue(entry);

  // Fetch page metadata in batches of 12 pages
  const allMeta = new Map<number, ReadwherePageMeta>();
  const maxProbe = numPages > 0 ? numPages : 48;
  const batchSize = 12;

  for (let start = 1; start <= maxProbe; start += batchSize) {
    const end = Math.min(start + batchSize - 1, maxProbe);
    const batch = await fetchPageMetaRange(entry.host, issueId, start, end);
    const entries = Object.values(batch).filter(
      (p) => p && typeof p.pagenum === "number" && p.levels
    );
    for (const p of entries) {
      allMeta.set(p.pagenum, p);
    }
    if (entries.length < end - start + 1) {
      break;
    }
  }

  const sortedPages = Array.from(allMeta.values()).sort((a, b) => a.pagenum - b.pagenum);
  if (sortedPages.length === 0) {
    throw new Error(`No page metadata returned by Readwhere for ${entry.name} (issue ${issueId})`);
  }

  const pageSpecs: TiledPageSpec[] = [];
  for (const page of sortedPages) {
    const levels = page.levels || {};
    // Prefer level2 (1600px HD) -> level1 (1400px) -> leveldefault -> level0
    const chosen = levels.level2 || levels.level1 || levels.leveldefault || levels.level0;
    if (!chosen || !chosen.chunks || chosen.chunks.length === 0) {
      throw new Error(`Missing tile chunks on page ${page.pagenum} of ${entry.name}`);
    }

    // Deduplicate tiles by (tx, ty) — Readwhere often duplicates the chunk array
    const seenCoords = new Set<string>();
    const uniqueTiles: TiledPageSpec["tiles"] = [];
    for (const chunk of chosen.chunks) {
      const coordKey = `${chunk.tx},${chunk.ty}`;
      if (seenCoords.has(coordKey)) continue;
      seenCoords.add(coordKey);
      uniqueTiles.push({
        tx: chunk.tx,
        ty: chunk.ty,
        width: chunk.width,
        height: chunk.height,
        url: chunk.url.replace(/^http:/i, "https:"),
      });
    }

    pageSpecs.push({
      width: chosen.width,
      height: chosen.height,
      tiles: uniqueTiles,
    });
  }

  const safeDate = date.replace(/[/\s]+/g, "-");
  const fileName = `${entry.slug}-${safeDate}.pdf`;
  const built = await downloadTiledPagesToPdf(pageSpecs, path.join(outDir, fileName), 12);

  return {
    source: "official" as any,
    paper: `${entry.name} (${entry.editionLabel})`,
    date,
    fileName,
    filePath: built.filePath,
    sizeBytes: built.sizeBytes,
    sizeMB: built.sizeMB,
    pages: built.pages,
  };
}
