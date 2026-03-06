# skills-sync

![npm version](https://img.shields.io/npm/v/@ryanreh99/skills-sync)
![npm downloads](https://img.shields.io/npm/dw/@ryanreh99/skills-sync)

`skills-sync` is a CLI for managing AI agent environments made of profiles, local skills, imported skills, sources, upstreams, and MCP configuration.

## What It Does

`skills-sync` keeps environment state in a workspace and materializes that state into supported agents.

It manages:

- local skills stored in profile packs
- imported skills tracked from repos or local paths
- sources and upstreams used to discover and refresh skills
- MCP server configuration per profile
- deterministic build output before anything is applied
- runtime materialization into agent-specific directories and config files
- refresh, inspect, drift, and reconcile operations after initial setup

In practice, this means you define an environment once and apply it to multiple agents.

## Supported Agents

![Codex](https://img.shields.io/badge/Codex-supported-412991?logo=openaigym&logoColor=white)
![Cursor](https://img.shields.io/badge/Cursor-supported-000000?logo=cursor)
![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4?logo=google)
![Copilot](https://img.shields.io/badge/Copilot-supported-2F80ED?logo=githubcopilot)
![Claude Code](https://img.shields.io/badge/Claude%20Code-experimental-orange?logo=anthropic&logoColor=white)

## Installation

```bash
npm i -g @ryanreh99/skills-sync
```

## Quickstart

This is a realistic first-use flow:

```bash
# initialize the local workspace
skills-sync init --seed

# register a source of external skills
skills-sync profile add-upstream --source matlab/skills

# inspect what that source contains
skills-sync list upstream-content --upstream matlab_skills

# attach one skill to the personal profile
skills-sync profile add-skill personal --upstream matlab_skills --path skills/matlab-test-generator

# build deterministic runtime output
skills-sync build --profile personal

# apply that output to agent locations
skills-sync apply --profile personal

# inspect the resulting profile inventory and source state
skills-sync profile inspect personal
```

## Core Concepts

- `Source`: a raw origin of skills, such as a git repo, repo subdirectory, or local path.
- `Upstream`: a source registered in the workspace so it can be discovered, attached, refreshed, and tracked.
- `Profile`: a named environment containing skills, imported sources, and MCP configuration.
- `Inventory`: the managed view of skills, provenance, revisions, install state, and agent materialization.
- `Build`: compute the desired runtime output for a profile without touching agent installs.
- `Apply`: materialize the built output into the directories and config files used by supported agents.

## Common Workflows

Register an upstream:

```bash
skills-sync upstream add --source matlab/skills
skills-sync list upstreams
```

Import directly from a source without registering it first:

```bash
skills-sync profile add-skill personal \
  --source https://github.com/openai/skills/tree/main/skills/.curated \
  --upstream-id openai_curated \
  --all \
  --build
```

List and search skills:

```bash
skills-sync list skills --profile personal --detail full
skills-sync search skills --query matlab --scope discoverable
skills-sync search skills --query spreadsheet --profile personal --scope installed
```

Inspect and refresh imported state:

```bash
skills-sync profile inspect personal
skills-sync profile refresh personal --dry-run
skills-sync profile refresh personal --upstream matlab_skills --build --apply
```

Apply to selected agents only:

```bash
skills-sync apply --profile personal --agents codex,claude
skills-sync unlink --agents codex --dry-run
```

Export or sync workspace state:

```bash
skills-sync workspace export
skills-sync workspace diff --format json
skills-sync workspace sync --dry-run
```

## Capability Handling Across Agents

`skills-sync` manages full skill directories, not just `SKILL.md`.

- optional files such as scripts, helpers, references, assets, and frontmatter are preserved
- agents can consume different subsets of the same skill
- if an agent ignores an optional capability, that does not block import, build, apply, or refresh
- capability mismatches are surfaced through inventory, `profile inspect`, `doctor`, and `agents drift`

The baseline portable unit is still the instruction content in `SKILL.md`, but the full directory remains the managed artifact.

## Workspace State And Files

Important workspace files:

- `workspace/upstreams.json`: registered upstreams and their normalized source descriptors
- `workspace/profiles/<name>.json`: profile metadata, including pack location and inheritance settings
- `workspace/packs/<profile>/sources.json`: imported skill bindings for a profile
- `workspace/packs/<profile>/mcp/servers.json`: MCP servers defined for a profile
- `workspace/skills-sync.lock.json`: resolved imported-source state, revisions, hashes, and refresh metadata
- `workspace/skills-sync.manifest.json`: exported whole-workspace state for restore or reconcile workflows
- `workspace/state/active-profile.json`: current applied runtime state used by `apply`, `unlink`, and drift checks

## Documentation

- [docs/commands.md](docs/commands.md)
- [docs/user-guide.md](docs/user-guide.md)

## License

[MIT](LICENSE)
