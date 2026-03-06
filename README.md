# skills-sync

![npm version](https://img.shields.io/npm/v/@ryanreh99/skills-sync)
![npm downloads](https://img.shields.io/npm/dw/@ryanreh99/skills-sync)

skills-sync keeps AI agent skills and MCP servers synchronized across various AI coding agents.

---

AI coding tools store skills and MCP definitions in different directories and configuration formats. Maintaining the same setup across multiple agents usually requires duplicating configuration, copying skill folders, and updating MCP server lists separately for each tool.

skills-sync provides a CLI for managing these definitions in one place and applying them to each supported agent. Skills can be sourced from local directories, public repositories, or private repositories.

If you create a skill or install an MCP server for one agent, skills-sync can synchronize it across your other agents so the same capabilities are available everywhere.

`skills-sync` works across any environment where these agents run, including both **IDEs and terminal-based workflows**.
## Supported Agents


![Codex](https://img.shields.io/badge/Codex-supported-412991?logo=openaigym&logoColor=white)
![Cursor](https://img.shields.io/badge/Cursor-supported-000000?logo=cursor)![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4?logo=google)
![Copilot](https://img.shields.io/badge/Copilot-supported-2F80ED?logo=githubcopilot)
![Claude Code](https://img.shields.io/badge/Claude%20Code-experimental-orange?logo=anthropic&logoColor=white)

## Installation

npm:

```bash
npm i -g @ryanreh99/skills-sync
```

Homebrew:

```bash
brew tap ryanreh99/skills-sync
brew install ryanreh99/skills-sync/skills-sync
```

## Quickstart

### Initialize and Sync

```bash
# 1) scaffold local workspace
skills-sync init --seed

# 2) build runtime artifacts
skills-sync build

# 3) apply to agent targets
skills-sync apply
```

### List Current State

```bash
# effective skills in active profile
skills-sync list skills

# effective MCP servers in active profile
skills-sync list mcps

# configured upstream repositories
skills-sync list upstreams
```

### Add Upstream, Skill, and MCP

```bash
# add an upstream (ID inferred: matlab_skills)
skills-sync profile add-upstream --repo https://github.com/matlab/skills

# inspect discoverable upstream content
skills-sync list upstream-content --upstream matlab_skills

# import one upstream skill
skills-sync profile add-skill --upstream matlab_skills --path skills/matlab-test-generator

# add GitHub MCP endpoint
skills-sync profile add-mcp io.github.github/github-mcp-server --url https://api.githubcopilot.com/mcp/
```

#### Note: Remember to run build and apply next

### Drift and Profile Check

```bash
# compare expected profile state vs installed agent state
skills-sync agents drift

# show profile summary
skills-sync profile show
```

### Search Skills

```bash
# fuzzy search skills by keyword
skills-sync search skills --query design
```

## Verify In Agent Chats

After `apply`, run these in your agent chat to confirm skills and MCP servers are available:

```text
/skills list or /skills show
/mcp list
```

## Documentation

Full documentation lives in the docs directory:

- [docs/user-guide.md](docs/user-guide.md)
- [docs/commands.md](docs/commands.md)

## License

[MIT](LICENSE)
