#!/usr/bin/env bun
/**
 * End-to-End Media Monitoring Pipeline Orchestrator.
 * 
 * Usage:
 *   bun run scripts/run_pipeline.ts --papers the-hindu,indian-express --pages 1-3
 *   bun run scripts/run_pipeline.ts --list
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string | boolean> = {
    papers: "the-hindu",
    pages: "1",
    date: "",
    out: "downloads",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") options.list = true;
    else if (arg === "--papers" && args[i + 1]) options.papers = args[++i];
    else if (arg === "--pages" && args[i + 1]) options.pages = args[++i];
    else if (arg === "--date" && args[i + 1]) options.date = args[++i];
    else if (arg === "--out" && args[i + 1]) options.out = args[++i];
  }
  return options;
}

async function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) => {
      if (code === 0) resolve("");
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    p.on("error", reject);
  });
}

async function main() {
  const opts = parseArgs();

  if (opts.list) {
    console.log("Listing available Indian newspapers...");
    await runCommand("bun", ["run", "src/epaper/epaper.ts", "list"]);
    return;
  }

  console.log("==================================================");
  console.log("🚀 STARTING MEDIA MONITORING WORKFLOW");
  console.log(`   Papers: ${opts.papers}`);
  console.log(`   Pages:  ${opts.pages}`);
  if (opts.date) console.log(`   Date:   ${opts.date}`);
  console.log("==================================================\n");

  // Step 1: Download Newspapers
  console.log("📥 Step 1: Downloading newspapers to ./downloads...");
  const downloadArgs = ["run", "src/epaper/epaper.ts", "batch", String(opts.papers), "--out", "./downloads", "--json"];
  if (opts.date) {
    downloadArgs.push("--date", String(opts.date));
  }
  await runCommand("bun", downloadArgs);

  // Step 2: Render downloaded PDFs
  console.log("\n🖼️ Step 2: Rendering PDF pages (with Vision-AI coordinate grid)...");
  const downloads = await fsp.readdir("downloads");
  const pdfs = downloads.filter((f) => f.endsWith(".pdf") && !f.startsWith("."));

  for (const pdf of pdfs) {
    const pdfPath = path.join("downloads", pdf);
    console.log(`  -> Rendering: ${pdfPath}`);
    await runCommand("bun", [
      "run",
      "src/epaper/epaper.ts",
      "render",
      pdfPath,
      "--pages",
      String(opts.pages),
      "--grid",
      "--hints",
      "--out",
      "./pages",
      "--json",
    ]);
  }

  // Step 3: Check for dataset extractions and ingest into SQLite
  console.log("\n📦 Step 3: Ingesting dataset into data/media_dataset.db...");
  await runCommand("python3", ["scripts/ingest_to_db.py", "--dir", "dataset", "--db", "data/media_dataset.db"]);

  // Step 4: Compile Intelligence Dashboard
  console.log("\n📊 Step 4: Generating interactive intelligence dashboard...");
  await runCommand("python3", [
    "scripts/generate_dashboard.py",
    "--db",
    "data/media_dataset.db",
    "--out",
    "outputs/dashboard.html",
  ]);

  console.log("\n✅ Pipeline complete!");
  console.log("   - PDFs:       ./downloads/");
  console.log("   - Pages/Grid: ./pages/");
  console.log("   - Database:   ./data/media_dataset.db");
  console.log("   - Dashboard:  ./outputs/dashboard.html");
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
