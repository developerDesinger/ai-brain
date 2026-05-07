import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BRAIN_HOME, BRIDGES_DIR } from "./paths.js";
import { ProjectRecord, registerProject } from "./projects.js";

interface BridgeTarget {
  name: string;
  templateFile: string;
  destFile: string;
}

const TARGETS: BridgeTarget[] = [
  { name: "claude-code", templateFile: "CLAUDE.md.tmpl", destFile: "CLAUDE.md" },
  { name: "codex", templateFile: "AGENTS.md.tmpl", destFile: "AGENTS.md" },
  { name: "cursor", templateFile: "cursorrules.tmpl", destFile: ".cursorrules" },
  {
    name: "copilot",
    templateFile: "copilot-instructions.md.tmpl",
    destFile: ".github/copilot-instructions.md",
  },
  {
    name: "kiro",
    templateFile: "kiro-steering.tmpl",
    destFile: ".kiro/steering/ai-brain.md",
  },
  { name: "windsurf", templateFile: "windsurfrules.tmpl", destFile: ".windsurfrules" },
  { name: "aider", templateFile: "CONVENTIONS.md.tmpl", destFile: "CONVENTIONS.md" },
];

export interface SyncResult {
  project: ProjectRecord;
  written: string[];
  skipped: string[];
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

export function syncBridges(projectPath: string, opts: { force?: boolean } = {}): SyncResult {
  const abs = resolve(projectPath);
  if (!existsSync(abs)) throw new Error(`Project path does not exist: ${abs}`);
  const project = registerProject(abs);
  const vars = {
    BRAIN_HOME,
    PROJECT_ID: project.id,
    PROJECT_NAME: project.name,
    PROJECT_PATH: project.root,
    PROJECT_ROOT: project.root,
  };
  const written: string[] = [];
  const skipped: string[] = [];
  for (const t of TARGETS) {
    const tplPath = join(BRIDGES_DIR, t.templateFile);
    if (!existsSync(tplPath)) {
      skipped.push(`${t.name} (missing template)`);
      continue;
    }
    const dest = join(abs, t.destFile);
    const tpl = readFileSync(tplPath, "utf8");
    const rendered = render(tpl, vars);
    if (existsSync(dest) && !opts.force) {
      const current = readFileSync(dest, "utf8");
      if (!current.includes("ai-brain")) {
        skipped.push(`${t.destFile} (exists, no ai-brain marker — use --force to overwrite)`);
        continue;
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rendered);
    written.push(t.destFile);
  }
  return { project, written, skipped };
}
