#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_HOME, ENGINE_HOME } from "./paths.js";

function readVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkg = JSON.parse(readFileSync(resolve(dirname(here), "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
const VERSION = readVersion();
import { listProjects, registerProject, resolveProject } from "./projects.js";
import {
  listEntries,
  recall as recallStore,
  rebuildIndex,
  remember as rememberStore,
  forget as forgetStore,
} from "./storage.js";
import { listSubagents } from "./subagents.js";
import { syncBridges } from "./sync.js";
import { Effort, runSubagent } from "./runner.js";
import { LearnSource, learn } from "./learn.js";

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function help() {
  console.log(`brain — project-local AI knowledge brain that learns from your codebase

  Engine:    ${ENGINE_HOME}
  Data:      ${DATA_HOME}

Usage:
  brain init [path]                    create .ai-brain/ + write bridges into a project
  brain learn <input> [--type code|requirements|auto] [--path P]
                                       LEARN: feed code, a directory, a file, or raw client text;
                                       the brain extracts knowledge and stores it in .ai-brain/kb/.
                                       (Needs ANTHROPIC_API_KEY.)
  brain sync [path] [--force]          re-write bridge files into a project
  brain list                           list all known projects
  brain show [path]                    print all KB entries for a project
  brain export [path]                  dump entire KB as a single markdown blob (for tools without MCP)
  brain recall <query...> [--path P] [--limit N] [--no-global]
                                       search the KB
  brain remember --title T --body B [--type X] [--tags a,b] [--scope project|global] [--path P]
                                       add a KB entry manually
  brain forget <id> [--path P] [--scope project|global]
                                       remove a KB entry
  brain rebuild [--path P] [--scope project|global]
                                       rebuild the FTS index from markdown
  brain agents [--path P] [--global-only]
                                       list installed sub-agents (global + project-specific)
  brain run <subagent> [input...] [--path P] [--model M] [--effort E] [--max-tokens N] [--max-iter N] [--quiet]
                                       run a sub-agent directly via Anthropic API
  brain status                         engine + data paths + counts
  brain version                        print version

Entry types: requirement, style, pattern, decision, snippet, glossary, note

Sub-agents (built-in): ${listSubagents()
    .map((a) => a.name)
    .join(", ") || "(none)"}

Env:
  ANTHROPIC_API_KEY        required for 'brain learn' and 'brain run'
  BRAIN_MODEL              default model (default: claude-opus-4-7)
  BRAIN_EFFORT             default effort: low|medium|high|xhigh|max (default: xhigh, Opus 4.7 only)
  AI_BRAIN_HOME            override data home (default: ~/.ai-brain)
  AI_BRAIN_ENGINE_HOME     override engine home (default: auto-detect from binary location)
`);
}

function flagStr(args: Args, key: string, fallback?: string): string | undefined {
  const v = args.flags[key];
  if (typeof v === "string") return v;
  return fallback;
}

function flagBool(args: Args, key: string, fallback = false): boolean {
  const v = args.flags[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "false" && v !== "0";
  return fallback;
}

const cmds: Record<string, (args: Args) => void | Promise<void>> = {
  help,
  "--help": help,
  "-h": help,

  init: (args) => {
    const path = resolve(args._[1] ?? process.cwd());
    if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
    const project = registerProject(path);
    const result = syncBridges(path, { force: flagBool(args, "force") });
    console.log(`Registered project ${project.name} (${project.id}) at ${project.root}`);
    if (result.written.length) console.log(`Wrote: ${result.written.join(", ")}`);
    if (result.skipped.length) console.log(`Skipped: ${result.skipped.join(", ")}`);
    console.log(`Project brain: ${project.root}/.ai-brain/  (commit kb/ and subagents/ to git; index.sqlite is ignored)`);
  },

  sync: (args) => {
    const path = resolve(args._[1] ?? process.cwd());
    const result = syncBridges(path, { force: flagBool(args, "force") });
    console.log(`Synced bridges for ${result.project.name} (${result.project.id}).`);
    if (result.written.length) console.log(`Wrote: ${result.written.join(", ")}`);
    if (result.skipped.length) console.log(`Skipped: ${result.skipped.join(", ")}`);
  },

  list: () => {
    const projects = listProjects();
    if (!projects.length) {
      console.log("No projects registered yet. Try: brain init <path>");
      return;
    }
    for (const p of projects) {
      console.log(`- ${p.name}  (${p.id})\n    ${p.root}\n    last seen: ${p.lastSeen}`);
    }
  },

  show: (args) => {
    const project = resolveProject(args._[1]);
    const entries = listEntries(project.root);
    console.log(`# ${project.name} — ${entries.length} entries`);
    for (const e of entries) {
      const head = e.body.split("\n")[0].slice(0, 200);
      console.log(`\n[${e.type}] ${e.title}  (${e.id})`);
      if (e.tags.length) console.log(`  tags: ${e.tags.join(", ")}`);
      console.log(`  ${head}`);
    }
  },

  export: (args) => {
    const project = resolveProject(args._[1]);
    const entries = listEntries(project.root);
    const subagents = listSubagents(project.root);
    const lines: string[] = [];
    lines.push(`# ai-brain snapshot — ${project.name}`);
    lines.push("");
    lines.push(`Project ID: \`${project.id}\``);
    lines.push(`Root: ${project.root}`);
    lines.push(`Brain folder: ${project.root}/.ai-brain/`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push(
      "Pipe this into any AI coding tool that doesn't speak MCP (Aider, Windsurf, raw ChatGPT, etc.). Refresh after meaningful KB updates with `brain export <path>`.",
    );
    lines.push("");
    lines.push("## Sub-agents available for this project");
    lines.push("");
    if (!subagents.length) {
      lines.push("(none)");
    } else {
      for (const a of subagents) {
        lines.push(`- **${a.name}** [${a.scope}] — ${a.description}`);
      }
    }
    lines.push("");
    lines.push(`## Knowledge entries (${entries.length})`);
    lines.push("");
    if (!entries.length) {
      lines.push("(no entries yet)");
    } else {
      const grouped = new Map<string, typeof entries>();
      for (const e of entries) {
        const arr = grouped.get(e.type) ?? [];
        arr.push(e);
        grouped.set(e.type, arr);
      }
      for (const [type, items] of grouped) {
        lines.push(`### ${type}`);
        lines.push("");
        for (const e of items) {
          lines.push(`#### ${e.title}`);
          if (e.tags.length) lines.push(`*tags: ${e.tags.join(", ")}*`);
          lines.push("");
          lines.push(e.body);
          lines.push("");
        }
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
  },

  recall: (args) => {
    const query = args._.slice(1).join(" ");
    if (!query) throw new Error("Usage: brain recall <query...>");
    const project = resolveProject(flagStr(args, "path"));
    const limit = Number(flagStr(args, "limit") ?? 8);
    const includeGlobal = !flagBool(args, "no-global");
    const hits = recallStore({ projectRoot: project.root, query, limit, includeGlobal });
    if (!hits.length) {
      console.log("(no matches)");
      return;
    }
    for (const h of hits) {
      console.log(`\n[${h.type}${h.scope === "global" ? " · global" : ""}] ${h.title}  (${h.id})`);
      console.log(`  ${h.excerpt.replace(/\n/g, "\n  ")}`);
    }
  },

  remember: (args) => {
    const title = flagStr(args, "title");
    const body = flagStr(args, "body");
    if (!title || !body) throw new Error("Usage: brain remember --title T --body B [--type X] [--tags a,b] [--scope project|global] [--path P]");
    const type = (flagStr(args, "type") ?? "note") as
      | "requirement"
      | "style"
      | "pattern"
      | "decision"
      | "snippet"
      | "glossary"
      | "note";
    const tagsStr = flagStr(args, "tags") ?? "";
    const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
    const scope = (flagStr(args, "scope") ?? "project") as "project" | "global";
    const projectRoot = scope === "global" ? null : resolveProject(flagStr(args, "path")).root;
    const entry = rememberStore({ projectRoot, title, body, type, tags });
    console.log(`Saved [${entry.scope}] ${entry.title}  (${entry.id})`);
  },

  forget: (args) => {
    const id = args._[1];
    if (!id) throw new Error("Usage: brain forget <id>");
    const scope = (flagStr(args, "scope") ?? "project") as "project" | "global";
    const projectRoot = scope === "global" ? null : resolveProject(flagStr(args, "path")).root;
    const ok = forgetStore(projectRoot, id);
    console.log(ok ? `Removed ${id}` : `Not found: ${id}`);
  },

  rebuild: (args) => {
    const scope = (flagStr(args, "scope") ?? "project") as "project" | "global";
    const projectRoot = scope === "global" ? null : resolveProject(flagStr(args, "path")).root;
    const n = rebuildIndex(projectRoot);
    console.log(`Rebuilt ${scope} index — ${n} entries.`);
  },

  agents: (args) => {
    let projectRoot: string | undefined;
    const path = flagStr(args, "path");
    if (path !== undefined || !flagBool(args, "global-only")) {
      try {
        projectRoot = resolveProject(path).root;
      } catch {
        projectRoot = undefined;
      }
    }
    const list = listSubagents(projectRoot);
    if (!list.length) {
      console.log("No sub-agents installed.");
      return;
    }
    for (const a of list) {
      console.log(`- ${a.name} [${a.scope}] — ${a.description}`);
      if (a.inputs.length) console.log(`    inputs: ${a.inputs.join(", ")}`);
    }
  },

  run: async (args) => {
    const name = args._[1];
    if (!name) throw new Error("Usage: brain run <subagent> [input...]");
    let input = args._.slice(2).join(" ").trim();
    if (!input) {
      if (process.stdin.isTTY) {
        throw new Error(
          "No input provided. Pass it as args, or pipe via stdin (e.g. `cat req.md | brain run requirement-refiner`).",
        );
      }
      input = await readStdin();
    }
    const quiet = flagBool(args, "quiet");
    const effort = flagStr(args, "effort") as Effort | undefined;
    const model = flagStr(args, "model");
    const maxTokens = flagStr(args, "max-tokens");
    const maxIter = flagStr(args, "max-iter");
    const path = flagStr(args, "path");

    if (!quiet) {
      process.stderr.write(`# brain run ${name}  (model=${model ?? "default"}, effort=${effort ?? "default"})\n\n`);
    }

    const result = await runSubagent({
      subagentName: name,
      input,
      projectPath: path,
      model,
      effort,
      maxTokens: maxTokens ? Number(maxTokens) : undefined,
      maxIterations: maxIter ? Number(maxIter) : undefined,
      onTextDelta: (d) => process.stdout.write(d),
      onIteration: (n) => {
        if (!quiet && n > 1) process.stderr.write(`\n[iteration ${n}]\n`);
      },
      onToolCall: (toolName, toolInput) => {
        if (!quiet) {
          const summary = JSON.stringify(toolInput).slice(0, 120);
          process.stderr.write(`\n[tool] ${toolName}(${summary})\n`);
        }
      },
      onToolResult: (toolName, res) => {
        if (!quiet) {
          process.stderr.write(`[tool ← ${toolName}] ${res.slice(0, 120).replace(/\n/g, " ")}\n`);
        }
      },
    });

    process.stdout.write("\n");
    if (!quiet) {
      const cacheNote =
        result.cacheReadTokens > 0
          ? `, cache_read=${result.cacheReadTokens}, cache_creation=${result.cacheCreationTokens}`
          : "";
      process.stderr.write(
        `\n# done. iterations=${result.iterations}, tool_calls=${result.toolCalls}, ` +
          `input_tokens=${result.inputTokens}, output_tokens=${result.outputTokens}${cacheNote}\n`,
      );
      if (result.rememberedIds.length) {
        process.stderr.write(`# remembered: ${result.rememberedIds.join(", ")}\n`);
      }
    }
  },

  learn: async (args) => {
    const positional = args._.slice(1);
    const typeFlag = flagStr(args, "type") as LearnSource | undefined;
    let input = positional.join(" ").trim();

    if (!input) {
      if (process.stdin.isTTY) {
        throw new Error(
          "Usage: brain learn <path-or-text>  (or pipe input via stdin).\n" +
            "Examples:\n" +
            "  brain learn ./src                                # learn the project's style\n" +
            "  brain learn ./client-email.txt                   # learn from a requirements doc\n" +
            "  brain learn \"Users want filtering by date...\"   # learn from raw text\n" +
            "  cat brief.md | brain learn                        # learn from stdin",
        );
      }
      input = await readStdin();
      if (!input) throw new Error("No input received on stdin.");
    }

    const quiet = flagBool(args, "quiet");
    const effort = flagStr(args, "effort") as Effort | undefined;
    const model = flagStr(args, "model");
    const maxTokens = flagStr(args, "max-tokens");
    const maxIter = flagStr(args, "max-iter");
    const path = flagStr(args, "path");

    if (!quiet) {
      process.stderr.write(
        `# brain learn  (input: ${input.slice(0, 80).replace(/\n/g, " ")}${input.length > 80 ? "…" : ""})\n`,
      );
    }

    const result = await learn({
      input,
      type: typeFlag ?? "auto",
      projectPath: path,
      model,
      effort,
      maxTokens: maxTokens ? Number(maxTokens) : undefined,
      maxIterations: maxIter ? Number(maxIter) : undefined,
      onTextDelta: (d) => process.stdout.write(d),
      onIteration: (n) => {
        if (!quiet && n > 1) process.stderr.write(`\n[iteration ${n}]\n`);
      },
      onToolCall: (toolName, toolInput) => {
        if (!quiet) {
          const summary = JSON.stringify(toolInput).slice(0, 120);
          process.stderr.write(`\n[tool] ${toolName}(${summary})\n`);
        }
      },
      onToolResult: (toolName, res) => {
        if (!quiet) {
          process.stderr.write(`[tool ← ${toolName}] ${res.slice(0, 120).replace(/\n/g, " ")}\n`);
        }
      },
    });

    process.stdout.write("\n");
    if (!quiet) {
      const cacheNote =
        result.cacheReadTokens > 0
          ? `, cache_read=${result.cacheReadTokens}, cache_creation=${result.cacheCreationTokens}`
          : "";
      process.stderr.write(
        `\n# learned via ${result.plan.subagent} — ${result.plan.summary}\n` +
          `# iterations=${result.iterations}, tool_calls=${result.toolCalls}, ` +
          `input_tokens=${result.inputTokens}, output_tokens=${result.outputTokens}${cacheNote}\n`,
      );
      if (result.rememberedIds.length) {
        process.stderr.write(
          `# new KB entries: ${result.rememberedIds.join(", ")}\n`,
        );
      } else {
        process.stderr.write(
          `# (no entries persisted — review the output and add manually with 'brain remember' if needed)\n`,
        );
      }
    }
  },

  status: () => {
    console.log(`Engine home:      ${ENGINE_HOME}`);
    console.log(`Data home:        ${DATA_HOME}`);
    console.log(`Sub-agents dir:   ${ENGINE_HOME}/core/subagents/`);
    console.log(`MCP launch cmd:   node ${ENGINE_HOME}/core/dist/mcp.js`);
    console.log(`Projects:         ${listProjects().length}`);
    console.log(`Sub-agents:       ${listSubagents().length}`);
  },

  version: () => {
    console.log(VERSION);
  },
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "help";
const fn = cmds[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\n`);
  help();
  process.exit(1);
}
try {
  await fn(args);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
