# Commands

## Run Modes
- Installed globally: `skills-sync <command> [options]`
- Local source dev: `npm run dev -- <command> [options]`
- Built local binary: `node ./dist/index.js <command> [options]`

Running `skills-sync` with no command opens interactive shell mode.

## Root Aliases
- `agent` is accepted as alias for `agents`
- Leading `/` on root commands is accepted for compatibility (for example `/build` -> `build`)

## Command Surface
1. `init [--seed] [--dry-run] [--profile <name>]`
2. `build [--profile <name>] [--lock read|write|refresh]`
3. `apply [--profile <name>] [--build] [--dry-run]`
4. `doctor [--profile <name>]`
5. `detect [--format text|json] [--agents <comma-list>]`
6. `unlink [--dry-run]`
7. `list skills [--profile <name>] [--format text|json]`
8. `list mcps [--profile <name>] [--format text|json]`
9. `list upstreams [--format text|json]`
10. `list profiles [--format text|json]`
11. `list everything [--format text|json]`
12. `list agents [--agents <comma-list>] [--format text|json]`
13. `list upstream-content [--upstream <id>] [--ref <ref>] [--profile <name>] [--verbose] [--format text|json]`
14. `search skills --query <text> [--upstream <id>] [--ref <ref>] [--profile <name>] [--verbose] [--format text|json]`
15. `use [name]`
16. `current`
17. `ls`
18. `new [name]`
19. `remove [name]`
20. `profile show [name] [--format text|json]`
21. `profile add-skill [name] [--upstream <id>] [--path <repoPath>] [--ref <ref>] [--dest-prefix <prefix>]`
22. `profile remove-skill [name] [--upstream <id>] [--path <repoPath>] [--ref <ref>] [--dest-prefix <prefix>]`
23. `profile add-mcp [name] [server] [--command <command> [--args <arg...> | --arg <arg>...] [--env <KEY=VALUE...>] | --url <url>]`
24. `profile remove-mcp [name] [server]`
25. `profile export [name] [--output <path>]`
26. `profile import [name] [--input <path>] [--replace]`
27. `profile add-upstream [id] [--repo <url>] [--default-ref <ref>] [--type git]`
28. `profile remove-upstream [id]`
29. `agents inventory [--agents <comma-list>] [--format text|json]`
30. `agents drift [--profile <name>] [--agents <comma-list>] [--dry-run] [--format text|json]`
31. `upstream add [id] [--repo <url>] [--default-ref <ref>] [--type git]`
32. `upstream remove [id]`
33. `shell [--profile <name>]`
34. `help`

Unknown commands fail with:
`Unknown command. See: help`

## Behavior Notes
- Prompts appear only on interactive TTY terminals and only when required mutating inputs are missing.
- Non-interactive mode stays strict and returns explicit argument errors.
- `use [name]` and `new [name]` default to `personal` when omitted.
- `profile add-skill [name]` falls back to current/default profile when omitted.
- `profile add-mcp [name] [server]` and `profile remove-mcp [name] [server]` fall back to current/default profile when profile name is omitted.
- When `--upstream` is omitted for `profile add-skill`/`profile remove-skill`, interactive mode shows configured upstream IDs as a select list.
- `profile add-upstream` and `profile remove-upstream` are aliases of `upstream add/remove`.
- Auto-inferred upstream IDs use `owner_repo` for GitHub URLs/SSH (for example `ryanreh99_skills`), with `_2`, `_3`, ... on conflicts.
- `upstream add`/`profile add-upstream` auto-detect `defaultRef` from repo HEAD when `--default-ref` is omitted (fallback: `main`).
- `build`, `apply`, and `doctor` can omit `--profile` when a default profile is set with `use`.
- `search skills` uses fuzzy ranking. Text output shows top 20 results; JSON returns full results.
- First `build` can take longer while upstream cache is initialized.

## Interactive Shell Shortcuts
- `list`: menu for `list` subcommands
- `agents`: menu for `agents inventory` and `agents drift`
- `profile`: menu for `profile` subcommands
- `search`: choose search mode, then enter query text for `search skills`
- `:profile <name>`: set shell profile context
- `:profile default`: reset shell profile context to default profile
- `:profile none`: clear shell profile context
