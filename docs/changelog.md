# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Added Copilot runtime target support:
  - skills path: `~/.copilot/skills` (Windows: `%USERPROFILE%\\.copilot\\skills`)
  - MCP config path: `~/.copilot/mcp-config.json` (Windows: `%USERPROFILE%\\.copilot\\mcp-config.json`)
  - default target policy: `canOverride: true`
- Wired Copilot through build/apply/unlink/detect/doctor flows.
- Extended integration fixtures/tests to validate Copilot behavior.
