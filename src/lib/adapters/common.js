import fs from "fs-extra";
import path from "node:path";
import { createDirectoryBinding, createFileBinding, detectOsName } from "../core.js";

export async function linkDirectoryProjection(sourcePath, targetPath) {
  await fs.ensureDir(path.dirname(targetPath));
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }

  try {
    const osName = detectOsName();
    return await createDirectoryBinding(sourcePath, targetPath, osName);
  } catch {
    await fs.copy(sourcePath, targetPath);
    return "copy";
  }
}

export async function linkFileProjection(sourcePath, targetPath) {
  await fs.ensureDir(path.dirname(targetPath));
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }

  try {
    const osName = detectOsName();
    const binding = await createFileBinding(sourcePath, targetPath, osName);
    return binding.method;
  } catch {
    await fs.copyFile(sourcePath, targetPath);
    return "copy";
  }
}

export async function discoverBundledSkills(bundleSkillsPath, currentPath = "", entries = []) {
  const absolutePath = currentPath
    ? path.join(bundleSkillsPath, currentPath.split("/").join(path.sep))
    : bundleSkillsPath;
  const children = await fs.readdir(absolutePath, { withFileTypes: true });

  let hasSkill = false;
  for (const child of children) {
    if (child.isFile() && child.name === "SKILL.md") {
      hasSkill = true;
      break;
    }
  }
  if (hasSkill && currentPath.length > 0) {
    entries.push(currentPath);
  }

  const dirs = children
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort((left, right) => left.localeCompare(right));
  for (const directory of dirs) {
    const next = currentPath.length > 0 ? `${currentPath}/${directory}` : directory;
    await discoverBundledSkills(bundleSkillsPath, next, entries);
  }
  return entries;
}

function nextVendorAliasName(relativeSkillPath, usedNames) {
  const flattened = relativeSkillPath.split("/").join("__");
  const base = `vendor__${flattened}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}__${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function projectTopLevelSkills(bundleSkillsPath, runtimeSkillsPath) {
  await fs.copy(bundleSkillsPath, runtimeSkillsPath);
  const discovered = await discoverBundledSkills(bundleSkillsPath);
  const topLevelEntries = await fs.readdir(runtimeSkillsPath, { withFileTypes: true });
  const usedNames = new Set(topLevelEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

  for (const relativeSkillPath of discovered) {
    if (!relativeSkillPath.includes("/")) {
      continue;
    }
    const sourceSkillPath = path.join(bundleSkillsPath, relativeSkillPath.split("/").join(path.sep));
    const aliasName = nextVendorAliasName(relativeSkillPath, usedNames);
    await linkDirectoryProjection(sourceSkillPath, path.join(runtimeSkillsPath, aliasName));
    usedNames.add(aliasName);
  }
}

export async function projectCommonFromBundle({ runtimeInternalRoot, bundleSkillsPath, bundleMcpPath }) {
  const commonRoot = path.join(runtimeInternalRoot, "common");
  await fs.ensureDir(commonRoot);
  const skillsMethod = await linkDirectoryProjection(bundleSkillsPath, path.join(commonRoot, "skills"));
  const mcpMethod = await linkFileProjection(bundleMcpPath, path.join(commonRoot, "mcp.json"));
  return { skillsMethod, mcpMethod };
}

export async function projectToolFromBundle({ tool, runtimeInternalRoot, bundleSkillsPath, bundleMcpPath, packRoot }) {
  const toolDist = path.join(runtimeInternalRoot, tool);
  await fs.ensureDir(toolDist);

  const skillsMethod = await linkDirectoryProjection(bundleSkillsPath, path.join(toolDist, "skills"));
  const mcpMethod = await linkFileProjection(bundleMcpPath, path.join(toolDist, "mcp.json"));

  const overrideSource = path.join(packRoot, "tool-overrides", tool);
  if (await fs.pathExists(overrideSource)) {
    await fs.copy(overrideSource, path.join(toolDist, "tool-overrides"));
  }

  return { skillsMethod, mcpMethod };
}
