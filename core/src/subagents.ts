import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { SUBAGENTS_DIR, projectSubagentsDir } from "./paths.js";

export interface Subagent {
  name: string;
  description: string;
  inputs: string[];
  prompt: string;
  scope: "global" | "project";
  source: string;
}

export function listSubagents(projectRoot?: string | null): Subagent[] {
  const out = new Map<string, Subagent>();
  if (existsSync(SUBAGENTS_DIR)) {
    for (const f of readdirSync(SUBAGENTS_DIR)) {
      if (!f.endsWith(".md")) continue;
      const sub = loadSubagentFile(join(SUBAGENTS_DIR, f), "global");
      if (sub) out.set(sub.name, sub);
    }
  }
  if (projectRoot) {
    const dir = projectSubagentsDir(projectRoot);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const sub = loadSubagentFile(join(dir, f), "project");
        if (sub) out.set(sub.name, sub); // project overrides global
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSubagent(name: string, projectRoot?: string | null): Subagent | null {
  if (projectRoot) {
    const file = join(projectSubagentsDir(projectRoot), `${name}.md`);
    if (existsSync(file)) return loadSubagentFile(file, "project");
  }
  const file = join(SUBAGENTS_DIR, `${name}.md`);
  if (existsSync(file)) return loadSubagentFile(file, "global");
  return null;
}

function loadSubagentFile(filePath: string, scope: "global" | "project"): Subagent | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const name = String(fm.name ?? basename(filePath, ".md"));
    const description = String(fm.description ?? "");
    const inputs = Array.isArray(fm.inputs) ? (fm.inputs as string[]) : [];
    return { name, description, inputs, prompt: parsed.content.trim(), scope, source: filePath };
  } catch {
    return null;
  }
}

export interface InstallSubagentInput {
  name: string;
  description: string;
  prompt: string;
  inputs?: string[];
  scope?: "global" | "project";
  projectRoot?: string | null;
}

export function installSubagent(input: InstallSubagentInput): Subagent {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) {
    throw new Error(
      `Invalid sub-agent name: "${input.name}". Use 2-41 chars, lowercase letters, digits, dashes; must start with a letter.`,
    );
  }
  const description = input.description.trim();
  const prompt = input.prompt.trim();
  if (!description) throw new Error("description is required");
  if (prompt.length < 50) throw new Error("prompt is too short — write a real sub-agent role");

  const scope = input.scope ?? "project";
  if (scope === "project" && !input.projectRoot) {
    throw new Error("projectRoot is required when installing a project sub-agent");
  }
  const dir = scope === "global" ? SUBAGENTS_DIR : projectSubagentsDir(input.projectRoot!);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.md`);
  const fm = {
    name,
    description,
    inputs: input.inputs ?? [],
    scope,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(filePath, matter.stringify(prompt + "\n", fm));
  return {
    name,
    description,
    inputs: input.inputs ?? [],
    prompt,
    scope,
    source: filePath,
  };
}
