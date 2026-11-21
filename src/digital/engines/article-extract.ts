import type { DigitalArticle } from "../types.ts";
import {
  decodeHtmlEntities,
  httpGet,
  parseDateToIso,
  runWithConcurrency,
  stripHtml,
} from "../utils.ts";

function extractMeta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

interface JsonLdExtracted {
  headline?: string;
  description?: string;
  author?: string;
  published_at?: string;
  image_url?: string;
}

function extractJsonLd(html: string): JsonLdExtracted {
  const out: JsonLdExtracted = {};
  const scriptRe =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
          ? parsed["@graph"]
          : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const type = String(node["@type"] || "").toLowerCase();
        if (
          type.includes("newsarticle") ||
          type.includes("article") ||
          type.includes("reportage")
        ) {
          if (!out.headline && typeof node.headline === "string") {
            out.headline = stripHtml(node.headline);
          }
          if (!out.description && typeof node.description === "string") {
            out.description = stripHtml(node.description).slice(0, 500);
          }
          if (!out.published_at && typeof node.datePublished === "string") {
            out.published_at = parseDateToIso(node.datePublished) || undefined;
          }
          if (!out.author && node.author) {
            const auth = Array.isArray(node.author) ? node.author[0] : node.author;
            if (typeof auth === "string") out.author = auth.trim();
            else if (typeof auth?.name === "string") out.author = auth.name.trim();
          }
          if (!out.image_url && node.image) {
            const img = Array.isArray(node.image) ? node.image[0] : node.image;
            if (typeof img === "string") out.image_url = img;
            else if (typeof img?.url === "string") out.image_url = img.url;
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return out;
}

export async function enrichArticle(
  article: DigitalArticle,
  timeoutMs = 8000
): Promise<DigitalArticle> {
  // Skip Google News opaque redirect URLs and YouTube watch URLs (already fully populated)
  if (
    article.url.includes("news.google.com/rss/articles/") ||
    article.url.includes("youtube.com/") ||
    article.url.includes("youtu.be/")
  ) {
    return article;
  }
  const res = await httpGet(article.url, timeoutMs, 0);
  if (!res.ok || !res.text) return article;

  const html = res.text;
  const ld = extractJsonLd(html);

  const ogTitle = extractMeta(html, "og:title") || extractMeta(html, "twitter:title");
  const ogDesc =
    extractMeta(html, "og:description") ||
    extractMeta(html, "description") ||
    extractMeta(html, "twitter:description");
  const ogImage = extractMeta(html, "og:image") || extractMeta(html, "twitter:image");
  const metaAuthor =
    extractMeta(html, "author") || extractMeta(html, "article:author");
  const metaPubTime =
    extractMeta(html, "article:published_time") ||
    extractMeta(html, "publish-date") ||
    extractMeta(html, "datePublished");

  return {
    ...article,
    headline: article.headline || ld.headline || ogTitle || article.headline,
    description: article.description || ld.description || ogDesc || null,
    summary: article.summary || ld.description || ogDesc || article.description || null,
    image_url: article.image_url || ld.image_url || ogImage || null,
    author: article.author || ld.author || metaAuthor || null,
    published_at:
      article.published_at || ld.published_at || parseDateToIso(metaPubTime) || null,
  };
}

export async function enrichArticles(
  articles: DigitalArticle[],
  concurrency = 8,
  timeoutMs = 8000
): Promise<DigitalArticle[]> {
  return runWithConcurrency(articles, concurrency, (art) => enrichArticle(art, timeoutMs));
}
