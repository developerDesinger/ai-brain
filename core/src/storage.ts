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
  /** 1–2 sentence summary; cheap to ship in compact recall results. */
  summary: string;
  /** Normalised entity names this entry references (lowercase, hyphenated). */
  entities: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
  scope: "project" | "global";
}

/** Compact recall result — no body. ~5x smaller than RecallHit in tokens. */
export interface CompactHit {
  id: string;
  title: string;
  type: EntryType;
  tags: string[];
  entities: string[];
  scope: "project" | "global";
  summary: string;
  score: number;
}

/** Full recall result — preserves the legacy shape for callers that opt in. */
export interface RecallHit {
  id: string;
  title: string;
  type: EntryType;
  tags: string[];
  scope: "project" | "global";
  excerpt: string;
  score: number;
}

export interface EntityNeighbor {
  /** Direction of the edge from the queried entity. */
  direction: "outgoing" | "incoming" | "co-occurring";
  entity: string;
  /** Number of entries this neighbor co-occurs with the queried entity in. */
  weight: number;
}

export interface EntityCard {
  /** Normalised entity name. */
  name: string;
  /** Glossary entry that defines the entity, if one exists. */
  definition: { id: string; title: string; summary: string; body: string } | null;
  /** Compact summaries of entries that reference this entity. */
  references: CompactHit[];
  /** Entities co-occurring in the same entries (1-hop neighborhood). */
  neighbors: EntityNeighbor[];
  /** Source-code file paths (project-relative) where this entity appears. */
  codeLocations: string[];
}

export interface CodeIndexStats {
  totalFiles: number;
  totalEntities: number;
  added: number;
  updated: number;
  removed: number;
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
  db.pragma("foreign_keys = ON");
  // FTS5 virtual table — `entities` column is searchable so entity names
  // surface entries that reference them.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
      id UNINDEXED,
      title,
      type UNINDEXED,
      tags,
      entities,
      summary,
      body,
      scope UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  // Light-weight side table for graph traversal. One row per (entry, entity).
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_refs (
      entry_id TEXT NOT NULL,
      entity   TEXT NOT NULL,
      PRIMARY KEY (entry_id, entity)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_refs_entity ON entity_refs(entity);
  `);
  // Code-level entity index — populated by `brain refresh` / `brain watch`.
  // Token-free: we extract entities from source files and remember which file
  // mentions which entity. Keeps the KB itself uncluttered.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_files (
      path        TEXT PRIMARY KEY,
      mtime_ms    INTEGER NOT NULL,
      size_bytes  INTEGER NOT NULL,
      hash        TEXT NOT NULL,
      indexed_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_entities (
      path        TEXT NOT NULL,
      entity      TEXT NOT NULL,
      PRIMARY KEY (path, entity),
      FOREIGN KEY (path) REFERENCES code_files(path) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_code_entities_entity ON code_entities(entity);
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

// ---------- Entity normalisation + extraction ----------

const ENTITY_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "use",
  "uses",
  "via",
  "via",
  "all",
  "any",
  "but",
  "not",
  "than",
  "then",
  "when",
  "where",
  "while",
  "what",
  "which",
  "must",
  "should",
  "would",
  "could",
  "may",
  "might",
  "shall",
  "will",
  "have",
  "has",
  "had",
  "are",
  "were",
  "was",
  "is",
  "be",
  "been",
  "being",
  "you",
  "your",
  "our",
  "their",
  "they",
  "it",
  "its",
  "we",
  "us",
  "them",
  "him",
  "her",
  "his",
  "she",
  "he",
]);

/** Lowercase, hyphenated, idempotent. Returns "" for invalid inputs. */
export function normaliseEntity(raw: string): string {
  const t = String(raw)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!t || t.length < 2 || t.length > 64) return "";
  if (ENTITY_STOP_WORDS.has(t)) return "";
  return t;
}

/**
 * Heuristic entity extraction. Conservative — false negatives are fine;
 * false positives would pollute the graph.
 *
 *   - `backticked` identifiers (high signal — code names, paths, flags)
 *   - ALL_CAPS_OR_UNDERSCORED tokens of length >= 3
 *   - PascalCase / camelCase identifiers of length >= 4
 *   - Multi-word TitleCase phrases (max 4 words)
 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const n = normaliseEntity(s);
    if (n) out.add(n);
  };

  // 1. backticked content
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) add(m[1]);

  // 2. ALL_CAPS or SNAKE_CASE
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1]);

  // 3. PascalCase / camelCase identifiers
  for (const m of text.matchAll(
    /\b([A-Z][a-z]+[A-Z][A-Za-z0-9]+|[a-z]+[A-Z][A-Za-z0-9]+)\b/g,
  )) {
    add(m[1]);
  }

  // 4. Multi-word TitleCase phrases (up to 4 words)
  for (const m of text.matchAll(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g,
  )) {
    add(m[1]);
  }

  return [...out].slice(0, 32);
}

// ---------- File I/O ----------

function writeEntryFile(dir: string, entry: Entry) {
  ensureDir(dir);
  const fm: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    tags: entry.tags,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  if (entry.summary) fm.summary = entry.summary;
  if (entry.entities.length) fm.entities = entry.entities;
  const md = matter.stringify(entry.body.trim() + "\n", fm);
  writeFileSync(entryFile(dir, entry.id), md);
}

function readEntryFile(filePath: string): Entry | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    if (!fm.id || !fm.title || !fm.type) return null;
    const entities = Array.isArray(fm.entities)
      ? (fm.entities as string[])
          .map((e) => normaliseEntity(String(e)))
          .filter(Boolean)
      : [];
    return {
      id: String(fm.id),
      title: String(fm.title),
      type: String(fm.type) as EntryType,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      summary: typeof fm.summary === "string" ? fm.summary : "",
      entities,
      scope: (fm.scope as "project" | "global") ?? "project",
      createdAt: String(fm.createdAt ?? new Date().toISOString()),
      updatedAt: String(fm.updatedAt ?? new Date().toISOString()),
      body: parsed.content.trim(),
    };
  } catch {
    return null;
  }
}

function autoSummary(body: string, max = 160): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  // Prefer the first sentence if it fits; otherwise truncate at a word boundary.
  const firstSentenceEnd = trimmed.search(/[.!?]\s/);
  if (firstSentenceEnd > 0 && firstSentenceEnd <= max) {
    return trimmed.slice(0, firstSentenceEnd + 1);
  }
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut) + "…";
}

function indexInsert(
  db: Database.Database,
  e: Pick<
    Entry,
    "id" | "title" | "type" | "tags" | "entities" | "summary" | "body" | "scope"
  >,
) {
  db.prepare(
    "INSERT INTO entries(id, title, type, tags, entities, summary, body, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    e.id,
    e.title,
    e.type,
    e.tags.join(" "),
    e.entities.join(" "),
    e.summary,
    e.body,
    e.scope,
  );
  if (e.entities.length) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO entity_refs(entry_id, entity) VALUES (?, ?)",
    );
    for (const ent of e.entities) ins.run(e.id, ent);
  }
}

function indexDelete(db: Database.Database, id: string) {
  db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  db.prepare("DELETE FROM entity_refs WHERE entry_id = ?").run(id);
}

// ---------- Public API ----------

export function remember(input: {
  projectRoot: string | null;
  title: string;
  body: string;
  type?: EntryType;
  tags?: string[];
  /** Optional pre-written summary; auto-derived from body if absent. */
  summary?: string;
  /** Explicit entities; merged with heuristic extraction from title+body. */
  entities?: string[];
}): Entry {
  const type: EntryType = (input.type && VALID_TYPES.includes(input.type)
    ? input.type
    : "note") as EntryType;
  const { fileDir, indexPath, scope } = dirsFor(input.projectRoot);
  const now = new Date().toISOString();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);

  // Merge explicit entities with heuristic extraction.
  const explicit = (input.entities ?? [])
    .map((e) => normaliseEntity(e))
    .filter(Boolean);
  const heuristic = extractEntities(`${input.title}\n${input.body}`);
  // For glossary entries, also add the title itself as an entity (so other
  // entries that reference the term find this one as the canonical definition).
  if (type === "glossary") {
    const titleEntity = normaliseEntity(input.title);
    if (titleEntity) heuristic.push(titleEntity);
  }
  const entities = [...new Set([...explicit, ...heuristic])].slice(0, 32);

  const summary = (input.summary ?? autoSummary(input.body)).trim();

  const entry: Entry = {
    id: slugId(input.title),
    title: input.title.trim(),
    type,
    tags,
    summary,
    entities,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    scope,
  };
  writeEntryFile(fileDir, entry);
  const db = openDb(indexPath);
  try {
    indexInsert(db, entry);
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
    indexDelete(db, id);
  } finally {
    db.close();
  }
  return true;
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

interface RawSearchRow {
  id: string;
  title: string;
  type: EntryType;
  tags: string;
  entities: string;
  summary: string;
  rank: number;
  excerpt?: string;
}

function searchOne(
  indexPath: string,
  query: string,
  limit: number,
  withExcerpt: boolean,
  typeFilter?: EntryType[],
): RawSearchRow[] {
  if (!existsSync(indexPath)) return [];
  const db = openDb(indexPath);
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const cols = withExcerpt
      ? `id, title, type, tags, entities, summary, snippet(entries, 6, '<<', '>>', ' … ', 16) AS excerpt, bm25(entries) AS rank`
      : `id, title, type, tags, entities, summary, bm25(entries) AS rank`;
    let sql = `SELECT ${cols} FROM entries WHERE entries MATCH ?`;
    const params: unknown[] = [ftsQuery];
    if (typeFilter && typeFilter.length) {
      sql += ` AND type IN (${typeFilter.map(() => "?").join(",")})`;
      params.push(...typeFilter);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as RawSearchRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function rowToCompact(row: RawSearchRow, scope: "project" | "global"): CompactHit {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    entities: row.entities ? row.entities.split(/\s+/).filter(Boolean) : [],
    scope,
    summary: row.summary,
    score: -row.rank,
  };
}

function rowToFull(row: RawSearchRow, scope: "project" | "global"): RecallHit {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    scope,
    excerpt: row.excerpt ?? "",
    score: -row.rank,
  };
}

/**
 * Compact recall — returns titles, tags, entities, and a short summary per
 * hit, **no body**. ~5x smaller than full recall in tokens. Use this as the
 * default and follow up with `getEntries(ids)` when a full body is needed.
 */
export function recallCompact(input: {
  projectRoot: string | null;
  query: string;
  limit?: number;
  includeGlobal?: boolean;
  types?: EntryType[];
}): CompactHit[] {
  const limit = input.limit ?? 8;
  const hits: CompactHit[] = [];
  if (input.projectRoot) {
    const rows = searchOne(
      projectIndexFile(input.projectRoot),
      input.query,
      limit,
      false,
      input.types,
    );
    hits.push(...rows.map((r) => rowToCompact(r, "project")));
  }
  if (input.includeGlobal !== false) {
    const rows = searchOne(
      GLOBAL_INDEX,
      input.query,
      Math.max(2, Math.floor(limit / 2)),
      false,
      input.types,
    );
    hits.push(...rows.map((r) => rowToCompact(r, "global")));
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Full recall (with body excerpt) — kept for back-compat and `--full` mode. */
export function recall(input: {
  projectRoot: string | null;
  query: string;
  limit?: number;
  includeGlobal?: boolean;
  types?: EntryType[];
}): RecallHit[] {
  const limit = input.limit ?? 8;
  const hits: RecallHit[] = [];
  if (input.projectRoot) {
    const rows = searchOne(
      projectIndexFile(input.projectRoot),
      input.query,
      limit,
      true,
      input.types,
    );
    hits.push(...rows.map((r) => rowToFull(r, "project")));
  }
  if (input.includeGlobal !== false) {
    const rows = searchOne(
      GLOBAL_INDEX,
      input.query,
      Math.max(2, Math.floor(limit / 2)),
      true,
      input.types,
    );
    hits.push(...rows.map((r) => rowToFull(r, "global")));
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

/** Bulk fetch full entries by ID. Order preserved; missing IDs are skipped. */
export function getEntries(
  projectRoot: string | null,
  ids: string[],
): Entry[] {
  const out: Entry[] = [];
  for (const id of ids) {
    const e = getEntry(projectRoot, id);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Look up an entity: returns its glossary definition (if any), the compact
 * summaries of all entries that reference it, and a 1-hop neighborhood of
 * other entities that co-occur with it.
 */
export function getEntity(
  projectRoot: string | null,
  rawName: string,
  opts: { limit?: number; includeGlobal?: boolean } = {},
): EntityCard {
  const name = normaliseEntity(rawName);
  if (!name) {
    return {
      name: rawName,
      definition: null,
      references: [],
      neighbors: [],
      codeLocations: [],
    };
  }
  const limit = opts.limit ?? 12;
  const card: EntityCard = {
    name,
    definition: null,
    references: [],
    neighbors: [],
    codeLocations: [],
  };

  const sources: Array<{ indexPath: string; scope: "project" | "global"; root: string | null }> =
    [];
  if (projectRoot) {
    sources.push({ indexPath: projectIndexFile(projectRoot), scope: "project", root: projectRoot });
  }
  if (opts.includeGlobal !== false) {
    sources.push({ indexPath: GLOBAL_INDEX, scope: "global", root: null });
  }

  const neighborCounts = new Map<string, number>();
  const seenIds = new Set<string>();

  for (const src of sources) {
    if (!existsSync(src.indexPath)) continue;
    const db = openDb(src.indexPath);
    try {
      const referencingIds = db
        .prepare("SELECT entry_id FROM entity_refs WHERE entity = ? LIMIT ?")
        .all(name, limit) as Array<{ entry_id: string }>;

      for (const { entry_id } of referencingIds) {
        if (seenIds.has(entry_id)) continue;
        seenIds.add(entry_id);
        const row = db
          .prepare(
            "SELECT id, title, type, tags, entities, summary FROM entries WHERE id = ?",
          )
          .get(entry_id) as RawSearchRow | undefined;
        if (!row) continue;
        const compact = rowToCompact({ ...row, rank: 0 }, src.scope);
        // Fill in glossary definition if found.
        if (row.type === "glossary" && !card.definition) {
          const full = src.root ? getEntry(src.root, row.id) : null;
          card.definition = {
            id: row.id,
            title: row.title,
            summary: row.summary,
            body: full?.body ?? row.summary,
          };
        }
        card.references.push(compact);
        for (const co of compact.entities) {
          if (co === name) continue;
          neighborCounts.set(co, (neighborCounts.get(co) ?? 0) + 1);
        }
      }
    } finally {
      db.close();
    }
  }

  card.neighbors = [...neighborCounts.entries()]
    .map(([entity, weight]) => ({ direction: "co-occurring" as const, entity, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);
  card.references = card.references.slice(0, limit);

  // Code-index lookup — only available on project scope.
  if (projectRoot) {
    const dbProject = openDb(projectIndexFile(projectRoot));
    try {
      const rows = dbProject
        .prepare(
          "SELECT path FROM code_entities WHERE entity = ? ORDER BY path LIMIT ?",
        )
        .all(name, Math.max(limit, 12)) as Array<{ path: string }>;
      card.codeLocations = rows.map((r) => r.path);
    } finally {
      dbProject.close();
    }
  }

  return card;
}

// ---------- Code index ----------

/**
 * Replace every code_entities row for a single file. Idempotent.
 * Pass `entities: []` (and any deletion via `applyCodeIndexDelete` instead) to
 * remove a file from the index.
 */
export function applyCodeIndexUpsert(
  projectRoot: string,
  args: {
    path: string;
    mtimeMs: number;
    sizeBytes: number;
    hash: string;
    entities: string[];
  },
): void {
  if (!projectRoot) return;
  const db = openDb(projectIndexFile(projectRoot));
  try {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO code_files(path, mtime_ms, size_bytes, hash, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes,
           hash = excluded.hash,
           indexed_at = excluded.indexed_at`,
      ).run(args.path, args.mtimeMs, args.sizeBytes, args.hash, new Date().toISOString());
      db.prepare("DELETE FROM code_entities WHERE path = ?").run(args.path);
      const ins = db.prepare(
        "INSERT OR IGNORE INTO code_entities(path, entity) VALUES (?, ?)",
      );
      for (const e of args.entities) ins.run(args.path, e);
    });
    tx();
  } finally {
    db.close();
  }
}

export function applyCodeIndexDelete(projectRoot: string, paths: string[]): void {
  if (!projectRoot || !paths.length) return;
  const db = openDb(projectIndexFile(projectRoot));
  try {
    const tx = db.transaction(() => {
      const del = db.prepare("DELETE FROM code_files WHERE path = ?");
      for (const p of paths) del.run(p);
    });
    tx();
  } finally {
    db.close();
  }
}

export function getIndexedCodeFiles(
  projectRoot: string,
): Map<string, { hash: string; mtimeMs: number }> {
  const out = new Map<string, { hash: string; mtimeMs: number }>();
  if (!projectRoot) return out;
  const indexPath = projectIndexFile(projectRoot);
  if (!existsSync(indexPath)) return out;
  const db = openDb(indexPath);
  try {
    const rows = db.prepare("SELECT path, hash, mtime_ms FROM code_files").all() as Array<{
      path: string;
      hash: string;
      mtime_ms: number;
    }>;
    for (const r of rows) out.set(r.path, { hash: r.hash, mtimeMs: r.mtime_ms });
  } finally {
    db.close();
  }
  return out;
}

export function getCodeIndexStats(projectRoot: string): {
  files: number;
  entities: number;
} {
  if (!projectRoot) return { files: 0, entities: 0 };
  const indexPath = projectIndexFile(projectRoot);
  if (!existsSync(indexPath)) return { files: 0, entities: 0 };
  const db = openDb(indexPath);
  try {
    const files = (db.prepare("SELECT COUNT(*) AS n FROM code_files").get() as { n: number }).n;
    const entities = (db.prepare("SELECT COUNT(DISTINCT entity) AS n FROM code_entities").get() as {
      n: number;
    }).n;
    return { files, entities };
  } finally {
    db.close();
  }
}

/** Search the code index for files where any of the query tokens appear as entities. */
export function recallCode(
  projectRoot: string,
  query: string,
  limit = 12,
): Array<{ path: string; matches: string[] }> {
  if (!projectRoot) return [];
  const indexPath = projectIndexFile(projectRoot);
  if (!existsSync(indexPath)) return [];
  const tokens = [
    ...new Set(
      query
        .split(/\s+/)
        .map((t) => normaliseEntity(t))
        .filter(Boolean),
    ),
  ];
  if (!tokens.length) return [];
  const db = openDb(indexPath);
  try {
    const placeholders = tokens.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT path, GROUP_CONCAT(entity, ',') AS matches, COUNT(*) AS hits
         FROM code_entities
         WHERE entity IN (${placeholders})
         GROUP BY path
         ORDER BY hits DESC, path
         LIMIT ?`,
      )
      .all(...tokens, limit) as Array<{ path: string; matches: string }>;
    return rows.map((r) => ({
      path: r.path,
      matches: r.matches.split(",").filter(Boolean),
    }));
  } finally {
    db.close();
  }
}

/**
 * Rebuild the FTS5 index and entity_refs from the markdown files on disk.
 * Use after manual edits to entry frontmatter, or to retrofit existing entries
 * with auto-extracted entities + summaries.
 */
export function rebuildIndex(
  projectRoot: string | null,
  opts: { refreshEntities?: boolean } = {},
): number {
  const { fileDir, indexPath } = dirsFor(projectRoot);
  if (existsSync(indexPath)) unlinkSync(indexPath);
  const db = openDb(indexPath);
  let count = 0;
  try {
    const stmt = db.prepare(
      "INSERT INTO entries(id, title, type, tags, entities, summary, body, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const refStmt = db.prepare(
      "INSERT OR IGNORE INTO entity_refs(entry_id, entity) VALUES (?, ?)",
    );
    const insertMany = db.transaction((entries: Entry[]) => {
      for (const e of entries) {
        let entities = e.entities;
        let summary = e.summary;
        if (opts.refreshEntities || !entities.length) {
          entities = [
            ...new Set([
              ...entities,
              ...extractEntities(`${e.title}\n${e.body}`),
              ...(e.type === "glossary"
                ? [normaliseEntity(e.title)].filter(Boolean)
                : []),
            ]),
          ].slice(0, 32);
        }
        if (opts.refreshEntities || !summary) {
          summary = autoSummary(e.body);
        }
        if (
          opts.refreshEntities &&
          (entities.join(" ") !== e.entities.join(" ") || summary !== e.summary)
        ) {
          // Persist refreshed values back to disk.
          writeEntryFile(fileDir, { ...e, entities, summary });
        }
        stmt.run(
          e.id,
          e.title,
          e.type,
          e.tags.join(" "),
          entities.join(" "),
          summary,
          e.body,
          e.scope,
        );
        for (const ent of entities) refStmt.run(e.id, ent);
        count += 1;
      }
    });
    insertMany(listEntries(projectRoot));
  } finally {
    db.close();
  }
  return count;
}

export { GLOBAL_KB_DIR, projectKbDir };
