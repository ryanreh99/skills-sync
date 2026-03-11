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
- These files are authored in `config`, `skills`, and `mcp` sections.
- Registry views and effective target maps are derived in code from these files. They are not separately authored contracts.

Important fields:
- `config.order`
- `config.adapter`
- `config.projectionVersion`
- `skills.internalDir`
- `skills.bindMode`
- `skills.targets.<os>.dir`
- `skills.support.*`
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

## Runtime Artifact Contract

Canonical artifact:
- `~/.skills-sync/internal/common/bundle.json`
- `~/.skills-sync/internal/common/skills/`
- `~/.skills-sync/internal/common/mcp.json`

`~/.skills-sync/internal/common` is authoritative.
All `~/.skills-sync/internal/.<agent>/*` paths are projections.

## Runtime Mutation Contract

`sync` behavior:
- Skills directories are linked where supported.
- MCP config is written through the configured `mcp.kind`.
- Managed MCP servers keep their canonical profile names in target configs.
- Unmanaged local config is preserved only when `mcp.hasNonMcpConfig` is `true`.

`unlink` behavior:
- Removes managed links.
- Removes managed MCP namespace entries only.
