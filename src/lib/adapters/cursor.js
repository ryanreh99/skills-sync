import fs from "fs-extra";
import path from "node:path";
import { logWarn, readJsonFile } from "../core.js";
import { buildAgentRuntimeMcpServers } from "../mcp-config.js";
import { projectSkillsForAgent } from "./common.js";

export async function projectCursorFromBundle(options) {
  const {
    agent = null,
    runtimeInternalRoot,
    bundleSkillsPath,
    bundleMcpPath,
    packRoot,
    localConfigPath = null,
    hasNonMcpConfig = false
  } = options;
  const runtimeRoot = path.join(runtimeInternalRoot, ".cursor");
  await fs.ensureDir(runtimeRoot);

  const runtimeSkillsPath = path.join(runtimeRoot, "skills");
  const { skillsMethod, projectionPlan } = await projectSkillsForAgent(bundleSkillsPath, runtimeSkillsPath, agent ?? "cursor");

  const canonicalMcp = await readJsonFile(bundleMcpPath);
  const projectedMcpServers = buildAgentRuntimeMcpServers(canonicalMcp, agent ?? {
    id: "cursor",
    mcpKind: "json-mcpServers"
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
      logWarn(`Failed to seed Cursor runtime config from local settings: ${error.message}`);
    }
  }

  const runtimeConfigPath = path.join(runtimeRoot, "mcp.json");
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");

  const overrideSource = path.join(packRoot, "tool-overrides", "cursor");
  if (await fs.pathExists(overrideSource)) {
    await fs.copy(overrideSource, path.join(runtimeRoot, "tool-overrides"));
  }

  return {
    skillsMethod,
    mcpMethod: "generated",
    projectionPlan
  };
}

export const projectFromBundle = projectCursorFromBundle;
