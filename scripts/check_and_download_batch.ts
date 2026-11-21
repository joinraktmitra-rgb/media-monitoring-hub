import { downloadDailyEpaper, getDailyEpaperIssues } from "../src/epaper/providers/dailyepaper.ts";
import path from "node:path";
import fs from "node:fs";

const HINDI_PAPERS = [
  "dainik-bhaskar",
  "navbharat-times",
  "punjab-kesari",
  "rajasthan-patrika",
  "jansatta",
  "prabhat-khabar",
  "naidunia",
  "inext-live",
  "lokmat",
  "hari-bhoomi"
];

const ENGLISH_PAPERS = [
  "times-of-india",
  "hindustan-times",
  "the-pioneer",
  "the-tribune",
  "deccan-herald",
  "the-free-press-journal",
  "financial-express",
  "the-telegraph"
];

const allPapers = [...HINDI_PAPERS, ...ENGLISH_PAPERS];
const outDir = path.resolve("./downloads");

console.log(`Checking ${allPapers.length} regional Hindi and English newspapers for 18 Nov 2026...`);

for (const slug of allPapers) {
  try {
    const { paper, issues } = await getDailyEpaperIssues(slug, 6);
    const issue18 = issues.find(i => i.dateKey.includes("18 nov"));
    if (!issue18) {
      console.log(`[-] ${slug}: No 18 Nov issue found (latest is ${issues[0]?.date})`);
      continue;
    }
    if (issue18.status !== "direct" || !issue18.fileId) {
      console.log(`[!] ${slug}: 18 Nov exists but not direct download (${issue18.status})`);
      continue;
    }
    console.log(`[+] ${slug} (18 Nov): Downloading from Google Drive...`);
    const res = await downloadDailyEpaper(slug, outDir, "18 Nov 2026");
    console.log(`    -> Downloaded: ${res.fileName} (${res.sizeMB} MB)`);
  } catch (err: any) {
    console.log(`[x] ${slug}: Error - ${err.message}`);
  }
}

console.log("Batch check & download completed.");
