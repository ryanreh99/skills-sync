import fs from "fs-extra";
import path from "node:path";
import { createDirectoryBinding, createFileBinding, detectOsName, parseSimpleFrontmatter } from "../core.js";
import { getAgentRegistryById } from "../agent-registry.js";

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

function normalizeSkillSupport(skillSupport) {
  const support = skillSupport && typeof skillSupport === "object" && !Array.isArray(skillSupport) ? skillSupport : {};
  return {
    nestedDiscovery: support.nestedDiscovery !== false,
    frontmatter: support.frontmatter !== false,
    scripts: support.scripts !== false,
    assets: support.assets !== false,
    references: support.references !== false,
    helpers: support.helpers !== false
  };
}

async function resolveAgentSkillSupport(agent) {
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    return normalizeSkillSupport(agent.support?.skills);
  }
  if (typeof agent === "string" && agent.trim().length > 0) {
    const registryById = await getAgentRegistryById();
    return normalizeSkillSupport(registryById.get(agent.trim())?.support?.skills);
  }
  return normalizeSkillSupport(null);
}

function shouldProjectSkillEntry(entryName, skillSupport) {
  const normalizedName = String(entryName ?? "").trim().toLowerCase();
  if (normalizedName === "scripts") {
    return skillSupport.scripts;
  }
  if (normalizedName === "assets") {
    return skillSupport.assets;
  }
  if (normalizedName === "references") {
    return skillSupport.references;
  }
  if (normalizedName === "helpers" || normalizedName === "helper") {
    return skillSupport.helpers;
  }
  return true;
}

export function stripSkillFrontmatter(markdown) {
  const { frontmatter, bodyLines } = parseSimpleFrontmatter(String(markdown ?? ""));
  if (Object.keys(frontmatter).length === 0) {
    return String(markdown ?? "");
  }

  const trimmedBodyLines = [...bodyLines];
  while (trimmedBodyLines.length > 0 && trimmedBodyLines[0].trim().length === 0) {
    trimmedBodyLines.shift();
  }

  const body = trimmedBodyLines.join("\n").trimEnd();
  return body.length > 0 ? `${body}\n` : "";
}

export function renderProjectedSkillMarkdown(markdown, skillSupport) {
  const normalizedSupport = normalizeSkillSupport(skillSupport);
  if (normalizedSupport.frontmatter) {
    return String(markdown ?? "");
  }
  return stripSkillFrontmatter(markdown);
}

export async function materializeProjectedSkillDirectory(sourceSkillPath, targetSkillPath, skillSupport) {
  const normalizedSupport = normalizeSkillSupport(skillSupport);
  await fs.remove(targetSkillPath);
  await fs.ensureDir(targetSkillPath);

  const entries = (await fs.readdir(sourceSkillPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!shouldProjectSkillEntry(entry.name, normalizedSupport)) {
      continue;
    }

    const sourceEntryPath = path.join(sourceSkillPath, entry.name);
    const targetEntryPath = path.join(targetSkillPath, entry.name);

    if (entry.isFile() && entry.name === "SKILL.md") {
      const markdown = await fs.readFile(sourceEntryPath, "utf8");
      await fs.writeFile(targetEntryPath, renderProjectedSkillMarkdown(markdown, normalizedSupport), "utf8");
      continue;
    }

    await fs.copy(sourceEntryPath, targetEntryPath);
  }
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

export function buildSkillProjectionPlan(discoveredSkillPaths, nestedSkillDiscoverySupported = true) {
  const sortedPaths = [...new Set(Array.isArray(discoveredSkillPaths) ? discoveredSkillPaths : [])].sort((left, right) =>
    left.localeCompare(right)
  );
  const plan = new Map(sortedPaths.map((relativeSkillPath) => [relativeSkillPath, [relativeSkillPath]]));
  if (nestedSkillDiscoverySupported) {
    return plan;
  }

  const usedNames = new Set(
    sortedPaths
      .map((relativeSkillPath) => relativeSkillPath.split("/")[0])
      .filter((item) => item.length > 0)
  );
  for (const relativeSkillPath of sortedPaths) {
    if (!relativeSkillPath.includes("/")) {
      continue;
    }
    const aliasName = nextVendorAliasName(relativeSkillPath, usedNames);
    usedNames.add(aliasName);
    plan.get(relativeSkillPath).push(aliasName);
  }
  return plan;
}

export async function planBundledSkillProjection(bundleSkillsPath, agent) {
  const skillSupport = await resolveAgentSkillSupport(agent);
  const discovered = await discoverBundledSkills(bundleSkillsPath);
  return buildSkillProjectionPlan(discovered, skillSupport.nestedDiscovery);
}

export async function projectSkillsForAgent(bundleSkillsPath, runtimeSkillsPath, agent) {
  const skillSupport = await resolveAgentSkillSupport(agent);
  const projectionPlan = buildSkillProjectionPlan(
    await discoverBundledSkills(bundleSkillsPath),
    skillSupport.nestedDiscovery
  );

  await fs.remove(runtimeSkillsPath);
  await fs.ensureDir(runtimeSkillsPath);

  for (const [relativeSkillPath, projectedPaths] of projectionPlan.entries()) {
    const sourceSkillPath = path.join(bundleSkillsPath, relativeSkillPath.split("/").join(path.sep));
    const canonicalTargetPath = path.join(runtimeSkillsPath, relativeSkillPath.split("/").join(path.sep));
    await materializeProjectedSkillDirectory(sourceSkillPath, canonicalTargetPath, skillSupport);

    for (const aliasName of projectedPaths.slice(1)) {
      await fs.copy(canonicalTargetPath, path.join(runtimeSkillsPath, aliasName));
    }
  }

  return {
    skillsMethod: Array.from(projectionPlan.values()).some((projectedPaths) => projectedPaths.length > 1)
      ? "copy+aliases"
      : "generated-copy",
    projectionPlan
  };
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
