# User Guide

`skills-sync` manages profile-scoped skills and MCP servers across Codex, Claude Code, Cursor, Copilot, and Gemini.

The normal workflow is:

1. register or reference an external source
2. attach skills to a profile
3. run `skills-sync sync`
4. inspect, refresh, or reconcile later

## Initialize a Workspace

```bash
skills-sync init --seed
skills-sync use personal
skills-sync sync
```

Check the current environment:

```bash
skills-sync profile show
skills-sync list skills --detail full
skills-sync list mcps
skills-sync doctor
```

## Import Skills Natively

Register an upstream explicitly:

```bash
skills-sync upstream add anthropic --source anthropics/skills
skills-sync list upstream-content --upstream anthropic
skills-sync profile add-skill personal --upstream anthropic --path skills/frontend-design
```

Or import directly from an ad hoc source:

```bash
skills-sync profile add-skill personal \
  --source https://github.com/openai/skills/tree/main/skills/.curated \
  --upstream-id openai_curated \
  --all
```

Local path sources are first-class too:

```bash
skills-sync profile add-skill personal \
  --source ./team-skills \
  --provider local-path \
  --all
```

## Discover Skills

Search discoverable and installed content:

```bash
skills-sync search skills --query design --scope discoverable
skills-sync search skills --query spreadsheet --profile personal --scope installed
skills-sync search skills --query skill --profile personal --scope all --format json
```

Inspect source content before attaching:

```bash
skills-sync list upstream-content --upstream anthropic --verbose
skills-sync list upstream-content --source ./team-skills --provider local-path --format json
```

## Capability Handling Across Agents

`skills-sync` manages full skill directories, not just `SKILL.md`.

- optional files such as scripts, helpers, references, assets, and frontmatter are preserved
- agents can consume different subsets of the same skill
- if an agent ignores an optional capability, that does not block import, sync, or refresh
- capability mismatches are surfaced through inventory, `profile inspect`, `doctor`, and `agents drift`

The baseline portable unit is still the instruction content in `SKILL.md`, but the full directory remains the managed artifact.

Use these commands to inspect that state:

```bash
skills-sync list skills --detail full
skills-sync profile inspect personal
skills-sync agents drift --dry-run
```

Capability mismatches are surfaced as warnings or metadata. They do not block import, sync, or refresh on their own.

## Refresh Imported Skills

Preview changes:

```bash
skills-sync profile refresh personal --dry-run
```

Refresh one source and sync:

```bash
skills-sync profile refresh personal --upstream anthropic
```

Imported-source state is stored in `workspace/skills-sync.lock.json`.
These commands sync automatically unless you pass `--no-sync`: `profile add-skill`, `profile remove-skill`, `profile add-mcp`, `profile remove-mcp`, `profile refresh`, and `profile import`.

## Remove Skills Cleanly

```bash
skills-sync profile remove-skill personal --upstream anthropic --path skills/frontend-design --yes
skills-sync profile remove-skill personal --upstream team_skills --all --prune-upstream --yes
```

Use `unlink --agents ...` when you only want to remove runtime materialization from selected agents.

## Profiles and Skill Authoring

Create or clone profiles:

```bash
skills-sync new work
skills-sync profile clone personal work
skills-sync profile diff personal work --format json
```

Scaffold a new local skill:

```bash
skills-sync profile new-skill review-helper --profile personal --frontmatter --include-scripts
```

## Workspace Manifests

Export the current workspace:

```bash
skills-sync workspace export
```

Compare manifest vs live state:

```bash
skills-sync workspace diff --format json
```

Reconcile from a manifest:

```bash
skills-sync workspace sync --dry-run
skills-sync workspace sync
```

## Workspace State And Files

Important workspace files:

- `workspace/upstreams.json`: registered upstreams and their normalized source descriptors
- `workspace/profiles/<name>.json`: profile metadata, including pack location and inheritance settings
- `workspace/packs/<profile>/sources.json`: imported skill bindings for a profile
- `workspace/packs/<profile>/mcp/servers.json`: MCP servers defined for a profile
- `workspace/skills-sync.lock.json`: resolved imported-source state, revisions, hashes, and refresh metadata
- `workspace/skills-sync.manifest.json`: exported whole-workspace state for restore or reconcile workflows
- `workspace/state/active-profile.json`: current synced runtime state used by `unlink` and drift checks

## Interactive Shell

Run `skills-sync` with no arguments to open shell mode.

Inside shell mode:

- `list` opens list shortcuts
- `agents` opens inventory/drift shortcuts
- `profile` opens profile shortcuts
- `search` opens search shortcuts
- `workspace` opens manifest shortcuts
- `:profile <name>` sets shell profile context
- `exit` closes shell mode

Example:

```text
skills-sync
skills-sync(personal) > sync --agents codex,claude
skills-sync(personal) > profile inspect
skills-sync(personal) > workspace diff
skills-sync(personal) > exit
```

## Migration Notes

- the canonical lockfile is now `workspace/skills-sync.lock.json`
- legacy `workspace/upstreams.lock.json` is migration input only
- upstreams, profile docs, and source docs are schema-versioned
- workspace manifests live at `workspace/skills-sync.manifest.json`
