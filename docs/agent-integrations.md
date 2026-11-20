# Agent Integrations

Agent support is defined by one JSON file per agent in `src/assets/integrations/agents/`.
Those files are the only authored source of truth for agent metadata, runtime projection paths, target paths, and compatibility metadata.

The authored shape is grouped into five sections:

- `config`: skills-sync runtime behavior
- `skills`: skill paths, binding, and optional skill feature support
- `commands`: custom command paths, rendering kind, and command capability support
- `mcp`: MCP paths, config behavior, and MCP capability support
- `hooks`: hook config paths, rendering kind, and hook capability support

## Example

```json
{
  "id": "cursor",
  "name": "Cursor",
  "config": {
    "order": 30,
    "adapter": "cursor",
    "projectionVersion": 1
  },
  "skills": {
    "internalDir": ".cursor/skills",
    "bindMode": "root",
    "targets": {
      "windows": {
        "dir": "%USERPROFILE%\\\\.cursor\\\\skills"
      },
      "macos": {
        "dir": "$HOME/.cursor/skills"
      },
      "linux": {
        "dir": "$HOME/.cursor/skills"
      }
    },
    "support": {
      "nestedDiscovery": false,
      "instructions": true,
      "frontmatter": true,
      "scripts": false,
      "assets": true,
      "references": true,
      "helpers": false
    }
  },
  "commands": {
    "internalDir": ".cursor/commands",
    "bindMode": "root",
    "kind": "markdown-files",
    "supportVersion": 1,
    "targets": {
      "windows": {
        "dir": "%USERPROFILE%\\\\.cursor\\\\commands"
      },
      "macos": {
        "dir": "$HOME/.cursor/commands"
      },
      "linux": {
        "dir": "$HOME/.cursor/commands"
      }
    },
    "support": {
      "description": true,
      "args": false,
      "tags": false,
      "frontmatter": false
    }
  },
  "mcp": {
    "internalConfig": ".cursor/mcp.json",
    "kind": "json-mcpServers",
    "supportVersion": 1,
    "hasNonMcpConfig": false,
    "targets": {
      "windows": {
        "config": "%USERPROFILE%\\\\.cursor\\\\mcp.json"
      },
      "macos": {
        "config": "$HOME/.cursor/mcp.json"
      },
      "linux": {
        "config": "$HOME/.cursor/mcp.json"
      }
    },
    "support": {
      "transports": {
        "stdio": true,
        "streamableHttp": true,
        "sse": true
      },
      "auth": {
        "oauth": true,
        "bearerToken": true,
        "staticHeaders": true,
        "envHeaders": true
      },
      "capabilities": {
        "tools": true,
        "resources": false,
        "prompts": false
      },
      "config": {
        "command": true,
        "args": true,
        "env": true,
        "url": true,
        "envFile": true
      }
    }
  },
  "hooks": {
    "internalConfig": ".cursor/hooks.json",
    "kind": "unsupported",
    "supportVersion": 1,
    "hasNonHookConfig": false,
    "targets": {
      "windows": {
        "config": "%USERPROFILE%\\\\.cursor\\\\settings.json"
      },
      "macos": {
        "config": "$HOME/.cursor/settings.json"
      },
      "linux": {
        "config": "$HOME/.cursor/settings.json"
      }
    },
    "support": {
      "actions": {
        "shell": false,
        "prompt": false,
        "http": false,
        "other": false
      },
      "events": {
        "sessionStart": false,
        "beforeAgent": false,
        "afterAgent": false,
        "beforeTool": false,
        "afterTool": false,
        "notification": false
      },
      "config": {
        "conditions": false,
        "timeoutMs": false,
        "retry": false,
        "async": false
      }
    }
  }
}
```

## Conservative Support Matrix

`skills-sync` only projects commands and hooks where the agent has a documented user-level surface that matches the normalized model closely enough for honest translation.

| Agent | Commands | Hooks | Notes |
| --- | --- | --- | --- |
| Codex | yes | no | Commands are projected as skill-backed slash commands. Hook parity is intentionally not claimed in v1. |
| Claude Code | yes | yes | Commands render as markdown files with frontmatter. Hooks merge into the shared JSON settings file. |
| Cursor | yes | no | Commands render as markdown files. Hooks stay unsupported in v1 user-scope mode. |
| Gemini CLI | yes | yes | Commands render as TOML files. Hooks merge into the shared JSON settings file. |
| GitHub Copilot | no | no | Repo-scoped custom instructions and hooks are out of scope for v1 user-scope sync. |

Unsupported or partial cases stay visible in `agents inventory`, `agents drift`, and sync diagnostics instead of being silently flattened away.

## Field Guide

| Key | Required | Purpose |
| --- | --- | --- |
| `id` | yes | Stable agent id used everywhere else in code and state. |
| `name` | yes | Human-readable label for CLI text and JSON output. |
| `config.order` | yes | Sort order when loading integrations. Lower comes first. |
| `config.adapter` | yes | File name in `src/infra/agents/adapters/<adapter>.js` exporting `projectFromBundle()`. |
| `config.projectionVersion` | yes | Bump when the adapter output contract changes and old projections should be treated as stale. |
| `skills.internalDir` | yes | Generated runtime skills path under `~/.skills-sync/internal/`. |
| `skills.bindMode` | yes | How generated skills are applied to the real agent location. `root` binds the projected root. `children` binds each child directory individually. |
| `skills.targets.<os>.dir` | optional | Real per-OS skills location. Omit for agents with no managed skills target. |
| `skills.support.nestedDiscovery` | yes | If `true`, the agent can discover canonical nested skill paths like `vendor/skill`. If `false`, `skills-sync` adds flattened `vendor__...` aliases during projection. |
| `skills.support.*` | yes | Boolean skill feature support map. Unsupported optional features are stripped from agent skill projections, and the same map is used for advisory compatibility warnings. |
| `commands.internalDir` | yes | Generated runtime command path under `~/.skills-sync/internal/`. |
| `commands.bindMode` | yes | Command binding mode. v1 uses `root`. |
| `commands.kind` | yes | Command renderer kind. Current values: `unsupported`, `markdown-files`, `toml-files`, `skills-backed`. |
| `commands.targets.<os>.dir` | optional | Real per-OS commands location. Omit when the agent does not support managed commands. |
| `commands.supportVersion` | optional | Version for the command support matrix shape. Missing values normalize to `1`. |
| `commands.support.*` | yes | Boolean command metadata support map: `description`, `args`, `tags`, `frontmatter`. Unsupported metadata is reported as lossy translation. |
| `mcp.internalConfig` | yes | Generated runtime MCP config path under `~/.skills-sync/internal/`. |
| `mcp.targets.<os>.config` | yes | Real per-OS MCP config location. |
| `mcp.kind` | yes | MCP config reader/writer kind. Current values: `json-mcpServers`, `claude-json-type`, `json-command-url`, `copilot-json-type`, `toml-managed-block`. |
| `mcp.supportVersion` | optional | Version for the MCP support matrix shape. Missing values normalize to `1`. |
| `mcp.hasNonMcpConfig` | yes | If `true`, the target config file contains non-MCP settings, so runtime generation must seed from the local config and replace only the managed MCP section. If `false`, a clean agent-native config can be generated. |
| `mcp.support.transports.*` | optional | Transport support metadata: `stdio`, `streamableHttp`, `sse`. Missing keys default to `false`. |
| `mcp.support.auth.*` | optional | Auth/config support metadata: `oauth`, `bearerToken`, `staticHeaders`, `envHeaders`, `providerAuth`. |
| `mcp.support.capabilities.*` | optional | Exposed server capability metadata: `tools`, `resources`, `prompts`. In authored agent JSON, prefer explicit `true` or `false` values for all three keys. |
| `mcp.support.advanced.*` | optional | Advanced client/protocol metadata: `sampling`, `roots`, `elicitation`. |
| `mcp.support.config.*` | optional | Config/write metadata such as `command`, `args`, `env`, `url`, `enabledTools`, `managedBlock`, plus optional `mergeStrategy`. |
| `hooks.internalConfig` | yes | Generated runtime hook config path under `~/.skills-sync/internal/`. |
| `hooks.kind` | yes | Hook renderer kind. Current values: `unsupported`, `json-hooks`. |
| `hooks.targets.<os>.config` | optional | Real per-OS hook config location. Omit when the agent does not support managed hooks. |
| `hooks.supportVersion` | optional | Version for the hook support matrix shape. Missing values normalize to `1`. |
| `hooks.hasNonHookConfig` | yes | If `true`, the target config file contains non-hook settings, so runtime generation must seed from the local config and replace only the managed hook groups. |
| `hooks.support.actions.*` | optional | Supported hook action types: `shell`, `prompt`, `http`, `other`. |
| `hooks.support.events.*` | optional | Supported normalized hook events: `sessionStart`, `beforeAgent`, `afterAgent`, `beforeTool`, `afterTool`, `notification`. |
| `hooks.support.config.*` | optional | Supported hook config features: `conditions`, `timeoutMs`, `retry`, `async`. Unsupported features are reported as lossy translation. |
| `notes` | optional | Maintainer notes only. No runtime behavior. |

## Capability Model

The integration matrices are used in four concrete places:

- skill projection strips unsupported optional skill content such as `scripts/`, `assets/`, `references/`, `helpers/`, or `SKILL.md` frontmatter
- command projection emits agent-native command files or skill-backed command directories and records lossy metadata drops
- hook projection emits agent-native hook config only where the integration says hooks are supported and records unsupported or lossy cases
- MCP projection and doctor validation reject agent projections that require unsupported transport or config features for the current profile MCP manifest and `mcp.kind`

`mcp.support.config.mergeStrategy` defaults to `replace`. Use `managed-block` only when the native config format requires a managed subsection instead of full replacement.

## Migration Notes

- Older flat agent JSON is migrated into `config`, `skills`, `commands`, `mcp`, and `hooks` sections during normalization.
- Older agent JSON with no `commands.supportVersion`, `mcp.supportVersion`, or `hooks.supportVersion` normalizes to `1`.
- Older agent JSON with no `mcp.support` or `mcp.support: {}` normalizes to the default all-false MCP matrix with `config.mergeStrategy: "replace"`.
- Older agent JSON with only legacy nested `targets.<os>.hasNonMcpConfig` values is migrated to `mcp.hasNonMcpConfig`. The derived per-OS targets document still carries the nested flag so existing `targets.override.json` files remain compatible.
- Older agent JSON with no `hooks.hasNonHookConfig` normalizes conservatively to `false`.
- `mcp.kind`, `commands.kind`, and `hooks.kind` control parser or writer behavior. The support matrices are capability metadata, not wire-format selectors.

## Adding An Agent

1. Add `src/assets/integrations/agents/<id>.json`.
2. Add `src/infra/agents/adapters/<id>.js` exporting `projectFromBundle(options)`.
3. Fill in `config.order`, `config.adapter`, and `config.projectionVersion`.
4. Fill in `skills.internalDir`, `skills.bindMode`, and `skills.targets`.
5. Fill in `commands.internalDir`, `commands.targets`, `commands.kind`, and `commands.support`.
6. Fill in `mcp.internalConfig`, `mcp.targets`, `mcp.kind`, and `mcp.hasNonMcpConfig`.
7. Fill in `hooks.internalConfig`, `hooks.targets`, `hooks.kind`, `hooks.hasNonHookConfig`, and `hooks.support`.
8. Set `skills.support.nestedDiscovery` based on whether the agent can discover nested skill paths directly.
9. Set `skills.support.*`, `commands.support.*`, `mcp.support.*`, and `hooks.support.*` conservatively from the agent's documented behavior.
10. Run `npm run build` and `npm test`.

## What To Check

- `sync` writes runtime projections to `~/.skills-sync/internal/.<agent>/`.
- `apply` links skills into the expected target directory.
- `apply` also links or copies commands into the expected target directory when supported.
- `apply` merges managed hook config into the expected target file when supported.
- MCP config is written in the agent's native shape.
- `agents inventory` detects the installed skills, commands, hooks, and MCP servers cleanly.
- `agents drift --dry-run` only reports real drift, skipped unsupported surfaces, and honest lossy translations.
- `doctor` passes.

## Notes

- There is no separate authored registry schema and no separate authored targets schema anymore.
- Registry views and per-OS target maps are derived in code from these per-agent files.
- If a field does not affect runtime behavior, keep it out of the JSON.
