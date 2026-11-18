import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-ignore Bun bundles text imports directly into standalone binaries
import clipperScriptText from "../clipper.py" with { type: "text" };
// @ts-ignore Bun bundles text imports directly into standalone binaries
import showScriptText from "../show.py" with { type: "text" };

async function runClipperPython(subArgs: string[]): Promise<Record<string, unknown>> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "epaper-clipper-"));
  const scriptPath = path.join(tmpDir, "clipper.py");
  await fsp.writeFile(scriptPath, clipperScriptText, "utf8");

  const uvPath = await findExecutable(["uv", path.join(os.homedir(), ".local", "bin", "uv")]);
  const cmd = uvPath || "python3";
  const args = uvPath
    ? ["run", "--quiet", "--with", "pymupdf", "--with", "pillow", "--with", "numpy", "python3", scriptPath, ...subArgs]
    : [scriptPath, ...subArgs];

  try {
    const { stdout, stderr, code } = await execAsync(cmd, args);
    if (code !== 0) {
      let msg = stderr.trim() || stdout.trim() || `clipper exited with code ${code}`;
      try {
        const parsed = JSON.parse(stderr.trim());
        if (parsed?.error) msg = parsed.error;
      } catch {
        // keep raw stderr
      }
      throw new Error(msg);
    }
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function findExecutable(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (c.includes(path.sep)) {
      try {
        await fsp.access(c);
        return c;
      } catch {
        continue;
      }
    }
    const { code } = await execAsync("which", [c]);
    if (code === 0) return c;
  }
  return null;
}

function execAsync(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export interface RenderOptions {
  pdfPath: string;
  outDir: string;
  dpi?: number;
  pages?: string;
  grid?: boolean;
  hints?: boolean;
}

/**
 * Render PDF pages to PNGs with optional Vision-AI coordinate grid and vector layout hints.
 */
export async function renderPdfPages(opts: RenderOptions): Promise<Record<string, unknown>> {
  const args = [
    "render",
    path.resolve(opts.pdfPath),
    "--out",
    path.resolve(opts.outDir),
    "--dpi",
    String(opts.dpi ?? 150),
    "--pages",
    opts.pages || "all",
  ];
  if (opts.grid) args.push("--grid");
  if (opts.hints) args.push("--hints");
  return runClipperPython(args);
}

/**
 * Execute gutter-snapping + exclude-box white-out masking from a coordinate JSON file.
 */
export async function clipFromCoords(
  coordsJsonPath: string,
  outDir: string
): Promise<Record<string, unknown>> {
  return runClipperPython([
    "clip",
    path.resolve(coordsJsonPath),
    "--out",
    path.resolve(outDir),
  ]);
}

export interface ShowOptions {
  runSheetPath: string;
  outDir: string;
  video?: boolean;
  reel?: boolean;
  audioDir?: string;
}

/**
 * Generate a chaptered multi-voice Newspaper Audio Show (Kokoro-82M + FFmpeg).
 */
export async function generateAudioShow(opts: ShowOptions): Promise<Record<string, unknown>> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "epaper-show-"));
  const scriptPath = path.join(tmpDir, "show.py");
  await fsp.writeFile(scriptPath, showScriptText, "utf8");

  const uvPath = await findExecutable(["uv", path.join(os.homedir(), ".local", "bin", "uv")]);
  const cmd = uvPath || "python3";
  const subArgs = [path.resolve(opts.runSheetPath), "--out", path.resolve(opts.outDir)];
  if (opts.video) subArgs.push("--video");
  if (opts.reel) subArgs.push("--reel");
  if (opts.audioDir) subArgs.push("--audio-dir", path.resolve(opts.audioDir));

  const args = uvPath
    ? [
        "run",
        "--quiet",
        "--with",
        "kokoro-onnx",
        "--with",
        "soundfile",
        "--with",
        "pillow",
        "--with",
        "numpy",
        "python3",
        scriptPath,
        ...subArgs,
      ]
    : [scriptPath, ...subArgs];

  try {
    const { stdout, stderr, code } = await execAsync(cmd, args);
    if (code !== 0) {
      let msg = stderr.trim() || stdout.trim() || `show exited with code ${code}`;
      try {
        const parsed = JSON.parse(stderr.trim());
        if (parsed?.error) msg = parsed.error;
      } catch {
        // keep raw stderr
      }
      throw new Error(msg);
    }
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
