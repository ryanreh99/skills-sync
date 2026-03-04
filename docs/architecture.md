# Architecture

## Design Principle
- Internal model is stable.
- External agent contracts are volatile.
- Adapters are thin and mechanical.

This repo keeps one canonical build artifact and projects to per-agent runtime shapes.

## Pipeline
1. Inputs in `workspace/`
2. `build` creates canonical bundle + projections in `dist/`
3. `apply` binds skills dirs and merges managed MCP entries into runtime targets
4. `unlink` reverses managed bindings/entries

## Canonical Artifact
`~/.skills-sync/internal/common/` is the source of truth:
- `bundle.json`
- `skills/`
- `mcp.json`

## Projections
Built from `common`:
- `dist/common/skills`, `dist/common/mcp.json`
- `dist/.codex/*`, `dist/.claude/*`, `dist/.cursor/*`, `dist/.copilot/*`, `dist/.gemini/*`

## Internal Modules
- Bundle builder: `internal/scripts/lib/bundle.mjs`
- Build orchestration: `internal/scripts/lib/build.mjs`
- Adapters:
  - `internal/scripts/lib/adapters/codex.mjs`
  - `internal/scripts/lib/adapters/claude.mjs`
  - `internal/scripts/lib/adapters/cursor.mjs`
  - `internal/scripts/lib/adapters/copilot.mjs`
  - `internal/scripts/lib/adapters/gemini.mjs`
  - `internal/scripts/lib/adapters/common.mjs`
- Binding/apply/unlink: `internal/scripts/lib/bindings.mjs`
- MCP managed merge: `internal/scripts/lib/mcp-config.mjs`
- Validation: `internal/scripts/lib/doctor.mjs`

## Runtime Write Policy
- Skills: linked (Windows junction/symlink, macOS symlink).
- MCP: merged under managed namespace `skills-sync__*`.
- Unmanaged entries are preserved.

## Link Behavior
- Windows directories: junction, symlink fallback
- Windows files: hardlink, copy fallback
- macOS: symlink

## Scope Defaults
- Apply targets user-level locations by default.
- Path contracts and verification notes live in:
  - [agent-storage-map.md](agent-storage-map.md)

## AI Contexts

`skills-sync` builds one canonical bundle and projects it to each agent runtime contract.

Canonical source:
- `~/.skills-sync/internal/common/skills`
- `~/.skills-sync/internal/common/mcp.json`
- `~/.skills-sync/internal/common/bundle.json`

### Codex
- Projection:
  - `dist/.codex/skills`
  - `dist/.codex/vendor_imports/skills`
  - `dist/.codex/config.toml`
- Apply:
  - skills dir binding
  - managed MCP block in user config TOML (`skills-sync__*`)

### Claude Code
- Projection:
  - `dist/.claude/skills`
  - `dist/.claude/mcp.json`
- Apply:
  - skills dir binding
  - managed MCP JSON entries under `mcpServers.skills-sync__*`

### Cursor
- Projection:
  - `dist/.cursor/skills` (includes top-level `vendor__*` aliases for discoverability)
  - `dist/.cursor/mcp.json`
- Apply:
  - skills dir binding
  - managed MCP JSON entries under `mcpServers.skills-sync__*`
- Cursor skills docs note native + compatibility discovery paths:
  - `.agents/skills`, `.cursor/skills`, `~/.agents/skills`, `~/.cursor/skills`
  - `.claude/skills`, `.codex/skills`, `~/.claude/skills`, `~/.codex/skills`

### Copilot
- Projection:
  - `dist/.copilot/skills` (includes top-level `vendor__*` aliases for discoverability)
  - `dist/.copilot/mcp-config.json`
- Apply:
  - skills dir binding
  - managed MCP JSON entries under `mcpServers.skills-sync__*`

### Gemini CLI
- Projection:
  - `dist/.gemini/skills` (includes top-level `vendor__*` aliases for discoverability)
  - `dist/.gemini/vendor_imports/skills`
  - `dist/.gemini/settings.json`
- Apply:
  - skills dir binding
  - managed MCP JSON entries under `mcpServers.skills-sync__*`
  - aliases are required because Gemini skill discovery is path-local (`SKILL.md` or `*/SKILL.md`)

## Important Behavior
- `build` regenerates all dist artifacts.
- During `build`, MCP projection policy is controlled by `canOverride` in target manifests:
  - `true`: projection can be regenerated from canonical MCP
  - `false`: projection is seeded from local config and MCP sections are updated in place
- `apply` consumes existing dist artifacts and updates runtime targets.
- `doctor` validates bundle, projections, state, and managed MCP presence.
