# User Guide

`skills-sync` manages profile-scoped skills and MCP servers across Codex, Claude Code, Cursor, Copilot, and Gemini CLI.

## Initial Setup on a New Machine

### Commands

```bash
# Install the CLI globally
npm install -g skills-sync
# Initialize an empty workspace scaffold
skills-sync init
# Initialize workspace with bundled starter content
skills-sync init --seed
# Set your default active profile
skills-sync use <profile>
# Build runtime artifacts for a profile
skills-sync build --profile <profile>
# Apply profile artifacts to all detected agents
skills-sync apply --profile <profile>
# Validate profile state and agent bindings
skills-sync doctor --profile <profile>
```

### Example

```bash
# Install the CLI globally
npm install -g skills-sync
# Initialize workspace with bundled starter content
skills-sync init --seed
# Set personal as the default active profile
skills-sync use personal
# Build runtime artifacts for personal profile
skills-sync build --profile personal
# Apply personal profile to all detected agents
skills-sync apply --profile personal
# Validate personal profile state and bindings
skills-sync doctor --profile personal
```

## Profile Switch

### Commands

```bash
# Create a new profile scaffold
skills-sync new <profile>
# Switch default profile to the new one
skills-sync use <profile>
# Show the current default profile
skills-sync current
# List all available profiles
skills-sync ls
# Build artifacts for the selected profile
skills-sync build --profile <profile>
# Apply selected profile to detected agents
skills-sync apply --profile <profile>
# Validate selected profile setup
skills-sync doctor --profile <profile>
```

### Example

```bash
# Create a work profile scaffold
skills-sync new work
# Switch default profile to work
skills-sync use work
# Build artifacts for work profile
skills-sync build --profile work
# Apply work profile to detected agents
skills-sync apply --profile work
# Validate work profile setup
skills-sync doctor --profile work
```

## List and Search Upstreams, Profiles, Skills, and MCP

### Commands

```bash
# List configured upstream repositories
skills-sync list upstreams
# Add an upstream before filtering by its id (if not already configured)
skills-sync upstream add <upstream-id> --repo <git-url> --default-ref <ref>
# List discovered profiles
skills-sync list profiles
# List profiles with current default marker
skills-sync ls
# List skills available from an upstream
skills-sync list skills --upstream <upstream-id> --format text
# Search upstream skills by keyword
skills-sync search skills --upstream <upstream-id> --query <keyword>
# Show profile skills and MCP servers
skills-sync profile show <profile>
# Show all profiles with effective resources
skills-sync list everything --format text
# Inspect installed resources on detected agents
skills-sync agent inventory --format text
```

### Example

```bash
# List configured upstream repositories
skills-sync list upstreams
# Add anthropics upstream (run once)
skills-sync upstream add anthropics --repo https://github.com/anthropics/claude-code --default-ref main
# List skills from anthropics upstream
skills-sync list skills --upstream anthropics --format text
# Search anthropics skills for MCP related entries
skills-sync search skills --upstream anthropics --query mcp
# Show skills and MCP servers in personal profile
skills-sync profile show personal
# Inspect installed resources on detected agents
skills-sync agent inventory --format text
```

## Add Upstreams, Skills, and MCP to a Profile

Use a skill path that appears in `skills-sync list skills --upstream anthropics --format text`.

### Commands

```bash
# Add a new upstream repository
skills-sync upstream add <upstream-id> --repo <git-url> --default-ref <ref>
# List skills available from the upstream
skills-sync list skills --upstream <upstream-id> --format text
# Add a skill import to a profile
skills-sync profile add-skill <profile> --upstream <upstream-id> --path <repo-skill-path>
# Add a stdio MCP server definition to a profile
skills-sync profile add-mcp <profile> <mcp-name> --command <command> --args <arg1> <arg2> ...
# Add a stdio MCP server with dash-prefixed args
skills-sync profile add-mcp <profile> <mcp-name> --command <command> --arg <arg1> --arg <arg2> ...
# Add an HTTP MCP server definition to a profile
skills-sync profile add-mcp <profile> <mcp-name> --url <https-url>
# Verify profile resources after updates
skills-sync profile show <profile>
# Build updated profile artifacts
skills-sync build --profile <profile>
# Apply updated profile to detected agents
skills-sync apply --profile <profile>
# Validate updated profile and bindings
skills-sync doctor --profile <profile>
```

### Example

```bash
# Add anthropics repository as an upstream
skills-sync upstream add anthropics --repo https://github.com/anthropics/claude-code --default-ref main
# List skills available from anthropics
skills-sync list skills --upstream anthropics --format text
# Add one anthropics skill path to personal profile
skills-sync profile add-skill personal --upstream anthropics --path skills/claude-code-review
# Remove anthropics upstream
skills-sync upstream remove anthropics
# Add filesystem MCP server to personal profile
skills-sync profile add-mcp personal filesystem --command npx --args -y @modelcontextprotocol/server-filesystem C:\Users\ryanr\Documents
# Add GitHub MCP server over HTTP to personal profile
skills-sync profile add-mcp personal io.github.github/github-mcp-server --url https://api.githubcopilot.com/mcp/
# Build updated personal profile artifacts
skills-sync build --profile personal
# Apply updated personal profile to detected agents
skills-sync apply --profile personal
# Validate updated personal profile setup
skills-sync doctor --profile personal
```

## Apply a Skill or MCP to All Your Agents

If you installed an MCP server or created a skill in one agent, add it to your profile and run one rollout.

### Commands

```bash
# Add a skill import to the profile
skills-sync profile add-skill <profile> --upstream <upstream-id> --path <repo-skill-path>
# Add a stdio MCP server to the profile
skills-sync profile add-mcp <profile> <mcp-name> --command <command> --args <arg1> <arg2> ...
# Add a stdio MCP server with dash-prefixed args
skills-sync profile add-mcp <profile> <mcp-name> --command <command> --arg <arg1> --arg <arg2> ...
# Add an HTTP MCP server to the profile
skills-sync profile add-mcp <profile> <mcp-name> --url <https-url>
# Build artifacts with new skill and MCP entries
skills-sync build --profile <profile>
# Apply updated profile to all detected agents
skills-sync apply --profile <profile>
# Validate final state after rollout
skills-sync doctor --profile <profile>
# Inspect installed resources per detected agent
skills-sync agent inventory --format text
# Preview drift between profile and agents (no changes)
skills-sync agent drift --profile <profile> --dry-run --format text
# Reconcile drift across detected agents and shared .skills-sync artifacts
# (extra MCP servers detected in agents are promoted into profile before rebuild/apply)
skills-sync agent drift --profile <profile> --format text
```

### Example

```bash
# Install an mcp for any specific agent
# Check the drift
skills-sync agent drift --dry-run
# Fix the drift and apply to all agents
skills-sync agent drift
```

## Clean, Unlink, and Doctor

### Commands

```bash
# Run health checks for a profile
skills-sync doctor --profile <profile>
# Preview unlink actions without modifying files
skills-sync unlink --dry-run
# Remove managed bindings from detected agents
skills-sync unlink
# Remove an imported skill from profile configuration
skills-sync profile remove-skill <profile> --upstream <upstream-id> --path <repo-skill-path>
# Remove an MCP server from profile configuration
skills-sync profile remove-mcp <profile> <mcp-name>
# Remove upstream repository from configuration
skills-sync upstream remove <upstream-id>
# Rebuild artifacts after cleanup
skills-sync build --profile <profile>
# Re-apply cleaned profile to detected agents
skills-sync apply --profile <profile>
# Re-run health checks after cleanup
skills-sync doctor --profile <profile>
```

### Example

```bash
# Preview unlink actions without modifying files
skills-sync unlink --dry-run
# Remove filesystem MCP server from personal profile
skills-sync profile remove-mcp personal filesystem
# Remove managed bindings from detected agents
skills-sync unlink
# Build cleaned personal profile
skills-sync build --profile personal
# Apply cleaned personal profile to detected agents
skills-sync apply --profile personal
# Validate cleaned personal profile
skills-sync doctor --profile personal
```
