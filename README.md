# skills-sync

![npm version](https://img.shields.io/npm/v/@ryanreh99/skills-sync)
![npm downloads](https://img.shields.io/npm/dw/@ryanreh99/skills-sync)

`skills-sync` is a CLI for managing AI agent environments made of profiles, local skills, imported skills, sources, upstreams, and MCP configuration.

## What It Does

`skills-sync` keeps environment state in a workspace and syncs it into supported agents from one profile-driven source of truth.

It manages:

- profiles, packs, and profile-scoped MCP server and skills configuration
- local skills plus imported skills from git repos, repo subdirectories, or local paths
- sources and upstreams for discovery, attachment, refresh, and provenance tracking
- lock state, revision tracking, content digests, projection metadata, and inventory views for installed and imported content
- profile inspection and upstream skills refresh so you can review what a profile contains, where imported skills came from, and pull in upstream updates
- drift checks across local agents so you can compare expected state with what is installed locally and spot missing, changed, stale, or incompatible skills and MCP config
- workspace manifest export, diff, import, and reconcile workflows

In practice, this means you define an environment once and sync it to multiple agents.

Run `skills-sync` with no arguments to open the interactive shell. It uses an explorer-first full-screen TTY layout with `Explorer` and `Transcript` panes; the explorer is organized around `Profiles`, `Skills`, `MCPs`, `Upstreams`, and `Agents`, `:` opens a raw command prompt, `/` filters or searches, `Tab` switches panes, and `y` copies transcript text. Shell mode is TTY-only, so in non-interactive environments you should run normal commands directly.

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
# initialize the local workspace with starter content
skills-sync init --seed

# Use the default skills-sync profile
skills-sync use personal

# sync runtime output to all agent locations
skills-sync sync
```


## Core Concepts

- `Source`: a raw origin of skills, such as a git repo, repo subdirectory, or local path.
- `Upstream`: a source registered in the workspace so it can be discovered, attached, refreshed, and tracked.
- `Profile`: a named environment containing skills, imported sources, and MCP configuration.
- `Inventory`: the managed view of skills, provenance, revisions, install state, and agent materialization.
- `Sync`: the recommended workflow that prepares runtime artifacts and updates supported agents.

## Reproducibility

- imported sources are accepted without a separate review step
- `sync` builds and applies directly; there is no separate sync-gate phase
- `workspace/skills-sync.lock.json` is the canonical imported-source lockfile and records source identity, normalized descriptors, resolved revisions, content digests, projection metadata, refresh state, and eval state
- `workspace/skills-sync.manifest.json` is the canonical whole-workspace manifest

## Common Workflows

These commands sync automatically unless you pass `--no-sync`: `profile add-skill`, `profile remove-skill`, `profile add-mcp`, `profile remove-mcp`, `profile refresh`, and `profile import`.

### How to add skills from an upstream:

![How to add skills from an upstream demo](docs/demo/add-skills-from-upstream.gif)


```bash
skills-sync profile add-upstream --source matlab/skills
skills-sync list upstream-content --upstream matlab_skills
skills-sync profile add-skill --upstream matlab_skills --path skills/matlab-test-generator
```


### Check drift across local agents:

![Check drift across local agents demo](docs/demo/agents-drift.gif)

```bash
skills-sync agents inventory
skills-sync agents drift --dry-run
```


### Inspect and refresh upstream skills:

![Inspect and refresh imported state demo](docs/demo/inspect-and-refresh-state.gif)

```bash
skills-sync profile inspect personal
skills-sync profile refresh personal --dry-run
skills-sync profile refresh personal --upstream matlab_skills
```


### List and search skills:

![List and search skills demo](docs/demo/list-and-search-skills.gif)

```bash
skills-sync list skills --profile personal --detail full
skills-sync search skills --query matlab --scope discoverable
skills-sync search skills --query spreadsheet --profile personal --scope installed
```

Import directly from a source without registering it first:

![Import directly from a source demo](docs/demo/import-direct-from-source.gif)

```bash
skills-sync profile add-skill personal \
  --source https://github.com/openai/skills/tree/main/skills/.curated \
  --upstream-id openai_curated \
  --all
```

### Export and import a profile:

```bash
skills-sync profile export personal --output personal-export.json
skills-sync profile import personal_copy --input personal-export.json
```

## Documentation

- [docs/commands.md](docs/commands.md)
- [docs/user-guide.md](docs/user-guide.md)
- [docs/agent-integrations.md](docs/agent-integrations.md)

## License

[MIT](LICENSE)
