# Commands

## Run Modes
- Installed globally: `skills-sync <command> [options]`
- Local source dev: `npm run dev -- <command> [options]`
- Built local binary: `node ./dist/index.js <command> [options]`

Running `skills-sync` with no command opens interactive shell mode.

## Root Aliases
- `agent` is accepted as alias for `agents`
- `/list`, `/agents`, `/profile`, `/search` are accepted as root aliases (interactive and non-interactive)

## Command Surface
1. `init [--seed] [--dry-run] [--profile <name>]`
2. `build [--profile <name>] [--lock read|write|refresh]`
3. `apply [--profile <name>] [--build] [--dry-run]`
4. `doctor [--profile <name>]`
5. `detect [--format text|json] [--agents <comma-list>]`
6. `unlink [--dry-run]`
7. `list skills [--profile <name>] [--format text|json]`
8. `list upstreams [--format text|json]`
9. `list profiles [--format text|json]`
10. `list everything [--format text|json]`
11. `list agents [--agents <comma-list>] [--format text|json]`
12. `list upstream-content [--upstream <id>] [--ref <ref>] [--profile <name>] [--verbose] [--format text|json]`
13. `search skills --query <text> [--upstream <id>] [--ref <ref>] [--profile <name>] [--verbose] [--format text|json]`
14. `use [name]`
15. `current`
16. `ls`
17. `new [name]`
18. `remove [name]`
19. `profile show [name] [--format text|json]`
20. `profile add-skill [name] [--upstream <id>] [--path <repoPath>] [--ref <ref>] [--dest-prefix <prefix>]`
21. `profile remove-skill [name] [--upstream <id>] [--path <repoPath>] [--ref <ref>] [--dest-prefix <prefix>]`
22. `profile add-mcp [name] [server] [--command <command> [--args <arg...> | --arg <arg>...] [--env <KEY=VALUE...>] | --url <url>]`
23. `profile remove-mcp [name] [server]`
24. `profile export [name] [--output <path>]`
25. `profile import [name] [--input <path>] [--replace]`
26. `agents inventory [--agents <comma-list>] [--format text|json]`
27. `agents drift [--profile <name>] [--agents <comma-list>] [--dry-run] [--format text|json]`
28. `upstream add [id] [--repo <url>] [--default-ref <ref>] [--type git]`
29. `upstream remove [id]`
30. `shell [--profile <name>]`
31. `help`

Unknown commands fail with:
`Unknown command. See: help`

## Behavior Notes
- Prompts appear only on interactive TTY terminals and only when required mutating inputs are missing.
- Non-interactive mode stays strict and returns explicit argument errors.
- `use [name]` and `new [name]` default to `personal` when omitted.
- `build`, `apply`, and `doctor` can omit `--profile` when a default profile is set with `use`.
- `search skills` uses fuzzy ranking. Text output shows top 20 results; JSON returns full results.
- First `build` can take longer while upstream cache is initialized.

## Interactive Shell Shortcuts
- `/list`: menu for `list` subcommands
- `/agents`: menu for `agents inventory` and `agents drift`
- `/profile`: menu for `profile` subcommands
- `/search`: menu for common `search skills` commands
- `:profile <name>`: set shell profile context
- `:profile default`: reset shell profile context to default profile
- `:profile none`: clear shell profile context
