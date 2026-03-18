## 1.2.2

Claude support hardening and release metadata update.

Features
- Promoted Claude Code from experimental to supported in the public support matrix
- Switched Claude skill projection to top-level alias discovery so nested imported skills are reliably discoverable, matching the flat projection behavior used for Gemini-style integrations
- Added integration coverage to verify Claude skill projections expose top-level discoverable skills after apply
- Updated Claude storage/projection notes to reflect the tested runtime behavior

## 1.2.1

Interactive shell polish and demo refresh.

Features
- Rebuilt the interactive shell into an explorer-first full-screen TTY experience using `neo-blessed`
- Simplified the shell explorer so `Skills`, `MCPs`, and `Upstreams` each keep related list and manage actions together, with upstream content browsing included directly in the explorer
- Removed the old shell fallback mode and standardized on the new TTY shell plus normal non-interactive CLI commands
- Added a persistent transcript with cursor navigation, search, selection, and clipboard copy support
- Improved transcript readability by adding clearer section emphasis for list-style output inside interactive mode
- Tightened shell behavior around focus, prompt opening, command-state clearing, and modal dismissal
- Added a real PTY-based interactive test suite and expanded shell unit coverage
- Reworked demo recording to capture the live interactive shell with color instead of a mocked frame renderer
- Regenerated README demo GIFs to reflect the new explorer-first shell and navigation flows

## 1.1.1

Major UX and workflow update.

Features
- Added an interactive shell with command completion, shortcut menus, profile context, and improved terminal UI
- Added workspace manifest workflows with `workspace export`, `workspace import`, `workspace diff`, and `workspace sync`
- Added richer agent inventory and drift reporting, plus MCP inventory output
- Added richer reproducibility metadata for imported skills in `workspace/skills-sync.lock.json`, including source identity, normalized source descriptors, resolved revisions, content digests, projection metadata, refresh metadata, and eval placeholders
- Added explicit agent compatibility metadata so projections can describe discovery rules, nested skill handling, MCP assumptions, and projection contract versions
- Added structured drift diagnostics such as `content-mismatch`, `projection-mismatch`, `changed-managed-mcp`, and `compatibility-degraded`
- Fixed Copilot MCP projection so managed stdio/remote servers use Copilot's current `type`-based config shape instead of legacy `transport` output
- Added source normalization and upstream discovery support for GitHub shorthand, hosted subdirectory URLs, GitLab tree URLs, and local-path sources
- Added git and local-path providers, import lock handling, profile runtime state, and skill capability scanning
- Added profile inspection and refresh workflows, along with stronger profile import/export, clone, and skill scaffolding support
- Added demo automation scripts and recorded workflow GIFs for the README
- Standardized CLI and docs around `sync` as the primary workflow
- Profile mutations now sync automatically by default, with `--no-sync` to opt out
- Improved Git ref resolution with fallback behavior when resolving upstream refs, with matching test coverage for the recovery path

## 1.0.0

Initial public release.

Features
- Skills synchronization across AI agents
- MCP configuration management
- Profile-based setup
- CLI commands: init, build, apply, doctor
