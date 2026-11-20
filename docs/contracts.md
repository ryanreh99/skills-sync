# Contracts

## Inputs

### Profile
Path:
- `workspace/profiles/<name>.json`

Schema:
- `internal/contracts/inputs/profile.schema.json`

Shape:
```json
{ "name": "personal", "packPath": "workspace/packs/personal" }
```

### Pack Manifest
Path:
- `<pack>/pack.json`

Schema:
- `internal/contracts/inputs/pack-manifest.schema.json`

### Pack Sources
Path:
- `<pack>/sources.json`

Schema:
- `internal/contracts/inputs/pack-sources.schema.json`

Shape:
```json
{ "imports": [] }
```

### Commands Input
Path:
- `<pack>/commands/commands.json`

Schema:
- `src/assets/contracts/inputs/commands.schema.json`

Shape:
```json
{
  "commands": [
    {
      "id": "review-pr",
      "name": "review-pr",
      "description": "Review the current pull request",
      "body": "Review the staged diff and summarize the highest-risk changes.",
      "args": [{ "name": "scope" }]
    }
  ]
}
```

Notes:
- Commands are local profile-owned content in v1. They do not participate in upstream import or lockfile import rows.
- Inheritance merge is by `id`. Later profiles override earlier ones in the resolved profile chain.
- Command projections are global profile intent. Agent capability metadata decides whether an agent gets a real projection, a lossy projection warning, or an unsupported skip.

### Hooks Input
Path:
- `<pack>/hooks/hooks.json`

Schema:
- `src/assets/contracts/inputs/hooks.schema.json`

Shape:
```json
{
  "hooks": [
    {
      "id": "pre-tool-check",
      "name": "pre-tool-check",
      "event": "beforeTool",
      "action": {
        "type": "shell",
        "payload": "echo validating tool invocation"
      },
      "conditions": ["Write"]
    }
  ]
}
```

Notes:
- Hooks are local profile-owned content in v1. They do not participate in upstream import or lockfile import rows.
- Unsupported or partial hook translations are surfaced in sync, inventory, and drift instead of being silently dropped.
- Hook projections are global profile intent. Agent capability metadata decides whether an agent gets a real projection, a lossy projection warning, or an unsupported skip.

### MCP Servers Input
Path:
- `<pack>/mcp/servers.json`

Schema:
- `internal/contracts/inputs/mcp-servers.schema.json`

Shape:
```json
{
  "servers": {
    "stdio-server": { "command": "...", "args": [], "env": { "KEY": "VALUE" } },
    "http-server": { "url": "https://example.com/mcp" },
    "sse-server": { "url": "https://example.com/sse", "transport": "sse" }
  }
}
```

Notes:
- URL-based servers may omit `transport`; `skills-sync` treats them as HTTP by default for Copilot projection.
- `transport` is agent-neutral input metadata. Adapters project it into each tool's native config shape.

### Upstreams + Lock
- `workspace/upstreams.json`
- `workspace/skills-sync.lock.json`

Schemas:
- `src/assets/contracts/inputs/upstreams.schema.json`
- `src/assets/contracts/state/upstreams-lock.schema.json`

Notes:
- `skills-sync.lock.json` is the canonical reproducibility state.
- Lock schema version is `3`.

## Agent Definitions

Source of truth:
- `src/assets/integrations/agents/*.json`

Schema:
- `src/assets/contracts/runtime/agent-integration.schema.json`

Notes:
- Each agent has its own JSON file.
- These files are authored in `config`, `skills`, `commands`, `mcp`, and `hooks` sections.
- Registry views and effective target maps are derived in code from these files. They are not separately authored contracts.

Important fields:
- `config.order`
- `config.adapter`
- `config.projectionVersion`
- `skills.internalDir`
- `skills.bindMode`
- `skills.targets.<os>.dir`
- `skills.support.*`
- `commands.internalDir`
- `commands.kind`
- `commands.targets.<os>.dir`
- `commands.support.*`
- `mcp.internalConfig`
- `mcp.targets.<os>.config`
- `mcp.hasNonMcpConfig`
- `mcp.supportVersion`
- `mcp.kind`
- `mcp.support.transports.*`
- `mcp.support.auth.*`
- `mcp.support.capabilities.*`
- `mcp.support.advanced.*`
- `mcp.support.config.*`
- `hooks.internalConfig`
- `hooks.kind`
- `hooks.targets.<os>.config`
- `hooks.hasNonHookConfig`
- `hooks.support.*`

## Runtime Artifact Contract

Canonical artifact:
- `~/.skills-sync/internal/common/bundle.json`
- `~/.skills-sync/internal/common/skills/`
- `~/.skills-sync/internal/common/commands.json`
- `~/.skills-sync/internal/common/hooks.json`
- `~/.skills-sync/internal/common/mcp.json`

`~/.skills-sync/internal/common` is authoritative.
All `~/.skills-sync/internal/.<agent>/*` paths are projections.

## Runtime Mutation Contract

`sync` behavior:
- Skills directories are linked where supported.
- Command directories or files are linked or copied where supported.
- Hook config is merged only for agents that declare managed hook support.
- MCP config is written through the configured `mcp.kind`.
- Managed MCP servers keep their canonical profile names in target configs.
- Unmanaged local config is preserved only when `mcp.hasNonMcpConfig` is `true`.

`unlink` behavior:
- Removes managed links.
- Removes managed command bindings.
- Removes only the managed hook groups recorded in active state.
- Removes managed MCP namespace entries only.
