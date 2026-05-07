import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Engine home — where the brain's code, bridge templates, and built-in
 * sub-agents live. Auto-detected from the location of this file. Treated as
 * read-only at runtime.
 *
 * dist/<file>.js  →  dist  →  core  →  ENGINE_HOME
 */
function defaultEngineHome(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "..", "..");
  } catch {
    // Fallback (should never happen with ESM): assume the user installed via
    // `npm link` and we're being executed from a known location.
    return resolve(dirname(process.argv[1] ?? "."), "..", "..");
  }
}

export const ENGINE_HOME = process.env.AI_BRAIN_ENGINE_HOME
  ? resolve(process.env.AI_BRAIN_ENGINE_HOME)
  : defaultEngineHome();

export const CORE_DIR = join(ENGINE_HOME, "core");
export const SUBAGENTS_DIR = join(CORE_DIR, "subagents");
export const BRIDGES_DIR = join(ENGINE_HOME, "bridges");

/**
 * Data home — where global cross-project KB and the project registry live.
 * User-writable. Defaults to `~/.ai-brain/`. Override with `AI_BRAIN_HOME`.
 *
 * If `AI_BRAIN_HOME` is unset and `<engine>/knowledge/registry.json` exists,
 * we use the engine's `knowledge/` for backwards compatibility with users who
 * cloned and ran without ever setting the env var.
 */
function defaultDataHome(): string {
  const legacy = join(ENGINE_HOME, "knowledge");
  if (existsSync(join(legacy, "registry.json"))) return ENGINE_HOME;
  return join(homedir(), ".ai-brain");
}

export const DATA_HOME = process.env.AI_BRAIN_HOME
  ? resolve(process.env.AI_BRAIN_HOME)
  : defaultDataHome();

export const KNOWLEDGE_DIR = join(DATA_HOME, "knowledge");
export const GLOBAL_KB_DIR = join(KNOWLEDGE_DIR, "global");
export const GLOBAL_INDEX = join(GLOBAL_KB_DIR, "index.sqlite");
export const REGISTRY_FILE = join(KNOWLEDGE_DIR, "registry.json");

/**
 * Backwards-compatible alias used by `bridges/*.tmpl` to point agents at the
 * engine's MCP binary.
 */
export const BRAIN_HOME = ENGINE_HOME;

// ---------- Project-local layout ----------
//
// Every initialized project carries its own brain inside `.ai-brain/`:
//
//   <project-root>/
//   ├── .ai-brain/
//   │   ├── config.json
//   │   ├── kb/                   ← knowledge entries (markdown, committed to git)
//   │   ├── subagents/            ← project-specific sub-agents (committed)
//   │   ├── index.sqlite          ← FTS5 index (gitignored, regenerable)
//   │   └── .gitignore            ← excludes index.sqlite + WAL files
//   ├── CLAUDE.md / AGENTS.md / .cursorrules / ...  ← bridge files
//   └── ... (project source)
//
// The brain travels with the project via git. The engine holds only the code,
// templates, and (optionally) cross-project global knowledge.

export const AI_BRAIN_DIRNAME = ".ai-brain";

export function aiBrainDir(projectRoot: string): string {
  return join(projectRoot, AI_BRAIN_DIRNAME);
}
export function projectConfigFile(projectRoot: string): string {
  return join(aiBrainDir(projectRoot), "config.json");
}
export function projectKbDir(projectRoot: string): string {
  return join(aiBrainDir(projectRoot), "kb");
}
export function projectIndexFile(projectRoot: string): string {
  return join(aiBrainDir(projectRoot), "index.sqlite");
}
export function projectSubagentsDir(projectRoot: string): string {
  return join(aiBrainDir(projectRoot), "subagents");
}
export function projectGitignoreFile(projectRoot: string): string {
  return join(aiBrainDir(projectRoot), ".gitignore");
}

/** Walk up from `start` looking for a `.ai-brain` directory. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, AI_BRAIN_DIRNAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
