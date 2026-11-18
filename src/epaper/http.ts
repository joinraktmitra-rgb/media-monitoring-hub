import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Fetch a URL with retry and linear backoff for transient network/TLS resets.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", DEFAULT_USER_AGENT);
      }
      const res = await fetch(url, { ...init, headers });
      if (!res.ok && res.status >= 500) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Decode common HTML entities and strip inline tags.
 */
export function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lightweight in-memory cookie jar for session-gated HTTP funnels.
 */
export interface CookieJar {
  updateFromHeaders(headers: Headers): void;
  toHeader(): string;
}

export function createCookieJar(): CookieJar {
  const jar = new Map<string, string>();
  return {
    updateFromHeaders(headers: Headers): void {
      const setCookies =
        typeof headers.getSetCookie === "function"
          ? headers.getSetCookie()
          : headers.get("set-cookie")
            ? [headers.get("set-cookie") as string]
            : [];
      for (const raw of setCookies) {
        const firstPart = raw.split(";")[0];
        const eqIdx = firstPart.indexOf("=");
        if (eqIdx > 0) {
          jar.set(firstPart.slice(0, eqIdx).trim(), firstPart.slice(eqIdx + 1).trim());
        }
      }
    },
    toHeader(): string {
      return Array.from(jar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
  };
}

/**
 * Extract a safe filename from a Content-Disposition header.
 */
export function parseContentDispositionFilename(
  header: string | null,
  fallbackName: string
): string {
  if (!header) return fallbackName;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]).replace(/[/\\?%*:|"<>]/g, "_");
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  if (plainMatch) {
    return plainMatch[1].trim().replace(/[/\\?%*:|"<>]/g, "_");
  }
  return fallbackName;
}

export interface SavedPdfResult {
  filePath: string;
  sizeBytes: number;
  sizeMB: number;
}

/**
 * Stream a Web ReadableStream to a temporary .part file, verify %PDF- header, and rename atomically.
 */
export async function savePdfAtomically(
  body: ReadableStream<Uint8Array>,
  targetPath: string
): Promise<SavedPdfResult> {
  const resolved = path.resolve(targetPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const partPath = `${resolved}.part`;

  await pipeline(Readable.fromWeb(body as any), fs.createWriteStream(partPath));

  const fh = await fsp.open(partPath, "r");
  try {
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    if (buf.toString("ascii") !== "%PDF-") {
      await fsp.rm(partPath, { force: true });
      throw new Error(
        `Downloaded file is not a valid PDF (magic header: ${JSON.stringify(buf.toString("ascii"))})`
      );
    }
  } finally {
    await fh.close();
  }

  await fsp.rename(partPath, resolved);
  const stat = await fsp.stat(resolved);
  return {
    filePath: resolved,
    sizeBytes: stat.size,
    sizeMB: Number((stat.size / (1024 * 1024)).toFixed(2)),
  };
}
