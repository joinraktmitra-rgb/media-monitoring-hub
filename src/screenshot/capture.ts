#!/usr/bin/env bun
/**
 * Ampio Labs — TypeScript Runner & Module for Evidence Screenshot Engine.
 *
 * Bridges Bun/TypeScript CLI workflows to the Playwright Evidence Screenshot
 * and Deep Visual Auditing Engine.
 *
 * Usage as CLI:
 *   bun run src/screenshot/capture.ts [options]
 *
 * Usage as Module:
 *   import { captureEvidenceScreenshots } from "./src/screenshot/capture.ts";
 *   await captureEvidenceScreenshots({ urls: ["https://example.com"] });
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface ScreenshotEngineOptions {
  urls?: string[];
  db?: string;
  viewport?: string;
  scale?: number;
  outDir?: string;
  pruneObsolete?: boolean;
  auditOnly?: boolean;
  headed?: boolean;
  jsonReport?: string;
}

export function captureEvidenceScreenshots(
  options: ScreenshotEngineOptions = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve("scripts/capture_evidence_screenshots.py");

    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`Python engine not found at: ${scriptPath}`));
    }

    const args: string[] = [];
    if (options.urls && options.urls.length > 0) {
      args.push("--urls", options.urls.join(","));
    }
    if (options.db) args.push("--db", options.db);
    if (options.viewport) args.push("--viewport", options.viewport);
    if (options.scale) args.push("--scale", String(options.scale));
    if (options.outDir) args.push("--out-dir", options.outDir);
    if (options.pruneObsolete) args.push("--prune-obsolete");
    if (options.auditOnly) args.push("--audit-only");
    if (options.headed) args.push("--headed");
    if (options.jsonReport) args.push("--json-report", options.jsonReport);

    const pyProcess = spawn("python3", [scriptPath, ...args], {
      stdio: "inherit",
    });

    pyProcess.on("close", (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Screenshot engine exited with code ${code}`));
      }
    });

    pyProcess.on("error", (err) => {
      reject(err);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const scriptPath = path.resolve("scripts/capture_evidence_screenshots.py");

  if (!fs.existsSync(scriptPath)) {
    console.error(`[ERROR] Python engine not found at: ${scriptPath}`);
    process.exit(1);
  }

  console.log(`\n============================================================`);
  console.log(`📸 AMPIO LABS — EVIDENCE SCREENSHOT & VERIFICATION ENGINE`);
  console.log(`============================================================\n`);

  const pyProcess = spawn("python3", [scriptPath, ...args], {
    stdio: "inherit",
  });

  pyProcess.on("close", (code) => {
    if (code !== 0) {
      console.error(`\n[FATAL] Screenshot engine exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
