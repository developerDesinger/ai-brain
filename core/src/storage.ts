import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import matter from "gray-matter";
import {
  GLOBAL_INDEX,
  GLOBAL_KB_DIR,
  projectIndexFile,
  projectKbDir,
} from "./paths.js";

export type EntryType =
  | "requirement"
  | "style"
  | "pattern"
  | "decision"
  | "snippet"
  | "glossary"
  | "note";

export interface Entry {
  id: string;
  title: string;
  type: EntryType;
  tags: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
  scope: "project" | "global";
}

export interface RecallHit {
  id: string;
  title: string;
  type: EntryType;
  tags: string[];
  scope: "project" | "global";
  excerpt: string;
  score: number;
}

const VALID_TYPES: EntryType[] = [
  "requirement",
  "style",
  "pattern",
  "decision",
  "snippet",
  "glossary",
  "note",
];

function entryFile(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function openDb(dbPath: string): Database.Database {
  ensureDir(dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
      id UNINDEXED,
      title,
      type UNINDEXED,
      tags,
      body,
      scope UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  return db;
}

function slugId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "entry";
  const suffix = createHash("sha1")
    .update(`${title}-${randomUUID()}`)
    .digest("hex")
    .slice(0, 6);
  return `${slug}-${suffix}`;
}

interface Dirs {
  fileDir: string;
  indexPath: string;
  scope: "project" | "global";
}

/**
 * Resolve filesystem locations for a given scope.
 *
 * - `projectRoot` (string): the project's root directory; KB lives in
 *   `<root>/.ai-brain/{kb,index.sqlite}`.
 * - `null`: global cross-project KB at the central brain home.
 */
function dirsFor(projectRoot: string | null): Dirs {
  if (projectRoot) {
    return {
      fileDir: projectKbDir(projectRoot),
      indexPath: projectIndexFile(projectRoot),
      scope: "project",
    };
  }
  return {
    fileDir: GLOBAL_KB_DIR,
    indexPath: GLOBAL_INDEX,
    scope: "global",
  };
}

function writeEntryFile(dir: string, entry: Entry) {
  ensureDir(dir);
  const fm = {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  const md = matter.stringify(entry.body.trim() + "\n", fm);
  writeFileSync(entryFile(dir, entry.id), md);
}

function readEntryFile(filePath: string): Entry | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    if (!fm.id || !fm.title || !fm.type) return null;
    return {
      id: String(fm.id),
      title: String(fm.title),
      type: String(fm.type) as EntryType,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      scope: (fm.scope as "project" | "global") ?? "project",
      createdAt: String(fm.createdAt ?? new Date().toISOString()),
      updatedAt: String(fm.updatedAt ?? new Date().toISOString()),
      body: parsed.content.trim(),
    };
  } catch {
    return null;
  }
}

export function remember(input: {
  projectRoot: string | null;
  title: string;
  body: string;
  type?: EntryType;
  tags?: string[];
}): Entry {
  const type: EntryType = (input.type && VALID_TYPES.includes(input.type)
    ? input.type
    : "note") as EntryType;
  const { fileDir, indexPath, scope } = dirsFor(input.projectRoot);
  const now = new Date().toISOString();
  const entry: Entry = {
    id: slugId(input.title),
    title: input.title.trim(),
    type,
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    body: input.body,
    createdAt: now,
    updatedAt: now,
    scope,
  };
  writeEntryFile(fileDir, entry);
  const db = openDb(indexPath);
  try {
    db.prepare(
      "INSERT INTO entries(id, title, type, tags, body, scope) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(entry.id, entry.title, entry.type, entry.tags.join(" "), entry.body, entry.scope);
  } finally {
    db.close();
  }
  return entry;
}

export function forget(projectRoot: string | null, id: string): boolean {
  const { fileDir, indexPath } = dirsFor(projectRoot);
  const file = entryFile(fileDir, id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  const db = openDb(indexPath);
  try {
    db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  } finally {
    db.close();
  }
  return true;
}

function searchOne(
  indexPath: string,
  scope: "project" | "global",
  query: string,
  limit: number,
): RecallHit[] {
  if (!existsSync(indexPath)) return [];
  const db = openDb(indexPath);
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = db
      .prepare(
        `SELECT id, title, type, tags, snippet(entries, 4, '<<', '>>', ' … ', 16) AS excerpt,
                bm25(entries) AS rank
         FROM entries WHERE entries MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
      id: string;
      title: string;
      type: EntryType;
      tags: string;
      excerpt: string;
      rank: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      tags: r.tags ? r.tags.split(/\s+/).filter(Boolean) : [],
      scope,
      excerpt: r.excerpt,
      score: -r.rank,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function sanitizeFtsQuery(q: string): string {
  const tokens = q
    .replace(/["']/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

export function recall(input: {
  projectRoot: string | null;
  query: string;
  limit?: number;
  includeGlobal?: boolean;
}): RecallHit[] {
  const limit = input.limit ?? 8;
  const hits: RecallHit[] = [];
  if (input.projectRoot) {
    hits.push(
      ...searchOne(projectIndexFile(input.projectRoot), "project", input.query, limit),
    );
  }
  if (input.includeGlobal !== false) {
    hits.push(
      ...searchOne(GLOBAL_INDEX, "global", input.query, Math.max(2, Math.floor(limit / 2))),
    );
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function listEntries(projectRoot: string | null): Entry[] {
  const { fileDir } = dirsFor(projectRoot);
  if (!existsSync(fileDir)) return [];
  return readdirSync(fileDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readEntryFile(join(fileDir, f)))
    .filter((e): e is Entry => e !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getEntry(projectRoot: string | null, id: string): Entry | null {
  const { fileDir } = dirsFor(projectRoot);
  return readEntryFile(entryFile(fileDir, id));
}

export function rebuildIndex(projectRoot: string | null): number {
  const { fileDir, indexPath } = dirsFor(projectRoot);
  if (existsSync(indexPath)) unlinkSync(indexPath);
  const db = openDb(indexPath);
  let count = 0;
  try {
    const stmt = db.prepare(
      "INSERT INTO entries(id, title, type, tags, body, scope) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertMany = db.transaction((entries: Entry[]) => {
      for (const e of entries) {
        stmt.run(e.id, e.title, e.type, e.tags.join(" "), e.body, e.scope);
        count += 1;
      }
    });
    insertMany(listEntries(projectRoot));
  } finally {
    db.close();
  }
  return count;
}

// Re-export for callers that just want to know where things live.
export { GLOBAL_KB_DIR, projectKbDir };
