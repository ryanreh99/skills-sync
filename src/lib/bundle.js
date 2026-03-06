import fs from "fs-extra";
import path from "node:path";
import {
  SCHEMAS,
  assertObjectMatchesSchema,
  collisionKey,
  toFileSystemRelativePath,
  writeJsonFile
} from "./core.js";
import { resolveImportedMaterialization } from "./upstreams.js";

export async function collectLocalSkillEntries(packRoots) {
  const roots = Array.isArray(packRoots) ? packRoots : [packRoots];
  const collected = [];

  for (const packRoot of roots) {
    const skillsRoot = path.join(packRoot, "skills");
    if (!(await fs.pathExists(skillsRoot))) {
      continue;
    }

    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const skillName of dirs) {
      collected.push({
        sourceType: "local",
        sourcePath: path.join(skillsRoot, skillName),
        destRelative: skillName,
        label: `local:${skillName}`
      });
    }
  }

  return collected;
}

export async function collectImportedSkillEntries(skillImports, upstreamById, resolvedReferences) {
  const entries = [];
  for (const item of skillImports) {
    const upstream = upstreamById.get(item.upstreamId);
    if (!upstream) {
      throw new Error(`Unknown upstream '${item.upstreamId}'.`);
    }
    const materialized = await resolveImportedMaterialization(upstream, item, resolvedReferences);
    entries.push({
      sourceType: item.sourceType,
      provider: upstream.provider,
      upstreamId: item.upstreamId,
      ref: item.ref,
      tracking: item.tracking,
      commit: materialized.resolvedRevision,
      sourcePath: materialized.sourcePath,
      selectionPath: item.selectionPath,
      destRelative: item.destRelative,
      label: item.label,
      originalInput: upstream.originalInput ?? (upstream.provider === "local-path" ? upstream.path : upstream.repo),
      contentHash: materialized.contentHash,
      capabilities: materialized.capabilities,
      title: materialized.title,
      summary: materialized.summary
    });
  }
  return entries;
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

    const stats = await fs.stat(entry.sourcePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      throw new Error(
        `Imported source path '${entry.selectionPath}' from upstream '${entry.upstreamId}' is not a directory.`
      );
    }
    await fs.copy(entry.sourcePath, destination);
  }
}

function buildBundleImports(importedSkillEntries) {
  const imports = [];
  for (const item of importedSkillEntries) {
    imports.push({
      upstream: item.upstreamId,
      provider: item.provider,
      ...(item.ref ? { ref: item.ref } : {}),
      ...(item.commit ? { commit: item.commit } : {}),
      tracking: item.tracking,
      originalInput: item.originalInput,
      path: item.selectionPath,
      destPrefix: path.posix.dirname(item.destRelative),
      capabilities: Array.isArray(item.capabilities) ? [...item.capabilities] : []
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
  packRoots,
  packRoot,
  skillImports,
  upstreamById,
  resolvedReferences,
  normalizedMcp,
  runtimeInternalRoot
}) {
  const localSkillEntries = await collectLocalSkillEntries(packRoots);
  const importedSkillEntries = await collectImportedSkillEntries(skillImports, upstreamById, resolvedReferences);
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
      imports: buildBundleImports(importedSkillEntries)
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
