import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import {
  checkoutCommit,
  detectDefaultRefFromRepo,
  ensureCommitAvailable,
  ensureUpstreamClone,
  fetchRefAndResolveCommit
} from "../git-runtime.js";
import { normalizeSelectionPath } from "../source-normalization.js";
import { scanSkillDirectory } from "../skill-capabilities.js";

async function hashPath(targetPath) {
  const hash = crypto.createHash("sha256");

  async function add(currentPath, currentRelative = "") {
    const stats = await fs.stat(currentPath);
    if (stats.isDirectory()) {
      hash.update(`dir:${currentRelative}\n`);
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        await add(path.join(currentPath, entry.name), currentRelative ? `${currentRelative}/${entry.name}` : entry.name);
      }
      return;
    }
    hash.update(`file:${currentRelative}\n`);
    hash.update(await fs.readFile(currentPath));
  }

  await add(targetPath);
  return hash.digest("hex");
}

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

async function resolveRevision(upstream, options = {}) {
  const repoPath = await ensureUpstreamClone(upstream);
  const requestedRef = options.ref || upstream.defaultRef || await detectDefaultRefFromRepo(upstream.repo) || "main";
  const resolved = options.revision
    ? { ref: requestedRef, commit: options.revision }
    : await fetchRefAndResolveCommit(repoPath, requestedRef, { repo: upstream.repo });
  await ensureCommitAvailable(repoPath, resolved.commit);
  return {
    repoPath,
    ref: resolved.ref,
    revision: resolved.commit
  };
}

async function checkoutRoot(upstream, options = {}) {
  const resolved = await resolveRevision(upstream, options);
  const tracker = options.checkoutTracker ?? new Map();
  await checkoutCommit(resolved.repoPath, resolved.revision, tracker);
  const rootPath = upstream.root
    ? path.join(resolved.repoPath, upstream.root.split("/").join(path.sep))
    : resolved.repoPath;
  if (!(await fs.pathExists(rootPath))) {
    throw new Error(
      `Configured root '${upstream.root}' was not found in upstream '${upstream.id}' at revision ${resolved.revision}.`
    );
  }
  return {
    ...resolved,
    rootPath,
    checkoutTracker: tracker
  };
}

export const gitProvider = {
  id: "git",
  async discover(upstream, options = {}) {
    const checkedOut = await checkoutRoot(upstream, options);
    const skills = [];
    const discovered = await walkSkills(checkedOut.rootPath);
    for (const selectionPath of discovered.sort((left, right) => left.localeCompare(right))) {
      const skillRoot =
        selectionPath === "."
          ? checkedOut.rootPath
          : path.join(checkedOut.rootPath, selectionPath.split("/").join(path.sep));
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
      rootPath: checkedOut.rootPath,
      revision: checkedOut.revision,
      ref: checkedOut.ref,
      skills
    };
  },
  async materialize(upstream, selectionPath, options = {}) {
    const normalized = normalizeSelectionPath(selectionPath, "selection path");
    const checkedOut = await checkoutRoot(upstream, options);
    const sourcePath =
      normalized === "."
        ? checkedOut.rootPath
        : path.join(checkedOut.rootPath, normalized.split("/").join(path.sep));
    const scan = await scanSkillDirectory(sourcePath);
    return {
      sourcePath,
      resolvedRevision: checkedOut.revision,
      ref: checkedOut.ref,
      contentHash: await hashPath(sourcePath),
      capabilities: scan.capabilities,
      title: scan.title,
      summary: scan.summary
    };
  },
  async refresh(upstream, selectionPath, options = {}) {
    return this.materialize(upstream, selectionPath, options);
  }
};
