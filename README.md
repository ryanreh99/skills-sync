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

## Quick Start

```bash
# Initialize local workspace from bundled starter content
skills-sync init --seed

# Build canonical artifacts from your active profile
skills-sync build

# Apply generated skills and MCP config to detected agent targets
skills-sync apply
```

These commands initialize your workspace, build canonical artifacts, apply them to detected agents, and verify health.

## Interactive Shell

Run `skills-sync` (no args) to launch interactive shell mode with command completion and colorized prompts.

```bash
skills-sync
```

Inside shell mode:

```text
Run: init --seed then build then apply
/list               # arrow-key menu for list commands
/agents             # arrow-key menu for agents inventory/drift
/profile            # arrow-key menu for profile management commands
/search             # arrow-key menu for common search commands
search skills --upstream anthropic --query mcp
exit
```

`/list`, `/agents`, `/profile`, and `/search` also work as direct CLI root aliases in non-interactive mode:

```bash
skills-sync /list profiles
skills-sync /agents inventory
skills-sync /profile show
skills-sync /search skills --query mcp
```

## Verify In Agent Chats

After `apply`, run these in your agent chat to confirm skills and MCP servers are available:

```text
/skills list or /skills show
/mcp list
```

## Documentation

Full documentation lives in the docs directory:

- [docs/quickstart.md](docs/quickstart.md)
- [docs/user-guide.md](docs/user-guide.md)
- [docs/commands.md](docs/commands.md)

## License

[MIT](LICENSE)
