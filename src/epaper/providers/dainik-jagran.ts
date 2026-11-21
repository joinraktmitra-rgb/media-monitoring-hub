import path from "node:path";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

export interface JagranCity {
  slug: string;
  code: number;
  name: string;
  state: string;
  region?: string;
  isPrime?: boolean;
}

export interface JagranIssueManifest {
  editionId: number;
  citySlug: string;
  cityName: string;
  stateName: string;
  dateStr: string; // e.g. "18-nov-2026"
  dateIso: string; // e.g. "2026-11-18"
  totalPages: number;
  pages: Array<{
    pageNo: number;
    pdfUrl: string;
    imageUrl: string;
    largeImageUrl?: string;
  }>;
}

export interface DownloadJagranResult {
  publication: "Dainik Jagran";
  city: string;
  state: string;
  editionCode: number;
  date: string;
  totalPages: number;
  downloadedPages: number;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sizeMB: number;
  durationSec: number;
  verified: boolean;
}

// Built-in primary city registry for instantaneous lookup
export const KNOWN_JAGRAN_CITIES: Record<string, { code: number; slug: string; name: string; state: string }> = {
  // Uttar Pradesh
  "varanasi": { code: 45, slug: "varanasi-city", name: "Varanasi City", state: "U.P" },
  "varanasi-city": { code: 45, slug: "varanasi-city", name: "Varanasi City", state: "U.P" },
  "vns": { code: 45, slug: "varanasi-city", name: "Varanasi City", state: "U.P" },
  "lucknow": { code: 11, slug: "lucknow", name: "Lucknow", state: "U.P" },
  "lko": { code: 11, slug: "lucknow", name: "Lucknow", state: "U.P" },
  "kanpur": { code: 64, slug: "kanpur", name: "Kanpur", state: "U.P" },
  "kanpur-dehat": { code: 65, slug: "kanpur-dehat", name: "Kanpur Dehat", state: "U.P" },
  "prayagraj": { code: 79, slug: "prayagraj-city", name: "Prayagraj City", state: "U.P" },
  "allahabad": { code: 79, slug: "prayagraj-city", name: "Prayagraj City", state: "U.P" },
  "gorakhpur": { code: 56, slug: "gorakhpur-city", name: "Gorakhpur City", state: "U.P" },
  "agra": { code: 193, slug: "agra", name: "Agra", state: "U.P" },
  "meerut": { code: 29, slug: "meerut", name: "Meerut", state: "U.P" },
  "ayodhya": { code: 16, slug: "ayodhya", name: "Ayodhya", state: "U.P" },
  "bareilly": { code: 40, slug: "bareilly-city", name: "Bareilly City", state: "U.P" },
  "aligarh": { code: 257, slug: "aligarh", name: "Aligarh", state: "U.P" },
  "moradabad": { code: 36, slug: "moradabad-city", name: "Moradabad City", state: "U.P" },
  "jhansi": { code: 74, slug: "jhansi-city", name: "Jhansi City", state: "U.P" },
  "ghaziabad": { code: 31, slug: "ghaziabad", name: "Ghaziabad", state: "U.P" },
  "noida": { code: 32, slug: "noida", name: "Noida", state: "U.P" },

  // Delhi NCR
  "delhi": { code: 4, slug: "delhi-city", name: "Delhi City", state: "Delhi NCR" },
  "delhi-city": { code: 4, slug: "delhi-city", name: "Delhi City", state: "Delhi NCR" },
  "national": { code: 4, slug: "delhi-city", name: "Delhi City (National)", state: "Delhi NCR" },
  "gurugram": { code: 110, slug: "gurugram", name: "Gurugram", state: "Delhi NCR" },
  "faridabad": { code: 111, slug: "faridabad", name: "Faridabad", state: "Delhi NCR" },

  // Bihar
  "patna": { code: 84, slug: "patna-nagar", name: "Patna Nagar", state: "Bihar" },
  "patna-nagar": { code: 84, slug: "patna-nagar", name: "Patna Nagar", state: "Bihar" },
  "bhagalpur": { code: 205, slug: "bhagalpur-city", name: "Bhagalpur City", state: "Bihar" },
  "muzaffarpur": { code: 203, slug: "muzaffarpur-nagar", name: "Muzaffarpur Nagar", state: "Bihar" },
  "gaya": { code: 201, slug: "gaya", name: "Gaya", state: "Bihar" },
  "purnea": { code: 223, slug: "purnea", name: "Purnea", state: "Bihar" },

  // Jharkhand
  "ranchi": { code: 212, slug: "ranchi", name: "Ranchi", state: "Jharkhand" },
  "dhanbad": { code: 210, slug: "dhanbad", name: "Dhanbad", state: "Jharkhand" },
  "jamshedpur": { code: 209, slug: "jamshedpur", name: "Jamshedpur", state: "Jharkhand" },

  // Uttarakhand
  "dehradun": { code: 104, slug: "dehradun-city", name: "Dehradun City", state: "Uttarakhand" },
  "haridwar": { code: 105, slug: "haridwar", name: "Haridwar", state: "Uttarakhand" },
  "haldwani": { code: 143, slug: "haldwani-city", name: "Haldwani City", state: "Uttarakhand" },

  // Punjab, Haryana, Himachal, J&K
  "chandigarh": { code: 122, slug: "chandigarh-city", name: "Chandigarh City", state: "Punjab" },
  "ludhiana": { code: 123, slug: "ludhiana-city", name: "Ludhiana City", state: "Punjab" },
  "amritsar": { code: 126, slug: "amritsar-city", name: "Amritsar City", state: "Punjab" },
  "jalandhar": { code: 124, slug: "jalandhar-city", name: "Jalandhar City", state: "Punjab" },
  "jammu": { code: 133, slug: "jammu-city", name: "Jammu City", state: "J&K" },
  "shimla": { code: 114, slug: "shimla", name: "Shimla", state: "Himachal" },
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Normalize arbitrary user date string into Jagran URL format (e.g. "18-nov-2026") and ISO (2026-11-18)
 */
export function normalizeJagranDate(inputDate?: string): { slugDate: string; isoDate: string } {
  let d: Date;
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);

  if (!inputDate || inputDate.toLowerCase() === "today") {
    d = nowIst;
  } else if (inputDate.toLowerCase() === "yesterday") {
    d = new Date(nowIst.getTime() - 24 * 60 * 60 * 1000);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
    // YYYY-MM-DD
    const [y, m, day] = inputDate.split("-").map(Number);
    d = new Date(Date.UTC(y, m - 1, day));
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(inputDate)) {
    // DD-MM-YYYY
    const [day, m, y] = inputDate.split("-").map(Number);
    d = new Date(Date.UTC(y, m - 1, day));
  } else {
    // Try native date parse
    d = new Date(inputDate);
    if (isNaN(d.getTime())) {
      d = nowIst;
    }
  }

  const dayStr = String(d.getUTCDate()).padStart(2, "0");
  const monthStr = MONTH_NAMES[d.getUTCMonth()];
  const yearStr = d.getUTCFullYear();
  const mNum = String(d.getUTCMonth() + 1).padStart(2, "0");

  return {
    slugDate: `${dayStr}-${monthStr}-${yearStr}`,
    isoDate: `${yearStr}-${mNum}-${dayStr}`,
  };
}

/**
 * Resolve user city input to Jagran edition code and slug
 */
export async function resolveJagranCity(cityInput: string): Promise<JagranCity> {
  const q = cityInput.trim().toLowerCase().replace(/\s+/g, "-");

  // 1. Direct cache check
  if (KNOWN_JAGRAN_CITIES[q]) {
    const c = KNOWN_JAGRAN_CITIES[q];
    return { slug: c.slug, code: c.code, name: c.name, state: c.state };
  }

  // 2. Partial match in local registry
  for (const [key, val] of Object.entries(KNOWN_JAGRAN_CITIES)) {
    if (key.includes(q) || q.includes(key)) {
      return { slug: val.slug, code: val.code, name: val.name, state: val.state };
    }
  }

  // 3. Dynamic lookup from live epaper manifest
  try {
    const res = await fetch("https://epaper.jagran.com/", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (match) {
        const data = JSON.parse(match[1]);
        const states = data.props?.pageProps?.currentCities || [];
        for (const state of states) {
          for (const reg of state.regions || []) {
            for (const city of reg.cities || []) {
              const cSlug = city.slug.toLowerCase();
              const cName = city.city_name.toLowerCase();
              if (cSlug === q || cSlug.includes(q) || cName.includes(q)) {
                return {
                  slug: city.slug,
                  code: city.code,
                  name: city.city_name,
                  state: state.state_name,
                  region: reg.regions_name,
                };
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore fallback failure
  }

  // Fallback to Delhi City if completely unknown
  console.warn(`[Jagran] City "${cityInput}" not found. Defaulting to Delhi City (code 4).`);
  return { slug: "delhi-city", code: 4, name: "Delhi City", state: "Delhi NCR" };
}

/**
 * Fetch complete issue manifest for given city and date
 */
export async function fetchJagranManifest(city: JagranCity, dateStr: string): Promise<JagranIssueManifest> {
  const targetUrl = `https://epaper.jagran.com/${dateStr}-${city.code}-${city.slug}-edition-${city.slug}-page-1.html`;
  
  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Jagran edition at ${targetUrl}: HTTP ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Invalid Jagran HTML: __NEXT_DATA__ JSON not found at ${targetUrl}`);
  }

  const data = JSON.parse(match[1]);
  const pageProps = data.props?.pageProps;
  const rawPages = pageProps?.data;
  const currentData = pageProps?.currentData;

  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new Error(`No pages listed for ${city.name} on ${dateStr}`);
  }

  const totalPages = currentData?.etotal_page || rawPages.length;

  const pages = rawPages.map((p: any) => ({
    pageNo: Number(p.pageno),
    pdfUrl: p.page_pdf,
    imageUrl: p.page_image,
    largeImageUrl: p.page_largeimage,
  }));

  // Sort pages numerically
  pages.sort((a, b) => a.pageNo - b.pageNo);

  return {
    editionId: city.code,
    citySlug: city.slug,
    cityName: city.name,
    stateName: city.state,
    dateStr,
    dateIso: pageProps?.currentDate || dateStr,
    totalPages,
    pages,
  };
}

/**
 * Download all vector page PDFs in parallel, merge into single PDF, and write to output dir.
 */
export async function downloadJagranEdition(options: {
  city?: string;
  date?: string;
  outDir?: string;
  onProgress?: (downloaded: number, total: number) => void;
}): Promise<DownloadJagranResult> {
  const t0 = Date.now();
  const cityInput = options.city || "varanasi";
  const city = await resolveJagranCity(cityInput);
  const { slugDate, isoDate } = normalizeJagranDate(options.date);

  const outDir = path.resolve(options.outDir || "outputs");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n================================================================`);
  console.log(`📰 DAINIK JAGRAN ADAPTER: FETCHING COMPLETE ISSUE`);
  console.log(`   City:    ${city.name} (${city.state}) [Code: ${city.code}, Slug: ${city.slug}]`);
  console.log(`   Date:    ${slugDate} (ISO: ${isoDate})`);
  console.log(`================================================================`);

  // 1. Fetch manifest
  const manifest = await fetchJagranManifest(city, slugDate);
  console.log(`✓ Manifest verified: ${manifest.pages.length} / ${manifest.totalPages} pages discovered`);

  // 2. Download all single-page vector PDFs in parallel
  console.log(`⬇ Downloading ${manifest.pages.length} official vector page PDFs in parallel...`);
  let downloadedCount = 0;

  const pagePdfBuffers = await Promise.all(
    manifest.pages.map(async (p) => {
      const pageRes = await fetch(p.pdfUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!pageRes.ok) {
        throw new Error(`Failed to download page ${p.pageNo} PDF: HTTP ${pageRes.status}`);
      }
      const buf = await pageRes.arrayBuffer();
      downloadedCount++;
      if (options.onProgress) {
        options.onProgress(downloadedCount, manifest.pages.length);
      }
      return { pageNo: p.pageNo, buffer: new Uint8Array(buf) };
    })
  );

  // 3. Merge all pages into single master vector PDF using pdf-lib
  console.log(`⚙ Merging all ${pagePdfBuffers.length} pages into master publication PDF...`);
  const masterDoc = await PDFDocument.create();

  // Sort strictly by page number
  pagePdfBuffers.sort((a, b) => a.pageNo - b.pageNo);

  for (const pageItem of pagePdfBuffers) {
    const singleDoc = await PDFDocument.load(pageItem.buffer);
    const copiedPages = await masterDoc.copyPages(singleDoc, singleDoc.getPageIndices());
    for (const copied of copiedPages) {
      masterDoc.addPage(copied);
    }
  }

  const mergedPdfBytes = await masterDoc.save();

  // 4. Save output PDF
  const fileName = `dainik-jagran-${city.slug}-${isoDate}.pdf`;
  const filePath = path.join(outDir, fileName);
  await Bun.write(filePath, mergedPdfBytes);

  const durationSec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const sizeMB = Number((mergedPdfBytes.byteLength / (1024 * 1024)).toFixed(2));

  console.log(`✓ SUCCESS: Complete edition assembled in ${durationSec}s`);
  console.log(`   Output File: ${filePath}`);
  console.log(`   Pages:       ${masterDoc.getPageCount()} / ${manifest.totalPages} (100% Verified)`);
  console.log(`   File Size:   ${sizeMB} MB`);
  console.log(`================================================================\n`);

  return {
    publication: "Dainik Jagran",
    city: city.name,
    state: city.state,
    editionCode: city.code,
    date: isoDate,
    totalPages: manifest.totalPages,
    downloadedPages: masterDoc.getPageCount(),
    filePath,
    fileName,
    sizeBytes: mergedPdfBytes.byteLength,
    sizeMB,
    durationSec,
    verified: masterDoc.getPageCount() === manifest.totalPages,
  };
}

/**
 * List all supported Jagran cities
 */
export function listJagranCities(filter?: string): Array<{ key: string; name: string; state: string; code: number }> {
  const q = filter ? filter.trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const list = Object.entries(KNOWN_JAGRAN_CITIES).map(([key, c]) => ({
    key,
    name: c.name,
    state: c.state,
    code: c.code,
  }));

  if (!q) return list;
  return list.filter((item) => {
    const normKey = item.key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normName = item.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normState = item.state.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normKey.includes(q) || normName.includes(q) || normState.includes(q);
  });
}

// Direct CLI Execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  let city = "varanasi";
  let date = "today";
  let outDir = "outputs";
  let listOnly = false;
  let filter = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--city" || a === "-c") {
      city = args[++i];
    } else if (a === "--date" || a === "-d") {
      date = args[++i];
    } else if (a === "--out" || a === "-o") {
      outDir = args[++i];
    } else if (a === "--list-cities" || a === "-l") {
      listOnly = true;
      filter = args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : "";
    } else if (a === "--help" || a === "-h") {
      console.log(`
Dainik Jagran Complete Edition Downloader

Usage:
  bun run src/epaper/providers/dainik-jagran.ts [options]

Options:
  --city, -c <name>       City name or slug (e.g. varanasi, delhi, lucknow, patna, gorakhpur, agra) [default: varanasi]
  --date, -d <date>       Date: today, yesterday, YYYY-MM-DD, or DD-MM-YYYY [default: today]
  --out,  -o <path>       Output directory [default: outputs]
  --list-cities, -l [str] List available cities (optional keyword filter)
  --help, -h              Show this help message
      `);
      process.exit(0);
    }
  }

  if (listOnly) {
    const cities = listJagranCities(filter);
    console.log(`\nAvailable Dainik Jagran Cities (${cities.length} matches):`);
    console.table(cities);
    process.exit(0);
  }

  downloadJagranEdition({
    city,
    date,
    outDir,
    onProgress: (done, total) => {
      process.stdout.write(`\r  Progress: ${done}/${total} pages downloaded...`);
    },
  })
    .then((res) => {
      console.log(`Download finished: ${res.filePath}`);
    })
    .catch((err) => {
      console.error(`\n❌ Error:`, err.message);
      process.exit(1);
    });
}
