# Agent Integrations

Agent support is defined by one JSON file per agent in `src/assets/integrations/agents/`.
Those files are the only authored source of truth for agent metadata, runtime projection paths, target paths, and compatibility metadata. The authored shape is grouped into three sections:
- `config`: skills-sync runtime behavior
- `skills`: skill paths, binding, and skill feature support
- `mcp`: MCP paths, config behavior, and MCP capability support

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
  }
}
```

## Field Guide

| Key | Required | Purpose |
| --- | --- | --- |
| `id` | yes | Stable agent id used everywhere else in code and state. |
| `name` | yes | Human-readable label for CLI text and JSON output. |
| `config.order` | yes | Sort order when loading integrations. Lower comes first. |
| `config.adapter` | yes | File name in `src/lib/adapters/<adapter>.js` exporting `projectFromBundle()`. |
| `config.projectionVersion` | yes | Bump when the adapter output contract changes and old projections should be treated as stale. |
| `skills.internalDir` | yes | Generated runtime skills path under `~/.skills-sync/internal/`. |
| `skills.bindMode` | yes | How generated skills are applied to the real agent location. `root` binds the projected root. `children` binds each child directory individually. |
| `skills.targets.<os>.dir` | optional | Real per-OS skills location. Omit for MCP-only agents. |
| `skills.support.nestedDiscovery` | yes | If `true`, the agent can discover canonical nested skill paths like `vendor/skill`. If `false`, `skills-sync` adds flattened `vendor__...` aliases during projection. |
| `skills.support.*` | yes | Boolean skill feature support map. Unsupported optional features are stripped from agent skill projections, and the same map is used for advisory compatibility warnings. |
| `mcp.internalConfig` | yes | Generated runtime MCP config path under `~/.skills-sync/internal/`. |
| `mcp.targets.<os>.config` | yes | Real per-OS MCP config location. |
| `mcp.kind` | yes | MCP config reader/writer kind. Current values: `json-mcpServers`, `claude-json-type`, `json-command-url`, `copilot-json-type`, `toml-managed-block`. |
| `mcp.supportVersion` | optional | Version for the MCP support matrix shape. Missing values normalize to `1`. |
| `mcp.hasNonMcpConfig` | yes | If `true`, the target config file contains non-MCP settings, so runtime generation must seed from the local config and replace only the managed MCP section. If `false`, a clean agent-native config can be generated. |
| `mcp.support.transports.*` | optional | Transport support metadata: `stdio`, `streamableHttp`, `sse`. Missing keys default to `false`. |
| `mcp.support.auth.*` | optional | Auth/config support metadata: `oauth`, `bearerToken`, `staticHeaders`, `envHeaders`, `providerAuth`. |
| `mcp.support.capabilities.*` | optional | Exposed server capability metadata: `tools`, `resources`, `prompts`. In authored agent JSON, prefer explicit `true`/`false` values for all three keys. |
| `mcp.support.advanced.*` | optional | Advanced client/protocol metadata: `sampling`, `roots`, `elicitation`. |
| `mcp.support.config.*` | optional | Config/write metadata such as `command`, `args`, `env`, `url`, `enabledTools`, `managedBlock`, plus optional `mergeStrategy`. |
| `notes` | optional | Maintainer notes only. No runtime behavior. |

## MCP Support Model

`mcp.support` is a normalized capability matrix. Runtime normalization still defaults missing entries to `false`, but authored agent integration JSON should keep `capabilities.tools`, `capabilities.resources`, and `capabilities.prompts` explicit for readability.

- `transports`: transport protocols the agent/client understands.
- `auth`: auth or header configuration modes the agent can represent.
- `capabilities`: server surfaces the client can expose meaningfully.
- `advanced`: advanced protocol features the client understands.
- `config`: writable config fields and merge behavior.

The current runtime uses this matrix in two concrete places:
- Skill projection strips unsupported optional skill content such as `scripts/`, `assets/`, `references/`, `helpers/`, or `SKILL.md` frontmatter.
- MCP projection and doctor validation reject agent projections that require unsupported transport/config features for the current profile MCP manifest and `mcp.kind`.

`mcp.support.config.mergeStrategy` defaults to `replace`. Use `managed-block` only when the native config format requires a managed subsection instead of full replacement.

## Migration Note

- Older flat agent JSON is migrated into `config`, `skills`, and `mcp` sections during normalization.
- Older agent JSON with no `mcp.supportVersion` normalizes to `1`.
- Older agent JSON with no `mcp.support` or `mcp.support: {}` normalizes to the default all-false MCP matrix with `config.mergeStrategy: "replace"`.
- Older agent JSON with only legacy nested `targets.<os>.hasNonMcpConfig` values is migrated to `mcp.hasNonMcpConfig`. The derived per-OS targets document still carries the nested flag so existing `targets.override.json` files remain compatible.
- `mcp.kind` still controls parser/writer behavior. `mcp.support` is capability metadata, not a wire-format selector.

## Adding An Agent

1. Add `src/assets/integrations/agents/<id>.json`.
2. Add `src/lib/adapters/<id>.js` exporting `projectFromBundle(options)`.
3. Fill in `config.order`, `config.adapter`, and `config.projectionVersion`.
4. Fill in `skills.internalDir`, `skills.bindMode`, and `skills.targets`.
5. Fill in `mcp.internalConfig`, `mcp.targets`, `mcp.kind`, and `mcp.hasNonMcpConfig`.
6. Set `skills.support.nestedDiscovery` based on whether the agent can discover nested skill paths directly.
7. Set `skills.support.*` and `mcp.support.*` conservatively from the agent's documented behavior.
8. Run `npm run build` and `npm test`.

## What To Check

- `sync` writes runtime projections to `~/.skills-sync/internal/.<agent>/`.
- `apply` links skills into the expected target directory.
- MCP config is written in the agent's native shape.
- `agents inventory` detects the installed skills and MCP servers cleanly.
- `agents drift --dry-run` only reports real drift, not false feature warnings.
- `doctor` passes.

## Notes

- There is no separate authored registry schema and no separate authored targets schema anymore.
- Registry views and per-OS target maps are derived in code from these per-agent files.
- If a field does not affect runtime behavior, keep it out of the JSON.
