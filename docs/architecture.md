# Architecture

`skills-sync` is a profile-driven environment manager for agent skills and MCP configuration.

It is not a registry clone and it is not just a one-shot installer. The workspace is the stable source of truth, the internal bundle is the stable runtime model, and agent adapters translate that model into each tool's current contract.

## Design Principles

- Internal model is stable.
- External agent contracts are volatile.
- Adapters are thin and mechanical.
- Reproducibility and operator intent are recorded explicitly in workspace state instead of being inferred from local agent folders.

## System Model

- `Source`: a raw origin of skills, such as a git repo, repo subdirectory, or local path.
- `Upstream`: a registered source with a normalized identity, default ref, and provider metadata.
- `Profile`: a named desired environment.
- `Pack`: the profile-local manifests that define imported skills and MCP servers.
- `Bundle`: the canonical internal artifact built from local skills, imported skills, and normalized MCP config.
- `Projection`: an agent-specific runtime view derived from the canonical bundle.
- `Inventory`: a derived read model that combines workspace config, lock state, runtime state, and compatibility metadata.

## State Layers

The docs refer to the managed workspace as `workspace/`. On disk this lives under `$SKILLS_SYNC_HOME/workspace` and defaults to `~/.skills-sync/workspace`.

### Workspace Inputs

The workspace root stores user-authored and workspace-owned inputs:

- `workspace/upstreams.json`
- `workspace/profiles/<name>.json`
- `workspace/packs/<profile>/sources.json`
- `workspace/packs/<profile>/mcp/servers.json`
- `workspace/skills-sync.manifest.json`

These files are the operator-facing model. They are the durable inputs that can be exported, imported, diffed, and reconciled.

### Reproducibility State

`workspace/skills-sync.lock.json` is the canonical imported-source lockfile. It records:

- normalized source descriptors and source identity
- resolved revisions and tracking mode
- content digests
- projection metadata
- refresh metadata

This lockfile is the reproducibility layer. It is read by inventory, refresh, drift checks, and manifest workflows.

### Internal Runtime Artifacts

`skills-sync` builds a canonical internal runtime under `~/.skills-sync/internal/`.

The authoritative common artifact is:

- `~/.skills-sync/internal/common/bundle.json`
- `~/.skills-sync/internal/common/skills/`
- `~/.skills-sync/internal/common/mcp.json`

Per-agent projections are written beside it:

- `~/.skills-sync/internal/.codex/`
- `~/.skills-sync/internal/.claude/`
- `~/.skills-sync/internal/.cursor/`
- `~/.skills-sync/internal/.copilot/`
- `~/.skills-sync/internal/.gemini/`

The common bundle is the stable internal model. The per-agent folders are generated projections of that model.

### Applied Runtime State

`sync` and `apply` materialize the generated projections into agent runtime locations.

- skills are linked where possible
- MCP config is merged into managed sections only
- unmanaged user config is preserved

The last applied state is recorded in:

- `workspace/state/active-profile.json`

That state is used by `unlink`, inventory, and drift checks.

## Sync Pipeline

The main control flow is:

1. Resolve the selected profile and its effective pack state.
2. Collect source planning from pack imports and registered upstreams.
3. Resolve upstream references against providers, cache, and lock state.
4. Build the canonical bundle in `~/.skills-sync/internal/common`.
5. Project the bundle into per-agent runtime shapes under `~/.skills-sync/internal/.<agent>`.
6. Update lock pins and import records with resolved revisions, digests, projection metadata, and refresh metadata.
7. Apply managed bindings and MCP updates to the selected agent runtimes.

## Module Boundaries

The current code is organized around a small set of stable control points.

- `src/lib/manage.js`
  Workspace mutation commands such as upstream registration, `profile add-skill`, `profile remove-skill`, and MCP edits.
- `src/lib/upstreams.js`
  Upstream normalization, reference planning, ref resolution, pin management, and lockfile helpers.
- `src/lib/build.js`
  Canonical bundle build, per-agent projection generation, and lockfile import record updates.
- `src/lib/bundle.js`
  Bundle assembly from local skills, imported skills, and MCP state.
- `src/lib/bindings.js`
  Runtime apply and unlink behavior for managed skills and MCP config.
- `src/lib/inventory.js`
  Derived read model used by list, inspect, doctor, and drift reporting.
- `src/lib/adapters/*.js`
  Thin per-agent projection code. These modules should stay mechanical and should not absorb policy decisions.

## Adapter Strategy

Adapters are intentionally limited in scope.

Each adapter is responsible for:

- projecting the canonical skill bundle into the target agent's discoverable layout
- projecting MCP config into the target agent's native config format
- preserving or merging local unmanaged config where the target contract requires it

Adapters are not responsible for:

- defining reproducibility state
- owning import, refresh, or review workflows

That separation is important because agent contracts change often. The system should be able to absorb those changes by updating adapters and compatibility metadata without redesigning the workspace model.

## Runtime Mutation Policy

`sync` applies only managed changes.

- skills directories are linked from internal projections into agent runtime locations
- managed MCP entries are written with their canonical profile names, or into the managed block format required by the agent
- unmanaged entries are preserved

`unlink` reverses only managed bindings and managed MCP entries. It does not attempt to clean arbitrary user files or unknown runtime content.

## Compatibility Model

Compatibility policy is driven by the agent integration files in `src/assets/integrations/agents/` and the derived registry built by `src/lib/agent-registry.js`.

That registry defines per-agent projection contract versions, nested skill handling, MCP config assumptions, and capability expectations. Inventory and drift use that metadata to classify:

- missing or changed managed runtime content
- stale projection metadata
- capability degradation that stays diagnostic-only vs cases that should be highlighted more prominently

This keeps compatibility logic centralized instead of scattering tool-specific assumptions across the CLI.

## Why The Architecture Is Shaped This Way

The architecture is optimized for a specific operating model:

- define an environment once in workspace state
- build one stable canonical bundle
- project it mechanically to multiple agents
- let future agent contract churn stay localized to adapters and compatibility metadata

That is what makes `skills-sync` an environment manager rather than a registry mirror or a collection of one-off installer scripts.
