#!/usr/bin/env bun
/**
 * Ampio Labs — Instagram Social Intelligence CLI
 * Drives the user's connected Chrome browser via the `browse` extension/relay.
 * Uses the active authenticated session (@officialraktmitra) to bypass bot gates,
 * extract exact timestamps, captions, hashtags, and capture crisp post/reel screenshots.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

export interface InstagramPost {
  id: string;
  shortcode: string;
  type: "post" | "reel" | "carousel";
  url: string;
  author: string;
  caption: string;
  published_at: string; // ISO 8601
  hours_ago: number;
  matched_keywords?: string[];
  clip_path?: string;
  likes_count?: number;
  comments_count?: number;
  thumbnail_url?: string;
  fetched_at: string;
}

export const DEFAULT_HANDLES = ["eduminofindia", "ktsangamam"];
export const DEFAULT_TAGS = ["kashitamilsangamam", "kts5"];

const OUT_DIR = path.resolve("clips/instagram");
const DB_PATH = path.resolve("data/media_dataset.db");

// ============================================================================
// BROWSE CLI EXECUTION HELPER
// ============================================================================
async function runBrowseCode<T = any>(jsCode: string, timeoutSec: number = 60): Promise<T | null> {
  return new Promise((resolve) => {
    const child = spawn("browse", ["execute", jsCode], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(null);
    }, timeoutSec * 1000);

    child.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
          try {
            const parsed = JSON.parse(trimmed);
            return resolve(parsed);
          } catch {}
        }
      }
      resolve(null);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ============================================================================
// PROFILE & POST EXTRACTION LOGIC
// ============================================================================
export async function getBrowserAuthStatus(): Promise<{
  connected: boolean;
  username: string | null;
  error?: string;
}> {
  const code = `
try {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(2000);
  const data = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href") || "");
    const profileLink = anchors.find(h => /^\\/[a-zA-Z0-9._]+\\/$/.test(h) && !["/explore/", "/reels/", "/direct/", "/stories/"].includes(h));
    const isLoginLink = anchors.some(h => h.includes("/accounts/login"));
    return {
      username: profileLink ? profileLink.replace(/\\//g, "") : null,
      isLoggedOut: isLoginLink
    };
  });
  return { ok: true, username: data.username, isLoggedOut: data.isLoggedOut };
} catch (e) {
  return { ok: false, error: e.message };
} finally {
  await page.close();
}
`;
  const res = await runBrowseCode(code, 25);
  if (res && res.ok && res.username) {
    return { connected: true, username: res.username };
  }
  return { connected: false, username: null, error: res?.error || "Not logged in or browser relay unreachable" };
}

export async function fetchProfilePosts(
  handle: string,
  limit: number = 12
): Promise<Array<{ url: string; shortcode: string; type: "post" | "reel" }>> {
  const code = `
try {
  await page.goto("https://www.instagram.com/${handle}/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);

  const posts = await page.evaluate((lim) => {
    const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
    const unique = new Map();
    for (const a of links) {
      const href = a.href;
      const m = href.match(/\\/(p|reel)\\/([a-zA-Z0-9_-]+)/);
      if (m && !unique.has(m[2])) {
        unique.set(m[2], {
          url: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/",
          shortcode: m[2],
          type: m[1] === "reel" ? "reel" : "post"
        });
      }
      if (unique.size >= lim) break;
    }
    return Array.from(unique.values());
  }, ${limit});

  return { ok: true, posts };
} catch (e) {
  return { ok: false, error: e.message };
} finally {
  await page.close();
}
`;
  const res = await runBrowseCode(code, 35);
  return res && res.ok && Array.isArray(res.posts) ? res.posts : [];
}

export async function fetchTagPosts(
  tag: string,
  limit: number = 10
): Promise<Array<{ url: string; shortcode: string; type: "post" | "reel" }>> {
  const cleanTag = tag.replace(/^#/, "");
  const code = `
try {
  await page.goto("https://www.instagram.com/explore/tags/${cleanTag}/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);

  const posts = await page.evaluate((lim) => {
    const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
    const unique = new Map();
    for (const a of links) {
      const href = a.href;
      const m = href.match(/\\/(p|reel)\\/([a-zA-Z0-9_-]+)/);
      if (m && !unique.has(m[2])) {
        unique.set(m[2], {
          url: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/",
          shortcode: m[2],
          type: m[1] === "reel" ? "reel" : "post"
        });
      }
      if (unique.size >= lim) break;
    }
    return Array.from(unique.values());
  }, ${limit});

  return { ok: true, posts };
} catch (e) {
  return { ok: false, error: e.message };
} finally {
  await page.close();
}
`;
  const res = await runBrowseCode(code, 35);
  return res && res.ok && Array.isArray(res.posts) ? res.posts : [];
}

export async function inspectAndScreenshotPost(
  postUrl: string,
  options: { takeScreenshot?: boolean; outDir?: string } = {}
): Promise<InstagramPost | null> {
  const m = postUrl.match(/\/(p|reel)\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const shortcode = m[2];
  const postType = m[1] === "reel" ? "reel" : "post";
  const outDir = options.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const shotPath = path.join(outDir, `${shortcode}.png`);
  const shouldShoot = options.takeScreenshot !== false;

  const code = `
try {
  await page.goto(${JSON.stringify(postUrl)}, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2200);

  const details = await page.evaluate(() => {
    const timeEl = document.querySelector("time");
    const dt = timeEl ? timeEl.getAttribute("datetime") : null;
    
    // Find caption text
    let captionText = "";
    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText.trim().length > 15) {
      captionText = h1.innerText.trim();
    } else {
      const candidateSpans = Array.from(document.querySelectorAll("article span, div[role='main'] span, ul span, div span"))
        .map(s => s.innerText.trim())
        .filter(t => t.length > 20 && !t.includes("Start the conversation") && !t.includes("Afrikaans") && !t.includes("Terms"));
      if (candidateSpans.length > 0) {
        captionText = candidateSpans[0];
      }
    }

    // Author
    const authorAnchor = document.querySelector("header a, h2 a, span a[href*='/']");
    const author = authorAnchor ? authorAnchor.innerText.trim() : "creator";

    return {
      datetime: dt,
      caption: captionText,
      author: author.replace(/[@\\s]/g, "")
    };
  });

  ${
    shouldShoot
      ? `await page.screenshot({ path: ${JSON.stringify(shotPath)} });`
      : ""
  }

  return { ok: true, details };
} catch (e) {
  return { ok: false, error: e.message };
} finally {
  await page.close();
}
`;

  const res = await runBrowseCode(code, 35);
  if (!res || !res.ok || !res.details) return null;

  const det = res.details;
  let isoDate = new Date().toISOString();
  let hoursAgo = 0;

  if (det.datetime) {
    try {
      const parsed = new Date(det.datetime);
      if (!isNaN(parsed.getTime())) {
        isoDate = parsed.toISOString();
        hoursAgo = Math.max(0, (Date.now() - parsed.getTime()) / (1000 * 3600));
      }
    } catch {}
  }

  let finalCaption = det.caption || "";
  if (!finalCaption) {
    try {
      const oembedRes = await fetch(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(postUrl)}`);
      if (oembedRes.ok) {
        const oembedJson = (await oembedRes.json()) as any;
        if (oembedJson && oembedJson.title) {
          finalCaption = oembedJson.title;
        }
      }
    } catch {}
  }

  const post: InstagramPost = {
    id: shortcode,
    shortcode,
    type: postType,
    url: postUrl,
    author: det.author || "instagram_creator",
    caption: finalCaption,
    published_at: isoDate,
    hours_ago: Math.round(hoursAgo * 10) / 10,
    clip_path: fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000 ? shotPath : undefined,
    fetched_at: new Date().toISOString(),
  };

  return post;
}

// ============================================================================
// SQLITE PERSISTENCE
// ============================================================================
export async function syncPostsToDb(posts: InstagramPost[], dbPath: string = DB_PATH): Promise<number> {
  if (posts.length === 0) return 0;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE IF NOT EXISTS clippings_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT,
      publication TEXT,
      edition TEXT,
      page_number INTEGER,
      date TEXT,
      major_category TEXT,
      sentiment TEXT,
      clip_path TEXT,
      raw_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const stmt = db.prepare(`
    INSERT INTO clippings_metadata (headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const p of posts) {
    const headline = p.caption ? p.caption.slice(0, 95).replace(/\n/g, " ") : `Instagram Post by @${p.author}`;
    const pub = `Instagram (@${p.author})`;
    const dateStr = p.published_at.slice(0, 10);
    const clipPath = p.clip_path || "";
    const rawJson = JSON.stringify(p);

    try {
      stmt.run(headline, pub, "Online", 1, dateStr, "Online Coverage", "Positive", clipPath, rawJson);
      inserted++;
    } catch {}
  }

  db.close();
  return inserted;
}

// ============================================================================
// CLI INTERFACE
// ============================================================================
function printHelp() {
  console.log(`
Ampio Labs — Instagram Social Intelligence CLI
Drives connected Chrome browser via browse relay (@officialraktmitra session).

Usage:
  bun run src/social/instagram.ts <command> [options]

Commands:
  status                        Check connected browser auth state & user handle
  handle <names...>             Scan Instagram profile(s) for latest posts/reels
  tag <tags...>                 Scan Instagram hashtag(s) for top posts
  search "<keyword>"            Search captions across monitored handles & tags within window

Options:
  -H, --hours <n>               Lookback window in hours (default: 48)
  --limit <n>                   Max posts to scan per handle/tag (default: 10)
  --no-screenshot               Skip desktop screenshot capture
  --ingest                      Auto-sync matched items into data/media_dataset.db
  --json                        Output structured JSON to stdout
  -h, --help                    Show this help message

Examples:
  bun run src/social/instagram.ts status
  bun run src/social/instagram.ts handle eduminofindia,ktsangamam -H 48
  bun run src/social/instagram.ts search "Kashi Tamil Sangamam" -H 48 --ingest
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const command = argv[0];
  let hours = 48;
  let limit = 10;
  let screenshot = true;
  let ingest = false;
  let asJson = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-H" || a === "--hours") hours = parseFloat(argv[++i]);
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
    else if (a === "--no-screenshot") screenshot = false;
    else if (a === "--ingest") ingest = true;
    else if (a === "--json") asJson = true;
  }

  // STATUS
  if (command === "status") {
    const st = await getBrowserAuthStatus();
    if (asJson) {
      console.log(JSON.stringify(st, null, 2));
    } else {
      if (st.connected) {
        console.log(`✓ Connected Browser: Active`);
        console.log(`  Logged in as: @${st.username}`);
      } else {
        console.log(`✗ Connected Browser: ${st.error || "Disconnected"}`);
      }
    }
    return;
  }

  // HANDLE
  if (command === "handle") {
    const targets = argv[1] && !argv[1].startsWith("-") ? argv[1].split(",") : DEFAULT_HANDLES;
    if (!asJson) console.log(`\nScanning ${targets.length} Instagram handle(s) (window: ${hours}h)...`);

    const allVerified: InstagramPost[] = [];
    for (const h of targets) {
      const handleClean = h.trim().replace(/^@/, "");
      if (!asJson) console.log(`  -> Fetching @${handleClean}...`);
      const links = await fetchProfilePosts(handleClean, limit);
      if (!asJson) console.log(`     Discovered ${links.length} recent item(s). Inspecting...`);

      for (const l of links) {
        const post = await inspectAndScreenshotPost(l.url, { takeScreenshot: screenshot });
        if (post && post.hours_ago <= hours) {
          allVerified.push(post);
          if (!asJson) {
            console.log(`     ✓ [${post.author}] (${post.hours_ago}h ago): ${post.caption.slice(0, 60)}...`);
            if (post.clip_path) console.log(`       Screenshot: ${path.basename(post.clip_path)}`);
          }
        }
      }
    }

    if (ingest && allVerified.length > 0) {
      const num = await syncPostsToDb(allVerified);
      if (!asJson) console.log(`\n💾 Ingested ${num} post(s) into database.`);
    }

    if (asJson) {
      console.log(JSON.stringify(allVerified, null, 2));
    } else {
      console.log(`\nFinished: Verified ${allVerified.length} post(s) within the ${hours}h window.`);
    }
    return;
  }

  // SEARCH
  if (command === "search") {
    const query = argv[1] && !argv[1].startsWith("-") ? argv[1].trim().toLowerCase() : "";
    if (!query) {
      console.error("Please provide a search keyword: bun run src/social/instagram.ts search \"<keyword>\"");
      process.exit(1);
    }

    if (!asJson) console.log(`\nSearching Instagram for "${query}" across monitored handles within ${hours}h...`);

    const keywords = query.split(/[\s,]+/).filter((k) => k.length > 1);
    const candidateLinks: Array<{ url: string; shortcode: string; type: "post" | "reel" }> = [];

    for (const h of DEFAULT_HANDLES) {
      const l = await fetchProfilePosts(h, limit);
      candidateLinks.push(...l);
    }
    for (const t of DEFAULT_TAGS) {
      const l = await fetchTagPosts(t, limit);
      candidateLinks.push(...l);
    }

    // Deduplicate candidate URLs
    const uniqueMap = new Map<string, { url: string; shortcode: string; type: "post" | "reel" }>();
    for (const c of candidateLinks) uniqueMap.set(c.shortcode, c);
    const unique = Array.from(uniqueMap.values());

    if (!asJson) console.log(`Discovered ${unique.length} candidate post(s). Filtering by keyword & time...`);

    const matchedPosts: InstagramPost[] = [];
    for (const item of unique) {
      const post = await inspectAndScreenshotPost(item.url, { takeScreenshot: screenshot });
      if (!post) continue;

      if (post.hours_ago > hours) continue;

      const fullText = (post.caption + " " + post.author).toLowerCase();
      const hits = keywords.filter((k) => fullText.includes(k));
      if (hits.length > 0) {
        post.matched_keywords = hits;
        matchedPosts.push(post);
        if (!asJson) {
          console.log(`  ✓ MATCH: [@${post.author}] (${post.hours_ago}h ago): ${post.caption.slice(0, 60)}...`);
          if (post.clip_path) console.log(`    Screenshot: ${path.basename(post.clip_path)}`);
        }
      }
    }

    if (ingest && matchedPosts.length > 0) {
      const num = await syncPostsToDb(matchedPosts);
      if (!asJson) console.log(`\n💾 Ingested ${num} match(es) into database.`);
    }

    if (asJson) {
      console.log(JSON.stringify(matchedPosts, null, 2));
    } else {
      console.log(`\nSearch complete: Found ${matchedPosts.length} matching post(s).`);
    }
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error("FATAL in Instagram CLI:", err);
  process.exit(1);
});
