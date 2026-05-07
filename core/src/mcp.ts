#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Entry,
  RecallHit,
  listEntries,
  recall as recallStore,
  remember as rememberStore,
  rebuildIndex,
} from "./storage.js";
import { listProjects, resolveProject } from "./projects.js";
import { getSubagent, listSubagents } from "./subagents.js";
import { syncBridges } from "./sync.js";

const server = new McpServer({ name: "ai-brain", version: "0.1.0" });

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function formatHits(hits: RecallHit[]): string {
  if (!hits.length) return "No matches in the brain. Consider remembering new facts as you learn them.";
  return hits
    .map(
      (h, i) =>
        `## ${i + 1}. ${h.title}  [${h.type}${h.scope === "global" ? " · global" : ""}]\n` +
        `id: ${h.id}\n` +
        (h.tags.length ? `tags: ${h.tags.join(", ")}\n` : "") +
        `\n${h.excerpt}`,
    )
    .join("\n\n---\n\n");
}

function formatEntries(entries: Entry[], heading: string): string {
  if (!entries.length) return `${heading}\n(no entries yet)`;
  const grouped = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = grouped.get(e.type) ?? [];
    arr.push(e);
    grouped.set(e.type, arr);
  }
  const sections = [...grouped.entries()].map(([type, items]) => {
    const lines = items
      .map(
        (e) =>
          `- **${e.title}** (id: \`${e.id}\`${e.tags.length ? `, tags: ${e.tags.join(", ")}` : ""})\n  ${e.body.split("\n")[0].slice(0, 200)}`,
      )
      .join("\n");
    return `### ${type}\n${lines}`;
  });
  return `${heading}\n\n${sections.join("\n\n")}`;
}

server.tool(
  "brain_recall",
  "Search the AI brain for knowledge relevant to a query, scoped to the current project plus global knowledge. Use this BEFORE generating code or answering project-specific questions.",
  {
    query: z.string().describe("Natural language search; the brain uses keyword search over the KB."),
    projectPath: z
      .string()
      .optional()
      .describe("Absolute path to the project. Defaults to current working directory."),
    limit: z.number().int().min(1).max(20).optional().default(8),
    includeGlobal: z.boolean().optional().default(true),
  },
  async ({ query, projectPath, limit, includeGlobal }) => {
    const project = resolveProject(projectPath);
    const hits = recallStore({
      projectRoot: project.root,
      query,
      limit,
      includeGlobal,
    });
    return text(
      `# Brain recall — project: ${project.name} (${project.id})\nquery: ${query}\n\n${formatHits(hits)}`,
    );
  },
);

server.tool(
  "brain_remember",
  "Persist a new fact, requirement, style rule, decision, or pattern into the project's knowledge base. Use whenever you learn something durable about the user, project, or codebase.",
  {
    title: z.string().min(3),
    body: z.string().min(3),
    type: z
      .enum(["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"])
      .default("note"),
    tags: z.array(z.string()).optional().default([]),
    projectPath: z.string().optional(),
    scope: z.enum(["project", "global"]).optional().default("project"),
  },
  async ({ title, body, type, tags, projectPath, scope }) => {
    const projectRoot = scope === "global" ? null : resolveProject(projectPath).root;
    const entry = rememberStore({ projectRoot, title, body, type, tags });
    return text(
      `Saved ${entry.scope} entry **${entry.title}** (id: \`${entry.id}\`, type: ${entry.type}).`,
    );
  },
);

server.tool(
  "brain_project_summary",
  "Return the full knowledge base for a project (every entry, grouped by type). Use this at the start of a session to load project context.",
  {
    projectPath: z.string().optional(),
  },
  async ({ projectPath }) => {
    const project = resolveProject(projectPath);
    const entries = listEntries(project.root);
    return text(
      formatEntries(
        entries,
        `# ${project.name} — Knowledge Base\nproject id: ${project.id}\nroot: ${project.root}\nKB folder: ${project.root}/.ai-brain/kb\nentries: ${entries.length}`,
      ),
    );
  },
);

server.tool(
  "brain_list_projects",
  "List every project the brain knows about.",
  {},
  async () => {
    const projects = listProjects();
    if (!projects.length) return text("No projects registered yet. Run `brain init` in a project root or call `brain_remember`.");
    return text(
      projects
        .map(
          (p) =>
            `- **${p.name}** (\`${p.id}\`)\n  root: ${p.root}\n  last seen: ${p.lastSeen}`,
        )
        .join("\n"),
    );
  },
);

server.tool(
  "brain_list_subagents",
  "List the brain's sub-agents (built-in + any project-specific ones grown via skill-forger). Sub-agents are prompt specialists invoked via brain_invoke_subagent.",
  {
    projectPath: z.string().optional(),
  },
  async ({ projectPath }) => {
    const project = projectPath !== undefined ? resolveProject(projectPath) : undefined;
    const agents = listSubagents(project?.root);
    return text(
      agents
        .map(
          (a) =>
            `- **${a.name}** [${a.scope}] — ${a.description}` +
            (a.inputs.length ? `\n  inputs: ${a.inputs.join(", ")}` : ""),
        )
        .join("\n") || "No sub-agents installed.",
    );
  },
);

server.tool(
  "brain_invoke_subagent",
  "Run a sub-agent. Returns the sub-agent's prompt with project KB context interpolated. The CALLING AGENT (you) must execute the prompt — the brain itself does not run inference. After producing output, persist any durable findings via brain_remember. Built-in sub-agents: requirement-refiner, style-learner, code-generator, knowledge-curator, skill-forger. Project-specific sub-agents grown by skill-forger are also discoverable here.",
  {
    name: z.string().describe("Sub-agent name. Includes both built-in and project-specific sub-agents."),
    input: z.string().describe("Free-form input to pass to the sub-agent (e.g. the client's raw requirement, code to analyze, a task description)."),
    projectPath: z.string().optional(),
  },
  async ({ name, input, projectPath }) => {
    const project = resolveProject(projectPath);
    const agent = getSubagent(name, project.root);
    if (!agent) {
      return text(
        `Unknown sub-agent: ${name}. Available: ${listSubagents(project.root).map((a) => a.name).join(", ") || "(none)"}`,
      );
    }
    const kbHits = recallStore({ projectRoot: project.root, query: input, limit: 8 });
    const kbBlock = kbHits.length
      ? `## Retrieved knowledge\n\n${formatHits(kbHits)}`
      : `## Retrieved knowledge\n(no prior knowledge in this project's brain — record findings via brain_remember)`;
    const summary = listEntries(project.root);
    const summaryBlock = summary.length
      ? `## Existing project KB outline\n\n${summary.map((e) => `- (${e.type}) ${e.title} [${e.id}]`).join("\n")}`
      : "";
    return text(
      [
        `# Sub-agent: ${agent.name}`,
        `Project: ${project.name} (${project.id}) — ${project.root}`,
        ``,
        `## Sub-agent role`,
        agent.prompt,
        ``,
        `## User input`,
        input,
        ``,
        kbBlock,
        summaryBlock,
        ``,
        `## Now do this`,
        `Execute the role above with the input and retrieved knowledge. After producing your output, call brain_remember for any durable facts you uncovered (requirement, style rule, decision, etc.).`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

server.tool(
  "brain_sync_bridges",
  "Write or refresh the brain's bridge files into a project (CLAUDE.md, .cursorrules, .github/copilot-instructions.md, .kiro/steering/ai-brain.md). Use after registering a new project.",
  {
    projectPath: z.string().describe("Absolute path to the project root."),
    force: z.boolean().optional().default(false),
  },
  async ({ projectPath, force }) => {
    const result = syncBridges(projectPath, { force });
    return text(
      `Synced bridges for ${result.project.name} (${result.project.id}).\n\n` +
        `Written:\n${result.written.map((f) => `  - ${f}`).join("\n") || "  (none)"}\n\n` +
        (result.skipped.length
          ? `Skipped:\n${result.skipped.map((f) => `  - ${f}`).join("\n")}`
          : ""),
    );
  },
);

server.tool(
  "brain_rebuild_index",
  "Rebuild the SQLite FTS index from the markdown files on disk. Use if recall results look stale or after editing files manually.",
  {
    projectPath: z.string().optional(),
    scope: z.enum(["project", "global"]).optional().default("project"),
  },
  async ({ projectPath, scope }) => {
    const projectRoot = scope === "global" ? null : resolveProject(projectPath).root;
    const n = rebuildIndex(projectRoot);
    return text(`Rebuilt ${scope} index — ${n} entries.`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
