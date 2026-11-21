#!/usr/bin/env bun
/**
 * Daily 9:00 AM Media Monitoring Runner for "Kashi Tamil Sangamam 5.0"
 * Runs complete 24-hour ingestion across Print, Online News, YouTube, and Instagram.
 * Compiles Ampio Labs Executive Word Report and Updates Interactive Dashboard.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] ${cmd} ${args.join(" ")}`);
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    p.on("error", reject);
  });
}

function todayIsoIst(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

async function main() {
  const t0 = Date.now();
  const dateIso = todayIsoIst();
  console.log(`\n================================================================`);
  console.log(`🌅 AMPIO LABS — MORNING 9:00 AM MEDIA MONITORING RUN`);
  console.log(`   Target Date: ${dateIso} (Last 24 Hours)`);
  console.log(`   Keyword:     "Kashi Tamil Sangamam 5.0" / "காசி தமிழ் சங்கமம்"`);
  console.log(`================================================================\n`);

  // Ensure directories exist
  for (const d of ["downloads", "outputs", "data", "clips/print", "clips/online", "clips/youtube", "clips/instagram"]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // 1. Download Dainik Jagran regional editions
  console.log(`\n[STEP 1/5] Ingesting Dainik Jagran Regional Editions...`);
  for (const city of ["varanasi", "lucknow", "delhi"]) {
    try {
      await runCmd("bun", ["run", "src/epaper/providers/dainik-jagran.ts", "--city", city, "--date", "today", "--out", "downloads"]);
    } catch (e: any) {
      console.warn(`[WARN] Jagran ${city} download skipped/failed: ${e.message}`);
    }
  }

  // 2. Download Amar Ujala regional editions
  console.log(`\n[STEP 2/5] Ingesting Amar Ujala Regional Editions...`);
  for (const city of ["varanasi-city", "lucknow-city"]) {
    try {
      await runCmd("bun", ["run", "src/epaper/providers/amar-ujala.ts", "--city", city, "--date", "today", "--out", "downloads"]);
    } catch (e: any) {
      console.warn(`[WARN] Amar Ujala ${city} download skipped/failed: ${e.message}`);
    }
  }

  // 3. Ingest Online News, YouTube & Instagram (Last 24 Hours)
  console.log(`\n[STEP 3/5] Ingesting Online News, YouTube Videos, and Instagram...`);
  try {
    await runCmd("python3", ["scripts/online_monitor.py"]);
  } catch (e: any) {
    console.warn(`[WARN] Online monitor warning: ${e.message}`);
  }

  // 4. Update Database
  console.log(`\n[STEP 4/5] Syncing Master SQLite Database...`);
  try {
    await runCmd("python3", ["scripts/populate_complete_dataset.py"]);
  } catch (e: any) {
    console.warn(`[WARN] Dataset sync warning: ${e.message}`);
  }

  // 5. Generate Word Dossier & Dashboard
  console.log(`\n[STEP 5/5] Generating Executive Word Report & Interactive Dashboard...`);
  const reportPath = `outputs/Ampio_KTS_Morning_Report_${dateIso}.docx`;
  await runCmd("python3", ["scripts/generate_docx_report.py", "--out", reportPath]);
  await runCmd("python3", ["scripts/generate_dashboard.py", "--db", "data/media_dataset.db", "--out", "outputs/dashboard.html"]);

  const durationMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n================================================================`);
  console.log(`✓ MORNING MEDIA MONITORING COMPLETE IN ${durationMin} MIN`);
  console.log(`   Word Report: ${reportPath}`);
  console.log(`   Dashboard:   outputs/dashboard.html`);
  console.log(`================================================================\n`);
}

main().catch((err) => {
  console.error("FATAL in morning runner:", err);
  process.exit(1);
});
