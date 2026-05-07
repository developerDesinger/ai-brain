# ai-brain

> A project-local AI knowledge brain that **learns from your codebase and your client's raw requirements** — and binds every coding agent that touches your project (Claude Code, Cursor, Codex CLI, Kiro, GitHub Copilot, Windsurf, Aider, …) to follow it.

[![CI](https://github.com/developerDesinger/ai-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/developerDesinger/ai-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

The brain lives at `<your-project>/.ai-brain/`. Knowledge entries are markdown files committed to git, so the brain travels with the project and grows alongside it. Every initialized project gets a set of bridge files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, etc.) carrying a strict, mandatory operating contract — so any AI agent the project meets reads from the same source of truth.

---

## What it does, in one paragraph

Tell `brain learn` about your project — point it at source files, paste in a vague client email, drop a requirements doc — and it analyses the input with the right specialist sub-agent (`style-learner` for code, `requirement-refiner` for prose), then **persists the durable findings as markdown KB entries inside `<project>/.ai-brain/kb/`**. Each entry carries a 1-2 sentence summary plus auto-extracted entities (libraries, files, concepts, terms), populating a lightweight knowledge graph the agent can query instead of always scanning text. Next time any AI coding agent works on that project, it reads the brain first, obeys the rules it finds, and adds new findings of its own. As patterns recur, the meta-agent `skill-forger` authors brand-new project-specific sub-agents into `.ai-brain/subagents/` — the brain literally grows new skills as your project grows.

---

## Quickstart (3 commands)

```bash
# 1. Install the engine (one-time per machine)
git clone https://github.com/developerDesinger/ai-brain.git
cd ai-brain && ./install.sh

# 2. Initialize the brain inside your project
cd /path/to/your/project
brain init                           # creates .ai-brain/ + bridge files for every supported AI tool

# 3. Teach it
export ANTHROPIC_API_KEY=sk-ant-...
brain learn ./src                                       # learn the project's style from existing code
brain learn ./client-email.txt                          # learn from a vague requirements doc
brain learn "Users want filtering by date and team"     # learn from raw text
```

That's it. Now every AI coding agent in this project — Claude Code, Cursor, Codex CLI, Kiro, Copilot, Windsurf, Aider — reads from `.ai-brain/` and obeys the contract in `CLAUDE.md` / `AGENTS.md` / etc.

---

## The headline workflow: `brain learn`

`brain learn` is the entry point for **everything you want the agent to know**.

```bash
# Learn from project code → produces a project-specific style guide
brain learn ./src
brain learn ./src/auth/                        # narrower scope
brain learn ./service.ts                       # a single file

# Learn from raw client requirements → produces a structured, testable spec
brain learn ./brief.md
brain learn ./client-email.txt
echo "We need a dashboard that shows..." | brain learn
brain learn "Users want filtering by date and team"

# Override auto-detection if needed
brain learn ./README.md --type requirements
brain learn ./snippet.ts --type code
```

Under the hood:

- **Auto-detect:** directory or code file → `style-learner`. `.md` / `.txt` / raw string → `requirement-refiner`.
- **Stream the analysis** to your terminal as the model thinks.
- **Persist findings** as markdown files in `<project>/.ai-brain/kb/` via `brain_remember`. One entry per finding, structured by type (`requirement`, `style`, `pattern`, `decision`, `snippet`, `glossary`, `note`).
- **Defaults:** Claude Opus 4.7 with adaptive thinking and `xhigh` effort (best for analysis tasks). Override with `--model`, `--effort`, or env vars (`BRAIN_MODEL`, `BRAIN_EFFORT`).

Re-run `brain learn` whenever you have new client input or open a new area of code. The KB grows, and every AI agent sees the new entries on its next call.

---

## The Iron Law

`brain init` writes seven bridge files into the project. Every one of them carries this:

> **Every line of code you produce or modify in this project must be traceable to the project's brain** — to an existing knowledge entry, to one you created via `brain_remember` in the same session, or to an explicit user statement. If your output cannot be justified by the brain, do not write it.

…followed by **the Five Mandatory Steps**: RECALL → MATCH (project, not generic best practices) → NO undocumented deviations → CAPTURE durable findings → GROW skills when patterns recur.

Agents that follow instructions well (Claude Code, Cursor, Kiro, Codex CLI) will obey. Agents with weaker instruction-following (some Copilot scenarios) will partially comply. The bridge file is the strongest cross-vendor enforcement mechanism that exists today.

---

## Tool compatibility

| AI agent                | Auto-reads bridge file               | MCP support | Setup                                                                                               |
| ----------------------- | ------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------- |
| **Claude Code**         | `CLAUDE.md`                          | ✅           | `claude mcp add ai-brain -s user -- node <engine>/core/dist/mcp.js`                                  |
| **Codex CLI** (OpenAI)  | `AGENTS.md`                          | —           | Zero-config; reads `AGENTS.md` automatically                                                        |
| **Cursor**              | `.cursorrules`                       | ✅           | Settings → MCP → add `ai-brain`, command `node`, args `["<engine>/core/dist/mcp.js"]`                |
| **Kiro**                | `.kiro/steering/ai-brain.md`         | ✅           | `.kiro/settings/mcp.json` → add `ai-brain` with the same command                                    |
| **GitHub Copilot**      | `.github/copilot-instructions.md`    | —           | Refresh with `brain sync <project>` after meaningful KB updates                                     |
| **Windsurf** (Codeium)  | `.windsurfrules`                     | —           | Auto-detected                                                                                       |
| **Aider**               | `CONVENTIONS.md`                     | —           | Add `read: CONVENTIONS.md` to `.aider.conf.yml`                                                     |
| **Anything else**       | — (use `brain export`)               | —           | `brain export <project> > snapshot.md` → paste into the tool's prompt                                |

The brain auto-discovers `.ai-brain/` by walking up from cwd (like `git`), so MCP-enabled agents don't need to be told the project path.

---

## Built-in sub-agents

Five specialists ship in [core/subagents/](core/subagents/):

| Sub-agent              | When to use it                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `requirement-refiner`  | Vague client ask → structured, testable requirement (acceptance tests, open questions, tags).   |
| `style-learner`        | Existing source files → the project's *actual* style guide with concrete file:line evidence.    |
| `code-generator`       | Task description → code that conforms to the project's KB (style, decisions, patterns).         |
| `knowledge-curator`    | Reviews the KB for duplicates, contradictions, staleness, and gaps.                             |
| `skill-forger`         | **Authors brand-new project-specific sub-agents** when a recurring need none of the others fit. |

When the same task keeps coming up — release notes in your house format, migration reviews, a particular kind of compliance check — invoke `skill-forger`:

```bash
brain run skill-forger "we keep needing release notes that follow our internal format"
# → skill-forger reads the KB, authors a release-notes-writer prompt,
#   installs it at .ai-brain/subagents/release-notes-writer.md (committed to git)

brain run release-notes-writer "v2.4 — billing flow + 2 SSO fixes"
# → uses the new sub-agent, persists findings to the KB
```

Project sub-agents take precedence over global ones with the same name, so each project gets its own specialised brain on top of the universal five.

---

## Two ways to run sub-agents

### 1. Through your AI coding agent (free; no API key)

Inside Claude Code / Cursor / Kiro, the brain is exposed as MCP tools. The host agent runs the LLM; the brain ships prompts + retrieved KB.

- `brain_recall(query, mode?, types?, limit?)` — search project + global KB. Defaults to compact mode (summaries only, bounded cost).
- `brain_get_entries(ids)` — fetch full body of specific entries by ID after recall.
- `brain_entity(name)` — knowledge-graph query: definition + references + 1-hop neighbors.
- `brain_remember(title, body, type, tags?, summary?, entities?)` — persist. Always include `summary` and `entities` for the graph.
- `brain_project_summary()` — load full project KB outline at session start.
- `brain_invoke_subagent(name, input)` — `requirement-refiner` / `style-learner` / `code-generator` / `knowledge-curator` / `skill-forger` + project-grown sub-agents.
- `brain_list_subagents()`, `brain_list_projects()`, `brain_sync_bridges()`, `brain_rebuild_index()`

### 2. Direct via Anthropic API (`brain learn` / `brain run`; needs `ANTHROPIC_API_KEY`)

Use when you want to invoke a sub-agent without going through a host agent. Streams tokens to stdout, lets the model autonomously call `brain_remember` / `brain_recall` / `brain_install_subagent`. Defaults to Claude Opus 4.7 with adaptive thinking and `xhigh` effort.

```bash
brain learn ./src                          # → style-learner
brain learn ./brief.md                     # → requirement-refiner
brain run code-generator "task..."         # any sub-agent by name
brain run knowledge-curator                # audit the KB
```

---

## Knowledge graph & token-aware retrieval (v0.2)

Every entry stores a **1-2 sentence summary** and a list of **entities** (libraries, files, concepts, terms). Entities are auto-extracted from titles and bodies (backticked identifiers, ALL_CAPS, PascalCase, TitleCase phrases) and merged with anything the user or a sub-agent passes explicitly. They power the graph.

Three retrieval modes the agent (or you) can pick from:

- **Compact recall** (default) — `brain_recall(query)` returns id + title + type + tags + entities + summary. **Bounded cost** regardless of body size; ideal when entries are long.
- **Full recall** — `brain_recall(query, mode="full")` or `brain recall --full` adds FTS5 body excerpts (denser per hit for short bodies; the right choice when summaries don't carry enough signal).
- **Entity lookup** — `brain_entity(name)` returns the glossary definition (if any), every entry that mentions the entity, and the 1-hop neighborhood of co-occurring entities. Replaces "recall + read 5 entries to figure out what JWT means here."

The agent can then `brain_get_entries(ids)` to pull only the specific full bodies it needs, instead of paying for everyone's at once.

```bash
# Compact recall — bounded summary per hit
brain recall "auth flow"

# Full recall when you need body excerpts
brain recall "auth flow" --full

# Filter by entry type before searching
brain recall "rate limit" --types decision,style

# Entity lookup — graph query
brain entity JWT

# Pull a specific entry's full body
brain entries auth-uses-jwt-a742f3

# Backfill entities + summaries on existing entries
brain rebuild --refresh-entities
```

## CLI reference

```text
brain init [path]                                   create .ai-brain/ + write bridges into a project
brain learn <input> [--type code|requirements|auto] [--path P]
                                                    learn from code, files, dirs, or raw text
brain sync [path] [--force]                         re-write bridge files into a project
brain list                                          list known projects
brain show [path]                                   print all KB entries for a project
brain export [path]                                 dump entire KB as a single markdown blob
brain recall <query...> [--path P] [--limit N] [--full] [--types t1,t2]
                                                    search KB; defaults to compact (summary only)
brain entries <id1> [id2 …] [--path P]             fetch full body for specific entries
brain entity <name> [--path P] [--limit N]         look up a knowledge-graph entity
brain remember --title T --body B [--type X] [--tags a,b] [--scope project|global] [--path P]
                                                    add a KB entry manually
brain forget <id>                                   remove a KB entry
brain rebuild [--refresh-entities]                  rebuild FTS5 index; --refresh-entities re-extracts
                                                    entities + summaries on disk
brain agents [--path P] [--global-only]            list sub-agents (global + project)
brain run <subagent> [input...] [--path P] [--model M] [--effort E]
                                                    run a sub-agent directly via Anthropic API
brain status                                        engine + data paths + counts
brain version                                       print version
```

Entry types: `requirement`, `style`, `pattern`, `decision`, `snippet`, `glossary`, `note`.

---

## Layout

```
# Engine — installed once per machine (this repo)
ai-brain/
├── core/                      ← TypeScript source + built CLI/MCP
│   ├── src/
│   ├── subagents/             ← built-in sub-agent prompts (5)
│   └── package.json
├── bridges/                   ← rule-file templates per AI agent (7)
├── install.sh                 ← installs deps, builds, npm-links the CLI
├── README.md
└── LICENSE

# Project brain — lives in YOUR project, travels via git
<your-project>/
├── .ai-brain/
│   ├── config.json
│   ├── kb/                    ← knowledge entries (commit to git)
│   │   ├── api-style-abc123.md
│   │   ├── auth-decision-def456.md
│   │   └── ...
│   ├── subagents/             ← project-grown sub-agents (commit to git)
│   │   └── release-notes-writer.md
│   ├── index.sqlite           ← FTS5 index (gitignored, regenerable)
│   └── .gitignore
├── CLAUDE.md / AGENTS.md / .cursorrules / .windsurfrules / CONVENTIONS.md
├── .github/copilot-instructions.md
├── .kiro/steering/ai-brain.md
└── ... (your source)
```

---

## Configuration

| Env var                   | Default                          | Purpose                                                              |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | —                                | Required for `brain learn` and `brain run`. Not needed for MCP mode. |
| `AI_BRAIN_HOME`           | `~/.ai-brain`                    | Where global KB and the project registry live                        |
| `AI_BRAIN_ENGINE_HOME`    | auto-detect from binary location | Where the engine code + templates + built-in sub-agents live         |
| `BRAIN_MODEL`             | `claude-opus-4-7`                | Default Anthropic model for `brain learn` / `brain run`              |
| `BRAIN_EFFORT`            | `xhigh`                          | Default effort: `low`/`medium`/`high`/`xhigh`/`max`                  |

---

## Why this design

- **Brain lives in each project, engine lives once.** Knowledge — KB, sub-agents, decisions — is at `<project>/.ai-brain/` and commits to git, so it travels with the repo and shows up in PRs. The engine (CLI + MCP server) stays at one shared install.
- **Strict, portable contract.** Every bridge file carries the same Iron Law and Five Mandatory Steps in mandatory language. Strongest cross-vendor enforcement that's portable across MCP-aware and rule-file-only AI tools.
- **Skills grow with the project.** Built-in sub-agents handle universal cases; `skill-forger` adds project-specific ones into `.ai-brain/subagents/` (committed, shared across team).
- **Passive brain by default.** MCP mode runs no inference. Zero API keys. Standalone runner is opt-in.
- **Markdown + SQLite FTS5.** Human-readable storage, inspectable in any editor; fast full-text search. The markdown lives in git; the SQLite index is regenerable and gitignored.

---

## Development

```bash
git clone https://github.com/developerDesinger/ai-brain.git
cd ai-brain && ./install.sh

# Edit code in core/src/, then rebuild:
cd core && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding sub-agents, bridges, or new tool support.

---

## License

[MIT](LICENSE) © ai-brain contributors
