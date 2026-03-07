## 1.1.0

Major UX and workflow update.

Features
- Added an interactive shell with command completion, shortcut menus, profile context, and improved terminal UI
- Added workspace manifest workflows with `workspace export`, `workspace import`, `workspace diff`, and `workspace sync`
- Added richer agent inventory and drift reporting, plus MCP inventory output
- Added source normalization and upstream discovery support for GitHub shorthand, hosted subdirectory URLs, GitLab tree URLs, and local-path sources
- Added git and local-path providers, import lock handling, profile runtime state, and skill capability scanning
- Added profile inspection and refresh workflows, along with stronger profile import/export, clone, and skill scaffolding support
- Added demo automation scripts and recorded workflow GIFs for the README
- Standardized CLI and docs around `sync` as the primary workflow
- Profile mutations now sync automatically by default, with `--no-sync` to opt out

## 1.0.0

Initial public release.

Features
- Skills synchronization across AI agents
- MCP configuration management
- Profile-based setup
- CLI commands: init, build, apply, doctor
