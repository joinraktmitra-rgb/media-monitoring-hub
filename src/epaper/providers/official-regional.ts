import path from "node:path";
import { fetchWithRetry } from "../http.ts";
import {
  downloadImagesToPdf,
  downloadPngsToPdf,
  mergePdfUrlsToPdf,
  type BuildPdfResult,
} from "../pdf-builder.ts";
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
  {
    source: "official",
    slug: "millennium-post",
    name: "Millennium Post",
    state: "Delhi & Kolkata",
    language: "English",
    url: "https://www.millenniumpost.in/epaper/",
  },
  {
    source: "official",
    slug: "daily-guardian",
    name: "The Daily Guardian",
    state: "Delhi NCR",
    language: "English",
    url: "https://epaper.thedailyguardian.com/",
  },
  {
    source: "official",
    slug: "top-story",
    name: "Top Story",
    state: "Delhi NCR & UP",
    language: "English",
    url: "https://epaper.topstory.online/",
  },
  {
    source: "official",
    slug: "navodaya-times",
    name: "Navodaya Times",
    state: "Delhi NCR",
    language: "Hindi",
    url: "https://epaper.navodayatimes.in/",
  },
  {
    source: "official",
    slug: "deshbandhu",
    name: "Deshbandhu",
    state: "National & Central India",
    language: "Hindi",
    url: "https://www.deshbandhu.co.in/epaper/national",
  },
  {
    source: "official",
    slug: "vir-arjun",
    name: "Vir Arjun",
    state: "Delhi NCR",
    language: "Hindi",
    url: "https://epapervirarjun.com/",
  },
  {
    source: "official",
    slug: "viraat-vaibhav",
    name: "Viraat Vaibhav",
    state: "Delhi & Rajasthan",
    language: "Hindi",
    url: "https://epaper.viraatvaibhav.com/",
  },
  {
    source: "official",
    slug: "loksatya",
    name: "Loksatya",
    state: "Delhi NCR",
    language: "Hindi",
    url: "https://epaper.loksatya.com/",
  },
  {
    source: "official",
    slug: "action-india",
    name: "Action India",
    state: "Delhi NCR & North India",
    language: "Hindi",
    url: "https://epaper.actionindialive.com/",
  },
  {
    source: "official",
    slug: "shah-times",
    name: "Shah Times",
    state: "Delhi NCR, UP & Uttarakhand",
    language: "Hindi",
    url: "https://shahtimesnews.com/epapers",
  },
  {
    source: "official",
    slug: "info-india",
    name: "Info India",
    state: "West Bengal & Eastern India",
    language: "Hindi",
    url: "http://www.echoofindia.com/ePaper/index.aspx?page=SUk=",
  },
  {
    source: "official",
    slug: "focus-news",
    name: "Focus News",
    state: "Telangana & Andhra Pradesh",
    language: "Telugu",
    url: "http://epaper.netifocusnews.com/",
  },
  {
    source: "official",
    slug: "aaj-samaj",
    name: "Aaj Samaj",
    state: "Haryana & Delhi NCR",
    language: "Hindi",
    url: "https://www.aajsamaaj.com/",
  },
];

type FetchResult = {
  date: string;
  urls: string[];
  format?: "jpeg" | "png" | "pdf";
};

function todayIsoIst(): string {
  // IST is UTC+5:30
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function yesterdayIsoIst(): string {
  const prev = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return prev.toISOString().slice(0, 10);
}

async function fetchPragativadiPages(): Promise<FetchResult> {
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

  return { date: titleDate, urls: imageUrls };
}

async function fetchAndhraPrabhaPages(): Promise<FetchResult> {
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
        return { date, urls: sorted };
      }
    }
  }
  throw new Error("No recent issue images found on epaper.prabhanews.com");
}

async function fetchLoktejPages(): Promise<FetchResult> {
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
  return { date: dateMatch, urls: ordered.map((o) => o.url) };
}

async function fetchDainikJanambhumiPages(): Promise<FetchResult> {
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
  return { date: todayIsoIst(), urls };
}

/**
 * Shared Hocalwire full-page-pdf extractor (Millennium Post, Deshbandhu).
 */
async function fetchHocalwirePages(
  host: string,
  listingUrl: string,
  editionPattern: RegExp
): Promise<FetchResult> {
  const homeRes = await fetchWithRetry(listingUrl);
  if (!homeRes.ok) throw new Error(`Hocalwire listing HTTP ${homeRes.status} (${listingUrl})`);
  const homeHtml = await homeRes.text();

  const today = todayIsoIst();
  const candidates: Array<{ href: string; isoDate: string }> = [];
  for (const m of homeHtml.matchAll(/href=["'](\/full-page-pdf\/epaper\/pdf\/[^"']+)["']/gi)) {
    const href = m[1];
    if (!editionPattern.test(href)) continue;
    const d = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    const isoDate = d ? `${d[1]}-${d[2]}-${d[3]}` : today;
    // Skip bogus future-dated test issues (e.g. 2027)
    if (isoDate > today) continue;
    candidates.push({ href, isoDate });
  }

  candidates.sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  const best = candidates[0];
  if (!best) {
    throw new Error(`No valid edition link found on ${listingUrl}`);
  }

  const edRes = await fetchWithRetry(`${host}${best.href}`);
  if (!edRes.ok) throw new Error(`Edition page HTTP ${edRes.status} (${best.href})`);
  const edHtml = await edRes.text();

  const pageMap = new Map<number, string>();
  const regex = /(?:https?:\/\/[^"'\s<>]+)?(\/h-upload\/[^"'\s<>]+-page(\d+)\.jpg)/gi;
  for (const m of edHtml.matchAll(regex)) {
    const pageNum = Number(m[2]);
    const fullUrl = `${host}${m[1]}`;
    if (!pageMap.has(pageNum)) {
      pageMap.set(pageNum, fullUrl);
    }
  }

  const ordered = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, url]) => url);

  if (ordered.length === 0) {
    throw new Error(`No page JPEGs found on ${host}${best.href}`);
  }
  return { date: best.isoDate, urls: ordered };
}

async function fetchMillenniumPostPages(): Promise<FetchResult> {
  return fetchHocalwirePages(
    "https://www.millenniumpost.in",
    "https://www.millenniumpost.in/epaper/",
    /\/delhi\//i
  );
}

async function fetchDeshbandhuPages(): Promise<FetchResult> {
  return fetchHocalwirePages(
    "https://www.deshbandhu.co.in",
    "https://www.deshbandhu.co.in/epaper/national",
    /\/national\//i
  );
}

async function fetchDailyGuardianPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://epaper.thedailyguardian.com/");
  if (!homeRes.ok) throw new Error(`The Daily Guardian HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const postLinks = Array.from(
    new Set(
      Array.from(
        homeHtml.matchAll(
          /href=["'](https:\/\/epaper\.thedailyguardian\.com\/\d{4}\/\d{2}\/\d{2}\/[^"']+)["']/gi
        )
      ).map((m) => m[1])
    )
  );
  const delhiPost =
    postLinks.find((u) => /delhi/i.test(u)) || postLinks[0];
  if (!delhiPost) {
    throw new Error("No edition post found on epaper.thedailyguardian.com");
  }

  const postRes = await fetchWithRetry(delhiPost);
  if (!postRes.ok) throw new Error(`The Daily Guardian post HTTP ${postRes.status}`);
  const postHtml = await postRes.text();

  const dateMatch = delhiPost.match(/(\d{1,2}-[a-z]+-\d{4})/i)?.[1] || todayIsoIst();
  const rawImgs = Array.from(
    new Set(
      postHtml.match(
        /https:\/\/epaper\.thedailyguardian\.com\/wp-content\/uploads\/[^\s"'<>]+-images-\d+(?:-\d+x\d+|-scaled)?\.jpg/gi
      ) || []
    )
  );

  // Group by page index (images-0, images-1, ...) and prefer -scaled.jpg if present
  // Filter to the main edition prefix (ignore sidebar related-edition thumbnails like Chandigarh/Jaipur)
  const prefixCounts = new Map<string, number>();
  for (const u of rawImgs) {
    const prefix = u.replace(/-images-\d+.*$/, "");
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }
  const mainPrefix = Array.from(prefixCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!mainPrefix) {
    throw new Error(`No page images found in ${delhiPost}`);
  }

  const pageMap = new Map<number, string>();
  for (const u of rawImgs) {
    if (!u.startsWith(mainPrefix)) continue;
    const idxMatch = u.match(/-images-(\d+)/);
    if (!idxMatch) continue;
    const idx = Number(idxMatch[1]);
    const existing = pageMap.get(idx);
    if (!existing || u.includes("-scaled.jpg")) {
      pageMap.set(idx, u);
    }
  }

  const ordered = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, u]) => u);

  if (ordered.length === 0) {
    throw new Error(`No ordered page images found in ${delhiPost}`);
  }

  // Upgrade -672x1024.jpg to -scaled.jpg if the server serves it
  if (ordered.length > 1 && /-\d+x\d+\.jpg$/.test(ordered[1])) {
    const scaledCandidate = ordered[1].replace(/-\d+x\d+\.jpg$/, "-scaled.jpg");
    try {
      const probe = await fetchWithRetry(scaledCandidate, {
        headers: { Range: "bytes=0-31" },
      });
      if (probe.ok) {
        for (let i = 0; i < ordered.length; i++) {
          ordered[i] = ordered[i].replace(/-\d+x\d+\.jpg$/, "-scaled.jpg");
        }
      }
    } catch {
      // keep original -672x1024.jpg URLs
    }
  }

  return { date: dateMatch, urls: ordered };
}

async function fetchTopStoryPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://epaper.topstory.online/");
  if (!homeRes.ok) throw new Error(`Top Story HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const editionPath = homeHtml.match(/href=["']([^"']*\/edition\/\d+[^"']*)["']/i)?.[1];
  if (!editionPath) {
    throw new Error("No latest edition link found on epaper.topstory.online");
  }

  const edUrl = editionPath.startsWith("http")
    ? editionPath
    : `https://epaper.topstory.online${editionPath.startsWith("/") ? "" : "/"}${editionPath}`;
  const edRes = await fetchWithRetry(edUrl);
  if (!edRes.ok) throw new Error(`Top Story edition HTTP ${edRes.status}`);
  const edHtml = await edRes.text();

  const normalized = edHtml.replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  const relPaths = Array.from(
    new Set(normalized.match(/\/uploads\/epaper\/[^\s"'<>\\)]+\.jpg/gi) || [])
  );
  if (relPaths.length === 0) {
    throw new Error(`No page images found on ${edUrl}`);
  }

  const urls = relPaths.map((p) => `https://epaper.topstory.online${p}`);
  return { date: todayIsoIst(), urls };
}

async function fetchNavodayaTimesPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://epaper.navodayatimes.in/");
  if (!homeRes.ok) throw new Error(`Navodaya Times HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const editionUrl =
    homeHtml.match(
      /href=["'](https:\/\/epaper\.navodayatimes\.in\/delhi\/\d{4}-\d{2}-\d{2}\/main-edition)["']/i
    )?.[1] ||
    homeHtml.match(
      /href=["'](https:\/\/epaper\.navodayatimes\.in\/delhi\/\d{4}-\d{2}-\d{2}\/[^"']+)["']/i
    )?.[1];
  if (!editionUrl) {
    throw new Error("No Delhi edition link found on epaper.navodayatimes.in");
  }

  const dateMatch = editionUrl.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || todayIsoIst();
  const edRes = await fetchWithRetry(editionUrl);
  if (!edRes.ok) throw new Error(`Navodaya Times edition HTTP ${edRes.status}`);
  const edHtml = await edRes.text();

  const pageMap = new Map<number, string>();
  const regex =
    /https:\/\/epaperimg\.navodayatimes\.in\/navodayatimes\/\d+\/[^\s"'<>]+_pg_(\d+)-s\.png/gi;
  for (const m of edHtml.matchAll(regex)) {
    const pgNum = Number(m[1]);
    if (!pageMap.has(pgNum)) {
      pageMap.set(pgNum, m[0]);
    }
  }

  const ordered = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, u]) => u);

  if (ordered.length === 0) {
    throw new Error(`No full-page PNGs found on ${editionUrl}`);
  }
  return { date: dateMatch, urls: ordered, format: "png" };
}

async function fetchVirArjunPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://epapervirarjun.com/");
  if (!homeRes.ok) throw new Error(`Vir Arjun HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  // Extract date folder and prefix, e.g. epaperpdf//19112026//19112026-md-hr-1.pdf
  const pdfMatch = homeHtml.match(
    /epaperpdf\/+(\d{8})\/+(\d{8}-[a-z0-9-]+-)(\d+)\.pdf/i
  );
  if (!pdfMatch) {
    throw new Error("Could not detect current issue date/prefix on epapervirarjun.com");
  }

  const folder = pdfMatch[1];
  const prefix = pdfMatch[2];
  const dateStr = `${folder.slice(4, 8)}-${folder.slice(2, 4)}-${folder.slice(0, 2)}`;

  // Probe sequential native per-page PDFs (1..32) until 404
  const pdfUrls: string[] = [];
  for (let p = 1; p <= 32; p++) {
    const url = `https://epapervirarjun.com/epaperpdf/${folder}/${prefix}${p}.pdf`;
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) {
        pdfUrls.push(url);
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  if (pdfUrls.length === 0) {
    throw new Error(`No native PDF pages found for Vir Arjun (${folder})`);
  }
  return { date: dateStr, urls: pdfUrls, format: "pdf" };
}

async function fetchLoksatyaPages(): Promise<FetchResult> {
  const res = await fetchWithRetry("https://epaper.loksatya.com/");
  if (!res.ok) throw new Error(`Loksatya HTTP ${res.status}`);
  const html = await res.text();

  const pageMap = new Map<number, string>();
  let detectedDate = todayIsoIst();
  // Match strictly date-edition-section-page.jpg, avoiding -400.jpg thumbnail suffix
  const regex = /epaperimages\/+(\d{8})\/+(\d{8}-[a-z]+-[a-z]+-)(\d+)\.jpg/gi;
  for (const m of html.matchAll(regex)) {
    const folder = m[1];
    const prefix = m[2];
    const pageNum = Number(m[3]);
    detectedDate = `${folder.slice(4, 8)}-${folder.slice(2, 4)}-${folder.slice(0, 2)}`;
    const url = `https://epaper.loksatya.com/epaperimages/${folder}/${prefix}${pageNum}.jpg`;
    if (!pageMap.has(pageNum)) {
      pageMap.set(pageNum, url);
    }
  }

  const ordered = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, u]) => u);

  if (ordered.length === 0) {
    throw new Error("No page images found on epaper.loksatya.com");
  }
  return { date: detectedDate, urls: ordered };
}

async function fetchViraatVaibhavPages(): Promise<FetchResult> {
  const res = await fetchWithRetry("https://epaper.viraatvaibhav.com/");
  if (!res.ok) throw new Error(`Viraat Vaibhav HTTP ${res.status}`);
  const html = await res.text();

  const pageMap = new Map<number, string>();
  let detectedDate = todayIsoIst();
  // Match strictly date-edition-section-page(ss).jpg
  const regex = /epaperimages\/+(\d{8})\/+(\d{8}-[a-z]+-[a-z]+-)(\d+)(?:ss)?\.jpg/gi;
  for (const m of html.matchAll(regex)) {
    const folder = m[1];
    const prefix = m[2];
    const pageNum = Number(m[3]);
    detectedDate = `${folder.slice(4, 8)}-${folder.slice(2, 4)}-${folder.slice(0, 2)}`;
    const url = `https://epaper.viraatvaibhav.com/epaperimages/${folder}/${prefix}${pageNum}.jpg`;
    if (!pageMap.has(pageNum)) {
      pageMap.set(pageNum, url);
    }
  }

  const ordered = Array.from(pageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, u]) => u);

  if (ordered.length === 0) {
    throw new Error("No page images found on epaper.viraatvaibhav.com");
  }
  return { date: detectedDate, urls: ordered };
}

async function fetchActionIndiaPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://epaper.actionindialive.com/");
  if (!homeRes.ok) throw new Error(`Action India HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const openUrl =
    homeHtml.match(/href=["'](https:\/\/epaper\.actionindialive\.com\/epaper\/default\/open\?id=\d+)["']/i)?.[1] ||
    "https://epaper.actionindialive.com/epaper/default/open?id=12";

  const edRes = await fetchWithRetry(openUrl, { redirect: "follow" });
  if (!edRes.ok) throw new Error(`Action India edition HTTP ${edRes.status}`);
  const edHtml = await edRes.text();

  const dateMatch = edHtml.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/)?.[1] || todayIsoIst();
  const pageMatches = Array.from(
    edHtml.matchAll(
      /"pg_order":"(\d+)"[^}]*"attachment":\{[^}]*"f_folder":"([^"]+)","f_filename":"([^"]+\.jpg)"/g
    )
  );

  const seen = new Set<string>();
  const ordered: Array<{ order: number; url: string }> = [];
  for (const m of pageMatches) {
    const order = Number(m[1]);
    const url = `https://epaper.actionindialive.com/media/${m[2]}/${m[3]}`;
    if (!seen.has(url)) {
      seen.add(url);
      ordered.push({ order, url });
    }
  }
  ordered.sort((a, b) => a.order - b.order);

  if (ordered.length === 0) {
    throw new Error(`No page images found on ${edRes.url}`);
  }
  return { date: dateMatch, urls: ordered.map((o) => o.url) };
}

async function fetchShahTimesPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("https://shahtimesnews.com/epapers");
  if (!homeRes.ok) throw new Error(`Shah Times HTTP ${homeRes.status}`);
  const html = await homeRes.text();

  const pdfMatch = html.match(/href=["']\/view\/(SHAHTIMES_[^"']+\.pdf)["']/i);
  if (!pdfMatch) {
    throw new Error("No recent edition PDF found on shahtimesnews.com/epapers");
  }

  const pdfUrl = `https://shahtimesnews.com/paper/${pdfMatch[1]}`;
  const dateMatch = pdfMatch[1].match(/([A-Za-z]+_\d+)/)?.[1] || todayIsoIst();

  return { date: dateMatch, urls: [pdfUrl], format: "pdf" };
}

async function fetchInfoIndiaPages(): Promise<FetchResult> {
  const res = await fetch("http://www.echoofindia.com/WebService/Master.asmx/GetPdfDocument", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ company_key: 3, edition_key: 1 }),
  });
  if (!res.ok) throw new Error(`Info India WebService HTTP ${res.status}`);
  const data = (await res.json()) as { d?: Array<{ PDF_DOCUMENT?: string }> };
  const doc = data.d?.[0]?.PDF_DOCUMENT;
  if (!doc) throw new Error("No PDF_DOCUMENT returned by echoofindia.com for Info India");

  const pageNames = doc
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pageNames.length === 0) throw new Error("No pages in Info India issue");

  const urls = pageNames.map((p) => `http://www.echoofindia.com/Documents/PDF/${p}`);
  const dateMatch = pageNames[0].match(/(\d{4}-\d{2}-\d{2})/)?.[1] || todayIsoIst();

  return { date: dateMatch, urls, format: "pdf" };
}

async function fetchFocusNewsPages(): Promise<FetchResult> {
  const homeRes = await fetchWithRetry("http://epaper.netifocusnews.com/");
  if (!homeRes.ok) throw new Error(`Focus News HTTP ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  const openUrl =
    homeHtml.match(
      /href=["'](https?:\/\/epaper\.netifocusnews\.com\/epaper\/default\/open\?id=\d+)["']/i
    )?.[1] || "https://epaper.netifocusnews.com/epaper/default/open?id=8";

  const edRes = await fetchWithRetry(openUrl);
  if (!edRes.ok) throw new Error(`Focus News edition HTTP ${edRes.status}`);
  const edHtml = await edRes.text();

  const dateMatch = edHtml.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/)?.[1] || todayIsoIst();
  const pageMatches = Array.from(
    edHtml.matchAll(
      /"pg_order":"(\d+)"[^}]*"attachment":\{[^}]*"f_folder":"([^"]+)","f_filename":"([^"]+\.jpg)"/g
    )
  );

  const seen = new Set<string>();
  const ordered: Array<{ order: number; url: string }> = [];
  for (const m of pageMatches) {
    const order = Number(m[1]);
    const url = `https://epaper.netifocusnews.com/media/${m[2]}/${m[3]}`;
    if (!seen.has(url)) {
      seen.add(url);
      ordered.push({ order, url });
    }
  }
  ordered.sort((a, b) => a.order - b.order);

  if (ordered.length === 0) {
    throw new Error(`No page images found on ${openUrl}`);
  }
  return { date: dateMatch, urls: ordered.map((o) => o.url) };
}

async function fetchAajSamajPages(): Promise<FetchResult> {
  const res = await fetch("https://www.aajsamaaj.com/wp-json/wp/v2/posts?per_page=12&_embed=true", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Aaj Samaj WP API HTTP ${res.status}`);
  const posts = (await res.json()) as Array<{
    date?: string;
    _embedded?: { "wp:featuredmedia"?: Array<{ source_url?: string }> };
  }>;

  const imageUrls = posts
    .map((p) => p._embedded?.["wp:featuredmedia"]?.[0]?.source_url)
    .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));

  if (imageUrls.length === 0) {
    throw new Error("No edition images returned from aajsamaaj.com");
  }

  const dateStr = posts[0]?.date ? posts[0].date.slice(0, 10) : todayIsoIst();
  return { date: dateStr, urls: imageUrls };
}

/**
 * List official regional papers supported via the direct official engine.
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
 * Download today's edition from an official ePaper site and assemble into PDF.
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

  let data: FetchResult;
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
    case "millennium-post":
      data = await fetchMillenniumPostPages();
      break;
    case "daily-guardian":
      data = await fetchDailyGuardianPages();
      break;
    case "top-story":
      data = await fetchTopStoryPages();
      break;
    case "navodaya-times":
      data = await fetchNavodayaTimesPages();
      break;
    case "deshbandhu":
      data = await fetchDeshbandhuPages();
      break;
    case "vir-arjun":
      data = await fetchVirArjunPages();
      break;
    case "viraat-vaibhav":
      data = await fetchViraatVaibhavPages();
      break;
    case "loksatya":
      data = await fetchLoksatyaPages();
      break;
    case "action-india":
      data = await fetchActionIndiaPages();
      break;
    case "shah-times":
      data = await fetchShahTimesPages();
      break;
    case "info-india":
      data = await fetchInfoIndiaPages();
      break;
    case "focus-news":
      data = await fetchFocusNewsPages();
      break;
    case "aaj-samaj":
      data = await fetchAajSamajPages();
      break;
    default:
      throw new Error(`Unsupported official regional slug: ${entry.slug}`);
  }

  const safeDate = data.date.replace(/[/\s]+/g, "-");
  const fileName = `${entry.slug}-${safeDate}.pdf`;
  const targetPath = path.join(outDir, fileName);

  let built: BuildPdfResult;
  if (data.format === "pdf") {
    built = await mergePdfUrlsToPdf(data.urls, targetPath, 6);
  } else if (data.format === "png") {
    built = await downloadPngsToPdf(data.urls, targetPath, 8);
  } else {
    built = await downloadImagesToPdf(data.urls, targetPath, 8);
  }

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
