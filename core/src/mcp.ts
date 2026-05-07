#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CompactHit,
  Entry,
  EntryType,
  RecallHit,
  getEntity as getEntityStore,
  getEntries as getEntriesStore,
  listEntries,
  recall as recallStore,
  recallCompact as recallCompactStore,
  rebuildIndex,
  remember as rememberStore,
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

server.tool(
  "brain_recall",
  "Search the AI brain for knowledge relevant to a query. **DEFAULTS TO COMPACT MODE** — returns id + title + type + tags + entities + a 1-2 sentence summary per hit. Use compact recall first (it is ~5x cheaper in tokens than full mode); follow up with brain_get_entries(ids) only if you need a specific entry's full body. Pass mode=\"full\" only when you genuinely need body excerpts.",
  {
    query: z.string().describe("Natural language search; the brain uses keyword search over the KB plus an entity index."),
    projectPath: z
      .string()
      .optional()
      .describe("Absolute path to the project. Auto-discovered by walking up from cwd if omitted."),
    limit: z.number().int().min(1).max(20).optional().default(8),
    includeGlobal: z.boolean().optional().default(true),
    mode: z.enum(["compact", "full"]).optional().default("compact").describe("compact (default) returns summaries only; full returns body excerpts at ~5x the token cost."),
    types: z
      .array(z.enum(["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"]))
      .optional()
      .describe("Narrow to specific entry types before searching."),
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

server.tool(
  "brain_get_entries",
  "Fetch the full body of one or more knowledge entries by ID. Use after brain_recall when you have decided which specific entries you need to read in full.",
  {
    ids: z.array(z.string()).min(1).max(20).describe("Entry IDs returned by brain_recall."),
    projectPath: z.string().optional(),
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

server.tool(
  "brain_entity",
  "Look up a knowledge-graph entity (a concept, library, file, or term referenced by knowledge entries). Returns its glossary definition (if any), compact summaries of all entries that mention it, and a 1-hop neighborhood of co-occurring entities. Cheaper than brain_recall when you already know the term you care about.",
  {
    name: z.string().describe("Entity name (case/whitespace insensitive). Examples: 'JWT', 'auth', 'rate-limit'."),
    projectPath: z.string().optional(),
    limit: z.number().int().min(1).max(30).optional().default(12),
    includeGlobal: z.boolean().optional().default(true),
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
    lines.push(`## Referenced by (${card.references.length} entries)`);
    if (card.references.length) {
      lines.push(formatCompact(card.references));
    } else {
      lines.push("(no entries reference this entity yet)");
    }
    lines.push("");
    if (card.neighbors.length) {
      lines.push("## Co-occurring entities (1-hop neighborhood)");
      lines.push(card.neighbors.map((n) => `- ${n.entity} (×${n.weight})`).join("\n"));
    }
    return text(lines.join("\n"));
  },
);

server.tool(
  "brain_remember",
  "Persist a new fact, requirement, style rule, decision, pattern, snippet, glossary entry, or note into the project's knowledge base. **Always include `summary` and `entities`** — they power the knowledge graph and the cheap (compact) recall path. Use whenever you learn something durable about the user, project, or codebase.",
  {
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
