import Anthropic from "@anthropic-ai/sdk";
import {
  CompactHit,
  Entry,
  EntryType,
  getEntity as getEntityStore,
  getEntries as getEntriesStore,
  listEntries,
  recallCompact as recallCompactStore,
  remember as rememberStore,
} from "./storage.js";
import { ProjectRecord, resolveProject } from "./projects.js";
import { Subagent, getSubagent, installSubagent } from "./subagents.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunOptions {
  subagentName: string;
  input: string;
  projectPath?: string;
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

export interface RunResult {
  finalText: string;
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rememberedIds: string[];
  installedSubagents: string[];
}

const DEFAULT_MODEL = process.env.BRAIN_MODEL || "claude-opus-4-7";
const DEFAULT_EFFORT: Effort = (process.env.BRAIN_EFFORT as Effort) || "xhigh";
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_MAX_ITER = 8;

const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "brain_remember",
    description:
      "Persist a durable fact into the current project's knowledge base. Call this whenever you uncover something the next session should remember: a refined requirement, a style rule the project follows, an architectural decision, a reusable pattern or snippet, a glossary term. **Always include `summary` and `entities`** — they power the knowledge graph and the cheap (compact) recall path. Do NOT use it for ephemeral state, scratch notes, or things already obvious from the code.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, distinct title (>=3 chars). Future-you will search by this.",
        },
        body: {
          type: "string",
          description: "Full markdown body of the entry.",
        },
        type: {
          type: "string",
          enum: ["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"],
          description: "Pick the most specific type that applies.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags to aid retrieval.",
        },
        summary: {
          type: "string",
          description:
            "1-2 sentence summary. Returned by compact recall instead of the body, so future sessions can find this entry without paying for the body's tokens. Required for clean knowledge-graph behavior.",
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete things this entry concerns: libraries, services, files, function names, concepts, terms. The knowledge graph uses these for cheap entity-based retrieval and 1-hop neighborhood queries.",
        },
      },
      required: ["title", "body", "type"],
    },
  },
  {
    name: "brain_recall",
    description:
      "COMPACT search. Returns id + title + type + tags + entities + a 1-2 sentence summary per hit (no body). ~5x cheaper in tokens than reading full entries. Use this whenever you need more KB context than what's in your system prompt; follow up with brain_get_entries(ids) only for specific entries you need to read in full.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query." },
        limit: { type: "integer", minimum: 1, maximum: 15 },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["requirement", "style", "pattern", "decision", "snippet", "glossary", "note"],
          },
          description: "Optional: restrict the search to specific entry types.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_get_entries",
    description:
      "Fetch the FULL body of one or more KB entries by ID. Use after brain_recall when you have decided which specific entries you need to read in full. Avoid pulling more than 3-4 at a time — pick selectively.",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Entry IDs returned by brain_recall.",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "brain_entity",
    description:
      "Look up a knowledge-graph entity (a concept, library, file, or term referenced by entries). Returns its glossary definition (if any), compact summaries of all entries that mention it, and the 1-hop neighborhood of co-occurring entities. Cheaper than brain_recall when you already know the term.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Entity name (case/whitespace insensitive). Examples: 'JWT', 'auth', 'rate-limit'.",
        },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["name"],
    },
  },
  {
    name: "brain_install_subagent",
    description:
      "Install a NEW sub-agent (typically project-scoped) so the brain can grow new skills as the project develops. Use this only when running as the skill-forger meta-agent and you have determined a recurring, project-specific need that the existing sub-agents do not cover. Once installed, the sub-agent is immediately available via `brain run <name>` and `brain_invoke_subagent`.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "kebab-case, 2-41 chars, lowercase letters/digits/dashes; must start with a letter.",
        },
        description: {
          type: "string",
          description: "One-sentence summary of what the sub-agent does. Shown in lists.",
        },
        prompt: {
          type: "string",
          description:
            "Full markdown body of the sub-agent's role/instructions. Must be substantive — describe the goal, process, output format, and what to brain_remember after.",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "Names of inputs this sub-agent expects (e.g. release_notes_text).",
        },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "project (default) installs for this project only; global installs machine-wide.",
        },
      },
      required: ["name", "description", "prompt"],
    },
  },
];

function effortIsValidFor(model: string, effort: Effort): boolean {
  if (effort === "xhigh") return /opus-4-7/.test(model);
  if (effort === "max") return /opus-4-(6|7)|opus-4-5/.test(model);
  return true;
}

function formatCompact(hits: CompactHit[]): string {
  if (!hits.length) return "(no relevant entries in the brain yet)";
  return hits
    .map((h, i) => {
      const meta = [h.type, h.scope === "global" ? "global" : ""]
        .filter(Boolean)
        .join(" · ");
      const ents = h.entities.length ? `\n  entities: ${h.entities.join(", ")}` : "";
      const tagsLine = h.tags.length ? `\n  tags: ${h.tags.join(", ")}` : "";
      return `${i + 1}. **${h.title}**  [${meta}]\n  id: ${h.id}${tagsLine}${ents}\n  ${h.summary || "(no summary)"}`;
    })
    .join("\n\n");
}

function formatOutline(entries: Entry[]): string {
  if (!entries.length) return "(no entries yet)";
  const grouped = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = grouped.get(e.type) ?? [];
    arr.push(e);
    grouped.set(e.type, arr);
  }
  return [...grouped.entries()]
    .map(([type, items]) => {
      const lines = items
        .map((e) => `- ${e.title} (${e.id})${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}`)
        .join("\n");
      return `**${type}**\n${lines}`;
    })
    .join("\n\n");
}

function buildSystemPrompt(args: {
  subagent: Subagent;
  project: ProjectRecord;
  hits: CompactHit[];
  entries: Entry[];
}): string {
  return [
    `# Sub-agent: ${args.subagent.name}`,
    `${args.subagent.description}`,
    ``,
    `Project: **${args.project.name}** (${args.project.id})`,
    `Project root: ${args.project.root}`,
    `Project brain: ${args.project.root}/.ai-brain/`,
    ``,
    `## Sub-agent role`,
    args.subagent.prompt,
    ``,
    `## Retrieved knowledge (compact — summaries only)`,
    formatCompact(args.hits),
    ``,
    `## Existing project KB outline`,
    formatOutline(args.entries),
    ``,
    `## Tools available to you`,
    `- **brain_recall(query, limit?, types?)** — compact search (summaries only) over the KB.`,
    `- **brain_get_entries(ids)** — fetch the FULL body of specific entries you need to read carefully. Use sparingly — pick from the ids in compact recall results.`,
    `- **brain_entity(name, limit?)** — look up a concept/term in the knowledge graph. Returns its definition + everything that references it, much cheaper than scanning the whole KB.`,
    `- **brain_remember(title, body, type, tags?)** — persist a durable finding. **Always include a 1-2 sentence summary at the top of body — it becomes the entry's compact-recall summary.** Pull out concrete entities (libraries, files, concepts) into the entities tag list when you can — they power the knowledge graph.`,
    ``,
    `Iron Law: prefer the cheapest tool that answers your question. Use compact recall first; only fetch full entries when the summary isn't enough. Use brain_entity when you already know the term.`,
    ``,
    `Execute the role faithfully. When in doubt, prefer to ASK rather than fabricate; surface open questions in your output. After producing your output, call brain_remember for any durable facts the role requires you to capture.`,
  ].join("\n");
}

function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: { projectRoot: string; rememberedIds: string[]; installedSubagents: string[] },
): { content: string; isError?: boolean } {
  try {
    if (toolName === "brain_remember") {
      const title = String(toolInput.title ?? "").trim();
      const body = String(toolInput.body ?? "").trim();
      const type = String(toolInput.type ?? "note") as EntryType;
      const tags = Array.isArray(toolInput.tags)
        ? (toolInput.tags as unknown[]).map((t) => String(t))
        : [];
      const summary =
        typeof toolInput.summary === "string" ? toolInput.summary : undefined;
      const entities = Array.isArray(toolInput.entities)
        ? (toolInput.entities as unknown[]).map((s) => String(s))
        : undefined;
      if (!title || !body) {
        return { content: "Error: title and body are required.", isError: true };
      }
      const entry = rememberStore({
        projectRoot: ctx.projectRoot,
        title,
        body,
        type,
        tags,
        summary,
        entities,
      });
      ctx.rememberedIds.push(entry.id);
      return {
        content: `Saved entry "${entry.title}" (id: ${entry.id}, type: ${entry.type}).`,
      };
    }
    if (toolName === "brain_recall") {
      const query = String(toolInput.query ?? "").trim();
      const limit = Number(toolInput.limit ?? 8);
      const types = Array.isArray(toolInput.types)
        ? (toolInput.types as unknown[]).map((t) => String(t) as EntryType)
        : undefined;
      if (!query) return { content: "Error: query is required.", isError: true };
      const hits = recallCompactStore({
        projectRoot: ctx.projectRoot,
        query,
        limit,
        includeGlobal: true,
        types,
      });
      return { content: formatCompact(hits) };
    }
    if (toolName === "brain_get_entries") {
      const ids = Array.isArray(toolInput.ids)
        ? (toolInput.ids as unknown[]).map((s) => String(s))
        : [];
      if (!ids.length) return { content: "Error: ids is required.", isError: true };
      const entries = getEntriesStore(ctx.projectRoot, ids);
      if (!entries.length) {
        return { content: `No entries found for ids: ${ids.join(", ")}` };
      }
      const formatted = entries
        .map(
          (e) =>
            `## ${e.title}  [${e.type}]\nid: ${e.id}\n` +
            (e.tags.length ? `tags: ${e.tags.join(", ")}\n` : "") +
            (e.entities.length ? `entities: ${e.entities.join(", ")}\n` : "") +
            `\n${e.body}`,
        )
        .join("\n\n---\n\n");
      return { content: formatted };
    }
    if (toolName === "brain_entity") {
      const name = String(toolInput.name ?? "").trim();
      const limit = Number(toolInput.limit ?? 12);
      if (!name) return { content: "Error: name is required.", isError: true };
      const card = getEntityStore(ctx.projectRoot, name, { limit, includeGlobal: true });
      const lines = [`# Entity: ${card.name}`];
      if (card.definition) {
        lines.push(`## Definition (\`${card.definition.id}\`)`);
        lines.push(card.definition.body);
      } else {
        lines.push("## Definition");
        lines.push("(no glossary entry — define with brain_remember type=glossary if useful)");
      }
      lines.push("");
      lines.push(`## Referenced by (${card.references.length} entries)`);
      lines.push(card.references.length ? formatCompact(card.references) : "(none)");
      if (card.neighbors.length) {
        lines.push("");
        lines.push("## Co-occurring entities");
        lines.push(card.neighbors.map((n) => `- ${n.entity} (×${n.weight})`).join("\n"));
      }
      return { content: lines.join("\n") };
    }
    if (toolName === "brain_install_subagent") {
      const name = String(toolInput.name ?? "").trim();
      const description = String(toolInput.description ?? "").trim();
      const prompt = String(toolInput.prompt ?? "").trim();
      const inputs = Array.isArray(toolInput.inputs)
        ? (toolInput.inputs as unknown[]).map((s) => String(s))
        : [];
      const scope = (toolInput.scope === "global" ? "global" : "project") as
        | "global"
        | "project";
      const sub = installSubagent({
        name,
        description,
        prompt,
        inputs,
        scope,
        projectRoot: scope === "project" ? ctx.projectRoot : null,
      });
      ctx.installedSubagents.push(sub.name);
      return {
        content: `Installed ${sub.scope} sub-agent **${sub.name}** at ${sub.source}.\nInvoke with: brain run ${sub.name} "<input>"`,
      };
    }
    return { content: `Error: unknown tool ${toolName}`, isError: true };
  } catch (err) {
    return { content: `Error: ${(err as Error).message}`, isError: true };
  }
}

export async function runSubagent(opts: RunOptions): Promise<RunResult> {
  const project = resolveProject(opts.projectPath);
  const subagent = getSubagent(opts.subagentName, project.root);
  if (!subagent) throw new Error(`Unknown sub-agent: ${opts.subagentName}`);
  const hits = recallCompactStore({
    projectRoot: project.root,
    query: opts.input,
    limit: 8,
  });
  const entries = listEntries(project.root);

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it or pass --api-key. (Or use the brain via an MCP-aware host like Claude Code, which provides its own model.)",
    );
  }

  const model = opts.model || DEFAULT_MODEL;
  const effort = opts.effort || DEFAULT_EFFORT;
  if (!effortIsValidFor(model, effort)) {
    throw new Error(
      `Effort "${effort}" is not valid for model "${model}". Lower to "high" or change the model.`,
    );
  }
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITER;

  const client = new Anthropic({ apiKey });

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt({ subagent, project, hits, entries }),
      cache_control: { type: "ephemeral" },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Task input from the user:\n\n${opts.input.trim()}`,
    },
  ];

  const ctx = {
    projectRoot: project.root,
    rememberedIds: [] as string[],
    installedSubagents: [] as string[],
  };

  let iterations = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations += 1;
    opts.onIteration?.(iterations);

    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      tools: TOOL_DEFS,
      thinking: { type: "adaptive" },
      output_config: { effort } as Anthropic.MessageCreateParams["output_config"],
      messages,
    });

    if (opts.onTextDelta) {
      stream.on("text", (delta: string) => opts.onTextDelta!(delta));
    }

    const message = await stream.finalMessage();

    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;
    cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;

    const lastText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (lastText) finalText = lastText;

    if (message.stop_reason !== "tool_use") {
      messages.push({ role: "assistant", content: message.content });
      break;
    }

    messages.push({ role: "assistant", content: message.content });

    const toolUseBlocks = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      toolCalls += 1;
      opts.onToolCall?.(tu.name, tu.input);
      const result = executeTool(tu.name, tu.input as Record<string, unknown>, ctx);
      opts.onToolResult?.(tu.name, result.content);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText,
    iterations,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    rememberedIds: ctx.rememberedIds,
    installedSubagents: ctx.installedSubagents,
  };
}
