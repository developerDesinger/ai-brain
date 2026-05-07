import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { Effort, RunOptions, RunResult, runSubagent } from "./runner.js";

/**
 * `brain learn` — the headline workflow.
 *
 * Feed any of: a directory of project code, a code file, a requirements
 * document, a snippet of raw client text, or a piped string. The brain
 * auto-detects the input shape, dispatches to the right sub-agent
 * (style-learner for code, requirement-refiner for prose), runs it
 * autonomously, and persists findings to the project's KB via brain_remember.
 */

export type LearnSource = "code" | "requirements" | "auto";

export interface LearnOptions {
  /** Raw input — may be a path, a string of prose, or pre-built text. */
  input: string;
  /** Override auto-detection. */
  type?: LearnSource;
  /** Project to learn into. Defaults to cwd via runner's auto-discovery. */
  projectPath?: string;
  /** Forwarded to runSubagent. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  maxIterations?: number;
  apiKey?: string;
  onTextDelta?: (delta: string) => void;
  onIteration?: (n: number) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: string) => void;
}

export interface LearnPlan {
  type: "code" | "requirements";
  subagent: "style-learner" | "requirement-refiner";
  /** The fully-built input string passed to the sub-agent. */
  builtInput: string;
  /** Human-readable summary of what we collected. */
  summary: string;
}

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
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
]);

const PROSE_EXTS = new Set([".md", ".txt", ".rst", ".adoc", ".markdown"]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
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
  ".ai-brain",
]);

const MAX_FILES = 15;
const MAX_BYTES_PER_FILE = 6000;
const MAX_TOTAL_BYTES = 120000;

function isCodeFile(path: string): boolean {
  return CODE_EXTS.has(extname(path).toLowerCase());
}
function isProseFile(path: string): boolean {
  return PROSE_EXTS.has(extname(path).toLowerCase());
}

function collectCodeFiles(dir: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const queue: string[] = [dir];
  while (queue.length && out.length < max * 4) {
    const cur = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && isCodeFile(e.name)) out.push(full);
    }
  }
  // Prefer files closer to the root (fewer slashes) so entry-points beat
  // deeply-nested helpers.
  out.sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  return out.slice(0, max);
}

function safeRead(path: string, maxBytes = MAX_BYTES_PER_FILE): string {
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

function fenceFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ext || "";
}

function buildCodeInput(rootOrFile: string): { built: string; summary: string } {
  const stat = statSync(rootOrFile);
  let files: string[];
  let label: string;

  if (stat.isDirectory()) {
    files = collectCodeFiles(rootOrFile);
    label = `directory ${rootOrFile}`;
  } else {
    files = [rootOrFile];
    label = `file ${rootOrFile}`;
  }

  if (!files.length) {
    return {
      built: `Project root: ${rootOrFile}\n\nNo recognizable code files were found.`,
      summary: `0 files from ${label}`,
    };
  }

  const root = stat.isDirectory() ? rootOrFile : resolve(rootOrFile, "..");
  const parts: string[] = [
    `Project root: ${rootOrFile}`,
    `Files sampled (${files.length}):`,
    ...files.map((f) => `- ${relative(root, f)}`),
    "",
    "## File contents",
    "",
  ];

  let total = 0;
  for (const f of files) {
    if (total >= MAX_TOTAL_BYTES) break;
    const remaining = MAX_TOTAL_BYTES - total;
    const content = safeRead(f, Math.min(MAX_BYTES_PER_FILE, remaining));
    if (!content) continue;
    total += content.length;
    parts.push(`### ${relative(root, f)}`);
    parts.push("```" + fenceFor(f));
    parts.push(content);
    parts.push("```");
    parts.push("");
  }

  return {
    built: parts.join("\n"),
    summary: `${files.length} files (${total.toLocaleString()} bytes) from ${label}`,
  };
}

function buildRequirementsInput(text: string, sourceLabel: string): {
  built: string;
  summary: string;
} {
  const trimmed = text.trim();
  return {
    built: `Raw requirement input (source: ${sourceLabel}):\n\n${trimmed}`,
    summary: `${trimmed.length.toLocaleString()} chars from ${sourceLabel}`,
  };
}

/**
 * Inspect the input and decide which sub-agent to run, then build the
 * enriched input the sub-agent will see (file contents inlined for code,
 * raw text for requirements). Does NOT run anything yet.
 */
export function planLearn(input: string, override?: LearnSource): LearnPlan {
  const trimmed = input.trim();
  const isPath = trimmed.length < 4096 && existsSync(trimmed);

  let type: "code" | "requirements";
  let sourceLabel: string;
  let built: string;
  let summary: string;

  if (override === "code") {
    type = "code";
    if (!isPath) {
      throw new Error(
        `--type code requires a path to a file or directory; got: ${trimmed.slice(0, 80)}…`,
      );
    }
    ({ built, summary } = buildCodeInput(trimmed));
  } else if (override === "requirements") {
    type = "requirements";
    if (isPath) {
      const text = safeRead(trimmed, MAX_TOTAL_BYTES);
      sourceLabel = trimmed;
      ({ built, summary } = buildRequirementsInput(text, sourceLabel));
    } else {
      sourceLabel = "user-provided text";
      ({ built, summary } = buildRequirementsInput(trimmed, sourceLabel));
    }
  } else {
    // auto-detect
    if (isPath) {
      const stat = statSync(trimmed);
      if (stat.isDirectory()) {
        type = "code";
        ({ built, summary } = buildCodeInput(trimmed));
      } else if (isCodeFile(trimmed)) {
        type = "code";
        ({ built, summary } = buildCodeInput(trimmed));
      } else if (isProseFile(trimmed)) {
        type = "requirements";
        const text = safeRead(trimmed, MAX_TOTAL_BYTES);
        ({ built, summary } = buildRequirementsInput(text, trimmed));
      } else {
        throw new Error(
          `Could not classify file ${trimmed} (extension ${extname(trimmed) || "<none>"}). Pass --type code|requirements explicitly.`,
        );
      }
    } else {
      type = "requirements";
      ({ built, summary } = buildRequirementsInput(trimmed, "user-provided text"));
    }
  }

  return {
    type,
    subagent: type === "code" ? "style-learner" : "requirement-refiner",
    builtInput: built,
    summary,
  };
}

export interface LearnResult extends RunResult {
  plan: LearnPlan;
}

export async function learn(opts: LearnOptions): Promise<LearnResult> {
  const plan = planLearn(opts.input, opts.type);
  const runOpts: RunOptions = {
    subagentName: plan.subagent,
    input: plan.builtInput,
    projectPath: opts.projectPath,
    model: opts.model,
    effort: opts.effort,
    maxTokens: opts.maxTokens,
    maxIterations: opts.maxIterations,
    apiKey: opts.apiKey,
    onTextDelta: opts.onTextDelta,
    onIteration: opts.onIteration,
    onToolCall: opts.onToolCall,
    onToolResult: opts.onToolResult,
  };
  const result = await runSubagent(runOpts);
  return { ...result, plan };
}
