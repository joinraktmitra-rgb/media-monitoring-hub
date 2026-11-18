import path from "node:path";
import {
  decodeHtml,
  fetchWithRetry,
  parseContentDispositionFilename,
  savePdfAtomically,
} from "../http.ts";

const DIRECTORY_URL = "https://dailyepaper.in/daily-news/";
const WP_POSTS_URL =
  "https://dailyepaper.in/wp-json/wp/v2/posts?per_page=100&_fields=slug,link,title";
const EXCLUDED_PATHS = new Set([
  "/",
  "/daily-news/",
  "/about/",
  "/about-us/",
  "/contact-us/",
  "/privacy-policy/",
  "/privacy-policy-us/",
  "/disclaimer/",
  "/dmca/",
  "/dmca-now/",
]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export interface DailyEpaperEntry {
  source: "dailyepaper";
  slug: string;
  name: string;
  url: string;
}

export interface DailyEpaperIssue {
  date: string;
  dateKey: string;
  host: "gdrive" | "telegram" | "other";
  status: "direct" | "telegram_only" | "external";
  fileId: string | null;
  directDownloadUrl: string | null;
  viewUrl: string;
}

export interface DownloadResult {
  source: "dailyepaper" | "indiags";
  paper: string;
  date: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sizeMB: number;
}

function extractShortSlug(pathname: string): string {
  return pathname
    .replace(/^\/|\/$/g, "")
    .replace(/-epaper.*$/, "")
    .replace(/-newspaper.*$/, "")
    .replace(/-free-download.*$/, "")
    .replace(/-download.*$/, "");
}

export function normalizeDateKey(input: string): string {
  const s = input.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const monthName = MONTHS[Number(iso[2]) - 1];
    return `${String(Number(iso[3])).padStart(2, "0")} ${monthName} ${iso[1]}`;
  }
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (dmy) {
    return `${dmy[1].padStart(2, "0")} ${dmy[2].toLowerCase()} ${dmy[3]}`;
  }
  return s.toLowerCase();
}

export function extractDriveFileId(url: string): string | null {
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const openMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (url.includes("drive.google.com") && openMatch) return openMatch[1];
  return null;
}

function cleanWpTitle(rendered: string): string {
  return decodeHtml(rendered)
    .replace(/\s+(ePaper|Newspaper)\s+(Free\s+)?Download.*$/i, "")
    .replace(/\s+PDF\s+Free\s+Download.*$/i, "")
    .replace(/\s+Today\s+(Free\s+)?Download.*$/i, "")
    .trim();
}

/**
 * List all newspapers from dailyepaper.in via WordPress REST API (with HTML directory fallback).
 */
export async function listDailyEpaper(search?: string): Promise<DailyEpaperEntry[]> {
  let papers: DailyEpaperEntry[] = [];

  try {
    const wpRes = await fetchWithRetry(WP_POSTS_URL, {
      headers: { Accept: "application/json" },
    });
    if (wpRes.ok) {
      const posts = (await wpRes.json()) as Array<{
        slug: string;
        link: string;
        title?: { rendered?: string };
      }>;
      papers = posts.map((p) => {
        const pathname = new URL(p.link).pathname;
        return {
          source: "dailyepaper" as const,
          slug: extractShortSlug(pathname),
          name: cleanWpTitle(p.title?.rendered || p.slug),
          url: p.link,
        };
      });
    }
  } catch {
    // Fallback to HTML directory parsing below
  }

  if (papers.length === 0) {
    const res = await fetchWithRetry(DIRECTORY_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch dailyepaper.in directory (HTTP ${res.status})`);
    }
    const html = await res.text();
    const linkRegex = /<a[^>]+href=["'](https:\/\/dailyepaper\.in\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set<string>();

    for (const match of html.matchAll(linkRegex)) {
      const url = match[1];
      const name = decodeHtml(match[2]);
      if (!name || name.toLowerCase() === "download now" || name.toLowerCase() === "download all") {
        continue;
      }

      const parsed = new URL(url);
      if (
        EXCLUDED_PATHS.has(parsed.pathname) ||
        parsed.pathname.includes("/wp-") ||
        parsed.pathname.endsWith("-newspapers/") ||
        /^\/\d{4}\//.test(parsed.pathname)
      ) {
        continue;
      }

      if (seen.has(url)) continue;
      seen.add(url);

      papers.push({
        source: "dailyepaper",
        slug: extractShortSlug(parsed.pathname),
        name,
        url,
      });
    }
  }

  const q = search ? search.trim().toLowerCase() : "";
  return q
    ? papers.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          p.url.toLowerCase().includes(q)
      )
    : papers;
}

async function resolvePaperEntry(paperInput: string): Promise<DailyEpaperEntry> {
  const raw = paperInput.trim();
  if (!raw) {
    throw new Error("Paper name, slug, or URL is required.");
  }
  if (/^https?:\/\/dailyepaper\.in\//i.test(raw)) {
    const parsed = new URL(raw);
    return {
      source: "dailyepaper",
      slug: extractShortSlug(parsed.pathname),
      name: extractShortSlug(parsed.pathname),
      url: raw,
    };
  }

  const papers = await listDailyEpaper();
  const q = raw.toLowerCase();
  const exact = papers.find(
    (p) => p.slug === q || p.name.toLowerCase() === q || new URL(p.url).pathname.replace(/^\/|\/$/g, "") === q
  );
  if (exact) return exact;

  const partial = papers.find(
    (p) => p.slug.includes(q) || p.name.toLowerCase().includes(q) || p.url.toLowerCase().includes(q)
  );
  if (partial) return partial;

  throw new Error(`Newspaper "${paperInput}" not found on dailyepaper.in`);
}

/**
 * Fetch dated issue links from a dailyepaper.in newspaper page.
 */
export async function getDailyEpaperIssues(
  paperInput: string,
  limit = 15
): Promise<{ paper: DailyEpaperEntry; issues: DailyEpaperIssue[] }> {
  const paper = await resolvePaperEntry(paperInput);
  const res = await fetchWithRetry(paper.url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${paper.url} (HTTP ${res.status})`);
  }
  const html = await res.text();

  const rowRegex = /<p[^>]*>\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*:([\s\S]*?)<\/p>/gi;
  const issues: DailyEpaperIssue[] = [];

  for (const match of html.matchAll(rowRegex)) {
    const date = match[1].replace(/\s+/g, " ").trim();
    const body = match[2];
    const links = Array.from(body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)).map((m) => m[1]);
    if (links.length === 0) continue;

    const driveUrl = links.find((u) => u.includes("drive.google.com"));
    const chosen = driveUrl || links[0];
    const fileId = extractDriveFileId(chosen);
    const isTelegram = chosen.includes("t.me/");

    issues.push({
      date,
      dateKey: normalizeDateKey(date),
      host: fileId ? "gdrive" : isTelegram ? "telegram" : "other",
      status: fileId ? "direct" : isTelegram ? "telegram_only" : "external",
      fileId,
      directDownloadUrl: fileId
        ? `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`
        : null,
      viewUrl: chosen,
    });

    if (issues.length >= limit) break;
  }

  if (issues.length === 0) {
    throw new Error(`No dated issues found on ${paper.url}`);
  }

  return { paper, issues };
}

async function resolveDriveStream(fileId: string): Promise<Response> {
  const initialUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  const res = await fetchWithRetry(initialUrl, { redirect: "follow" });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return res;
  }

  const html = await res.text();
  const actionMatch = html.match(/<form[^>]+id=["']download-form["'][^>]+action=["']([^"']+)["']/i);
  if (!actionMatch) {
    throw new Error(`Google Drive returned HTML instead of PDF for file ${fileId} (quota or access error)`);
  }

  const confirmUrl = new URL(actionMatch[1].replace(/&amp;/g, "&"));
  for (const inputMatch of html.matchAll(/<input[^>]+type=["']hidden["'][^>]*>/gi)) {
    const tag = inputMatch[0];
    const nameM = tag.match(/name=["']([^"']+)["']/i);
    const valM = tag.match(/value=["']([^"']*)["']/i);
    if (nameM && valM) {
      confirmUrl.searchParams.set(nameM[1], valM[1]);
    }
  }

  const confirmedRes = await fetchWithRetry(confirmUrl.toString(), { redirect: "follow" });
  if ((confirmedRes.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(`Google Drive confirmation still returned HTML for file ${fileId}`);
  }
  return confirmedRes;
}

/**
 * Download a newspaper PDF from dailyepaper.in via its direct Google Drive link.
 */
export async function downloadDailyEpaper(
  paperInput: string,
  outDir: string,
  date?: string
): Promise<DownloadResult> {
  const { paper, issues } = await getDailyEpaperIssues(paperInput, 200);

  let target: DailyEpaperIssue | undefined;
  if (date) {
    const key = normalizeDateKey(date);
    target = issues.find((i) => i.dateKey === key);
    if (!target) {
      throw new Error(`Issue for date "${date}" not found. Latest available: ${issues[0].date}`);
    }
    if (!target.fileId) {
      throw new Error(`Issue ${target.date} for ${paper.name} is ${target.status} (no direct PDF).`);
    }
  } else {
    target = issues.find((i) => Boolean(i.fileId));
    if (!target || !target.fileId) {
      throw new Error(
        `${paper.name} has no direct Google Drive PDFs on dailyepaper.in (Telegram-only / DMCA).`
      );
    }
  }

  const driveRes = await resolveDriveStream(target.fileId);
  if (!driveRes.body) {
    throw new Error(`Empty response body from Google Drive for ${paper.name}`);
  }

  const fallbackName = `${paper.slug}-${target.date.replace(/\s+/g, "-")}.pdf`;
  const fileName = parseContentDispositionFilename(
    driveRes.headers.get("content-disposition"),
    fallbackName
  );
  const saved = await savePdfAtomically(driveRes.body, path.join(outDir, fileName));

  return {
    source: "dailyepaper",
    paper: paper.name,
    date: target.date,
    fileName,
    ...saved,
  };
}
