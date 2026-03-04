# Commands

Use either:
- `npm run <script> -- <args>`
- `node internal/scripts/skills-sync.mjs <command> <args>`

## Command Surface
1. `init [--seed]`
2. `build [--profile <name>] [--lock=read|write|refresh]`
3. `apply [--profile <name>] [--build] [--dry-run]`
4. `doctor [--profile <name>]`
5. `detect`
6. `detect [--format text|json] [--agents <comma-list>]`
7. `unlink [--dry-run]`
8. `list upstreams [--format text|json]`
9. `list skills [--upstream <id>] [--ref <ref>] [--profile <name>] [--format text|json]`
10. `list upstream-content [--upstream <id>] [--ref <ref>] [--profile <name>] [--format text|json]`
11. `list profiles [--format text|json]`
12. `list everything [--format text|json]`
13. `profile show [name] [--format text|json]`
14. `profile add-skill <name> --upstream <id> --path <repoPath> [--ref <ref>] [--dest-prefix <prefix>]`
15. `profile remove-skill <name> --upstream <id> --path <repoPath> [--ref <ref>] [--dest-prefix <prefix>]`
16. `profile add-mcp <name> <server> --command <command> [--args <arg...>] [--env <KEY=VALUE...>]`
17. `profile remove-mcp <name> <server>`
18. `profile export [name] [--output <path>]`
19. `profile import <name> --input <path> [--replace]`
20. `agent inventory [--agents <comma-list>] [--format text|json]`
21. `agent drift [--profile <name>] [--agents <comma-list>] [--dry-run] [--format text|json]`
22. `upstream add <id> --repo <url> [--default-ref <ref>] [--type git]`
23. `upstream remove <id>`
24. `search skills [--upstream <id>] [--ref <ref>] [--profile <name>] --query <text> [--format text|json]`
25. `search skills [--upstream <id>] [--ref <ref>] [--profile <name>] --interactive`
26. `use <name>`
27. `current`
28. `ls`
29. `new <name>`
30. `remove <name>`
31. `help`

Unknown commands fail with:
`Unknown command. See: skills-sync help`

## Notes
- `init`: scaffolds minimal workspace only (non-destructive).
- `init --seed`: backs up existing workspace and copies seed content (no build).
- `apply`: does not build unless `--build` is provided. If `--profile` is omitted, it uses the profile embedded in `~/.skills-sync/internal/common/bundle.json`.
- `apply --dry-run`: prints planned bind/config operations without touching files or state.
- `detect`: prints resolved target paths and support mode per agent.
- `detect --agents`: limits output to selected agents (for example: `codex,claude`).
- `doctor`: validates contracts, lock pins, dist projections, and bindings.
- `unlink --dry-run`: previews removals without deleting bindings or MCP entries.
- `list upstreams`: lists configured upstream repositories and default refs.
- `list skills`: lists all skills (path + title) available under `skills/**/SKILL.md`. If `--upstream` is omitted, it lists across profile-derived refs (or all upstream defaults when no profile is provided).
- `list upstream-content`: lists both skills and any discoverable upstream MCP manifests (`**/mcp/servers.json`) for selected upstream refs.
- `list profiles`: same profile listing as `ls`, with optional JSON output.
- `list everything`: prints every discovered profile plus its local/imported skills and MCP servers.
- `profile show [name]`: shows one profile's local skills, imported skills, and MCP servers (defaults to current profile if omitted).
- `profile add-skill` / `profile remove-skill`: edits `workspace/packs/<name>/sources.json` skill imports.
- `profile add-mcp` / `profile remove-mcp`: edits `workspace/packs/<name>/mcp/servers.json` (`--env` entries use `KEY=VALUE` format).
- `profile export`: exports profile pack config and local skill files to JSON for migration.
- `profile import`: imports exported profile config into local workspace.
- `agent inventory`: inspects installed skills and MCP servers per detected agent, including parse issues.
- `agent drift --dry-run`: compares profile-expected skills/MCP against installed agent state without mutating files.
- `agent drift`: reconciles drift by promoting detected extra MCP servers into the selected profile, then rebuilds and applies across detected agents before reporting final drift.
- `upstream add` / `upstream remove`: edits `workspace/upstreams.json`. Removing also prunes matching lock pins from `workspace/upstreams.lock.json`.
- `search skills` (non-interactive): filters skills by keyword matched case-insensitively against skill path and title.
- `search skills --interactive`: prompt-based search loop for ad-hoc exploration.
- `use <name>`: writes `{ "defaultProfile": "<name>" }` to `workspace/config.json`. After this, `--profile` can be omitted from `build`, `apply`, and `doctor`.
- `current`: prints the current default profile name from `workspace/config.json`.
- `ls`: lists all profiles found in `workspace/profiles/` and `internal/seed/profiles/`, marking the default with `->`.
- `new <name>`: scaffolds a new profile JSON and pack directory under `workspace/` (non-destructive).
- `remove <name>`: deletes `workspace/profiles/<name>.json` and clears the default if it matched. Pack directory is preserved.

## Default Profile (`workspace/config.json`)
`--profile` is optional on `build`, `apply`, and `doctor`. When omitted, the CLI reads `defaultProfile` from `workspace/config.json`.

Set it once:
```bash
skills-sync use personal
# or edit workspace/config.json directly:
# { "defaultProfile": "personal" }
```

Then omit `--profile` everywhere:
```bash
skills-sync build
skills-sync apply
skills-sync doctor
```

## Lock Modes (`build`)
- `write` (default): writes missing pins.
- `read`: never writes lockfile; fails when required pins are missing.
- `refresh`: refreshes pins for all refs used by the selected profile.
