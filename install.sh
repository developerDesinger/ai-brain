#!/usr/bin/env bash
set -euo pipefail

# Resolve script location even when invoked from elsewhere or via symlink.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$SCRIPT_DIR"
CORE_DIR="$ENGINE_HOME/core"

if [ ! -d "$CORE_DIR" ]; then
  echo "ai-brain: core/ not found at $CORE_DIR" >&2
  echo "Run this script from inside the ai-brain repo." >&2
  exit 1
fi

# --- Pre-flight checks ---
if ! command -v node >/dev/null 2>&1; then
  echo "ai-brain: 'node' is not on PATH. Install Node.js >= 20 and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ai-brain: Node.js >= 20 is required (you have $(node -v))." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ai-brain: 'npm' is not on PATH." >&2
  exit 1
fi

echo "==> Engine home: $ENGINE_HOME"
echo "==> Installing dependencies"
cd "$CORE_DIR"
npm install --no-audit --no-fund

echo "==> Building"
npm run build

echo "==> Linking 'brain' CLI globally"
npm link

echo
echo "✅  Installed."
echo
echo "Quick start:"
echo "  brain status                          # paths + counts"
echo "  cd /path/to/your/project && brain init"
echo "  brain learn ./src                     # learn the project's style (needs ANTHROPIC_API_KEY)"
echo
echo "Wire into AI coding agents (one-time per machine):"
echo "  Claude Code:  claude mcp add ai-brain -s user -- node $CORE_DIR/dist/mcp.js"
echo "  Cursor:       Settings → MCP → add 'ai-brain', command: node, args: [\"$CORE_DIR/dist/mcp.js\"]"
echo "  Kiro:         .kiro/settings/mcp.json → add 'ai-brain' with the same command"
echo "  Codex CLI:    reads AGENTS.md automatically; no MCP wiring needed"
echo "  Copilot:      reads .github/copilot-instructions.md (refresh with 'brain sync')"
echo "  Windsurf:     reads .windsurfrules"
echo "  Aider:        add 'read: CONVENTIONS.md' to .aider.conf.yml"
echo
echo "User data lives at \${AI_BRAIN_HOME:-~/.ai-brain}/. Override with AI_BRAIN_HOME if desired."
