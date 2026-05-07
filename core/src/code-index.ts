import { createHash } from "node:crypto";
import {
  Stats,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  CodeIndexStats,
  applyCodeIndexDelete,
  applyCodeIndexUpsert,
  extractEntities,
  getIndexedCodeFiles,
  normaliseEntity,
} from "./storage.js";
import { extractWithAst } from "./ast-extract.js";

/**
 * Continuous, token-free code indexer. Scans source files, extracts entities
 * (function names, types, identifiers, terms) using the same conservative
 * heuristic that powers `brain_remember`, and stores them in the per-project
 * `code_entities` table so `brain_entity` and `brain code <query>` can find
 * "where does X live?" without ever calling the LLM.
 *
 * The KB itself stays clean — code-index lives in its own table and never
 * spawns markdown files.
 */

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".ex",
  ".exs",
  ".erl",
  ".clj",
  ".cljs",
  ".elm",
  ".fs",
  ".ml",
  ".mli",
  ".lua",
  ".dart",
  ".vue",
  ".svelte",
  ".sql",
]);

const SKIP_DIRS = new Set([
  ".ai-brain",
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "coverage",
  ".gradle",
  ".idea",
  ".vscode",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
]);

const MAX_BYTES = 256 * 1024; // skip files larger than 256KB; usually generated/minified

export function isIndexable(absPath: string): boolean {
  if (!CODE_EXTS.has(extname(absPath).toLowerCase())) return false;
  // Skip files inside any skipped directory.
  for (const part of absPath.split("/")) {
    if (SKIP_DIRS.has(part)) return false;
  }
  return true;
}

export function* walkProject(
  rootAbs: string,
): Generator<{ abs: string; rel: string; stat: Stats }> {
  const stack: string[] = [rootAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile() && isIndexable(abs)) {
        let stat: Stats;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_BYTES) continue;
        yield { abs, rel: relative(rootAbs, abs), stat };
      }
    }
  }
}

function hashContent(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 16);
}

function extractFromCodeFile(buf: Buffer, ext: string): string[] {
  // Decode as UTF-8; binary noise will yield no entities and be filtered out.
  const text = buf.toString("utf8");

  const out = new Set<string>();
  // Inputs from the regex pass go through extractEntities -> already normalised.
  // Inputs from the AST pass are raw identifiers — normalise them here so they
  // round-trip through `recallCode`'s normalised query path.
  const addRaw = (s: string) => {
    const n = normaliseEntity(s);
    if (n) out.add(n);
  };
  const addNormalised = (s: string) => {
    if (!s) return;
    if (s.length < 2 || s.length > 64) return;
    out.add(s);
  };

  // Prefer AST-based extraction when a tree-sitter grammar is available for
  // this extension. The AST path returns structurally accurate function /
  // class / type names — strings inside comments and strings won't match,
  // and decorated / nested declarations are caught. When AST succeeds we
  // use ONLY AST names (no heuristic pollution from identifiers that
  // appear in comments / docstrings). When the grammar isn't installed,
  // fall back to the heuristic + regex pass below.
  const astNames = extractWithAst(text, ext);
  if (astNames) {
    for (const n of astNames) addRaw(n);
    return [...out].slice(0, 64);
  }

  // Regex fallback: heuristic entity scan over the raw text plus per-language
  // declaration patterns. Less precise than AST but works on every extension.
  for (const e of extractEntities(text)) addNormalised(e);

  // TypeScript / JavaScript-style declarations.
  if (
    [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)
  ) {
    for (const m of text.matchAll(
      /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      addRaw(m[1]);
    }
    for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      addRaw(m[1]);
    }
  }
  // Python.
  if ([".py", ".pyi"].includes(ext)) {
    for (const m of text.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)) {
      addRaw(m[1]);
    }
  }
  // Go.
  if (ext === ".go") {
    for (const m of text.matchAll(
      /\b(?:func|type|var|const)\s+([A-Za-z_]\w*)/g,
    )) {
      addRaw(m[1]);
    }
  }
  // Rust.
  if (ext === ".rs") {
    for (const m of text.matchAll(
      /\b(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/g,
    )) {
      addRaw(m[1]);
    }
  }
  // Java / Kotlin / Scala / Swift / C# share patterns.
  if ([".java", ".kt", ".kts", ".scala", ".swift", ".cs"].includes(ext)) {
    for (const m of text.matchAll(
      /\b(?:class|interface|enum|object|trait|struct|fun|def|func)\s+([A-Za-z_]\w*)/g,
    )) {
      addRaw(m[1]);
    }
  }
  // Ruby / Elixir.
  if ([".rb", ".ex", ".exs"].includes(ext)) {
    for (const m of text.matchAll(
      /\b(?:class|module|def|defmodule)\s+([A-Za-z_][\w?!]*)/g,
    )) {
      addRaw(m[1]);
    }
  }

  // Cap to a reasonable per-file limit so a generated file can't blow up the
  // index.
  return [...out].slice(0, 64);
}

export interface RefreshOptions {
  /** Don't write — return the diff that would be applied. */
  dryRun?: boolean;
  /** Pre-collected file paths (relative to root) to limit work to. */
  paths?: string[];
}

/**
 * Full or partial scan of the project's source tree. Updates the
 * `code_entities` table to match what's on disk now. Token-free.
 */
export function refreshCodeIndex(
  projectRoot: string,
  opts: RefreshOptions = {},
): CodeIndexStats {
  const rootAbs = resolve(projectRoot);
  if (!existsSync(rootAbs)) {
    throw new Error(`Project root does not exist: ${rootAbs}`);
  }

  const indexed = getIndexedCodeFiles(rootAbs);
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;

  const targets = opts.paths
    ? opts.paths.map((p) => ({
        abs: resolve(rootAbs, p),
        rel: p.replace(/^\/+/, ""),
      }))
    : null;

  const consider = (abs: string, rel: string) => {
    if (!isIndexable(abs)) return;
    let stat: Stats;
    try {
      stat = statSync(abs);
    } catch {
      return;
    }
    if (stat.size > MAX_BYTES) return;
    seen.add(rel);

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return;
    }
    const hash = hashContent(buf);
    const prev = indexed.get(rel);
    if (prev && prev.hash === hash) return; // unchanged

    const ext = extname(abs).toLowerCase();
    const entities = extractFromCodeFile(buf, ext);

    if (!opts.dryRun) {
      applyCodeIndexUpsert(rootAbs, {
        path: rel,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        hash,
        entities,
      });
    }
    if (prev) updated += 1;
    else added += 1;
  };

  if (targets) {
    for (const t of targets) {
      if (existsSync(t.abs) && statSync(t.abs).isFile()) consider(t.abs, t.rel);
    }
  } else {
    for (const f of walkProject(rootAbs)) consider(f.abs, f.rel);
  }

  // Anything previously indexed that's no longer on disk → drop it (only on
  // full scans; partial scans don't have authority to remove).
  if (!targets) {
    const stale: string[] = [];
    for (const path of indexed.keys()) {
      if (!seen.has(path)) stale.push(path);
    }
    if (stale.length && !opts.dryRun) applyCodeIndexDelete(rootAbs, stale);
    removed = stale.length;
  }

  // Final counts.
  const finalIndexed = opts.dryRun ? indexed : getIndexedCodeFiles(rootAbs);
  return {
    totalFiles: finalIndexed.size,
    totalEntities: 0, // populated below for free if needed; cheap to call separately
    added,
    updated,
    removed,
  };
}

// ---------- Watcher ----------

import chokidar from "chokidar";

export interface WatchOptions {
  /** Quiet period (ms) before processing a batch of changes. */
  debounceMs?: number;
  /** Called once when the initial scan completes. */
  onReady?: (stats: CodeIndexStats) => void;
  /** Called after each batch is processed. */
  onBatch?: (batch: { changed: string[]; removed: string[]; stats: CodeIndexStats }) => void;
  /** Called on file events for verbose logging. */
  onEvent?: (event: "add" | "change" | "unlink", relPath: string) => void;
  /** Called on chokidar errors. */
  onError?: (err: Error) => void;
}

export interface Watcher {
  /** Stop watching. Resolves once chokidar has closed. */
  stop(): Promise<void>;
}

/**
 * Continuous, token-free code-index watcher. Performs a full refresh on
 * startup, then incrementally updates the index as files change. Debounces
 * bursts of changes (default 1s) to avoid hammering SQLite on bulk operations
 * like `git checkout`.
 */
export function watchProject(projectRoot: string, opts: WatchOptions = {}): Watcher {
  const rootAbs = resolve(projectRoot);
  const debounceMs = opts.debounceMs ?? 1000;

  // Initial full scan — synchronous so the first onReady is accurate.
  const initialStats = refreshCodeIndex(rootAbs);
  opts.onReady?.(initialStats);

  const pendingChanged = new Set<string>();
  const pendingRemoved = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    timer = null;
    const changed = [...pendingChanged];
    const removed = [...pendingRemoved];
    pendingChanged.clear();
    pendingRemoved.clear();
    if (!changed.length && !removed.length) return;

    if (removed.length) applyCodeIndexDelete(rootAbs, removed);
    let stats: CodeIndexStats = {
      totalFiles: 0,
      totalEntities: 0,
      added: 0,
      updated: 0,
      removed: removed.length,
    };
    if (changed.length) {
      const partial = refreshCodeIndex(rootAbs, { paths: changed });
      stats = {
        ...partial,
        removed: removed.length,
      };
    }
    opts.onBatch?.({ changed, removed, stats });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const watcher = chokidar.watch(rootAbs, {
    ignored: (p: string) => {
      // Ignore anything under a skipped directory or non-indexable extension
      // (chokidar emits initial 'add' events for everything during the
      // walkthrough, so we apply the same filter as walkProject).
      for (const part of p.split("/")) {
        if (SKIP_DIRS.has(part)) return true;
      }
      return false;
    },
    ignoreInitial: true, // initial state already captured by refreshCodeIndex
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  });

  watcher.on("add", (abs: string) => {
    if (!isIndexable(abs)) return;
    const rel = relative(rootAbs, abs);
    pendingChanged.add(rel);
    opts.onEvent?.("add", rel);
    schedule();
  });
  watcher.on("change", (abs: string) => {
    if (!isIndexable(abs)) return;
    const rel = relative(rootAbs, abs);
    pendingChanged.add(rel);
    opts.onEvent?.("change", rel);
    schedule();
  });
  watcher.on("unlink", (abs: string) => {
    const rel = relative(rootAbs, abs);
    pendingRemoved.add(rel);
    pendingChanged.delete(rel);
    opts.onEvent?.("unlink", rel);
    schedule();
  });
  watcher.on("error", (err) => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    async stop() {
      if (timer) clearTimeout(timer);
      flush();
      await watcher.close();
    },
  };
}
