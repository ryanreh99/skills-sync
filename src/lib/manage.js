import fs from "fs-extra";
import path from "node:path";
import {
  LOCKFILE_PATH,
  SCHEMAS,
  UPSTREAMS_CONFIG_PATHS,
  assertJsonFileMatchesSchema,
  assertObjectMatchesSchema,
  logInfo,
  logWarn,
  normalizeDestPrefix,
  normalizeRepoPath,
  writeJsonFile
} from "./core.js";
import { listAvailableProfiles, loadPackSources, resolvePack, resolveProfile } from "./config.js";
import { collectSourcePlanning, loadLockfile, loadUpstreamsConfig, sortPins } from "./upstreams.js";

function normalizeRequiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneSourcesDocument(sources) {
  return {
    imports: Array.isArray(sources?.imports)
      ? sources.imports.map((entry) => ({
          ...entry,
          paths: Array.isArray(entry.paths) ? [...entry.paths] : []
        }))
      : []
  };
}

function normalizeImportRef(importEntry, upstreamDefaultRef) {
  if (typeof importEntry.ref === "string" && importEntry.ref.trim().length > 0) {
    return importEntry.ref.trim();
  }
  return upstreamDefaultRef;
}

function normalizedImportPaths(importEntry) {
  const normalized = new Set();
  for (const rawPath of Array.isArray(importEntry.paths) ? importEntry.paths : []) {
    normalized.add(normalizeRepoPath(rawPath, "imports[].paths[]"));
  }
  return Array.from(normalized.values()).sort((left, right) => left.localeCompare(right));
}

function sortImports(imports) {
  imports.sort((left, right) => {
    const leftRef = typeof left.ref === "string" && left.ref.trim().length > 0 ? left.ref.trim() : "";
    const rightRef = typeof right.ref === "string" && right.ref.trim().length > 0 ? right.ref.trim() : "";
    const leftPrefix = typeof left.destPrefix === "string" ? left.destPrefix : "";
    const rightPrefix = typeof right.destPrefix === "string" ? right.destPrefix : "";
    const leftKey = `${left.upstream}::${leftRef}::${leftPrefix}::${left.paths.join("|")}`;
    const rightKey = `${right.upstream}::${rightRef}::${rightPrefix}::${right.paths.join("|")}`;
    return leftKey.localeCompare(rightKey);
  });
}

async function writeValidatedSources(sourcesPath, sourcesDoc, upstreamById) {
  await assertObjectMatchesSchema(sourcesDoc, SCHEMAS.packSources, "pack sources");
  collectSourcePlanning(sourcesDoc, upstreamById);
  await writeJsonFile(sourcesPath, sourcesDoc);
}

async function loadEditableUpstreamsConfig() {
  const loaded = await loadUpstreamsConfig();
  return {
    upstreams: loaded.config.upstreams.map((item) => ({
      id: item.id,
      type: item.type,
      repo: item.repo,
      defaultRef: item.defaultRef
    })),
    byId: loaded.byId
  };
}

async function writeValidatedUpstreamsConfig(upstreams) {
  const next = { upstreams: [...upstreams] };
  next.upstreams.sort((left, right) => left.id.localeCompare(right.id));
  await assertObjectMatchesSchema(next, SCHEMAS.upstreams, "upstreams config");
  await writeJsonFile(UPSTREAMS_CONFIG_PATHS.local, next);
}

async function findProfilesUsingUpstream(upstreamId) {
  const profiles = await listAvailableProfiles();
  const consumers = [];
  for (const profile of profiles) {
    try {
      const resolved = await resolveProfile(profile.name);
      const packRoot = await resolvePack(resolved.profile);
      const { sources } = await loadPackSources(packRoot);
      const hasReference = Array.isArray(sources.imports)
        ? sources.imports.some((entry) => entry?.upstream === upstreamId)
        : false;
      if (hasReference) {
        consumers.push(profile.name);
      }
    } catch {
      // Ignore invalid profiles here; doctor/build will report them.
    }
  }
  return consumers.sort((left, right) => left.localeCompare(right));
}

export async function cmdUpstreamAdd({ id, repo, defaultRef, type }) {
  const upstreamId = normalizeRequiredText(id, "Upstream id");
  const upstreamRepo = normalizeRequiredText(repo, "Upstream repo");
  const upstreamRef = normalizeRequiredText(defaultRef || "main", "Upstream default ref");
  const upstreamType = normalizeRequiredText(type || "git", "Upstream type");

  if (upstreamType !== "git") {
    throw new Error("Only upstream type 'git' is supported.");
  }

  const editable = await loadEditableUpstreamsConfig();
  if (editable.byId.has(upstreamId)) {
    throw new Error(`Upstream '${upstreamId}' already exists.`);
  }

  editable.upstreams.push({
    id: upstreamId,
    type: upstreamType,
    repo: upstreamRepo,
    defaultRef: upstreamRef
  });

  await writeValidatedUpstreamsConfig(editable.upstreams);
  logInfo(`Added upstream '${upstreamId}'.`);
}

export async function cmdUpstreamRemove({ id }) {
  const upstreamId = normalizeRequiredText(id, "Upstream id");
  const editable = await loadEditableUpstreamsConfig();
  const before = editable.upstreams.length;
  const nextUpstreams = editable.upstreams.filter((item) => item.id !== upstreamId);

  if (before === nextUpstreams.length) {
    throw new Error(`Upstream '${upstreamId}' not found.`);
  }

  await writeValidatedUpstreamsConfig(nextUpstreams);
  logInfo(`Removed upstream '${upstreamId}'.`);

  const lockState = await loadLockfile();
  if (lockState.exists) {
    const initialPins = lockState.lock.pins.length;
    lockState.lock.pins = lockState.lock.pins.filter((pin) => pin.upstream !== upstreamId);
    const removedPins = initialPins - lockState.lock.pins.length;
    if (removedPins > 0) {
      sortPins(lockState.lock);
      await writeJsonFile(LOCKFILE_PATH, lockState.lock);
      logInfo(`Removed ${removedPins} lock pin(s) for upstream '${upstreamId}'.`);
    }
  }

  const consumers = await findProfilesUsingUpstream(upstreamId);
  if (consumers.length > 0) {
    logWarn(
      `Upstream '${upstreamId}' is still referenced by profile(s): ${consumers.join(", ")}. ` +
        "Update profile imports before the next build."
    );
  }
}

export async function cmdProfileAddSkill({ profile, upstream, skillPath, ref, destPrefix }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const upstreamId = normalizeRequiredText(upstream, "Upstream id");
  const repoPath = normalizeRepoPath(skillPath, "Skill path");

  const { profile: profileDoc } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profileDoc);
  const sourcesPath = path.join(packRoot, "sources.json");

  const upstreams = await loadUpstreamsConfig();
  const upstreamDoc = upstreams.byId.get(upstreamId);
  if (!upstreamDoc) {
    throw new Error(`Unknown upstream '${upstreamId}'.`);
  }

  const effectiveRef = ref ? normalizeRequiredText(ref, "Ref") : upstreamDoc.defaultRef;
  const effectiveDestPrefix = normalizeDestPrefix(destPrefix, upstreamId, "Skill import");
  const { sources } = await loadPackSources(packRoot);
  const nextSources = cloneSourcesDocument(sources);

  let added = false;
  for (const importEntry of nextSources.imports) {
    if (importEntry.upstream !== upstreamId) {
      continue;
    }
    const entryRef = normalizeImportRef(importEntry, upstreamDoc.defaultRef);
    const entryDestPrefix = normalizeDestPrefix(importEntry.destPrefix, upstreamId, "imports[]");
    if (entryRef !== effectiveRef || entryDestPrefix !== effectiveDestPrefix) {
      continue;
    }

    const currentPaths = normalizedImportPaths(importEntry);
    if (currentPaths.includes(repoPath)) {
      logInfo(`Profile '${profileName}' already imports '${repoPath}' from ${upstreamId}@${effectiveRef}.`);
      return;
    }

    importEntry.ref = effectiveRef;
    importEntry.destPrefix = effectiveDestPrefix;
    importEntry.paths = [...currentPaths, repoPath].sort((left, right) => left.localeCompare(right));
    added = true;
    break;
  }

  if (!added) {
    nextSources.imports.push({
      upstream: upstreamId,
      ref: effectiveRef,
      paths: [repoPath],
      destPrefix: effectiveDestPrefix
    });
  }

  for (const importEntry of nextSources.imports) {
    importEntry.paths = normalizedImportPaths(importEntry);
  }
  sortImports(nextSources.imports);
  await writeValidatedSources(sourcesPath, nextSources, upstreams.byId);

  logInfo(
    `Added skill import '${repoPath}' to profile '${profileName}' from ${upstreamId}@${effectiveRef} ` +
      `with destPrefix '${effectiveDestPrefix}'.`
  );
}

export async function cmdProfileRemoveSkill({ profile, upstream, skillPath, ref, destPrefix }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const upstreamId = normalizeRequiredText(upstream, "Upstream id");
  const repoPath = normalizeRepoPath(skillPath, "Skill path");

  const { profile: profileDoc } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profileDoc);
  const sourcesPath = path.join(packRoot, "sources.json");

  const upstreams = await loadUpstreamsConfig();
  const upstreamDoc = upstreams.byId.get(upstreamId);
  if (!upstreamDoc) {
    throw new Error(`Unknown upstream '${upstreamId}'.`);
  }

  const desiredRef = ref ? normalizeRequiredText(ref, "Ref") : null;
  const desiredDestPrefix = destPrefix ? normalizeDestPrefix(destPrefix, upstreamId, "destPrefix") : null;
  const { sources } = await loadPackSources(packRoot);
  const nextSources = cloneSourcesDocument(sources);

  let removedCount = 0;
  const filteredImports = [];
  for (const importEntry of nextSources.imports) {
    if (importEntry.upstream !== upstreamId) {
      filteredImports.push(importEntry);
      continue;
    }

    const entryRef = normalizeImportRef(importEntry, upstreamDoc.defaultRef);
    if (desiredRef && entryRef !== desiredRef) {
      filteredImports.push(importEntry);
      continue;
    }

    const entryDestPrefix = normalizeDestPrefix(importEntry.destPrefix, upstreamId, "imports[]");
    if (desiredDestPrefix && entryDestPrefix !== desiredDestPrefix) {
      filteredImports.push(importEntry);
      continue;
    }

    const remainingPaths = [];
    for (const existingPath of normalizedImportPaths(importEntry)) {
      if (existingPath === repoPath) {
        removedCount += 1;
      } else {
        remainingPaths.push(existingPath);
      }
    }

    if (remainingPaths.length === 0) {
      continue;
    }
    filteredImports.push({
      ...importEntry,
      ref: entryRef,
      destPrefix: entryDestPrefix,
      paths: remainingPaths
    });
  }

  if (removedCount === 0) {
    throw new Error(
      `Skill import '${repoPath}' not found for profile '${profileName}' and upstream '${upstreamId}'.`
    );
  }

  nextSources.imports = filteredImports;
  sortImports(nextSources.imports);
  await writeValidatedSources(sourcesPath, nextSources, upstreams.byId);

  logInfo(`Removed ${removedCount} skill import entr${removedCount === 1 ? "y" : "ies"} from profile '${profileName}'.`);
}

function normalizeMcpArgs(rawArgs) {
  if (!rawArgs) {
    return [];
  }
  if (!Array.isArray(rawArgs)) {
    return [String(rawArgs)];
  }
  return rawArgs.map((value) => String(value));
}

function normalizeMcpEnvMap(rawEnv) {
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return {};
  }
  const normalized = {};
  const keys = Object.keys(rawEnv).sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    if (key.length === 0) {
      continue;
    }
    normalized[key] = String(rawEnv[key]);
  }
  return normalized;
}

function normalizeMcpEnvEntries(rawEntries) {
  if (!rawEntries) {
    return {};
  }
  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  const parsed = {};
  for (const rawEntry of entries) {
    const text = String(rawEntry ?? "");
    const equalsAt = text.indexOf("=");
    if (equalsAt <= 0) {
      throw new Error("MCP env values must be in KEY=VALUE format.");
    }
    const key = text.slice(0, equalsAt).trim();
    if (key.length === 0) {
      throw new Error("MCP env variable name cannot be empty.");
    }
    parsed[key] = text.slice(equalsAt + 1);
  }
  return normalizeMcpEnvMap(parsed);
}

function normalizeMcpServersDocument(document) {
  const serverNames = Object.keys(document.servers ?? {}).sort((left, right) => left.localeCompare(right));
  const servers = {};
  for (const name of serverNames) {
    const server = document.servers[name] ?? {};
    if (typeof server.url === "string" && server.url.trim().length > 0) {
      servers[name] = {
        url: server.url.trim()
      };
      continue;
    }
    const normalizedServer = {
      command: server.command,
      args: Array.isArray(server.args) ? server.args : []
    };
    const env = normalizeMcpEnvMap(server.env);
    if (Object.keys(env).length > 0) {
      normalizedServer.env = env;
    }
    servers[name] = normalizedServer;
  }
  return { servers };
}

async function loadMcpServersForProfile(profileName) {
  const { profile } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profile);
  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  let document = { servers: {} };
  if (await fs.pathExists(mcpPath)) {
    document = await assertJsonFileMatchesSchema(mcpPath, SCHEMAS.mcpServers);
  }
  return {
    mcpPath,
    document: normalizeMcpServersDocument(document)
  };
}

export async function cmdProfileAddMcp({ profile, name, command, url, args, env }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const serverName = normalizeRequiredText(name, "MCP server name");
  const serverCommand = normalizeOptionalText(command);
  const serverUrl = normalizeOptionalText(url);

  if ((serverCommand ? 1 : 0) + (serverUrl ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of --command or --url for profile add-mcp.");
  }

  const serverArgs = normalizeMcpArgs(args);
  const serverEnv = normalizeMcpEnvEntries(env);

  if (serverUrl && serverArgs.length > 0) {
    throw new Error("--args cannot be used with --url.");
  }
  if (serverUrl && Object.keys(serverEnv).length > 0) {
    throw new Error("--env cannot be used with --url.");
  }

  const { mcpPath, document } = await loadMcpServersForProfile(profileName);
  const existed = Object.prototype.hasOwnProperty.call(document.servers, serverName);
  let nextServer = null;
  if (serverUrl) {
    nextServer = {
      url: serverUrl
    };
  } else {
    nextServer = {
      command: serverCommand,
      args: serverArgs
    };
    if (Object.keys(serverEnv).length > 0) {
      nextServer.env = serverEnv;
    }
  }
  document.servers[serverName] = nextServer;

  const normalized = normalizeMcpServersDocument(document);
  await assertObjectMatchesSchema(normalized, SCHEMAS.mcpServers, mcpPath);
  await writeJsonFile(mcpPath, normalized);

  if (existed) {
    logInfo(`Updated MCP server '${serverName}' for profile '${profileName}'.`);
  } else {
    logInfo(`Added MCP server '${serverName}' for profile '${profileName}'.`);
  }
}

export async function cmdProfileRemoveMcp({ profile, name }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const serverName = normalizeRequiredText(name, "MCP server name");
  const { mcpPath, document } = await loadMcpServersForProfile(profileName);

  if (!Object.prototype.hasOwnProperty.call(document.servers, serverName)) {
    throw new Error(`MCP server '${serverName}' not found in profile '${profileName}'.`);
  }
  delete document.servers[serverName];

  const normalized = normalizeMcpServersDocument(document);
  await assertObjectMatchesSchema(normalized, SCHEMAS.mcpServers, mcpPath);
  await writeJsonFile(mcpPath, normalized);
  logInfo(`Removed MCP server '${serverName}' from profile '${profileName}'.`);
}
