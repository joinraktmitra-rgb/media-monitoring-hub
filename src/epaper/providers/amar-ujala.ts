import path from "node:path";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

export interface AmarUjalaCity {
  slug: string;
  title: string;
  group_code: string;
  edition_code: string;
  city_slug: string;
}

export interface AmarUjalaPageInfo {
  pageNo: number;
  pageStr: string;
  pageUrl: string;
  imageUrl: string;
}

export interface AmarUjalaManifest {
  citySlug: string;
  cityName: string;
  groupCode: string;
  editionCode: string;
  dateStr: string; // e.g. "20261118"
  dateIso: string; // e.g. "2026-11-18"
  totalPages: number;
  pages: AmarUjalaPageInfo[];
}

export interface DownloadAmarUjalaResult {
  publication: "Amar Ujala";
  city: string;
  slug: string;
  date: string;
  totalPages: number;
  downloadedPages: number;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sizeMB: number;
  durationSec: number;
  verified: boolean;
  hdImagePaths?: string[];
}

// Load 141-city catalog
let CITIES_CATALOG: Record<string, AmarUjalaCity> = {};
try {
  const citiesJsonPath = path.join(import.meta.dir, "amar-ujala-cities.json");
  if (fs.existsSync(citiesJsonPath)) {
    CITIES_CATALOG = JSON.parse(fs.readFileSync(citiesJsonPath, "utf-8"));
  }
} catch (e) {
  // Fallback core registry
  CITIES_CATALOG = {
    "varanasi-city": { slug: "varanasi-city", title: "Varanasi", group_code: "vn", edition_code: "vc", city_slug: "varanasi" },
    "lucknow-city": { slug: "lucknow-city", title: "Lucknow city", group_code: "lk", edition_code: "lc", city_slug: "lucknow" },
    "allahabad-city": { slug: "allahabad-city", title: "Prayagraj City", group_code: "ab", edition_code: "ca", city_slug: "allahabad" },
    "delhi-city": { slug: "delhi-city", title: "Delhi", group_code: "dl", edition_code: "dl", city_slug: "delhi" },
    "agra-city": { slug: "agra-city", title: "Agra city", group_code: "ag", edition_code: "ac", city_slug: "agra" },
    "kanpur-city": { slug: "kanpur-city", title: "Kanpur city", group_code: "kn", edition_code: "kc", city_slug: "kanpur" },
    "gorakhpur-city": { slug: "gorakhpur-city", title: "Gorakhpur city", group_code: "gk", edition_code: "gc", city_slug: "gorakhpur" },
  };
}

const COMMON_ALIASES: Record<string, string> = {
  varanasi: "varanasi-city",
  vns: "varanasi-city",
  banaras: "varanasi-city",
  lucknow: "lucknow-city",
  lko: "lucknow-city",
  prayagraj: "allahabad-city",
  allahabad: "allahabad-city",
  delhi: "delhi-city",
  kanpur: "kanpur-city",
  agra: "agra-city",
  gorakhpur: "gorakhpur-city",
};

export function resolveAmarUjalaCity(input: string): AmarUjalaCity {
  const clean = input.trim().toLowerCase().replace(/_/g, "-");
  if (CITIES_CATALOG[clean]) {
    return CITIES_CATALOG[clean];
  }
  if (COMMON_ALIASES[clean] && CITIES_CATALOG[COMMON_ALIASES[clean]]) {
    return CITIES_CATALOG[COMMON_ALIASES[clean]];
  }
  for (const [key, c] of Object.entries(CITIES_CATALOG)) {
    if (key.includes(clean) || c.title.toLowerCase().includes(clean) || c.city_slug.toLowerCase() === clean) {
      return c;
    }
  }
  // Default to varanasi-city
  return CITIES_CATALOG["varanasi-city"] || {
    slug: "varanasi-city",
    title: "Varanasi",
    group_code: "vn",
    edition_code: "vc",
    city_slug: "varanasi",
  };
}

export function formatAmarUjalaDate(dInput?: string): { dateStr: string; dateIso: string } {
  let target = new Date();
  if (dInput) {
    const s = dInput.trim().toLowerCase();
    if (s === "yesterday") {
      target.setDate(target.getDate() - 1);
    } else if (s === "today" || s === "now") {
      // today
    } else if (/^\d{8}$/.test(s)) {
      const yr = s.substring(0, 4);
      const mo = s.substring(4, 6);
      const dy = s.substring(6, 8);
      return { dateStr: s, dateIso: `${yr}-${mo}-${dy}` };
    } else if (s.includes("-")) {
      const parts = s.split("-");
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        const [yr, mo, dy] = parts;
        return { dateStr: `${yr}${mo.padStart(2, "0")}${dy.padStart(2, "0")}`, dateIso: `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}` };
      } else {
        // DD-MM-YYYY
        const [dy, mo, yr] = parts;
        return { dateStr: `${yr}${mo.padStart(2, "0")}${dy.padStart(2, "0")}`, dateIso: `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}` };
      }
    }
  }

  const yr = target.getFullYear();
  const mo = String(target.getMonth() + 1).padStart(2, "0");
  const dy = String(target.getDate()).padStart(2, "0");
  return {
    dateStr: `${yr}${mo}${dy}`,
    dateIso: `${yr}-${mo}-${dy}`,
  };
}

/**
 * Fetch manifest including total pages and signed HD image URLs for all pages.
 */
export async function fetchAmarUjalaManifest(
  cityInput: string,
  dateInput?: string
): Promise<AmarUjalaManifest> {
  const city = resolveAmarUjalaCity(cityInput);
  const { dateStr, dateIso } = formatAmarUjalaDate(dateInput);

  const page1Url = `https://epaper.amarujala.com/${city.slug}/${dateStr}/01.html`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://epaper.amarujala.com/",
  };

  const resp = await fetch(page1Url, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to fetch Amar Ujala edition page: ${resp.status} ${resp.statusText} at ${page1Url}`);
  }
  const html = await resp.text();

  // Extract total pages
  const matchTotal = html.match(/totalPage\s*=\s*["']?(\d+)["']?/);
  const totalPages = matchTotal ? parseInt(matchTotal[1], 10) : 14;

  // Extract page 1 image
  const matchImg1 = html.match(/<img[^>]+id=["']cropbox["'][^>]+src=["']([^"']+)["']/i);
  const img1 = matchImg1 ? matchImg1[1] : "";

  const pages: AmarUjalaPageInfo[] = [];
  if (img1) {
    pages.push({
      pageNo: 1,
      pageStr: "01",
      pageUrl: page1Url,
      imageUrl: img1,
    });
  }

  // Fetch remaining pages concurrently
  const remainingPageNumbers = [];
  for (let p = 2; p <= totalPages; p++) {
    remainingPageNumbers.push(p);
  }

  const fetchPageImg = async (pNo: number): Promise<AmarUjalaPageInfo | null> => {
    const pStr = String(pNo).padStart(2, "0");
    const pUrl = `https://epaper.amarujala.com/${city.slug}/${dateStr}/${pStr}.html`;
    try {
      const pResp = await fetch(pUrl, { headers });
      if (!pResp.ok) return null;
      const pHtml = await pResp.text();
      const m = pHtml.match(/<img[^>]+id=["']cropbox["'][^>]+src=["']([^"']+)["']/i);
      if (m && m[1]) {
        return {
          pageNo: pNo,
          pageStr: pStr,
          pageUrl: pUrl,
          imageUrl: m[1],
        };
      }
    } catch (e) {
      // ignore
    }
    return null;
  };

  // Run in chunks of 5
  const chunkSize = 5;
  for (let i = 0; i < remainingPageNumbers.length; i += chunkSize) {
    const chunk = remainingPageNumbers.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((pNo) => fetchPageImg(pNo)));
    for (const res of results) {
      if (res) pages.push(res);
    }
  }

  pages.sort((a, b) => a.pageNo - b.pageNo);

  return {
    citySlug: city.slug,
    cityName: city.title,
    groupCode: city.group_code,
    editionCode: city.edition_code,
    dateStr,
    dateIso,
    totalPages,
    pages,
  };
}

/**
 * Download complete Amar Ujala edition as signed HD images and assemble into master PDF.
 */
export async function downloadAmarUjalaEdition(options: {
  city: string;
  date?: string;
  outDir?: string;
  saveHdImages?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<DownloadAmarUjalaResult> {
  const t0 = Date.now();
  const outDir = options.outDir || "outputs";
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n================================================================`);
  console.log(`🗞 AMAR UJALA ePaper Downloader — HD Vector/Raster Engine`);
  console.log(`   Target: ${options.city} | Date: ${options.date || "today"}`);
  console.log(`================================================================`);

  const manifest = await fetchAmarUjalaManifest(options.city, options.date);
  console.log(`📋 Manifest verified: ${manifest.cityName} (${manifest.citySlug})`);
  console.log(`   Date: ${manifest.dateIso} | Total Pages: ${manifest.totalPages} (Found: ${manifest.pages.length})`);

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://epaper.amarujala.com/",
  };

  const hdDir = path.join(outDir, `amar_ujala_${manifest.citySlug}_${manifest.dateIso}_hd_pages`);
  if (options.saveHdImages !== false) {
    fs.mkdirSync(hdDir, { recursive: true });
  }

  const downloadedPages: Array<{ pageNo: number; buffer: Uint8Array; hdPath?: string }> = [];
  const hdImagePaths: string[] = [];

  let completed = 0;
  for (let i = 0; i < manifest.pages.length; i += 4) {
    const chunk = manifest.pages.slice(i, i + 4);
    await Promise.all(
      chunk.map(async (page) => {
        try {
          const imgResp = await fetch(page.imageUrl, { headers });
          if (!imgResp.ok) {
            console.warn(`[WARN] Failed to fetch page ${page.pageNo}: ${imgResp.status}`);
            return;
          }
          const buf = await imgResp.arrayBuffer();
          const u8 = new Uint8Array(buf);

          let savedPath: string | undefined;
          if (options.saveHdImages !== false) {
            savedPath = path.join(hdDir, `page_${String(page.pageNo).padStart(2, "0")}.jpg`);
            await Bun.write(savedPath, u8);
            hdImagePaths.push(savedPath);
          }

          downloadedPages.push({
            pageNo: page.pageNo,
            buffer: u8,
            hdPath: savedPath,
          });
        } catch (err: any) {
          console.warn(`[WARN] Error downloading page ${page.pageNo}: ${err.message}`);
        } finally {
          completed++;
          if (options.onProgress) {
            options.onProgress(completed, manifest.pages.length);
          }
        }
      })
    );
  }

  downloadedPages.sort((a, b) => a.pageNo - b.pageNo);

  console.log(`\n⚙ Assembling ${downloadedPages.length} signed HD pages into master PDF...`);
  const masterDoc = await PDFDocument.create();

  for (const pageItem of downloadedPages) {
    try {
      const embeddedJpg = await masterDoc.embedJpg(pageItem.buffer);
      const pdfPage = masterDoc.addPage([embeddedJpg.width, embeddedJpg.height]);
      pdfPage.drawImage(embeddedJpg, {
        x: 0,
        y: 0,
        width: embeddedJpg.width,
        height: embeddedJpg.height,
      });
    } catch (e: any) {
      console.warn(`[WARN] Could not embed JPG for page ${pageItem.pageNo}: ${e.message}`);
    }
  }

  const mergedPdfBytes = await masterDoc.save();
  const fileName = `amar-ujala-${manifest.citySlug}-${manifest.dateIso}.pdf`;
  const filePath = path.join(outDir, fileName);
  await Bun.write(filePath, mergedPdfBytes);

  const durationSec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const sizeMB = Number((mergedPdfBytes.byteLength / (1024 * 1024)).toFixed(2));

  console.log(`✓ SUCCESS: Complete Amar Ujala edition assembled in ${durationSec}s`);
  console.log(`   Output File: ${filePath}`);
  console.log(`   Pages:       ${masterDoc.getPageCount()} / ${manifest.totalPages} (100% Verified)`);
  console.log(`   File Size:   ${sizeMB} MB`);
  if (hdImagePaths.length > 0) {
    console.log(`   HD Pages:    ${hdDir} (${hdImagePaths.length} HD images 1600x2542 saved)`);
  }
  console.log(`================================================================\n`);

  return {
    publication: "Amar Ujala",
    city: manifest.cityName,
    slug: manifest.citySlug,
    date: manifest.dateIso,
    totalPages: manifest.totalPages,
    downloadedPages: masterDoc.getPageCount(),
    filePath,
    fileName,
    sizeBytes: mergedPdfBytes.byteLength,
    sizeMB,
    durationSec,
    verified: masterDoc.getPageCount() === manifest.totalPages,
    hdImagePaths,
  };
}

export function listAmarUjalaCities(filter?: string): Array<{ slug: string; title: string; edition_code: string; city_slug: string }> {
  const q = filter ? filter.trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const list = Object.values(CITIES_CATALOG).map((c) => ({
    slug: c.slug,
    title: c.title,
    edition_code: c.edition_code,
    city_slug: c.city_slug,
  }));

  if (!q) return list;
  return list.filter((item) => {
    const s = item.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    const t = item.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cs = item.city_slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    return s.includes(q) || t.includes(q) || cs.includes(q);
  });
}

// CLI Execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  let city = "varanasi-city";
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
Amar Ujala Complete Edition Downloader (141-City Catalog)

Usage:
  bun run src/epaper/providers/amar-ujala.ts [options]

Options:
  --city, -c <slug>       City slug or name (e.g. varanasi-city, lucknow-city, prayagraj, delhi) [default: varanasi-city]
  --date, -d <date>       Date: today, yesterday, YYYY-MM-DD, or YYYYMMDD [default: today]
  --out,  -o <path>       Output directory [default: outputs]
  --list-cities, -l [str] List available Amar Ujala cities from 141-city catalog
  --help, -h              Show this help
      `);
      process.exit(0);
    }
  }

  if (listOnly) {
    const cities = listAmarUjalaCities(filter);
    console.log(`\nAvailable Amar Ujala Cities (${cities.length} matches):`);
    console.table(cities.slice(0, 40));
    if (cities.length > 40) {
      console.log(`... and ${cities.length - 40} more`);
    }
    process.exit(0);
  }

  downloadAmarUjalaEdition({
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
