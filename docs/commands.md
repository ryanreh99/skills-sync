# Commands

## Run Modes

- installed globally: `skills-sync <command> [options]`
- local dev source: `npm run dev -- <command> [options]`
- built local binary: `node ./dist/index.js <command> [options]`

Running `skills-sync` with no command opens interactive shell mode.
Shell mode is a TTY-only explorer-first full-screen shell UI with `Explorer` and `Transcript` panes plus an on-demand prompt.
The `Explorer` exposes the main interactive catalog for profiles, skills, MCPs, upstreams, and agents, and parameterized commands open the prompt with a prefilled command line.
When TTY features are unavailable, use normal CLI commands directly instead of shell mode.

## Root Commands

- `init [--seed] [--dry-run] [--profile <name>]`
- `sync [--profile <name>] [--agents <comma-list>] [--dry-run]`
- `unlink [--agents <comma-list>] [--dry-run]`
- `doctor [--profile <name>]`
- `detect [--format text|json] [--agents <comma-list>]`
- `use [name]`
- `current`
- `ls`
- `new [name]`
- `remove [name]`
- `shell [--profile <name>]`
- `help`

## List

- `list skills [--profile <name>] [--detail concise|full] [--agents <comma-list>] [--format text|json]`
- `list mcps [--profile <name>] [--format text|json]`
- `list upstreams [--format text|json]`
- `list profiles [--format text|json]`
- `list everything [--detail concise|full] [--format text|json]`
- `list agents [--agents <comma-list>] [--format text|json]`
- `list upstream-content [--upstream <id>] [--source <locator>] [--provider auto|git|local-path] [--root <path>] [--ref <ref>] [--profile <name>] [--verbose] [--format text|json]`

`list skills --detail full` shows profile ownership, source provenance, tracking mode, resolved revision, content digests, materialized agents, projection staleness, and feature-support metadata.

## Search

- `search skills --query <text> [--upstream <id>] [--source <locator>] [--provider auto|git|local-path] [--root <path>] [--ref <ref>] [--profile <name>] [--scope installed|discoverable|all] [--verbose] [--format text|json]`

`--scope discoverable` remains the default. JSON output returns full ranked results with source metadata.

## Profile

- `profile show [name] [--detail concise|full] [--agents <comma-list>] [--format text|json]`
- `profile inspect [name] [--format text|json]`
- `profile refresh [name] [--upstream <id>] [--path <repoPath> ...] [--all] [--no-sync] [--dry-run] [--format text|json]`
- `profile diff <left> <right> [--format text|json]`
- `profile clone <source> <target>`
- `profile new-skill <skillName> [--profile <name>] [--path <path>] [--frontmatter] [--include-scripts] [--include-references]`
- `profile add-skill [name] [--upstream <id>] [--upstream-id <id>] [--source <locator>] [--provider auto|git|local-path] [--root <path>] [--path <repoPath> ...] [--all] [--interactive] [--ref <ref>] [--pin] [--dest-prefix <prefix>] [--no-sync]`
- `profile remove-skill [name] [--upstream <id>] [--path <repoPath> ...] [--all] [--interactive] [--ref <ref>] [--dest-prefix <prefix>] [--prune-upstream] [--no-sync] [--yes]`
- `profile add-mcp [name] [server] [--command <command> [--args <arg...> | --arg <arg>...] [--env <KEY=VALUE...>] | --url <url>] [--no-sync]`
- `profile remove-mcp [name] [server] [--no-sync]`
- `profile export [name] [--output <path>]`
- `profile import [name] [--input <path>] [--replace] [--no-sync]`
- `profile add-upstream [id] [--source <locator>] [--repo <url>] [--provider auto|git|local-path] [--root <path>] [--default-ref <ref>] [--type git]`
- `profile remove-upstream [id]`

Notes:

- `profile add-upstream` and `profile remove-upstream` are aliases of `upstream add/remove`
- `--repo` remains supported as a backward-compatible alias for git sources
- `profile add-skill` can auto-register an upstream from `--source`
- `profile remove-skill` prompts for confirmation in TTY mode unless `--yes` is passed
- these commands sync automatically unless `--no-sync` is passed:
  `profile add-skill`, `profile remove-skill`, `profile add-mcp`, `profile remove-mcp`, `profile refresh`, `profile import`

## Upstream

- `upstream add [id] [--source <locator>] [--repo <url>] [--provider auto|git|local-path] [--root <path>] [--default-ref <ref>] [--type git]`
- `upstream remove [id]`

Supported native source locators:

- GitHub shorthand such as `owner/repo`
- full GitHub repo URLs
- GitHub subdirectory URLs
- GitLab tree URLs
- generic git URLs
- local filesystem paths

## Agents

- `agents inventory [--agents <comma-list>] [--format text|json]`
- `agents drift [--profile <name>] [--agents <comma-list>] [--dry-run] [--format text|json]`

`agents drift` includes structured classes such as `missing-skill`, `content-mismatch`, `projection-mismatch`, `compatibility-degraded`, `missing-managed-mcp`, `changed-managed-mcp`, and `extra-managed-mcp`.

## Workspace

- `workspace export [--output <path>]`
- `workspace import [--input <path>] [--replace]`
- `workspace diff [--input <path>] [--format text|json]`
- `workspace sync [--input <path>] [--dry-run]`

Default manifest path: `workspace/skills-sync.manifest.json`

## Behavior Notes

- prompts appear only on interactive TTY terminals
- `use [name]` and `new [name]` default to `personal`
- `sync` and `doctor` can omit `--profile` when a default profile is set
- `workspace/skills-sync.lock.json` is the canonical imported-source lockfile
- `workspace/skills-sync.manifest.json` is the canonical whole-workspace manifest
- unsupported optional skill capabilities are surfaced as warnings, not fatal import/sync errors
- unknown commands fail with `Unknown command. See: help`

## Interactive Shell Shortcuts

- `list`
- `agents`
- `profile`
- `search`
- `:profile <name>`
- `:profile default`
- `:profile none`

TTY shell notes:

- typed commands still use the normal CLI syntax and quoting rules
- the shell launches with `Explorer` focused and the command prompt hidden
- `Explorer` is a nested tree for `Setup`, `Profiles`, `Skills`, `MCPs`, `Upstreams`, and `Agents`
- `Transcript` keeps the running session output instead of replacing it with only the latest result
- `Tab` switches between `Explorer` and `Transcript`
- `:` opens the raw command prompt, `/` filters the `Explorer` or searches the `Transcript`
- `Space` starts or clears transcript selection, `y` copies the current selection or block, and `Ctrl+Y` copies the full transcript
- `workspace` commands still run from the raw prompt, but they do not appear in the explorer tree
- prompt-heavy flows such as `profile add-skill --interactive` temporarily hand control back to the normal terminal, then restore the TUI shell
