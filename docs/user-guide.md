# User Guide

`skills-sync` manages profile-scoped skills and MCP servers across Codex, Claude Code, Cursor, Copilot, and Gemini.

## Direct CLI Mode
Use full commands when not in shell mode.

```bash
skills-sync /init --seed
skills-sync use personal
skills-sync /build
skills-sync /apply
skills-sync /doctor
```

Slash-style root aliases are supported in direct mode too:

```bash
skills-sync /list profiles
skills-sync /agents inventory
skills-sync /profile show
skills-sync /search skills --query mcp
```

## Interactive Mode
Run `skills-sync` with no args to open shell mode.

Inside shell:
- `/list` shows list command menu
- `/agents` shows inventory/drift menu
- `/profile` shows profile command menu
- `/search` shows search mode menu, then prompts for query text
- `:profile <name>` sets shell profile context
- `exit` closes shell

Example session:

```text
skills-sync
skills-sync(personal) > /init --seed
skills-sync(personal) > use personal
skills-sync(personal) > /build
skills-sync(personal) > /apply
skills-sync(personal) > /doctor
skills-sync(personal) > exit
```

## Common Tasks

### Manage Profiles
```bash
skills-sync new work
skills-sync use work
skills-sync current
skills-sync ls
skills-sync list skills
skills-sync list mcps
skills-sync profile show
```

### Add Upstream, Skill, and MCP
```bash
skills-sync profile add-upstream anthropic --repo https://github.com/anthropics/claude-code
skills-sync list upstream-content --upstream anthropic --format text
skills-sync profile add-skill personal --upstream anthropic --path skills/claude-code-review
skills-sync profile add-mcp personal filesystem --command npx --args -y @modelcontextprotocol/server-filesystem C:\Users\ryanr\Documents
skills-sync profile add-mcp personal github --url https://api.githubcopilot.com/mcp/
skills-sync /build
skills-sync /apply
skills-sync /doctor
```

### Search Skills
`search skills` uses fuzzy matching by default.
- Matches `path` and `basename`
- Includes `title` matching with `--verbose`
- Text output shows top 20 matches
- JSON output returns full results

```bash
skills-sync search skills --query mcp --upstream anthropic
skills-sync search skills --query git --upstream anthropic --verbose --format json
```

### Agent Inventory and Drift
```bash
skills-sync agents inventory --format text
skills-sync agents drift --dry-run --format text
skills-sync agents drift --format text
```

### Cleanup
```bash
skills-sync /unlink --dry-run
skills-sync /unlink
skills-sync profile remove-skill personal --upstream anthropic --path skills/claude-code-review
skills-sync profile remove-mcp personal filesystem
skills-sync profile remove-upstream anthropic
skills-sync /build
skills-sync /apply
skills-sync /doctor
```

## Prompt Behavior
- Missing required inputs on mutating commands prompt only in interactive TTY terminals.
- Non-interactive runs stay strict and return explicit errors.
- Prompt cancellation exits cleanly with no partial mutation.
- `profile add-skill` / `profile remove-skill` now show a selectable list of configured upstream IDs when `--upstream` is omitted.

## Notes
- First `build` can be slower while upstream cache initializes.
- `use` and `new` default to `personal` when name is omitted.
- Unknown commands return: `Unknown command. See: help`.
