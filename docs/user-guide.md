# User Guide

`skills-sync` manages profile-scoped skills and MCP servers across Codex, Claude Code, Cursor, Copilot, and Gemini.

The normal workflow is:

1. register or reference an external source
2. attach skills to a profile
3. build deterministic runtime artifacts
4. apply them to one or more agents
5. inspect, refresh, or reconcile later

## Initialize a Workspace

```bash
skills-sync init --seed
skills-sync use personal
skills-sync build
skills-sync apply
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
skills-sync profile add-skill personal --upstream anthropic --path skills/frontend-design --build --apply
```

Or import directly from an ad hoc source:

```bash
skills-sync profile add-skill personal \
  --source https://github.com/openai/skills/tree/main/skills/.curated \
  --upstream-id openai_curated \
  --all \
  --build
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

## Inventory and Agent Tolerance

Instruction content from `SKILL.md` is the baseline portable unit. Optional scripts, assets, references, helpers, and frontmatter are preserved even when some agents only consume part of them.

Use these commands to inspect that state:

```bash
skills-sync list skills --detail full
skills-sync profile inspect personal
skills-sync agents drift --dry-run
```

Capability mismatches are surfaced as warnings or metadata. They do not block import, build, apply, or refresh on their own.

## Refresh Imported Skills

Preview changes:

```bash
skills-sync profile refresh personal --dry-run
```

Refresh one source and rebuild:

```bash
skills-sync profile refresh personal --upstream anthropic --build --apply
```

Imported-source state is stored in `workspace/skills-sync.lock.json`.

## Remove Skills Cleanly

```bash
skills-sync profile remove-skill personal --upstream anthropic --path skills/frontend-design --yes
skills-sync profile remove-skill personal --upstream team_skills --all --prune-upstream --yes
skills-sync build
skills-sync apply
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
skills-sync(personal) > build
skills-sync(personal) > apply --agents codex,claude
skills-sync(personal) > profile inspect
skills-sync(personal) > workspace diff
skills-sync(personal) > exit
```

## Migration Notes

- the canonical lockfile is now `workspace/skills-sync.lock.json`
- legacy `workspace/upstreams.lock.json` is migration input only
- upstreams, profile docs, and source docs are schema-versioned
- workspace manifests live at `workspace/skills-sync.manifest.json`
