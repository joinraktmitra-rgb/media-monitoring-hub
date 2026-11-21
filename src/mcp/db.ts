import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const WORKSPACE_ROOT = process.cwd();
export const DATA_DIR = join(WORKSPACE_ROOT, 'data');
export const TOPICS_DIR = join(DATA_DIR, 'topics');
export const SYSTEM_DB_PATH = join(DATA_DIR, 'system.db');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TOPICS_DIR, { recursive: true });

export function sanitizeTopic(topic: string): string {
  const cleaned = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'default_topic';
}

function openWalDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

// ---------------------------------------------------------------------------
// 1. System DB: API Keys + Async Jobs Registry
// ---------------------------------------------------------------------------
let _systemDb: Database | null = null;

export function getSystemDb(): Database {
  if (_systemDb) return _systemDb;
  const db = openWalDb(SYSTEM_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      allowed_topics TEXT NOT NULL DEFAULT '*',
      rate_limit INTEGER NOT NULL DEFAULT 120,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      progress TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  _systemDb = db;
  return db;
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function createApiKey(clientName: string, allowedTopics = '*', rateLimit = 120) {
  const db = getSystemDb();
  const id = randomUUID().slice(0, 8);
  const rawKey = `ampio_sec_${randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 18);
  const keyHash = hashApiKey(rawKey);
  const now = new Date().toISOString();

  db.query(
    `INSERT INTO api_keys (id, client_name, key_prefix, key_hash, allowed_topics, rate_limit, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, clientName, keyPrefix, keyHash, allowedTopics, rateLimit, now);

  return { id, client_name: clientName, api_key: rawKey, allowed_topics: allowedTopics, rate_limit: rateLimit, created_at: now };
}

export function verifyApiKey(rawKey: string): { valid: boolean; client_name?: string; allowed_topics?: string } {
  if (!rawKey) return { valid: false };
  const db = getSystemDb();
  const row = db
    .query(`SELECT client_name, allowed_topics, active FROM api_keys WHERE key_hash = ?`)
    .get(hashApiKey(rawKey)) as { client_name: string; allowed_topics: string; active: number } | null;

  if (!row || row.active !== 1) return { valid: false };
  return { valid: true, client_name: row.client_name, allowed_topics: row.allowed_topics };
}

export function listApiKeys() {
  const db = getSystemDb();
  return db
    .query(`SELECT id, client_name, key_prefix, allowed_topics, rate_limit, active, created_at FROM api_keys ORDER BY created_at DESC`)
    .all();
}

export function revokeApiKey(id: string): boolean {
  const db = getSystemDb();
  const res = db.query(`UPDATE api_keys SET active = 0 WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Jobs CRUD
export interface JobRecord {
  id: string;
  topic: string;
  tool_name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function createJob(topic: string, toolName: string, progress = 'Queued'): JobRecord {
  const db = getSystemDb();
  const id = `job_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO jobs (id, topic, tool_name, status, progress, result_json, error, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, NULL, NULL, ?, ?)`
  ).run(id, sanitizeTopic(topic), toolName, progress, now, now);
  return getJob(id)!;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'error'>> & { result?: unknown }
) {
  const db = getSystemDb();
  const current = getJob(id);
  if (!current) return;
  const now = new Date().toISOString();
  const nextStatus = patch.status ?? current.status;
  const nextProgress = patch.progress ?? current.progress;
  const nextResult = patch.result !== undefined ? JSON.stringify(patch.result) : current.result_json;
  const nextError = patch.error !== undefined ? patch.error : current.error;

  db.query(
    `UPDATE jobs SET status = ?, progress = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?`
  ).run(nextStatus, nextProgress, nextResult, nextError, now, id);
}

export function getJob(id: string): JobRecord | null {
  const db = getSystemDb();
  return db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRecord | null;
}

export function listRecentJobs(limit = 15): JobRecord[] {
  const db = getSystemDb();
  return db.query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRecord[];
}

// ---------------------------------------------------------------------------
// 2. Per-Topic Isolated SQLite Databases: data/topics/<topic_slug>.db
// ---------------------------------------------------------------------------
const topicDbCache = new Map<string, Database>();

export function getTopicDbPath(topic: string): string {
  return join(TOPICS_DIR, `${sanitizeTopic(topic)}.db`);
}

export function getTopicDb(topic: string): Database {
  const slug = sanitizeTopic(topic);
  if (topicDbCache.has(slug)) return topicDbCache.get(slug)!;

  const db = openWalDb(getTopicDbPath(slug));
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      source TEXT DEFAULT '',
      domain TEXT DEFAULT '',
      category TEXT DEFAULT 'Print & Digital News',
      media_type TEXT DEFAULT 'news_article',
      snippet TEXT DEFAULT '',
      content_published_at TEXT,
      content_date TEXT,
      relative_time TEXT,
      timestamp_confidence INTEGER DEFAULT 0,
      time_source TEXT,
      screenshot_status TEXT DEFAULT 'PENDING',
      clip_path TEXT,
      quality_score INTEGER DEFAULT 0,
      sentiment TEXT DEFAULT 'Neutral',
      notes TEXT DEFAULT '',
      flagged_irrelevant INTEGER DEFAULT 0,
      harvested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clippings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edition TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      slug TEXT NOT NULL,
      headline TEXT DEFAULT '',
      ocr_text TEXT DEFAULT '',
      bbox_json TEXT NOT NULL,
      exclude_json TEXT DEFAULT '[]',
      file_path TEXT NOT NULL,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(screenshot_status);
    CREATE INDEX IF NOT EXISTS idx_items_date ON items(content_date);
  `);

  topicDbCache.set(slug, db);
  return db;
}

export function listTopicDbs(): string[] {
  if (!existsSync(TOPICS_DIR)) return [];
  return readdirSync(TOPICS_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => f.replace(/\.db$/, ''));
}

export interface TopicItemInput {
  headline: string;
  url: string;
  source?: string;
  domain?: string;
  category?: string;
  media_type?: string;
  snippet?: string;
  content_published_at?: string | null;
  content_date?: string | null;
  relative_time?: string | null;
  timestamp_confidence?: number;
  time_source?: string | null;
  screenshot_status?: string;
  clip_path?: string | null;
  quality_score?: number;
  sentiment?: string;
  harvested_at?: string;
}

export function upsertTopicItems(topic: string, items: TopicItemInput[]): { inserted: number; updated: number } {
  const db = getTopicDb(topic);
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  const findStmt = db.query(`SELECT id FROM items WHERE url = ?`);
  const insertStmt = db.query(`
    INSERT INTO items (
      headline, url, source, domain, category, media_type, snippet,
      content_published_at, content_date, relative_time, timestamp_confidence, time_source,
      screenshot_status, clip_path, quality_score, sentiment, harvested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.query(`
    UPDATE items SET
      headline = COALESCE(NULLIF(?, ''), headline),
      source = COALESCE(NULLIF(?, ''), source),
      domain = COALESCE(NULLIF(?, ''), domain),
      category = COALESCE(NULLIF(?, ''), category),
      media_type = COALESCE(NULLIF(?, ''), media_type),
      snippet = COALESCE(NULLIF(?, ''), snippet),
      content_published_at = COALESCE(?, content_published_at),
      content_date = COALESCE(?, content_date),
      relative_time = COALESCE(?, relative_time),
      timestamp_confidence = CASE WHEN ? > timestamp_confidence THEN ? ELSE timestamp_confidence END,
      time_source = COALESCE(?, time_source),
      screenshot_status = CASE WHEN ? IS NOT NULL AND ? != 'PENDING' THEN ? ELSE screenshot_status END,
      clip_path = COALESCE(?, clip_path),
      quality_score = CASE WHEN ? > quality_score THEN ? ELSE quality_score END,
      updated_at = ?
    WHERE url = ?
  `);

  const tx = db.transaction((rows: TopicItemInput[]) => {
    for (const it of rows) {
      if (!it.url) continue;
      const existing = findStmt.get(it.url);
      if (existing) {
        updateStmt.run(
          it.headline || '',
          it.source || '',
          it.domain || '',
          it.category || '',
          it.media_type || '',
          it.snippet || '',
          it.content_published_at ?? null,
          it.content_date ?? null,
          it.relative_time ?? null,
          it.timestamp_confidence ?? 0,
          it.timestamp_confidence ?? 0,
          it.time_source ?? null,
          it.screenshot_status ?? null,
          it.screenshot_status ?? null,
          it.screenshot_status ?? null,
          it.clip_path ?? null,
          it.quality_score ?? 0,
          it.quality_score ?? 0,
          now,
          it.url
        );
        updated++;
      } else {
        insertStmt.run(
          it.headline || it.url,
          it.url,
          it.source || '',
          it.domain || '',
          it.category || 'Print & Digital News',
          it.media_type || 'news_article',
          it.snippet || '',
          it.content_published_at ?? null,
          it.content_date ?? null,
          it.relative_time ?? null,
          it.timestamp_confidence ?? 0,
          it.time_source ?? null,
          it.screenshot_status || 'PENDING',
          it.clip_path ?? null,
          it.quality_score ?? 0,
          it.sentiment || 'Neutral',
          it.harvested_at || now,
          now
        );
        inserted++;
      }
    }
  });

  tx(items);
  return { inserted, updated };
}

export function insertTopicClipping(
  topic: string,
  clip: {
    edition: string;
    pdf_path: string;
    page_number: number;
    slug: string;
    headline?: string;
    ocr_text?: string;
    bbox: number[];
    exclude?: number[][];
    file_path: string;
    width: number;
    height: number;
  }
) {
  const db = getTopicDb(topic);
  const now = new Date().toISOString();
  const res = db
    .query(
      `INSERT INTO clippings (edition, pdf_path, page_number, slug, headline, ocr_text, bbox_json, exclude_json, file_path, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      clip.edition,
      clip.pdf_path,
      clip.page_number,
      clip.slug,
      clip.headline || '',
      clip.ocr_text || '',
      JSON.stringify(clip.bbox),
      JSON.stringify(clip.exclude || []),
      clip.file_path,
      clip.width,
      clip.height,
      now
    );
  return Number(res.lastInsertRowid);
}

export function updateTopicItem(
  topic: string,
  lookup: { id?: number; url?: string },
  patch: { sentiment?: string; category?: string; notes?: string; flagged_irrelevant?: boolean }
): boolean {
  const db = getTopicDb(topic);
  const now = new Date().toISOString();
  const fields: string[] = ['updated_at = ?'];
  const params: any[] = [now];

  if (patch.sentiment !== undefined) {
    fields.push('sentiment = ?');
    params.push(patch.sentiment);
  }
  if (patch.category !== undefined) {
    fields.push('category = ?');
    params.push(patch.category);
  }
  if (patch.notes !== undefined) {
    fields.push('notes = ?');
    params.push(patch.notes);
  }
  if (patch.flagged_irrelevant !== undefined) {
    fields.push('flagged_irrelevant = ?');
    params.push(patch.flagged_irrelevant ? 1 : 0);
  }

  let where = '';
  if (lookup.id !== undefined) {
    where = 'id = ?';
    params.push(lookup.id);
  } else if (lookup.url) {
    where = 'url = ?';
    params.push(lookup.url);
  } else {
    return false;
  }

  const res = db.query(`UPDATE items SET ${fields.join(', ')} WHERE ${where}`).run(...params);
  return res.changes > 0;
}
