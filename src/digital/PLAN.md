# Digital, Wire & Broadcast-Digital Media Monitoring CLI (`src/digital/`)

Unified Bun TypeScript CLI covering **47 Indian Wire Agencies, Digital News Portals, Business Portals, TV News Digital Wings, and Public Broadcasters**.

## Folder Structure (Planned)

```
src/digital/
├── PLAN.md                  # Architecture & phased rollout plan
├── publications.json        # Master catalog of all 47 outlets + strategies
├── digital.ts               # Unified CLI entrypoint (list | check | fetch | search | ingest)
├── types.ts                 # Normalized Article / Video / BroadcastItem schema
├── engines/
│   ├── rss.ts               # Generic RSS 2.0 / Atom XML parser + date-window filter
│   ├── sitemap.ts           # Google News Sitemap (news-sitemap.xml) crawler
│   ├── wp-api.ts            # WordPress REST API (/wp-json/wp/v2/posts?search=...)
│   ├── gnews-site.ts        # Zero-browser Google News RSS site:<domain> fallback
│   ├── youtube-feed.ts      # YouTube channel Atom feed (feeds/videos.xml) for TV channels
│   └── article-extract.ts   # Clean full-text + metadata (og:image, author, published_at) extractor
└── providers/               # Outlet-specific overrides only where generic engines aren't enough
    ├── pti.ts               # PTI wire search / API adapter
    ├── ani.ts               # ANI wire adapter
    ├── uni.ts               # UNI wire adapter
    ├── ians.ts              # IANS wire adapter
    └── public-broadcast.ts  # DD News, DD India, Sansad TV, News on AIR
```

## Unified CLI Interface

```bash
# List all 47 outlets (or filter by category / language)
bun run digital list [--category wire|business|english-digital|hindi-digital|broadcast-english|broadcast-hindi|public-broadcaster] [--json]

# Live health-check across all 47 outlets (verifies RSS / Sitemap / API reachability)
bun run digital check [--json]

# Keyword search across all 47 outlets (strict time window, parallel concurrency, deduped)
bun run digital search "Kashi Tamil Sangamam" --hours 48 [--preset all|wire|business|hindi|english|tv|public] [--out ./dataset/digital.json]

# Pull latest feed items from specific outlets
bun run digital fetch --outlets pti,ani,ndtv,aaj-tak --hours 24 --json

# Search + ingest directly into data/media_dataset.db
bun run digital monitor --keywords "keyword1,keyword2" --hours 48 --db data/media_dataset.db
```

## Build Phases

1. **Phase 1 — Endpoint Discovery & Health Matrix**: Probe all 47 domains in parallel to lock down exact working RSS URLs, `news-sitemap.xml` URLs, WP REST endpoints, and official YouTube channel IDs.
2. **Phase 2 — Core Engines (`engines/`)**: Build the 5 zero-browser HTTP engines (`rss.ts`, `sitemap.ts`, `wp-api.ts`, `gnews-site.ts`, `youtube-feed.ts`) with concurrency limits, retry/backoff, and multilingual keyword matching.
3. **Phase 3 — Custom Wire & Public Broadcaster Adapters (`providers/`)**: Wire-specific adapters for PTI, ANI, UNI, IANS, and Sansad TV / News on AIR / DD India.
4. **Phase 4 — Unified CLI + SQLite Integration**: Wire `src/digital/digital.ts` into `package.json`, add URL-normalized deduplication, and write directly to `data/media_dataset.db` (plus optional screenshot capture only for verified matches).
