import fs from "fs-extra";
import path from "node:path";
import { SCHEMAS, assertJsonFileMatchesSchema } from "./core.js";
import { loadPackSources, normalizeMcpManifest, resolvePack, resolveProfileChain } from "./config.js";

function uniqueByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return Array.from(map.values());
}

function mergeSourcesDocuments(documents) {
  const imports = [];
  for (const document of documents) {
    for (const entry of document.imports ?? []) {
      imports.push({
        upstream: entry.upstream,
        ...(entry.ref ? { ref: entry.ref } : {}),
        tracking: entry?.tracking === "pinned" ? "pinned" : "floating",
        paths: Array.isArray(entry.paths) ? [...entry.paths] : [],
        ...(entry.destPrefix ? { destPrefix: entry.destPrefix } : {}),
        ...(entry.allowWholeSkillsTree === true ? { allowWholeSkillsTree: true } : {})
      });
    }
  }
  return {
    schemaVersion: 2,
    imports: uniqueByKey(
      imports.map((entry) => ({
        ...entry,
        paths: [...new Set(entry.paths)].sort((left, right) => left.localeCompare(right))
      })),
      (entry) => [
        entry.upstream,
        entry.ref ?? "",
        entry.tracking,
        entry.destPrefix ?? "",
        entry.paths.join("|")
      ].join("::")
    ).sort((left, right) =>
      [
        left.upstream,
        left.ref ?? "",
        left.destPrefix ?? "",
        left.paths.join("|")
      ].join("::").localeCompare([
        right.upstream,
        right.ref ?? "",
        right.destPrefix ?? "",
        right.paths.join("|")
      ].join("::"))
    )
  };
}

async function loadMcpForPack(packRoot) {
  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  if (!(await fs.pathExists(mcpPath))) {
    return { servers: {} };
  }
  return assertJsonFileMatchesSchema(mcpPath, SCHEMAS.mcpServers);
}

function mergeMcpDocuments(documents) {
  const merged = { servers: {} };
  for (const document of documents) {
    for (const [name, server] of Object.entries(document.servers ?? {})) {
      merged.servers[name] = server;
    }
  }
  return merged;
}

export async function loadEffectiveProfileState(profileName) {
  const chain = await resolveProfileChain(profileName);
  const packs = [];
  const sourcesDocs = [];
  const mcpDocs = [];

  for (const item of chain) {
    const packRoot = await resolvePack(item.profile);
    packs.push({
      profile: item.profile,
      profilePath: item.profilePath,
      packRoot
    });
    const { sources } = await loadPackSources(packRoot);
    sourcesDocs.push(sources);
    mcpDocs.push(await loadMcpForPack(packRoot));
  }

  const effectiveProfile = chain[chain.length - 1].profile;
  return {
    chain,
    packs,
    effectiveProfile,
    effectiveSources: mergeSourcesDocuments(sourcesDocs),
    effectiveMcpDocument: mergeMcpDocuments(mcpDocs),
    normalizedMcp: normalizeMcpManifest(mergeMcpDocuments(mcpDocs))
  };
}
