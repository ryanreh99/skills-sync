import fs from "fs-extra";
import path from "node:path";
import {
  SCHEMAS,
  assertObjectMatchesSchema,
  collisionKey,
  toFileSystemRelativePath,
  writeJsonFile
} from "./core.js";
import { checkoutCommit, ensureCommitAvailable, getLockKey } from "./upstreams.js";

export async function collectLocalSkillEntries(packRoot) {
  const skillsRoot = path.join(packRoot, "skills");
  if (!(await fs.pathExists(skillsRoot))) {
    return [];
  }

  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return dirs.map((skillName) => ({
    sourceType: "local",
    sourcePath: path.join(skillsRoot, skillName),
    destRelative: skillName,
    label: `local:${skillName}`
  }));
}

export function collectImportedSkillEntries(skillImports, resolvedReferences) {
  return skillImports.map((item) => {
    const key = getLockKey(item.upstreamId, item.ref);
    const resolved = resolvedReferences.get(key);
    if (!resolved) {
      throw new Error(`Internal error: unresolved upstream reference for ${item.upstreamId}@${item.ref}`);
    }
    return {
      sourceType: "upstream",
      upstreamId: item.upstreamId,
      ref: item.ref,
      commit: resolved.commit,
      repoPath: resolved.repoPath,
      sourceRepoPath: item.repoPath,
      destRelative: item.destRelative,
      label: item.label
    };
  });
}

function assertNoSkillCollisions(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = collisionKey(entry.destRelative);
    if (seen.has(key)) {
      const previous = seen.get(key);
      throw new Error(
        `Skill destination collision detected at '${entry.destRelative}'.` +
          ` First: ${previous.label}; Second: ${entry.label}.`
      );
    }
    seen.set(key, entry);
  }
}

async function materializeBundleSkills(entries, destinationRoot) {
  const sortedEntries = [...entries].sort((left, right) => left.destRelative.localeCompare(right.destRelative));
  const checkoutTracker = new Map();

  await fs.ensureDir(destinationRoot);
  for (const entry of sortedEntries) {
    const destination = path.join(destinationRoot, toFileSystemRelativePath(entry.destRelative));
    if (await fs.pathExists(destination)) {
      throw new Error(`Destination already exists while materializing skills: ${destination}`);
    }
    await fs.ensureDir(path.dirname(destination));

    if (entry.sourceType === "local") {
      await fs.copy(entry.sourcePath, destination);
      continue;
    }

    await ensureCommitAvailable(entry.repoPath, entry.commit);
    await checkoutCommit(entry.repoPath, entry.commit, checkoutTracker);
    const sourcePath = path.join(entry.repoPath, toFileSystemRelativePath(entry.sourceRepoPath));
    const stats = await fs.stat(sourcePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      throw new Error(
        `Imported source path '${entry.sourceRepoPath}' from upstream '${entry.upstreamId}' is not a directory at commit ${entry.commit}.`
      );
    }
    await fs.copy(sourcePath, destination);
  }
}

function buildBundleImports(skillImports, resolvedReferences) {
  const imports = [];
  for (const item of skillImports) {
    const key = getLockKey(item.upstreamId, item.ref);
    const resolved = resolvedReferences.get(key);
    if (!resolved) {
      throw new Error(`Internal error: unresolved upstream reference for ${item.upstreamId}@${item.ref}.`);
    }
    imports.push({
      upstream: item.upstreamId,
      ref: item.ref,
      commit: resolved.commit,
      path: item.repoPath,
      destPrefix: path.posix.dirname(item.destRelative)
    });
  }

  imports.sort((left, right) => {
    const leftKey = `${left.upstream}::${left.ref}::${left.path}::${left.destPrefix}`;
    const rightKey = `${right.upstream}::${right.ref}::${right.path}::${right.destPrefix}`;
    return leftKey.localeCompare(rightKey);
  });
  return imports;
}

export async function buildBundle({
  profile,
  packRoot,
  skillImports,
  resolvedReferences,
  normalizedMcp,
  runtimeInternalRoot
}) {
  const localSkillEntries = await collectLocalSkillEntries(packRoot);
  const importedSkillEntries = collectImportedSkillEntries(skillImports, resolvedReferences);
  const skillEntries = [...localSkillEntries, ...importedSkillEntries];
  assertNoSkillCollisions(skillEntries);

  const bundleRoot = path.join(runtimeInternalRoot, "common");
  const bundleSkillsPath = path.join(bundleRoot, "skills");
  const bundleMcpPath = path.join(bundleRoot, "mcp.json");
  const bundleMetadataPath = path.join(bundleRoot, "bundle.json");

  await fs.ensureDir(bundleRoot);
  await materializeBundleSkills(skillEntries, bundleSkillsPath);
  await writeJsonFile(bundleMcpPath, normalizedMcp);

  const bundleDocument = {
    schemaVersion: 1,
    profile: profile.name,
    generatedAt: new Date().toISOString(),
    sources: {
      packPath: packRoot,
      imports: buildBundleImports(skillImports, resolvedReferences)
    }
  };
  await assertObjectMatchesSchema(bundleDocument, SCHEMAS.bundle, "bundle metadata");
  await writeJsonFile(bundleMetadataPath, bundleDocument);

  return {
    bundleRoot,
    bundleSkillsPath,
    bundleMcpPath,
    bundleMetadataPath,
    localSkillEntries,
    importedSkillEntries,
    skillEntries
  };
}
