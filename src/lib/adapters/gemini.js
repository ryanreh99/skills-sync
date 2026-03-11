import fs from "fs-extra";
import path from "node:path";
import { logWarn, readJsonFile } from "../core.js";
import { buildAgentRuntimeMcpServers } from "../mcp-config.js";
import { projectSkillsForAgent } from "./common.js";

export async function projectGeminiFromBundle(options) {
  const {
    agent = null,
    runtimeInternalRoot,
    bundleSkillsPath,
    bundleMcpPath,
    packRoot,
    localConfigPath = null,
    hasNonMcpConfig = false
  } = options;
  const runtimeRoot = path.join(runtimeInternalRoot, ".gemini");
  await fs.ensureDir(runtimeRoot);

  const runtimeSkillsPath = path.join(runtimeRoot, "skills");
  const { skillsMethod, projectionPlan } = await projectSkillsForAgent(bundleSkillsPath, runtimeSkillsPath, agent ?? "gemini");
  await projectSkillsForAgent(bundleSkillsPath, path.join(runtimeRoot, "vendor_imports", "skills"), agent ?? "gemini");

  const canonicalMcp = await readJsonFile(bundleMcpPath);
  const projectedMcpServers = buildAgentRuntimeMcpServers(canonicalMcp, agent ?? {
    id: "gemini",
    mcpKind: "json-command-url"
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
      logWarn(`Failed to seed Gemini runtime config from local settings: ${error.message}`);
    }
  }

  const runtimeSettingsPath = path.join(runtimeRoot, "settings.json");
  await fs.writeFile(runtimeSettingsPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
  const mcpMethod = "generated";

  const overrideSource = path.join(packRoot, "tool-overrides", "gemini");
  if (await fs.pathExists(overrideSource)) {
    await fs.copy(overrideSource, path.join(runtimeRoot, "tool-overrides"));
  }

  return { skillsMethod, mcpMethod, projectionPlan };
}

export const projectFromBundle = projectGeminiFromBundle;
