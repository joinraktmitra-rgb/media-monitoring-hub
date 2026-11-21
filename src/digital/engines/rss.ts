import type { DigitalArticle, PublicationConfig } from "../types.ts";
import {
  canonicalizeUrl,
  extractAttr,
  extractTag,
  httpGet,
  isWithinHours,
  parseDateToIso,
  stripHtml,
} from "../utils.ts";

export function parseRssOrAtomXml(
  xml: string,
  pub: PublicationConfig,
  engine: DigitalArticle["source_engine"] = "rss",
  hours?: number,
  limit = 100
): DigitalArticle[] {
  const articles: DigitalArticle[] = [];
  const fetchedAt = new Date().toISOString();

  const isAtom = /<feed\b/i.test(xml.slice(0, 1500)) && !/<rss\b/i.test(xml.slice(0, 1500));
  const blockRegex = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
    : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml)) !== null) {
    const block = match[1];
    const rawTitle = extractTag(block, "title");
    const headline = stripHtml(rawTitle || "");

    let url = isAtom
      ? extractAttr(block, "link", "href") || extractTag(block, "link") || ""
      : extractTag(block, "link") || extractAttr(block, "link", "href") || extractTag(block, "guid") || "";
    url = url.trim();

    if (!headline || !url || !/^https?:\/\//i.test(url)) continue;

    const rawDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated") ||
      extractTag(block, "dc:date");
    const publishedAt = parseDateToIso(rawDate);

    if (!isWithinHours(publishedAt, hours)) continue;

    const rawDesc =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "media:description") ||
      extractTag(block, "content:encoded") ||
      extractTag(block, "content");
    const description = rawDesc ? stripHtml(rawDesc).slice(0, 500) : null;

    const authorBlock = extractTag(block, "author");
    let author: string | null = null;
    if (authorBlock) {
      author = stripHtml(extractTag(authorBlock, "name") || authorBlock) || null;
    }
    if (!author) {
      author =
        stripHtml(
          extractTag(block, "dc:creator") ||
            extractTag(block, "author") ||
            extractTag(block, "name") ||
            ""
        ) || null;
    }

    let imageUrl =
      extractAttr(block, "media:thumbnail", "url") ||
      extractAttr(block, "enclosure", "url") ||
      null;
    if (!imageUrl) {
      const mediaContentUrl = extractAttr(block, "media:content", "url");
      if (mediaContentUrl && !mediaContentUrl.includes("youtube.com/v/")) {
        imageUrl = mediaContentUrl;
      }
    }
    if (!imageUrl && rawDesc) {
      const imgMatch = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch) imageUrl = imgMatch[1];
    }

    const tags: string[] = [];
    for (const cm of block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)) {
      const t = stripHtml(cm[1]);
      if (t && !tags.includes(t)) tags.push(t);
    }

    articles.push({
      headline,
      url,
      canonical_url: canonicalizeUrl(url),
      publication: pub.name,
      slug: pub.slug,
      category: pub.category,
      language: pub.lang,
      published_at: publishedAt,
      author,
      description: description || null,
      summary: description || null,
      image_url: imageUrl,
      source_engine: engine,
      tags: tags.length ? tags : undefined,
      fetched_at: fetchedAt,
    });

    if (articles.length >= limit) break;
  }

  return articles;
}

export async function fetchRss(
  pub: PublicationConfig,
  opts: { hours?: number; limit?: number; timeoutMs?: number } = {}
): Promise<DigitalArticle[]> {
  const url = pub.endpoints.rss;
  if (!url) return [];
  const res = await httpGet(url, opts.timeoutMs ?? 10000);
  if (!res.ok || !res.text) return [];
  return parseRssOrAtomXml(res.text, pub, "rss", opts.hours, opts.limit ?? 100);
}
