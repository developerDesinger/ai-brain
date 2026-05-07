import Anthropic from "@anthropic-ai/sdk";
import {
  Entry,
  EntryType,
  RecallHit,
  listEntries,
  recall as recallStore,
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
      "Persist a durable fact into the current project's knowledge base. Call this whenever you uncover something the next session should remember: a refined requirement, a style rule the project follows, an architectural decision, a reusable pattern or snippet, a glossary term. Do NOT use it for ephemeral state, scratch notes, or things already obvious from the code.",
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
      },
      required: ["title", "body", "type"],
    },
  },
  {
    name: "brain_recall",
    description:
      "Search the project's knowledge base for additional context. Use this if the retrieved knowledge in your system prompt is thin and you suspect more is on file under a different query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query." },
        limit: { type: "integer", minimum: 1, maximum: 15 },
      },
      required: ["query"],
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

function formatHits(hits: RecallHit[]): string {
  if (!hits.length) return "(no relevant entries in the brain yet)";
  return hits
    .map(
      (h, i) =>
        `### ${i + 1}. ${h.title}  [${h.type}${h.scope === "global" ? " · global" : ""}]\n` +
        `id: ${h.id}\n` +
        (h.tags.length ? `tags: ${h.tags.join(", ")}\n` : "") +
        `\n${h.excerpt}`,
    )
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
  hits: RecallHit[];
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
    `## Retrieved knowledge`,
    formatHits(args.hits),
    ``,
    `## Existing project KB outline`,
    formatOutline(args.entries),
    ``,
    `## Tools available to you`,
    `- **brain_remember(title, body, type, tags?)** — persist a finding so it survives this session. Use only for durable facts.`,
    `- **brain_recall(query, limit?)** — search the KB if you need more context than what's above.`,
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
      if (!title || !body) {
        return { content: "Error: title and body are required.", isError: true };
      }
      const entry = rememberStore({ projectRoot: ctx.projectRoot, title, body, type, tags });
      ctx.rememberedIds.push(entry.id);
      return {
        content: `Saved entry "${entry.title}" (id: ${entry.id}, type: ${entry.type}).`,
      };
    }
    if (toolName === "brain_recall") {
      const query = String(toolInput.query ?? "").trim();
      const limit = Number(toolInput.limit ?? 8);
      if (!query) return { content: "Error: query is required.", isError: true };
      const hits = recallStore({ projectRoot: ctx.projectRoot, query, limit, includeGlobal: true });
      return { content: formatHits(hits) };
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
  const hits = recallStore({ projectRoot: project.root, query: opts.input, limit: 8 });
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
