import path from "node:path";
import { fetchWithRetry } from "../http.ts";
import { downloadImagesToPdf } from "../pdf-builder.ts";
import type { DownloadResult } from "./dailyepaper.ts";

export interface OfficialRegionalEntry {
  source: "official";
  slug: string;
  name: string;
  state: string;
  language: string;
  url: string;
}

export const OFFICIAL_REGIONAL_PAPERS: OfficialRegionalEntry[] = [
  {
    source: "official",
    slug: "pragativadi",
    name: "Pragativadi",
    state: "Odisha",
    language: "Odia",
    url: "https://epaper.pragativadi.com/",
  },
  {
    source: "official",
    slug: "andhra-prabha",
    name: "Andhra Prabha",
    state: "Andhra Pradesh & Telangana",
    language: "Telugu",
    url: "https://epaper.prabhanews.com/",
  },
  {
    source: "official",
    slug: "loktej",
    name: "Loktej",
    state: "Gujarat & Rajasthan",
    language: "Hindi",
    url: "https://epaper.loktej.com/",
  },
  {
    source: "official",
    slug: "dainik-janambhumi",
    name: "Dainik Janambhumi",
    state: "Assam & Northeast",
    language: "Assamese",
    url: "https://s2.dainikjanambhumi.co.in/",
  },
];

function todayIsoIst(): string {
  // IST is UTC+5:30
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function yesterdayIsoIst(): string {
  const prev = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return prev.toISOString().slice(0, 10);
}

async function fetchPragativadiPages(): Promise<{ date: string; imageUrls: string[] }> {
  const res = await fetchWithRetry("https://epaper.pragativadi.com/");
  if (!res.ok) throw new Error(`Pragativadi HTTP ${res.status}`);
  const html = await res.text();

  const titleDate = html.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] || todayIsoIst();
  const rawMatches = Array.from(
    new Set(
      html.match(
        /https?:\/\/epaper\.pragativadi\.com\/assets\/public\/epaper\/edition\/[^\s"'<>]+\.jpg/gi
      ) || []
    )
  );
  if (rawMatches.length === 0) {
    throw new Error("No page images found on epaper.pragativadi.com");
  }

  // Prefer full-res if available by testing first URL without 'compressed_'
  let imageUrls = rawMatches;
  if (rawMatches[0].includes("compressed_")) {
    const fullCandidate = rawMatches[0].replace("compressed_", "");
    try {
      const head = await fetch(fullCandidate, { method: "HEAD" });
      if (head.ok) {
        imageUrls = rawMatches.map((u) => u.replace("compressed_", ""));
      }
    } catch {
      // keep compressed_ URLs
    }
  }

  return { date: titleDate, imageUrls };
}

async function fetchAndhraPrabhaPages(): Promise<{ date: string; imageUrls: string[] }> {
  for (const date of [todayIsoIst(), yesterdayIsoIst()]) {
    const apiUrl = `https://epaper.prabhanews.com/api/issues/${date}/Andhra%20Pradesh%20Mains/Vijayawada%20Main/`;
    const res = await fetchWithRetry(apiUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const rows = (await res.json()) as Array<{ page_number: number; image?: string }>;
    if (Array.isArray(rows) && rows.length > 0) {
      const sorted = rows
        .filter((r) => Boolean(r.image))
        .sort((a, b) => a.page_number - b.page_number)
        .map((r) => r.image as string);
      if (sorted.length > 0) {
        return { date, imageUrls: sorted };
      }
    }
  }
  throw new Error("No recent issue images found on epaper.prabhanews.com");
}

async function fetchLoktejPages(): Promise<{ date: string; imageUrls: string[] }> {
  const res = await fetchWithRetry("https://epaper.loktej.com/");
  if (!res.ok) throw new Error(`Loktej HTTP ${res.status}`);
  const html = await res.text();

  const dateMatch = html.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/)?.[1] || todayIsoIst();
  const pageMatches = Array.from(
    html.matchAll(
      /"pg_order":"(\d+)"[^}]*"attachment":\{[^}]*"f_folder":"([^"]+)","f_filename":"([^"]+\.jpg)"/g
    )
  );

  const seen = new Set<string>();
  const ordered: Array<{ order: number; url: string }> = [];
  for (const m of pageMatches) {
    const order = Number(m[1]);
    const url = `https://epaper.loktej.com/media/${m[2]}/${m[3]}`;
    if (!seen.has(url)) {
      seen.add(url);
      ordered.push({ order, url });
    }
  }
  ordered.sort((a, b) => a.order - b.order);

  if (ordered.length === 0) {
    throw new Error("No page images found on epaper.loktej.com");
  }
  return { date: dateMatch, imageUrls: ordered.map((o) => o.url) };
}

async function fetchDainikJanambhumiPages(): Promise<{ date: string; imageUrls: string[] }> {
  const homeRes = await fetchWithRetry("https://s2.dainikjanambhumi.co.in/");
  if (!homeRes.ok) throw new Error(`Dainik Janambhumi HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const editionPath = homeHtml.match(/href=["'](\/edition\/\d+\/[^"']+)["']/i)?.[1];
  if (!editionPath) {
    throw new Error("No latest edition link found on s2.dainikjanambhumi.co.in");
  }

  const edRes = await fetchWithRetry(`https://s2.dainikjanambhumi.co.in${editionPath}`);
  if (!edRes.ok) throw new Error(`Dainik Janambhumi edition HTTP ${edRes.status}`);
  const edHtml = await edRes.text();

  const normalized = edHtml.replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  const urls = Array.from(
    new Set(
      normalized.match(
        /https:\/\/s2\.dainikjanambhumi\.co\.in\/uploads\/epaper\/[^\s"'<>\\)]+\.jpg/gi
      ) || []
    )
  );

  if (urls.length === 0) {
    throw new Error(`No page images found on ${editionPath}`);
  }
  return { date: todayIsoIst(), imageUrls: urls };
}

/**
 * List official regional papers supported via the Image-to-PDF engine.
 */
export function listOfficialRegional(search?: string): OfficialRegionalEntry[] {
  const q = search ? search.trim().toLowerCase() : "";
  return q
    ? OFFICIAL_REGIONAL_PAPERS.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.slug.includes(q) ||
          p.state.toLowerCase().includes(q) ||
          p.language.toLowerCase().includes(q)
      )
    : OFFICIAL_REGIONAL_PAPERS;
}

/**
 * Download today's edition from an official regional ePaper site and assemble into PDF.
 */
export async function downloadOfficialRegional(
  paperInput: string,
  outDir: string
): Promise<DownloadResult & { pages: number }> {
  const q = paperInput.trim().toLowerCase();
  const entry =
    OFFICIAL_REGIONAL_PAPERS.find((p) => p.slug === q || p.name.toLowerCase() === q) ||
    OFFICIAL_REGIONAL_PAPERS.find((p) => p.slug.includes(q) || p.name.toLowerCase().includes(q));

  if (!entry) {
    throw new Error(
      `Paper "${paperInput}" is not in the official regional provider. Available: ${OFFICIAL_REGIONAL_PAPERS.map((p) => p.slug).join(", ")}`
    );
  }

  let data: { date: string; imageUrls: string[] };
  switch (entry.slug) {
    case "pragativadi":
      data = await fetchPragativadiPages();
      break;
    case "andhra-prabha":
      data = await fetchAndhraPrabhaPages();
      break;
    case "loktej":
      data = await fetchLoktejPages();
      break;
    case "dainik-janambhumi":
      data = await fetchDainikJanambhumiPages();
      break;
    default:
      throw new Error(`Unsupported official regional slug: ${entry.slug}`);
  }

  const safeDate = data.date.replace(/[/\s]+/g, "-");
  const fileName = `${entry.slug}-${safeDate}.pdf`;
  const built = await downloadImagesToPdf(data.imageUrls, path.join(outDir, fileName), 8);

  return {
    source: "official" as any,
    paper: entry.name,
    date: data.date,
    fileName,
    filePath: built.filePath,
    sizeBytes: built.sizeBytes,
    sizeMB: built.sizeMB,
    pages: built.pages,
  };
}
