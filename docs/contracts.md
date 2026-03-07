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
- `transport` is agent-neutral metadata in the input manifest. Agent adapters project it into each tool's native config shape.

### Upstreams + Lock
- `workspace/upstreams.json` (fallback `internal/starter/upstreams.json`)
- `workspace/upstreams.lock.json`

Schemas:
- `internal/contracts/inputs/upstreams.schema.json`
- `internal/contracts/state/upstreams-lock.schema.json`

## Runtime Targets

Schema:
- `internal/contracts/runtime/targets.schema.json`

Required top-level keys:
- `codex`
- `claude`
- `cursor`
- `copilot`
- `gemini`

Per-tool target fields:
- `skillsDir`: runtime skills directory target
- `mcpConfig`: runtime MCP config target
- `canOverride` (boolean): runtime projection policy for MCP config
  - `true`: dist MCP projection can be generated directly from canonical bundle
  - `false`: runtime artifact generation reads existing local config (if present) and only replaces MCP sections

## Runtime Artifact Contract

Canonical artifact:
- `~/.skills-sync/internal/common/bundle.json`
- `~/.skills-sync/internal/common/skills/`
- `~/.skills-sync/internal/common/mcp.json`

`~/.skills-sync/internal/common` is authoritative.  
All other `dist/*` paths are projections.

## Projection Contract (Current)

Primary projections:
- `dist/common/*`
- `dist/.codex/*`
- `dist/.claude/*`
- `dist/.cursor/*`
- `dist/.copilot/*`
- `dist/.gemini/*`

## Runtime Mutation Contract

`sync` behavior:
- skills directories are linked where supported
- MCP config is merged under `skills-sync__*` namespace
- unmanaged user entries are preserved

`unlink` behavior:
- removes managed links
- removes managed MCP namespace entries only
