import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
  BRAIN_HOME,
  REGISTRY_FILE,
  aiBrainDir,
  findProjectRoot,
  projectConfigFile,
  projectGitignoreFile,
  projectKbDir,
  projectSubagentsDir,
} from "./paths.js";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Canonical (realpath-resolved) absolute path to the project root. */
  root: string;
  createdAt: string;
  lastSeen: string;
}

interface Registry {
  projects: Record<string, ProjectRecord>;
}

interface ProjectConfig {
  id: string;
  name: string;
  createdAt: string;
  brainHome: string;
  /**
   * Schema version of the project-local .ai-brain layout. Incremented when
   * we change file/folder structure inside .ai-brain/.
   */
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;

function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

export function projectIdFromRoot(root: string): string {
  const canon = canonical(root);
  const slug = slugify(basename(canon));
  const hash = createHash("sha1").update(canon).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_FILE)) return { projects: {} };
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return { projects: {} };
  }
}

function saveRegistry(reg: Registry): void {
  mkdirSync(resolve(REGISTRY_FILE, ".."), { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

const GITIGNORE_BODY = `# ai-brain — keep markdown KB in git, exclude regenerable artifacts
index.sqlite
index.sqlite-shm
index.sqlite-wal
`;

function ensureProjectScaffold(record: ProjectRecord, brainHome: string): void {
  const root = record.root;
  mkdirSync(aiBrainDir(root), { recursive: true });
  mkdirSync(projectKbDir(root), { recursive: true });
  mkdirSync(projectSubagentsDir(root), { recursive: true });

  const cfgFile = projectConfigFile(root);
  if (!existsSync(cfgFile)) {
    const cfg: ProjectConfig = {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      brainHome,
      schemaVersion: SCHEMA_VERSION,
    };
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  }
  const giFile = projectGitignoreFile(root);
  if (!existsSync(giFile)) writeFileSync(giFile, GITIGNORE_BODY);
}

export function registerProject(rootInput: string, name?: string): ProjectRecord {
  const root = canonical(rootInput);
  const id = projectIdFromRoot(root);
  const reg = loadRegistry();
  const now = new Date().toISOString();
  const existing = reg.projects[id];
  const record: ProjectRecord = existing
    ? { ...existing, lastSeen: now, root, name: name ?? existing.name }
    : {
        id,
        name: name ?? basename(root),
        root,
        createdAt: now,
        lastSeen: now,
      };
  reg.projects[id] = record;
  saveRegistry(reg);
  ensureProjectScaffold(record, BRAIN_HOME);
  return record;
}

export function listProjects(): ProjectRecord[] {
  const reg = loadRegistry();
  return Object.values(reg.projects).sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen),
  );
}

export function getProject(id: string): ProjectRecord | undefined {
  return loadRegistry().projects[id];
}

export function findProjectByRoot(root: string): ProjectRecord | undefined {
  return getProject(projectIdFromRoot(root));
}

/**
 * Resolve a project record from an optional input.
 *
 * - If `input` is given, treat it as either a registry ID or a path. If a path,
 *   walk up to find an existing `.ai-brain/`; otherwise treat the path itself
 *   as the project root.
 * - If `input` is omitted, walk up from `process.cwd()` looking for `.ai-brain/`,
 *   falling back to cwd itself if none is found.
 *
 * In all cases, the project is registered (or its `lastSeen` updated) in the
 * central registry. The project's `.ai-brain/` directory is created on disk
 * if it does not exist.
 */
export function resolveProject(input?: string): ProjectRecord {
  if (input) {
    const byId = getProject(input);
    if (byId) return byId;
    const abs = canonical(input);
    const discovered = findProjectRoot(abs);
    return registerProject(discovered ?? abs);
  }
  const cwd = canonical(process.cwd());
  const discovered = findProjectRoot(cwd);
  return registerProject(discovered ?? cwd);
}
