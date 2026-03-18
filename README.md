# skills-sync

![npm version](https://img.shields.io/npm/v/@ryanreh99/skills-sync)
![npm downloads](https://img.shields.io/npm/dw/@ryanreh99/skills-sync)

`skills-sync` is a profile-driven CLI for managing local skills, imported skills, upstreams, and MCP servers across supported AI agents.

Define an environment once, keep it in a local workspace, and sync it to tools like Codex, Cursor, Gemini, Copilot, and Claude Code.

## What It Manages

- profiles with skills and MCP configuration
- local skills plus imported skills from git repos, repo subdirectories, or local paths
- upstreams and sources for discovery, attachment, refresh, and provenance tracking
- inventory, lock, and manifest state for inspecting what is installed and where it came from
- local agent drift checks so you can compare expected state with what is actually installed

## Supported Agents

![Codex](https://img.shields.io/badge/Codex-supported-412991?logo=openaigym&logoColor=white)
![Cursor](https://img.shields.io/badge/Cursor-supported-000000?logo=cursor)
![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4?logo=google)
![Copilot](https://img.shields.io/badge/Copilot-supported-2F80ED?logo=githubcopilot)
![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-191919?logo=anthropic&logoColor=white)

## Installation

```bash
npm i -g @ryanreh99/skills-sync
```

## Quick Start

```bash
skills-sync init --seed
skills-sync use personal
skills-sync sync
```



## Core Ideas

- `Profile`: a named environment with skills and MCP configuration.
- `Upstream`: a registered skill source you can browse, attach, refresh, and track.
- `Source`: a raw git repo, repo subdirectory, or local path.
- `Sync`: the recommended workflow that prepares runtime artifacts and updates supported agents.

The workspace also keeps lock and manifest state so imported content stays inspectable and refreshable.

## Demo Workflows

### Register an upstream

![Register upstream demo](docs/demo/register-upstream.gif)

```bash
skills-sync profile add-upstream --source matlab/skills
```

### Add skills from an upstream

![Add skills from an upstream demo](docs/demo/add-skills-from-upstream.gif)

```bash
skills-sync profile add-upstream --source matlab/skills
skills-sync list upstream-content --upstream matlab_skills
skills-sync profile add-skill --upstream matlab_skills --path skills/matlab-test-generator
```

### Import directly from a source

![Import directly from a source demo](docs/demo/import-direct-from-source.gif)

```bash
skills-sync profile add-skill personal \
  --source https://github.com/openai/skills/tree/main/skills/.curated \
  --upstream-id openai_curated \
  --all
```

### List and search skills

![List and search skills demo](docs/demo/list-and-search-skills.gif)

```bash
skills-sync list skills --profile personal --detail full
skills-sync search skills --query matlab --scope discoverable
skills-sync search skills --query spreadsheet --profile personal --scope installed
```

### Inspect and refresh imported state

![Inspect and refresh imported state demo](docs/demo/inspect-and-refresh-state.gif)

```bash
skills-sync profile inspect personal
skills-sync profile refresh personal --dry-run
skills-sync profile refresh personal --upstream matlab_skills
```

### Check agent drift

![Check drift across local agents demo](docs/demo/agents-drift.gif)

```bash
skills-sync agents inventory
skills-sync agents drift --dry-run
```

### Export and reconcile workspace state

![Workspace sync demo](docs/demo/workspace-sync.gif)

```bash
skills-sync workspace export
skills-sync workspace diff --format json
skills-sync workspace sync --dry-run
```

## Documentation

- [docs/commands.md](docs/commands.md)
- [docs/user-guide.md](docs/user-guide.md)
- [docs/agent-integrations.md](docs/agent-integrations.md)

## License

[MIT](LICENSE)
