# Changelog

All notable changes to this project will be documented in this file.

## 0.4.0 — AST-based extraction + service templates

The code indexer can now use real ASTs instead of regex, and `brain watch` ships
with launchd / systemd templates so it can run as a managed background service
that survives reboots.

**Tree-sitter AST extractor (optional, falls back to regex)**

- New `core/src/ast-extract.ts` — lazy-loads tree-sitter and per-language
  grammars, walks the AST, and returns structurally accurate function /
  class / interface / type / method names. Supported extensions: `.ts`,
  `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.rb`, `.cs`.
- Tree-sitter and grammars are listed under `optionalDependencies`. If they
  install successfully (requires a C toolchain on most platforms; macOS and
  most Linux distros are fine), the AST path is used automatically. If any
  fail to compile, that language quietly falls back to the existing regex
  pass — `brain refresh` and `brain watch` keep working exactly as before.
- AST output is **authoritative when it succeeds** — the heuristic / regex
  pass is skipped for that file. This eliminates false positives from
  identifiers that appear inside comments, docstrings, or string literals
  (verified on a fixture: `// function fakeFn() {}` no longer pollutes the
  index, while `realMethod()` nested inside a class is correctly captured).
- New `brain doctor` command surfaces tree-sitter / grammar availability
  per extension so users can see which path is in use.

**`brain service` — managed background watcher**

- `service-templates/launchd.plist.tmpl` (macOS) and
  `service-templates/systemd.service.tmpl` (Linux) ship in the package and
  are rendered per project on demand.
- `brain service render [path]` — print the rendered service file to stdout
  (no side effects).
- `brain service install [path] [--load] [--debounce MS]` — write the
  service file under `~/Library/LaunchAgents/` (macOS) or
  `~/.config/systemd/user/` (Linux). Default writes the file and prints
  load instructions; pass `--load` to also bootstrap / enable + start
  immediately.
- `brain service status [path]` — best-effort probe via `launchctl print`
  or `systemctl --user status`.
- `brain service uninstall [path]` — bootout / disable + remove the file.
- Service identifiers derive from the project's stable ID, so multiple
  projects coexist cleanly under the user agent.
- Logs land in `~/.ai-brain/logs/<label>.{out,err}.log`; the watcher runs
  with `Nice 5` / `LowPriorityIO` (launchd) or `IOSchedulingClass=idle`
  (systemd) so it never competes with your editor.

## 0.3.0 — Continuous auto-learning + MCP migration

The brain now learns from the codebase **continuously and automatically**, without API calls. Plus the MCP layer migrated to the modern `registerTool` API.

**New: token-free code indexer**

- `brain refresh [path]` — one-shot scan: walks source files, extracts entities (function names, classes, identifiers, terms) using language-aware heuristics + the existing entity extractor, stores them in a per-project `code_entities` table. Skips `node_modules/`, `.git/`, `dist/`, build artefacts, etc. Caps files at 256KB. ~13ms for a small project.
- `brain watch [path] [--debounce MS] [--quiet]` — continuous: full scan on startup, then incremental updates as files change (powered by [chokidar](https://github.com/paulmillr/chokidar) with `awaitWriteFinish` so partial writes don't trigger re-indexing). Debounced (default 1s) to coalesce bursts like `git checkout`. Foreground; Ctrl-C to stop.
- `brain code <query> [--limit N]` — search the code-entity index. Returns files where any query token appears as an identifier, ranked by hit count. Token-free.

**Knowledge-graph integration**

- `brain entity <name>` and the MCP `brain_entity` tool now include a **"Found in N source files"** section listing every code path where the entity appears. The graph fuses curated KB entries with the auto-indexed code so "what do we know about JWT?" returns both decisions/glossary entries AND the files where JWT logic lives.
- New MCP tool `brain_code_search` for code-only queries.
- New MCP tool `brain_refresh_code_index` for triggering a one-shot scan from inside an AI agent session.

**MCP SDK migration**

- All 12 tools migrated from the deprecated `server.tool(name, desc, schema, cb)` to `server.registerTool(name, {description, inputSchema}, cb)`. No behaviour change; clears v0.2's deprecation hints; keeps us aligned with `@modelcontextprotocol/sdk` ≥ 1.29.

**How auto-learning composes**

- `brain watch` keeps the code index fresh — token-free, fast, runs in a separate terminal or as a long-lived process.
- `brain learn` (manual) still feeds raw client requirements + code into the KB via Anthropic API for rich, structured findings.
- `brain remember` (manual) still works for explicit decisions / patterns / glossary entries.
- The two layers are complementary: the watcher knows *where things are*; the KB knows *why they exist and what rules apply*.

## 0.2.0 — Knowledge graph

Adds a knowledge-graph layer on top of the markdown KB so agents can retrieve
by entity instead of always scanning text, and choose between cheap (compact)
and expensive (full) retrieval explicitly.

**New**

- `summary` and `entities` fields on every `Entry` (auto-extracted from body
  on `brain_remember`; users and sub-agents can also pass them explicitly).
  Conservative heuristic extraction picks up backticked identifiers, ALL_CAPS
  / SNAKE_CASE, PascalCase / camelCase, and multi-word TitleCase phrases.
- `entity_refs(entry_id, entity)` SQLite table for graph traversal; FTS5
  index gains an `entities` column so entity names surface entries that
  reference them.
- **MCP tools:**
  - `brain_recall` now defaults to compact mode (id + title + type + tags +
    entities + 1-2 sentence summary, no body). Pass `mode: "full"` for body
    excerpts. New optional `types` filter restricts to specific entry types.
  - `brain_get_entries(ids)` — bulk fetch full bodies by ID. Use after
    `brain_recall` when you've decided which specific entries you need.
  - `brain_entity(name)` — returns the glossary definition (if any), every
    entry that references the entity (compact summaries), and the 1-hop
    neighborhood of co-occurring entities. Replaces keyword scans for
    entity-centric questions.
  - `brain_remember` accepts `summary` and `entities` parameters.
- **CLI:**
  - `brain entity <name>` — same as the MCP tool above.
  - `brain entries <id1> [id2 …]` — bulk fetch full bodies.
  - `brain recall` defaults to compact; pass `--full` for body excerpts.
    `--types t1,t2` filters by entry type.
  - `brain rebuild --refresh-entities` — retrofits existing entries with
    auto-extracted entities + summaries (writes back to markdown frontmatter).
- **Runner / sub-agents:**
  - All five built-in sub-agents updated to populate `summary` and `entities`
    when calling `brain_remember`.
  - Runner system prompt now uses compact recall and exposes the three new
    tools to the model with explicit "use the cheapest tool that answers your
    question" guidance.

**What this actually saves**

The win is **bounded retrieval cost** and **entity-based traversal**, not
universally smaller responses:

- Summary length is capped (~160 chars) regardless of body size, so very long
  bodies (compliance specs, requirement docs) no longer blow up recall context.
- `brain_entity` returns a structured neighborhood for one term — replaces a
  full-text scan + manual cross-referencing.
- The agent now has explicit control: it sees compact summaries first, picks
  selectively, and pulls full bodies via `brain_get_entries` only when needed.
- Entries persisted via `brain_remember` always get auto-extracted entities,
  so the graph populates itself as the brain grows.

For short bodies, FTS5's 16-word snippet (full mode) is still denser than a
160-char summary. Use `--full` when that matters and `brain_entity` when you
already know the term.

## 0.1.0 — initial public release

- Project-local knowledge base at `<project>/.ai-brain/` (markdown KB + SQLite FTS5 index, travels with git).
- Auto-discovery of `.ai-brain/` by walking up from cwd, like `git`.
- Engine vs data path split: engine auto-detected from binary location; user data defaults to `~/.ai-brain/` (override with `AI_BRAIN_HOME`).
- MCP server with eight tools: `brain_recall`, `brain_remember`, `brain_project_summary`, `brain_list_projects`, `brain_list_subagents`, `brain_invoke_subagent`, `brain_sync_bridges`, `brain_rebuild_index`.
- Five built-in sub-agents: `requirement-refiner`, `style-learner`, `code-generator`, `knowledge-curator`, `skill-forger` (the meta-agent that authors new project-specific sub-agents).
- Bridge files for Claude Code (`CLAUDE.md`), Codex CLI (`AGENTS.md`), Cursor (`.cursorrules`), GitHub Copilot (`.github/copilot-instructions.md`), Kiro (`.kiro/steering/ai-brain.md`), Windsurf (`.windsurfrules`), Aider (`CONVENTIONS.md`).
- Mandatory **Iron Law** + **Five Mandatory Steps** in every bridge file.
- `brain learn` — feed code, a directory, a doc, or raw text; the brain extracts knowledge into `.ai-brain/kb/`.
- `brain run` — standalone runner that calls Anthropic API directly with adaptive thinking, prompt caching, and `xhigh` effort by default.
- `brain export` — single-markdown KB dump for tools without bridges.
