import type { DigitalArticle, PublicationConfig } from "../types.ts";
import { httpGet } from "../utils.ts";
import { parseRssOrAtomXml } from "./rss.ts";

export async function fetchYouTubeFeed(
  pub: PublicationConfig,
  opts: { hours?: number; limit?: number; timeoutMs?: number } = {}
): Promise<DigitalArticle[]> {
  const channelId = pub.endpoints.youtubeChannelId;
  if (!channelId) return [];

  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await httpGet(url, opts.timeoutMs ?? 10000);
  if (!res.ok || !res.text) return [];

  return parseRssOrAtomXml(res.text, pub, "youtube-rss", opts.hours, opts.limit ?? 25);
}
