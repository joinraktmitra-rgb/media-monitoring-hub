import path from "node:path";
import {
  type CookieJar,
  createCookieJar,
  decodeHtml,
  fetchWithRetry,
  parseContentDispositionFilename,
  savePdfAtomically,
} from "../http.ts";
import { type DownloadResult, normalizeDateKey } from "./dailyepaper.ts";

const DIRECTORY_URL = "https://www.indiags.com/epaper-pdf-download";

export interface IndiaGsEntry {
  source: "indiags";
  id: string;
  slug: string;
  name: string;
  date: string;
  bookUrl: string;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseIndiaGsCards(html: string): IndiaGsEntry[] {
  const cards: IndiaGsEntry[] = [];
  const seen = new Set<string>();
  const cardRegex = /class="ep-card"[^>]*>([\s\S]*?)https:\/\/www\.indiags\.com\/epaper\/books\/(\d+)/gi;

  for (const match of html.matchAll(cardRegex)) {
    const id = match[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const text = decodeHtml(match[1]).replace(/^PDF Available\s*/i, "");
    const dateMatch = text.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
    const date = dateMatch ? dateMatch[1] : "Today";
    const name = text
      .replace(date, "")
      .replace(/Read instantly.*$/i, "")
      .trim();

    cards.push({
      source: "indiags",
      id,
      slug: toSlug(name),
      name,
      date,
      bookUrl: `https://www.indiags.com/epaper/books/${id}`,
    });
  }

  return cards;
}

/**
 * List available daily ePapers from indiags.com/epaper-pdf-download.
 */
export async function listIndiaGs(search?: string, jar?: CookieJar): Promise<IndiaGsEntry[]> {
  const res = await fetchWithRetry(DIRECTORY_URL, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  jar?.updateFromHeaders(res.headers);
  if (!res.ok) {
    throw new Error(`Failed to fetch indiags.com directory (HTTP ${res.status})`);
  }
  const html = await res.text();
  const cards = parseIndiaGsCards(html);

  const q = search ? search.trim().toLowerCase() : "";
  return q
    ? cards.filter((c) => c.name.toLowerCase().includes(q) || c.slug.includes(q) || c.id === q)
    : cards;
}

/**
 * Download a newspaper PDF from indiags.com by walking its Laravel session funnel.
 */
export async function downloadIndiaGs(
  paperInput: string,
  outDir: string,
  date?: string
): Promise<DownloadResult> {
  const jar = createCookieJar();
  const cards = await listIndiaGs(undefined, jar);
  const q = paperInput.trim().toLowerCase();

  const paper =
    cards.find((c) => c.id === q || c.slug === q || c.name.toLowerCase() === q) ||
    cards.find((c) => c.slug.includes(q) || c.name.toLowerCase().includes(q));

  if (!paper) {
    throw new Error(
      `Newspaper "${paperInput}" not found on indiags.com. Available: ${cards.map((c) => c.slug).join(", ")}`
    );
  }

  if (date && normalizeDateKey(date) !== normalizeDateKey(paper.date)) {
    throw new Error(
      `indiags only has ${paper.name} for "${paper.date}", not "${date}".`
    );
  }

  for (const stepUrl of [
    `https://www.indiags.com/epaper/books/${paper.id}`,
    `https://www.indiags.com/epaper/newsletter/${paper.id}`,
  ]) {
    const stepRes = await fetchWithRetry(stepUrl, {
      headers: { Cookie: jar.toHeader(), Referer: DIRECTORY_URL },
    });
    jar.updateFromHeaders(stepRes.headers);
    if (!stepRes.ok) {
      throw new Error(`indiags funnel failed at ${stepUrl} (HTTP ${stepRes.status})`);
    }
    await stepRes.arrayBuffer();
  }

  const openRes = await fetchWithRetry(`https://www.indiags.com/epaper/open/${paper.id}`, {
    redirect: "manual",
    headers: {
      Cookie: jar.toHeader(),
      Referer: `https://www.indiags.com/epaper/newsletter/${paper.id}`,
    },
  });
  jar.updateFromHeaders(openRes.headers);

  const location = openRes.headers.get("location") || "";
  const hashIdx = location.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(`Expected #unlock redirect from /epaper/open/${paper.id}, got ${openRes.status}`);
  }

  const unlockUrl = new URLSearchParams(location.slice(hashIdx + 1)).get("unlock");
  if (!unlockUrl) {
    throw new Error(`Missing unlock URL in redirect fragment: ${location}`);
  }

  const pdfRes = await fetchWithRetry(unlockUrl, {
    headers: { Cookie: jar.toHeader(), Referer: location.slice(0, hashIdx) },
  });
  if (!pdfRes.ok || !pdfRes.body) {
    throw new Error(`Failed to download PDF from ${unlockUrl} (HTTP ${pdfRes.status})`);
  }

  const fallbackName = `${paper.slug}-${paper.date.replace(/\s+/g, "-")}.pdf`;
  const fileName = parseContentDispositionFilename(
    pdfRes.headers.get("content-disposition"),
    fallbackName
  );
  const saved = await savePdfAtomically(pdfRes.body, path.join(outDir, fileName));

  return {
    source: "indiags",
    paper: paper.name,
    date: paper.date,
    fileName,
    ...saved,
  };
}
