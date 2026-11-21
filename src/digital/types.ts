export type Category =
  | "wire"
  | "business"
  | "english-digital"
  | "hindi-digital"
  | "broadcast-english"
  | "broadcast-hindi"
  | "public-broadcaster";

export type StrategyName =
  | "rss"
  | "news-sitemap"
  | "wp-api"
  | "youtube-rss"
  | "gnews-rss";

export interface PublicationEndpoints {
  rss?: string;
  sitemap?: string;
  wpApi?: string;
  youtubeChannelId?: string;
  gnewsQuery?: string;
}

export interface PublicationConfig {
  slug: string;
  name: string;
  category: Category;
  lang: string;
  domain: string;
  strategies: StrategyName[];
  endpoints: PublicationEndpoints;
}

export interface PublicationsCatalog {
  version: string;
  total: number;
  categories: Category[];
  publications: PublicationConfig[];
}

export interface DigitalArticle {
  headline: string;
  url: string;
  canonical_url: string;
  publication: string;
  slug: string;
  category: Category;
  language: string;
  published_at: string | null;
  author: string | null;
  description: string | null;
  summary?: string | null;
  image_url: string | null;
  source_engine: StrategyName;
  matched_keywords?: string[];
  tags?: string[];
  fetched_at: string;
}

export interface HealthCheckResult {
  slug: string;
  name: string;
  category: Category;
  lang: string;
  domain: string;
  ok: boolean;
  engine: StrategyName | null;
  item_count: number;
  latency_ms: number;
  sample_headline: string | null;
  sample_url: string | null;
  error: string | null;
}

export interface FetchOptions {
  hours?: number;
  limitPerOutlet?: number;
  timeoutMs?: number;
  concurrency?: number;
  includeAllEngines?: boolean;
}

export interface SearchOptions extends FetchOptions {
  keywords: string[];
  matchAll?: boolean;
  useGnewsFallback?: boolean;
}
