import fs from "fs-extra";
import path from "node:path";
import { hashPathContent } from "../digest.js";
import { normalizeSelectionPath } from "../source-normalization.js";
import { scanSkillDirectory } from "../skill-capabilities.js";

async function walkSkills(rootPath, currentRelative = "", entries = []) {
  const absolute = currentRelative.length > 0 ? path.join(rootPath, currentRelative) : rootPath;
  const children = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);

  let hasSkill = false;
  for (const child of children) {
    if (child.isFile() && child.name === "SKILL.md") {
      hasSkill = true;
      break;
    }
  }

  if (hasSkill) {
    entries.push(currentRelative.length > 0 ? currentRelative.split(path.sep).join("/") : ".");
    return entries;
  }

  const directories = children
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort((left, right) => left.localeCompare(right));

  for (const directory of directories) {
    const nextRelative = currentRelative.length > 0 ? path.join(currentRelative, directory) : directory;
    await walkSkills(rootPath, nextRelative, entries);
  }

  return entries;
}

export const localPathProvider = {
  id: "local-path",
  async discover(upstream) {
    const rootPath = upstream.root ? path.join(upstream.path, upstream.root.split("/").join(path.sep)) : upstream.path;
    if (!(await fs.pathExists(rootPath))) {
      throw new Error(`Local source root '${rootPath}' was not found.`);
    }

    const skills = [];
    const discovered = await walkSkills(rootPath);
    for (const selectionPath of discovered.sort((left, right) => left.localeCompare(right))) {
      const skillRoot = selectionPath === "." ? rootPath : path.join(rootPath, selectionPath.split("/").join(path.sep));
      const scanned = await scanSkillDirectory(skillRoot);
      skills.push({
        path: selectionPath,
        title: scanned.title,
        summary: scanned.summary,
        capabilities: scanned.capabilities,
        frontmatter: scanned.frontmatter,
        sourcePath: skillRoot
      });
    }
    return {
      rootPath,
      revision: null,
      skills
    };
  },
  async materialize(upstream, selectionPath) {
    const normalized = normalizeSelectionPath(selectionPath, "selection path");
    const rootPath = upstream.root ? path.join(upstream.path, upstream.root.split("/").join(path.sep)) : upstream.path;
    const sourcePath = normalized === "." ? rootPath : path.join(rootPath, normalized.split("/").join(path.sep));
    const scan = await scanSkillDirectory(sourcePath);
    return {
      sourcePath,
      resolvedRevision: null,
      contentHash: await hashPathContent(sourcePath),
      capabilities: scan.capabilities,
      title: scan.title,
      summary: scan.summary
    };
  },
  async refresh(upstream, selectionPath) {
    return this.materialize(upstream, selectionPath);
  }
};
