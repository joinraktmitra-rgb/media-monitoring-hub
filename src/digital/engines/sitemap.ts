import type { DigitalArticle, PublicationConfig } from "../types.ts";
import {
  canonicalizeUrl,
  extractTag,
  httpGet,
  isWithinHours,
  parseDateToIso,
  stripHtml,
} from "../utils.ts";

function formatSlugHeadline(slugText: string): string {
  if (!slugText) return "";
  const words = slugText.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const lowerStopWords = new Set([
    "a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "by", "in", "of", "with"
  ]);
  return words
    .map((w, idx) => {
      const lower = w.toLowerCase();
      if (idx > 0 && lowerStopWords.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function headlineFromUrlSlug(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    if (!segments.length) return "";
    // Pick the longest non-numeric segment as the article slug
    const candidate =
      segments
        .slice()
        .reverse()
        .find((s) => !/^\d+$/.test(s) && s.length > 6) || segments[segments.length - 1];
    const cleaned = candidate
      .replace(/\.(html?|php|cms|aspx)$/i, "")
      .replace(/[-_]\d{5,}$/g, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return formatSlugHeadline(cleaned);
  } catch {
    return "";
  }
}

export function parseSitemapXml(
  xml: string,
  pub: PublicationConfig,
  hours?: number,
  limit = 150
): DigitalArticle[] {
  const articles: DigitalArticle[] = [];
  const fetchedAt = new Date().toISOString();

  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let match: RegExpExecArray | null;
  while ((match = urlBlockRe.exec(xml)) !== null) {
    const block = match[1];
    const loc = (extractTag(block, "loc") || "").trim();
    if (!loc || !/^https?:\/\//i.test(loc)) continue;

    const rawDate =
      extractTag(block, "news:publication_date") || extractTag(block, "lastmod");
    const publishedAt = parseDateToIso(rawDate);
    if (!isWithinHours(publishedAt, hours)) continue;

    const newsTitle = extractTag(block, "news:title");
    const headline = stripHtml(newsTitle || "") || headlineFromUrlSlug(loc);
    if (!headline) continue;

    const imageUrl =
      extractTag(block, "image:loc") || extractTag(block, "media:content") || null;

    const rawKeywords = extractTag(block, "news:keywords");
    const tags = rawKeywords
      ? rawKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean)
      : undefined;

    const rawDesc = extractTag(block, "news:description") || extractTag(block, "image:caption");
    const description = rawDesc ? stripHtml(rawDesc).slice(0, 500) : null;

    articles.push({
      headline,
      url: loc,
      canonical_url: canonicalizeUrl(loc),
      publication: pub.name,
      slug: pub.slug,
      category: pub.category,
      language: pub.lang,
      published_at: publishedAt,
      author: null,
      description: description || null,
      summary: description || null,
      image_url: imageUrl,
      source_engine: "news-sitemap",
      tags: tags?.length ? tags : undefined,
      fetched_at: fetchedAt,
    });

    if (articles.length >= limit) break;
  }

  return articles;
}

export function prioritizeChildSitemaps(
  childEntries: Array<{ loc: string; lastmod?: string }>
): string[] {
  // Prefer news / post / article sitemaps when mixed with taxonomies/tags/pages
  const postsOnly = childEntries.filter((e) =>
    /news|posts?-post|\/post|article|pti-sitemap/i.test(e.loc)
  );
  const pool = postsOnly.length > 0 ? postsOnly : childEntries;

  return pool
    .slice()
    .sort((a, b) => {
      // 1. Sort by explicit lastmod if both have it
      if (a.lastmod && b.lastmod) {
        const da = Date.parse(a.lastmod) || 0;
        const db = Date.parse(b.lastmod) || 0;
        if (da !== db) return db - da;
      }
      // 2. Sort by date in URL (e.g. 2026-11-19)
      const dateA = a.loc.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      const dateB = b.loc.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      if (dateA && dateB) {
        const strA = `${dateA[1]}-${dateA[2]}-${dateA[3]}`;
        const strB = `${dateB[1]}-${dateB[2]}-${dateB[3]}`;
        return strB.localeCompare(strA);
      }
      // 3. Sort by numeric suffix (e.g. post-38 vs post-1)
      const numA = a.loc.match(/[-_](\d+)\.xml/i);
      const numB = b.loc.match(/[-_](\d+)\.xml/i);
      if (numA && numB) {
        return Number.parseInt(numB[1], 10) - Number.parseInt(numA[1], 10);
      }
      // 4. Fallback: preserve reverse document order (newest typically appended at end)
      return 0;
    })
    .map((e) => e.loc);
}

export async function fetchNewsSitemap(
  pub: PublicationConfig,
  opts: { hours?: number; limit?: number; timeoutMs?: number } = {}
): Promise<DigitalArticle[]> {
  const url = pub.endpoints.sitemap;
  if (!url) return [];
  const timeoutMs = opts.timeoutMs ?? 12000;
  const limit = opts.limit ?? 150;

  const res = await httpGet(url, timeoutMs);
  if (!res.ok || !res.text) return [];

  // Handle <sitemapindex> by prioritizing the most recent child sitemaps (up to 3)
  if (/<sitemapindex\b/i.test(res.text.slice(0, 2000))) {
    const childEntries: Array<{ loc: string; lastmod?: string }> = [];
    for (const m of res.text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
      const childLoc = (extractTag(m[1], "loc") || "").trim();
      const lastmod = (extractTag(m[1], "lastmod") || "").trim();
      if (childLoc && /^https?:\/\//i.test(childLoc)) {
        childEntries.push({ loc: childLoc, lastmod: lastmod || undefined });
      }
    }
    const prioritized = prioritizeChildSitemaps(childEntries);
    const targets = prioritized.slice(0, 3);
    const all: DigitalArticle[] = [];
    for (const childUrl of targets) {
      const childRes = await httpGet(childUrl, timeoutMs);
      if (childRes.ok && childRes.text) {
        all.push(...parseSitemapXml(childRes.text, pub, opts.hours, limit - all.length));
      }
      if (all.length >= limit) break;
    }
    return all;
  }

  return parseSitemapXml(res.text, pub, opts.hours, limit);
}
