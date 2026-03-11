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
