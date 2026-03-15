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

## Imported Source Behavior

Imported sources are accepted without a separate review step.

- there is no `workspace/source-policy.json`
- `sync` builds and applies directly; there is no separate sync-gate phase
- `workspace/skills-sync.lock.json` records source identity, normalized source descriptors, resolved revisions, content digests, projection metadata, refresh outcomes, and eval state
- `workspace/skills-sync.manifest.json` records the exported workspace shape and currently uses schema version `2`

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
- unsupported skill features are surfaced through inventory, `profile inspect`, `doctor`, and `agents drift`

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
The lockfile now records source identity, normalized source descriptors, resolved revisions, content digests, projection metadata, refresh outcomes, and reserved eval state.
The current lockfile schema version is `3`.
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
- `workspace/skills-sync.lock.json`: resolved imported-source state, revisions, content digests, projection metadata, refresh metadata, and eval state
- `workspace/skills-sync.manifest.json`: exported whole-workspace state for restore or reconcile workflows
- `workspace/state/active-profile.json`: current synced runtime state used by `unlink` and drift checks

## Interactive Shell

Run `skills-sync` with no arguments to open shell mode.
Shell mode requires a capable TTY terminal and uses a full-screen interface with:

- an `Explorer` pane on the left grouped into expandable `Setup`, `Profiles`, `Skills`, `MCPs`, `Upstreams`, and `Agents` branches
- a `Transcript` pane on the right that keeps the running shell session output
- a hidden prompt that opens only when you need a raw command or a filter/search query
- a minimal footer that changes with the active pane

When `stdin`/`stdout` are not interactive TTYs, use normal CLI commands directly instead of shell mode.

Inside shell mode:

- `skills`, `mcps`, `upstreams`, `agents`, `profiles`, and `search` jump to the main explorer groups
- `list` jumps to the main skills listing group
- `:profile <name>` sets shell profile context
- `Tab` switches between `Explorer` and `Transcript`
- `Enter` or `Right` expands the selected explorer branch or runs the selected action
- `:` opens the raw command prompt
- `/` filters the `Explorer` or searches the `Transcript`
- `Space` starts or clears transcript selection
- `y` copies the current transcript selection or block, and `Ctrl+Y` copies the full transcript
- `workspace` commands still work from the raw `:` prompt, but they are no longer shown in the explorer tree
- `exit` closes shell mode

Example:

```text
 skills-sync | profile personal | ready | Active: Explorer
+---------------------------+---------------------------------+
| Explorer                  | Transcript                      |
| v Setup                   | [shell] Explorer-first shell    |
|   > Init                  | [shell] Profile context:        |
| > Explore                 | personal                        |
+---------------------------+---------------------------------+
| Enter expand/run | : command | / filter | Tab transcript   |
```

## Migration Notes

- the canonical lockfile is now `workspace/skills-sync.lock.json`
- the current lockfile schema version is `3`
- upstreams, profile docs, and source docs are schema-versioned
- workspace manifests live at `workspace/skills-sync.manifest.json`
- the current workspace manifest schema version is `2`
