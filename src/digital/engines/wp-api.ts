import type { DigitalArticle, PublicationConfig } from "../types.ts";
import { canonicalizeUrl, httpGet, isWithinHours, parseDateToIso, stripHtml } from "../utils.ts";

interface WpPost {
  link?: string;
  date_gmt?: string;
  date?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  jetpack_featured_media_url?: string;
  _embedded?: {
    author?: Array<{ name?: string }>;
    "wp:featuredmedia"?: Array<{ source_url?: string }>;
  };
}

export async function fetchWpApi(
  pub: PublicationConfig,
  opts: { keyword?: string; hours?: number; limit?: number; timeoutMs?: number } = {}
): Promise<DigitalArticle[]> {
  const base = pub.endpoints.wpApi;
  if (!base) return [];

  const u = new URL(base);
  const perPage = Math.min(opts.limit ?? 30, 50);
  u.searchParams.set("per_page", String(perPage));
  u.searchParams.set("_embed", "true");
  if (opts.keyword?.trim()) {
    u.searchParams.set("search", opts.keyword.trim());
  }
  if (opts.hours && opts.hours > 0) {
    const afterIso = new Date(Date.now() - opts.hours * 3600 * 1000).toISOString();
    u.searchParams.set("after", afterIso);
  }

  const res = await httpGet(u.toString(), opts.timeoutMs ?? 10000);
  if (!res.ok || !res.text.trim().startsWith("[")) return [];

  let posts: WpPost[];
  try {
    posts = JSON.parse(res.text) as WpPost[];
  } catch {
    return [];
  }

  const fetchedAt = new Date().toISOString();
  const articles: DigitalArticle[] = [];

  for (const post of posts) {
    const url = (post.link || "").trim();
    const headline = stripHtml(post.title?.rendered || "");
    if (!url || !headline) continue;

    const publishedAt = parseDateToIso(post.date_gmt ? `${post.date_gmt}Z` : post.date);
    if (!isWithinHours(publishedAt, opts.hours)) continue;

    const description = post.excerpt?.rendered
      ? stripHtml(post.excerpt.rendered).slice(0, 500)
      : null;
    const author = post._embedded?.author?.[0]?.name || null;
    const imageUrl =
      post.jetpack_featured_media_url ||
      post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ||
      null;

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
      source_engine: "wp-api",
      fetched_at: fetchedAt,
    });
  }

  return articles;
}
