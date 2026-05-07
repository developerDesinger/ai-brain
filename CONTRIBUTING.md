# Contributing

ai-brain is small and opinionated; contributions are welcome but please open an issue first to discuss anything beyond a typo or obvious bug.

## Development setup

```bash
git clone https://github.com/<owner>/ai-brain.git
cd ai-brain
./install.sh                       # installs deps, builds, and links `brain` globally
```

Source lives in [core/src/](core/src/). After edits:

```bash
cd core && npm run build
```

The CLI re-link happens automatically through the `npm link` from `install.sh` — your edits are picked up by the next invocation.

## Layout

- `core/src/` — TypeScript: MCP server, CLI, runner, storage, sub-agents, learn pipeline.
- `core/subagents/` — built-in sub-agent prompts (markdown with frontmatter).
- `bridges/` — rule-file templates that get materialised into projects by `brain init`.

## Adding a sub-agent

Drop a markdown file into `core/subagents/<name>.md` with this frontmatter:

```yaml
---
name: my-subagent
description: One-sentence summary shown in lists.
inputs:
  - input_name
---

You are the **My Sub-Agent** sub-agent.

Goal: ...

Process:
1. ...

Output format: ...

After producing the output: call brain_remember for any durable facts.
```

Mirror the structure of the built-in five (see [requirement-refiner.md](core/subagents/requirement-refiner.md)).

## Adding a bridge for a new AI tool

1. Add a template under `bridges/<tool>.tmpl`.
2. Add an entry to the `TARGETS` array in [core/src/sync.ts](core/src/sync.ts).
3. Update the README's compatibility table.

## Code style

The codebase is small and unopinionated; new code should match what's already there. No external linters; the TS compiler is the only gate.
