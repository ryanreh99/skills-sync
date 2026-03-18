# Agent Storage Map (Validated)

This document records the current source-of-truth findings for runtime storage and config behavior for:
- Codex CLI (OpenAI)
- Claude Code (Anthropic)
- Cursor
- Gemini CLI

If a field is not clearly documented in official docs, it is marked **UNVERIFIED** and `skills-sync` uses a conservative default.

## Codex CLI (OpenAI)

### Config and MCP
- User config: `~/.codex/config.toml` (Windows equivalent: `%USERPROFILE%\\.codex\\config.toml`)
- Project config: `.codex/config.toml` (project-scoped config)
- MCP schema: TOML tables under `[mcp_servers.<name>]` with keys like:
  - `transport`
  - `command`, `args`, `env`, `env_vars`, `cwd` (stdio)
  - `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers` (HTTP)

### Skills / discovery
- Codex skills docs describe discovery from `.agents/skills` and other scopes.
- `SKILL.md`-based folders are supported.

### Precedence and env vars
- Docs show user + project config and per-run overrides (`-c/--config`).
- `CODEX_HOME` controls Codex home location.

### Stability
- MCP and skills are documented as first-class features (treated as stable for this repo).

### Sources
- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/skills

---

## Claude Code (Anthropic)

### Config and MCP
- Settings files:
  - User: `~/.claude/settings.json`
  - Project: `.claude/settings.json`
  - Local project override: `.claude/settings.local.json`
- MCP config locations documented as:
  - Local/user scope: `~/.claude.json`
  - Project scope: `.mcp.json`
  - Managed/admin scope: system-wide `managed-mcp.json`
  - The documented `.mcp.json` / `managed-mcp.json` examples use `mcpServers` entries with Claude-style `type` values like `http` and `stdio`.

### Skills / sub-agents discovery
- Sub-agents:
  - User: `~/.claude/agents/`
  - Project: `.claude/agents/`
- `~/.claude/skills` / `.claude/skills` are **UNVERIFIED** in Anthropic docs.
  - This repo uses `.claude/skills` as a conservative compatibility path.
  - Because this path is undocumented, `skills-sync` treats skill discovery conservatively as top-level only and projects flat aliases for nested skill namespaces.

### Precedence and env vars
- Settings precedence is documented (managed > user/project tiers).
- `CLAUDE_CONFIG_DIR` is documented for config/data location control.

### Stability
- Claude settings + MCP are documented.
- Sub-agents are documented as primary feature.
- Plugin marketplaces can also bundle MCP servers, but that is a separate plugin-installation path from user/project MCP config files.

### Sources
- https://docs.anthropic.com/en/docs/claude-code/settings
- https://docs.anthropic.com/en/docs/claude-code/mcp
- https://docs.anthropic.com/en/docs/claude-code/sub-agents

---

## Cursor

### Config and MCP
- MCP config:
  - User: `~/.cursor/mcp.json`
  - Project: `.cursor/mcp.json`
- MCP schema uses JSON `mcpServers` objects with keys like `command`, `args`, `env`.

### Skills / discovery
- Cursor-native locations:
  - `.agents/skills/`
  - `.cursor/skills/`
  - `~/.agents/skills/`
  - `~/.cursor/skills/`
- Compatibility loading (officially documented):
  - `.claude/skills/`
  - `.codex/skills/`
  - `~/.claude/skills/`
  - `~/.codex/skills/`
- Discovery is **top-level only** (same constraint as Gemini). Nested skill namespaces require flat aliases at the skills directory root for reliable detection.

### Precedence and env vars
- Project vs global MCP files are documented.
- Cursor CLI config has documented envs:
  - `CURSOR_CONFIG_DIR`
  - `XDG_CONFIG_HOME` (Linux/BSD)
- MCP-specific env-override variable for config file location is **UNVERIFIED**.

### Stability
- MCP and skills pages are official docs pages.

### Sources
- https://cursor.com/docs/context/mcp
- https://cursor.com/docs/context/skills
- https://cursor.com/docs/context/rules
- https://cursor.com/docs/cli/reference/configuration

---

## GitHub Copilot

### Config and MCP
- MCP config:
  - User: `~/.copilot/mcp-config.json`
- Copilot MCP server entries are JSON objects keyed under `mcpServers`.
- Current docs show:
  - local/stdio servers use keys like `type`, `command`, `args`, `env`, `tools`
  - remote servers use keys like `type`, `url`, `headers`, `tools`
- `skills-sync` projects command-based servers to `type: "stdio"` and URL-based servers to `type: "http"` by default unless the input manifest explicitly marks them as `sse`.

### Skills / discovery
- Project and user skill directories are supported via `.copilot/skills` and `~/.copilot/skills`.
- Top-level aliases improve discoverability for nested imported skills.

### Precedence and env vars
- The MCP config file location is documented.
- Additional override/env behavior is still treated conservatively unless explicitly documented.

### Stability
- MCP support is documented and actively evolving; the Copilot adapter should be treated as a projection layer over a volatile external contract.

### Sources
- https://docs.github.com/copilot/customizing-copilot/extending-copilot-chat-with-mcp
- https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot

---

## Gemini CLI (Google)

### Config and MCP
- Settings files:
  - User: `~/.gemini/settings.json`
  - Project: `.gemini/settings.json`
- MCP config lives in `settings.json` under:
  - `mcpServers` (server definitions)
  - `mcp` (global MCP behavior settings)

### Skills / sub-agents discovery
- Skills discovery:
  - `.gemini/skills/` and alias `.agents/skills/` (project)
  - `~/.gemini/skills/` and alias `~/.agents/skills/` (user)
  - discovery is path-local (`SKILL.md` or `*/SKILL.md`), so nested namespace trees require flatten/aliasing for reliable detection.
  - documented precedence includes workspace over user over extension.
- Custom agents/subagents:
  - docs show `.gemini/agents/*.md` and `~/.gemini/agents/*.md`
  - subagents are explicitly marked experimental.

### Precedence and env vars
- Settings precedence is explicitly documented.
- `GEMINI_CLI_HOME` controls user config/storage root.

### Stability
- Settings/MCP/skills are documented.
- Subagents/agent-mode area includes experimental labeling.

### Sources
- https://geminicli.com/docs/reference/configuration
- https://geminicli.com/docs/tools/mcp-server/
- https://geminicli.com/docs/cli/skills/
- https://geminicli.com/docs/core/subagents/

---

## Conservative defaults used by this repo

- `sync` manages **user-level targets only** by default.
- Claude, Cursor, Copilot, and Gemini use flat alias projection for nested skill paths — skills are projected under `~/.skills-sync/internal/.<agent>/skills` with `vendor__*` aliases when needed, then bound to the agent runtime skills directory during sync.
- When schema/path behavior is ambiguous, docs are preserved in this file and implementation avoids destructive assumptions.
