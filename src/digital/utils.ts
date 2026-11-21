import type { DigitalArticle } from "./types.ts";

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
  contentType: string;
  error?: string;
}

export async function httpGet(
  url: string,
  timeoutMs = 10000,
  retries = 1
): Promise<HttpResult> {
  let lastError = "Unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await res.text();
      clearTimeout(timer);
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          text,
          finalUrl: res.url,
          contentType: res.headers.get("content-type") || "",
        };
      }
      lastError = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return {
          ok: false,
          status: res.status,
          text,
          finalUrl: res.url,
          contentType: res.headers.get("content-type") || "",
          error: lastError,
        };
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return {
    ok: false,
    status: 0,
    text: "",
    finalUrl: url,
    contentType: "",
    error: lastError,
  };
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&hellip;": "…",
  "&trade;": "™",
  "&copy;": "©",
  "&reg;": "®",
  "&bull;": "•",
  "&middot;": "·",
};

export function decodeHtmlEntities(input: string): string {
  if (!input) return "";
  let out = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  out = out.replace(/&#(\d+);/g, (_, num) => {
    const code = Number.parseInt(num, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  out = out.replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|lsquo|rsquo|ldquo|rdquo|hellip|trade|copy|reg|bull|middot);/g,
    (m) => ENTITY_MAP[m] ?? m
  );
  return out;
}

export function stripHtml(input: string): string {
  if (!input) return "";
  const decoded = decodeHtmlEntities(input);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTag(xml: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).trim();
}

export function extractAttr(xml: string, tagName: string, attrName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i");
  const m = xml.match(re);
  return m ? decodeHtmlEntities(m[1]).trim() : null;
}

export function parseDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Normalize Indian and common timezone abbreviations unrecognized by Date.parse
  // IST (Indian Standard Time) -> +05:30, GMT/UTC -> +00:00
  trimmed = trimmed.replace(/\bIST\b/g, "+05:30");
  trimmed = trimmed.replace(/\bGMT\b/g, "+00:00");
  trimmed = trimmed.replace(/\bUTC\b/g, "+00:00");

  // Fix military-style times e.g. "July 16, 2003 1800 +05:30" -> "July 16, 2003 18:00:00 +05:30"
  trimmed = trimmed.replace(/\b(\d{2})(\d{2})\s*([+-]\d{2}:?\d{2})/g, "$1:$2:00 $3");

  // Normalize space separator in ISO-like strings e.g. "2026-11-19 14:30:00" -> "2026-11-19T14:30:00"
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) {
    trimmed = trimmed.replace(/\s+/, "T");
  }

  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

export function isWithinHours(isoDate: string | null, hours?: number): boolean {
  if (!hours || hours <= 0) return true;
  if (!isoDate) return true; // Keep undated items unless strict filtering is desired
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return true;
  const cutoff = Date.now() - hours * 3600 * 1000;
  return ts >= cutoff;
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "oc",
  "ref",
  "ref_src",
]);

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        u.searchParams.delete(key);
      }
    }
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    u.pathname = path;
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function matchKeywords(
  article: Pick<DigitalArticle, "headline" | "description" | "url" | "tags"> & {
    summary?: string | null;
  },
  keywords: string[],
  matchAll = false
): string[] {
  if (!keywords.length) return [];
  const haystack = [
    article.headline || "",
    article.description || "",
    article.summary || "",
    article.url || "",
    ...(article.tags || []),
  ]
    .join(" ")
    .normalize("NFC")
    .toLowerCase();

  const matched: string[] = [];
  for (const kw of keywords) {
    const needle = kw.trim().normalize("NFC").toLowerCase();
    if (!needle) continue;
    if (haystack.includes(needle)) {
      matched.push(kw.trim());
    }
  }
  if (matchAll && matched.length < keywords.filter((k) => k.trim()).length) {
    return [];
  }
  return matched;
}

export function deduplicateArticles(articles: DigitalArticle[]): DigitalArticle[] {
  const byKey = new Map<string, DigitalArticle>();
  for (const art of articles) {
    const key = art.canonical_url || art.url;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, art);
    } else {
      // Merge richer metadata (prefer direct feed over gnews-rss, keep non-null fields)
      const preferNew =
        existing.source_engine === "gnews-rss" && art.source_engine !== "gnews-rss";
      const base = preferNew ? art : existing;
      const other = preferNew ? existing : art;
      const mergedKeywords = Array.from(
        new Set([...(base.matched_keywords || []), ...(other.matched_keywords || [])])
      );
      byKey.set(key, {
        ...base,
        published_at: base.published_at || other.published_at,
        author: base.author || other.author,
        description: base.description || other.description,
        summary: base.summary || other.summary || base.description || other.description || null,
        image_url: base.image_url || other.image_url,
        matched_keywords: mergedKeywords.length ? mergedKeywords : undefined,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const ta = a.published_at ? Date.parse(a.published_at) : 0;
    const tb = b.published_at ? Date.parse(b.published_at) : 0;
    return tb - ta;
  });
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () =>
    runner()
  );
  await Promise.all(workers);
  return results;
}
