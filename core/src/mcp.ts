#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CompactHit,
  Entry,
  EntryType,
  RecallHit,
  getCodeIndexStats,
  getEntity as getEntityStore,
  getEntries as getEntriesStore,
  listEntries,
  recall as recallStore,
  recallCode as recallCodeStore,
  recallCompact as recallCompactStore,
  rebuildIndex,
  remember as rememberStore,
} from "./storage.js";
import { listProjects, resolveProject } from "./projects.js";
import { getSubagent, listSubagents } from "./subagents.js";
import { syncBridges } from "./sync.js";
import { refreshCodeIndex } from "./code-index.js";

const server = new McpServer({ name: "ai-brain", version: "0.3.0" });

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

function formatCompact(hits: CompactHit[]): string {
  if (!hits.length) {
    return "No matches in the brain. Consider remembering new facts as you learn them.";
  }
  return hits
    .map((h, i) => {
      const meta = [h.type, h.scope === "global" ? "global" : ""].filter(Boolean).join(" · ");
      const ents = h.entities.length ? `\n  entities: ${h.entities.join(", ")}` : "";
      const tagsLine = h.tags.length ? `\n  tags: ${h.tags.join(", ")}` : "";
      return `${i + 1}. **${h.title}**  [${meta}]\n  id: \`${h.id}\`${tagsLine}${ents}\n  ${h.summary || "(no summary)"}`;
    })
    .join("\n\n");
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

// ---------- KB recall + read ----------

server.registerTool(
  "brain_recall",
  {
    description:
      'Search the AI brain for knowledge relevant to a query. **Defaults to compact mode** (id + title + type + tags + entities + 1-2 sentence summary per hit, no body). Use compact recall first; follow up with brain_get_entries(ids) only if you need a specific entry\'s full body. Pass mode="full" only when you genuinely need body excerpts.',
    inputSchema: {
      query: z.string().describe("Natural language search over the KB + entity index."),
      projectPath: z
        .string()
        .optional()
        .describe("Auto-discovered by walking up from cwd if omitted."),
      limit: z.number().int().min(1).max(20).optional().default(8),
      includeGlobal: z.boolean().optional().default(true),
      mode: z
        .enum(["compact", "full"])
        .optional()
        .default("compact")
        .describe('compact (default) returns summaries only; full returns body excerpts.'),
      types: z
        .array(z.enum(["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"]))
        .optional(),
    },
  },
  async ({ query, projectPath, limit, includeGlobal, mode, types }) => {
    const project = resolveProject(projectPath);
    if (mode === "full") {
      const hits = recallStore({
        projectRoot: project.root,
        query,
        limit,
        includeGlobal,
        types: types as EntryType[] | undefined,
      });
      return text(
        `# Brain recall (full) — ${project.name} (${project.id})\nquery: ${query}\n\n${formatHits(hits)}`,
      );
    }
    const hits = recallCompactStore({
      projectRoot: project.root,
      query,
      limit,
      includeGlobal,
      types: types as EntryType[] | undefined,
    });
    return text(
      `# Brain recall (compact) — ${project.name} (${project.id})\nquery: ${query}\n\n${formatCompact(hits)}\n\n_Need a full body? Call brain_get_entries with the ids above._`,
    );
  },
);

server.registerTool(
  "brain_get_entries",
  {
    description:
      "Fetch the full body of one or more knowledge entries by ID. Use after brain_recall when you have decided which specific entries you need to read in full.",
    inputSchema: {
      ids: z.array(z.string()).min(1).max(20).describe("Entry IDs returned by brain_recall."),
      projectPath: z.string().optional(),
    },
  },
  async ({ ids, projectPath }) => {
    const project = resolveProject(projectPath);
    const entries = getEntriesStore(project.root, ids);
    if (!entries.length) {
      return text(`No entries found for ids: ${ids.join(", ")}`);
    }
    const formatted = entries
      .map(
        (e) =>
          `## ${e.title}  [${e.type}]\n` +
          `id: \`${e.id}\`\n` +
          (e.tags.length ? `tags: ${e.tags.join(", ")}\n` : "") +
          (e.entities.length ? `entities: ${e.entities.join(", ")}\n` : "") +
          `\n${e.body}`,
      )
      .join("\n\n---\n\n");
    return text(`# Brain entries — ${project.name}\n\n${formatted}`);
  },
);

server.registerTool(
  "brain_remember",
  {
    description:
      "Persist a new fact, requirement, style rule, decision, pattern, snippet, glossary entry, or note. **Always include `summary` and `entities`** — they power the knowledge graph and the cheap (compact) recall path. Use whenever you learn something durable about the user, project, or codebase.",
    inputSchema: {
      title: z.string().min(3),
      body: z.string().min(3),
      type: z
        .enum(["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"])
        .default("note"),
      tags: z.array(z.string()).optional().default([]),
      summary: z
        .string()
        .optional()
        .describe(
          "1-2 sentence summary surfaced by compact recall. Strongly recommended; auto-derived from body if absent.",
        ),
      entities: z
        .array(z.string())
        .optional()
        .describe(
          "Concrete things this entry concerns (libraries, services, files, function names, concepts). Powers the knowledge graph; merged with heuristic extraction.",
        ),
      projectPath: z.string().optional(),
      scope: z.enum(["project", "global"]).optional().default("project"),
    },
  },
  async ({ title, body, type, tags, summary, entities, projectPath, scope }) => {
    const projectRoot = scope === "global" ? null : resolveProject(projectPath).root;
    const entry = rememberStore({
      projectRoot,
      title,
      body,
      type,
      tags,
      summary,
      entities,
    });
    return text(
      `Saved ${entry.scope} entry **${entry.title}** (id: \`${entry.id}\`, type: ${entry.type}, entities: ${entry.entities.join(", ") || "(none)"}).`,
    );
  },
);

server.registerTool(
  "brain_project_summary",
  {
    description:
      "Return the full knowledge base for a project (every entry, grouped by type). Use this at the start of a session to load project context. Plus code-index stats: how many source files have been auto-indexed and how many distinct entities they contain.",
    inputSchema: {
      projectPath: z.string().optional(),
    },
  },
  async ({ projectPath }) => {
    const project = resolveProject(projectPath);
    const entries = listEntries(project.root);
    const codeStats = getCodeIndexStats(project.root);
    const head =
      `# ${project.name} — Knowledge Base\n` +
      `project id: ${project.id}\n` +
      `root: ${project.root}\n` +
      `KB folder: ${project.root}/.ai-brain/kb\n` +
      `KB entries: ${entries.length}\n` +
      `code-index: ${codeStats.files} files, ${codeStats.entities} distinct entities` +
      (codeStats.files === 0
        ? "\n(run `brain refresh` or `brain watch` to populate the code index — token-free)"
        : "");
    return text(formatEntries(entries, head));
  },
);

server.registerTool(
  "brain_list_projects",
  {
    description: "List every project the brain knows about.",
    inputSchema: {},
  },
  async () => {
    const projects = listProjects();
    if (!projects.length) {
      return text(
        "No projects registered yet. Run `brain init` in a project root or call `brain_remember`.",
      );
    }
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

// ---------- Sub-agents ----------

server.registerTool(
  "brain_list_subagents",
  {
    description:
      "List the brain's sub-agents (built-in + any project-specific ones grown via skill-forger). Sub-agents are prompt specialists invoked via brain_invoke_subagent.",
    inputSchema: {
      projectPath: z.string().optional(),
    },
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

server.registerTool(
  "brain_invoke_subagent",
  {
    description:
      "Run a sub-agent. Returns the sub-agent's prompt with project KB context interpolated. The CALLING AGENT (you) must execute the prompt — the brain itself does not run inference. After producing output, persist any durable findings via brain_remember. Built-in sub-agents: requirement-refiner, style-learner, code-generator, knowledge-curator, skill-forger. Project-specific sub-agents grown by skill-forger are also discoverable here.",
    inputSchema: {
      name: z
        .string()
        .describe("Sub-agent name. Includes both built-in and project-specific sub-agents."),
      input: z
        .string()
        .describe(
          "Free-form input to pass to the sub-agent (e.g. the client's raw requirement, code to analyze, a task description).",
        ),
      projectPath: z.string().optional(),
    },
  },
  async ({ name, input, projectPath }) => {
    const project = resolveProject(projectPath);
    const agent = getSubagent(name, project.root);
    if (!agent) {
      return text(
        `Unknown sub-agent: ${name}. Available: ${listSubagents(project.root).map((a) => a.name).join(", ") || "(none)"}`,
      );
    }
    const kbHits = recallCompactStore({
      projectRoot: project.root,
      query: input,
      limit: 8,
    });
    const kbBlock = kbHits.length
      ? `## Retrieved knowledge (compact)\n\n${formatCompact(kbHits)}`
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
        `Execute the role above with the input and retrieved knowledge. Use brain_get_entries to pull specific full bodies, brain_entity to query the knowledge graph, and brain_code_search for "where in the code does X live?". After producing your output, call brain_remember (with summary + entities) for any durable facts you uncovered.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

// ---------- Knowledge graph ----------

server.registerTool(
  "brain_entity",
  {
    description:
      "Look up a knowledge-graph entity (a concept, library, file, function, or term). Returns its glossary definition (if any), compact summaries of every KB entry that mentions it, the 1-hop neighborhood of co-occurring entities, and **source-code file paths** where the entity appears (auto-populated by `brain refresh` / `brain watch`). Cheaper than brain_recall when you already know the term.",
    inputSchema: {
      name: z
        .string()
        .describe("Entity name (case/whitespace insensitive). Examples: 'JWT', 'auth', 'rate-limit', 'getUserById'."),
      projectPath: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional().default(12),
      includeGlobal: z.boolean().optional().default(true),
    },
  },
  async ({ name, projectPath, limit, includeGlobal }) => {
    const project = resolveProject(projectPath);
    const card = getEntityStore(project.root, name, { limit, includeGlobal });
    const lines: string[] = [`# Entity: ${card.name}`, `Project: ${project.name}`, ""];
    if (card.definition) {
      lines.push(`## Definition (glossary entry \`${card.definition.id}\`)`);
      lines.push(card.definition.body);
      lines.push("");
    } else {
      lines.push("## Definition");
      lines.push(
        `(no glossary entry — define this term with brain_remember type=glossary if useful)`,
      );
      lines.push("");
    }
    lines.push(`## Referenced by ${card.references.length} KB entries`);
    if (card.references.length) {
      lines.push(formatCompact(card.references));
    } else {
      lines.push("(no entries reference this entity yet)");
    }
    lines.push("");
    if (card.codeLocations.length) {
      lines.push(`## Found in ${card.codeLocations.length} source files`);
      lines.push(card.codeLocations.map((p) => `- ${p}`).join("\n"));
      lines.push("");
    } else {
      lines.push(
        "## Found in source code\n(no matches — run `brain refresh` if the project's code index is empty)",
      );
      lines.push("");
    }
    if (card.neighbors.length) {
      lines.push("## Co-occurring entities (1-hop neighborhood)");
      lines.push(card.neighbors.map((n) => `- ${n.entity} (×${n.weight})`).join("\n"));
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "brain_code_search",
  {
    description:
      'Search the project\'s **code-index** (token-free). Given a query of identifiers/terms, returns the source files where any token appears as an identifier, ranked by hit count. Cheaper than brain_recall for "where in the code does X live?" — populated continuously by `brain refresh` / `brain watch`.',
    inputSchema: {
      query: z
        .string()
        .describe("Identifiers / terms to look up. Multiple tokens are OR-ed. Example: 'getUserById validate'."),
      projectPath: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional().default(12),
    },
  },
  async ({ query, projectPath, limit }) => {
    const project = resolveProject(projectPath);
    const hits = recallCodeStore(project.root, query, limit);
    const stats = getCodeIndexStats(project.root);
    if (!hits.length) {
      return text(
        `# Code search — ${project.name}\nquery: ${query}\n\n(no matches in ${stats.files} indexed files / ${stats.entities} entities)\n\n` +
          (stats.files === 0
            ? "Tip: run `brain refresh` (or `brain watch` for continuous indexing) to populate the code index."
            : ""),
      );
    }
    const lines = [
      `# Code search — ${project.name}`,
      `query: ${query}`,
      `index: ${stats.files} files, ${stats.entities} entities`,
      "",
    ];
    for (const h of hits) {
      lines.push(`- **${h.path}**`);
      lines.push(`    matches: ${h.matches.slice(0, 8).join(", ")}${h.matches.length > 8 ? "…" : ""}`);
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "brain_refresh_code_index",
  {
    description:
      "Token-free: re-scan the project's source files and update the code-index. Run when brain_code_search misses something you know is in the code, or after a large checkout. The continuous equivalent is `brain watch` from the shell — point your AI agent at this tool when you need a one-shot refresh.",
    inputSchema: {
      projectPath: z.string().optional(),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Optional: only refresh these specific file paths (project-relative). Otherwise scans the whole tree.",
        ),
    },
  },
  async ({ projectPath, paths }) => {
    const project = resolveProject(projectPath);
    const stats = refreshCodeIndex(project.root, { paths });
    return text(
      `Refreshed code index for ${project.name}.\n` +
        `added=${stats.added}, updated=${stats.updated}, removed=${stats.removed}, total files=${stats.totalFiles}`,
    );
  },
);

// ---------- Bridges + maintenance ----------

server.registerTool(
  "brain_sync_bridges",
  {
    description:
      "Write or refresh the brain's bridge files into a project (CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md, .kiro/steering/ai-brain.md, CONVENTIONS.md). Use after registering a new project.",
    inputSchema: {
      projectPath: z.string().describe("Absolute path to the project root."),
      force: z.boolean().optional().default(false),
    },
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

server.registerTool(
  "brain_rebuild_index",
  {
    description:
      "Rebuild the SQLite FTS5 index from the markdown files on disk. Use if recall results look stale or after editing files manually. Pass scope='global' to rebuild the cross-project KB instead.",
    inputSchema: {
      projectPath: z.string().optional(),
      scope: z.enum(["project", "global"]).optional().default("project"),
      refreshEntities: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also re-run entity + summary heuristics on each entry, writing results back to the markdown frontmatter.",
        ),
    },
  },
  async ({ projectPath, scope, refreshEntities }) => {
    const projectRoot = scope === "global" ? null : resolveProject(projectPath).root;
    const n = rebuildIndex(projectRoot, { refreshEntities });
    return text(
      `Rebuilt ${scope} index — ${n} entries${refreshEntities ? " (entities + summaries refreshed)" : ""}.`,
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
