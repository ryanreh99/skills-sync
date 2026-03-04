# skills-sync

skills-sync synchronizes skills and MCP server configuration across AI coding agents.

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
npm install -g skills-sync
```

Homebrew:

```bash
brew tap ryanreh99/skills-sync
brew install ryanreh99/skills-sync/skills-sync
```

## Quick Start

```bash
# Initialize local workspace from bundled seed content
skills-sync init --seed

# Build canonical artifacts from your profile inputs
skills-sync build

# Apply generated skills and MCP config to detected agent targets
skills-sync apply
```

These commands initialize your local workspace, build canonical artifacts, and apply them to supported agent targets.

Paste your existing agent's `mcp.json` settings and ask an AI agent to generate the corresponding `skills-sync` commands.

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
