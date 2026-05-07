# Changelog

All notable changes to this project will be documented in this file.

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
