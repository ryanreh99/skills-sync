import fs from "fs-extra";
import path from "node:path";
import { projectCommandsForAgent } from "../commands.js";
import { logWarn, readJsonFile } from "../core.js";
import { projectHooksForAgent } from "../hook-config.js";
import { buildAgentRuntimeMcpServers } from "../mcp-config.js";
import { projectSkillsForAgent } from "./common.js";

export async function projectClaudeFromBundle(options) {
  const {
    agent = null,
    runtimeInternalRoot,
    bundleSkillsPath,
    bundleMcpPath,
    bundleCommandsPath,
    bundleHooksPath,
    packRoot,
    localConfigPath = null,
    hasNonMcpConfig = false
  } = options;
  const runtimeRoot = path.join(runtimeInternalRoot, ".claude");
  await fs.ensureDir(runtimeRoot);

  const { skillsMethod, projectionPlan } = await projectSkillsForAgent(
    bundleSkillsPath,
    path.join(runtimeRoot, "skills"),
    agent ?? "claude"
  );
  await projectSkillsForAgent(bundleSkillsPath, path.join(runtimeRoot, "vendor_imports", "skills"), agent ?? "claude");
  const { commandsMethod } = await projectCommandsForAgent({
    bundleCommandsPath,
    runtimeCommandsPath: path.join(runtimeRoot, "commands"),
    agent: agent ?? { id: "claude", commandKind: "markdown-files", support: { commands: {} } }
  });

  const canonicalMcp = await readJsonFile(bundleMcpPath);
  const projectedMcpServers = buildAgentRuntimeMcpServers(canonicalMcp, agent ?? {
    id: "claude",
    mcpKind: "claude-json-type"
  });
  let projected = {
    ...canonicalMcp,
    mcpServers: projectedMcpServers
  };

  if (hasNonMcpConfig && localConfigPath && (await fs.pathExists(localConfigPath))) {
    try {
      const existing = await readJsonFile(localConfigPath);
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error("expected JSON object root");
      }
      projected = {
        ...existing,
        mcpServers: projectedMcpServers
      };
    } catch (error) {
      logWarn(`Failed to seed Claude runtime config from local settings: ${error.message}`);
    }
  }

  const runtimeConfigPath = path.join(runtimeRoot, "mcp.json");
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
  const mcpMethod = "generated";
  const { hooksMethod } = await projectHooksForAgent({
    bundleHooksPath,
    runtimeHooksPath: path.join(runtimeRoot, "hooks.json"),
    agent: agent ?? { id: "claude", hookKind: "json-hooks" }
  });

  const overrideSource = path.join(packRoot, "tool-overrides", "claude");
  if (await fs.pathExists(overrideSource)) {
    await fs.copy(overrideSource, path.join(runtimeRoot, "tool-overrides"));
  }

  return {
    skillsMethod,
    commandsMethod,
    mcpMethod,
    hooksMethod,
    projectionPlan
  };
}

export const projectFromBundle = projectClaudeFromBundle;
