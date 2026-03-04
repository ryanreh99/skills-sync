import fs from "fs-extra";
import path from "node:path";
import { logWarn, readJsonFile } from "../core.js";
import { projectTopLevelSkills } from "./common.js";

export async function projectCopilotFromBundle(options) {
  const {
    runtimeInternalRoot,
    bundleSkillsPath,
    bundleMcpPath,
    packRoot,
    localConfigPath = null,
    canOverride = false
  } = options;
  const runtimeRoot = path.join(runtimeInternalRoot, ".copilot");
  await fs.ensureDir(runtimeRoot);

  const runtimeSkillsPath = path.join(runtimeRoot, "skills");
  await fs.remove(runtimeSkillsPath);
  await projectTopLevelSkills(bundleSkillsPath, runtimeSkillsPath);
  const skillsMethod = "copy+aliases";

  const canonicalMcp = await readJsonFile(bundleMcpPath);
  let projected = canonicalMcp;

  if (!canOverride && localConfigPath && (await fs.pathExists(localConfigPath))) {
    try {
      const existing = await readJsonFile(localConfigPath);
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error("expected JSON object root");
      }
      projected = {
        ...existing,
        mcpServers: canonicalMcp?.mcpServers ?? {}
      };
    } catch (error) {
      logWarn(`Failed to seed Copilot runtime config from local settings: ${error.message}`);
    }
  }

  const runtimeConfigPath = path.join(runtimeRoot, "mcp-config.json");
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");

  const overrideSource = path.join(packRoot, "tool-overrides", "copilot");
  if (await fs.pathExists(overrideSource)) {
    await fs.copy(overrideSource, path.join(runtimeRoot, "tool-overrides"));
  }

  return {
    skillsMethod,
    mcpMethod: "generated"
  };
}
