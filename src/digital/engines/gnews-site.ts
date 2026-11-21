import type { DigitalArticle, PublicationConfig } from "../types.ts";
import { httpGet } from "../utils.ts";
import { parseRssOrAtomXml } from "./rss.ts";

function buildGnewsLocale(lang: string): string {
  if (lang === "hi") return "hl=hi&gl=IN&ceid=IN:hi";
  return "hl=en-IN&gl=IN&ceid=IN:en";
}

function formatWhenClause(hours?: number): string {
  if (!hours || hours <= 0) return "";
  if (hours <= 72) return ` when:${Math.ceil(hours)}h`;
  const days = Math.ceil(hours / 24);
  return ` when:${days}d`;
}

export async function fetchGnewsSite(
  pub: PublicationConfig,
  opts: { keyword?: string; hours?: number; limit?: number; timeoutMs?: number } = {}
): Promise<DigitalArticle[]> {
  const scope = pub.endpoints.gnewsQuery
    ? pub.endpoints.gnewsQuery
    : `site:${pub.domain}`;

  let query = scope;
  if (opts.keyword?.trim()) {
    const kw = opts.keyword.trim();
    const quoted = kw.includes(" ") && !kw.startsWith('"') ? `"${kw}"` : kw;
    query = `${quoted} ${scope}`;
  }
  query += formatWhenClause(opts.hours);

  const locale = buildGnewsLocale(pub.lang);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`;

  const res = await httpGet(url, opts.timeoutMs ?? 10000);
  if (!res.ok || !res.text) return [];

  const items = parseRssOrAtomXml(res.text, pub, "gnews-rss", opts.hours, opts.limit ?? 50);

  // Clean trailing " - Publication Name" suffix that Google News appends to titles
  return items.map((item) => {
    const idx = item.headline.lastIndexOf(" - ");
    if (idx > 15) {
      return { ...item, headline: item.headline.slice(0, idx).trim() };
    }
    return item;
  });
}
