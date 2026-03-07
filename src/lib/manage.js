import fs from "fs-extra";
import path from "node:path";
import {
  SCHEMAS,
  assertJsonFileMatchesSchema,
  assertObjectMatchesSchema,
  logInfo,
  logWarn,
  normalizeDestPrefix,
  writeJsonFile
} from "./core.js";
import { buildProfile } from "./build.js";
import { cmdApply } from "./bindings.js";
import { listAvailableProfiles, loadPackSources, resolvePack, resolveProfile } from "./config.js";
import { removeImportRecords } from "./import-lock.js";
import { getProvider } from "./providers/index.js";
import {
  collectSourcePlanning,
  createUpstreamFromSourceInput,
  loadLockfile,
  loadUpstreamsConfig,
  saveLockfile,
  writeUpstreamsConfig
} from "./upstreams.js";
import { normalizeSelectionPath } from "./source-normalization.js";

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

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function cloneSourcesDocument(sources) {
  return {
    schemaVersion: 2,
    imports: Array.isArray(sources?.imports)
      ? sources.imports.map((entry) => ({
          ...entry,
          tracking: entry?.tracking === "pinned" ? "pinned" : "floating",
          paths: Array.isArray(entry.paths) ? [...entry.paths] : []
        }))
      : []
  };
}

function normalizedImportPaths(importEntry) {
  return uniqueSorted(
    (Array.isArray(importEntry.paths) ? importEntry.paths : []).map((rawPath) =>
      normalizeSelectionPath(rawPath, "imports[].paths[]")
    )
  );
}

function sortImports(imports) {
  imports.sort((left, right) => {
    const leftRef = typeof left.ref === "string" && left.ref.trim().length > 0 ? left.ref.trim() : "";
    const rightRef = typeof right.ref === "string" && right.ref.trim().length > 0 ? right.ref.trim() : "";
    const leftPrefix = typeof left.destPrefix === "string" ? left.destPrefix : "";
    const rightPrefix = typeof right.destPrefix === "string" ? right.destPrefix : "";
    const leftTracking = left?.tracking === "pinned" ? "pinned" : "floating";
    const rightTracking = right?.tracking === "pinned" ? "pinned" : "floating";
    const leftKey = `${left.upstream}::${leftRef}::${leftTracking}::${leftPrefix}::${(left.paths ?? []).join("|")}`;
    const rightKey = `${right.upstream}::${rightRef}::${rightTracking}::${rightPrefix}::${(right.paths ?? []).join("|")}`;
    return leftKey.localeCompare(rightKey);
  });
}

async function writeValidatedSources(sourcesPath, sourcesDoc, upstreamById) {
  const normalized = cloneSourcesDocument(sourcesDoc);
  await assertObjectMatchesSchema(normalized, SCHEMAS.packSources, "pack sources");
  collectSourcePlanning(normalized, upstreamById);
  await writeJsonFile(sourcesPath, normalized);
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
      // Invalid profiles are surfaced elsewhere.
    }
  }
  return consumers.sort((left, right) => left.localeCompare(right));
}

function upstreamsMatch(left, right) {
  return (
    left.provider === right.provider &&
    (left.repo ?? null) === (right.repo ?? null) &&
    (left.path ?? null) === (right.path ?? null) &&
    (left.root ?? null) === (right.root ?? null)
  );
}

async function ensureUpstreamRegistration({ id, source, provider = "auto", root = null, defaultRef = null }) {
  const requestedId = normalizeOptionalText(id);
  const normalized = await createUpstreamFromSourceInput({
    id: requestedId,
    source,
    provider,
    root,
    defaultRef
  });

  const editable = await loadUpstreamsConfig();
  const existing = editable.config.upstreams.find((item) => upstreamsMatch(item, normalized));
  if (existing) {
    return existing;
  }
  if (requestedId && editable.byId.has(requestedId)) {
    throw new Error(`Upstream '${requestedId}' already exists.`);
  }

  let upstreamId = normalized.id;
  if (editable.byId.has(upstreamId)) {
    let suffix = 2;
    while (editable.byId.has(`${upstreamId}_${suffix}`)) {
      suffix += 1;
    }
    upstreamId = `${upstreamId}_${suffix}`;
  }

  const nextUpstream = {
    ...normalized,
    id: upstreamId
  };
  editable.config.upstreams.push(nextUpstream);
  await writeUpstreamsConfig(editable.config);
  logInfo(`Added upstream '${upstreamId}'.`);
  return nextUpstream;
}

async function maybeBuildAndApply(profileName, options = {}) {
  if (options.build === true || options.apply === true) {
    await buildProfile(profileName, { lockMode: "write" });
  }
  if (options.apply === true) {
    await cmdApply(profileName);
  }
}

async function discoverPathsIfRequested({ upstreamDoc, ref, all = false, skillPaths = [] }) {
  const normalizedPaths = uniqueSorted(skillPaths.map((rawPath) => normalizeSelectionPath(rawPath, "Skill path")));
  if (normalizedPaths.length > 0) {
    return normalizedPaths;
  }
  if (all !== true) {
    throw new Error("At least one --path is required unless --all is used.");
  }

  const provider = getProvider(upstreamDoc.provider);
  const discovery = await provider.discover(upstreamDoc, {
    ref: ref || upstreamDoc.defaultRef || undefined
  });
  return uniqueSorted(discovery.skills.map((item) => item.path));
}

export async function cmdUpstreamAdd({ id, repo, source, defaultRef, type, provider, root }) {
  const requestedType = normalizeOptionalText(type);
  if (requestedType && requestedType !== "git") {
    throw new Error("Only upstream type 'git' is supported for legacy --type usage.");
  }
  const locator = normalizeOptionalText(source) ?? normalizeOptionalText(repo);
  if (!locator) {
    throw new Error("A source locator is required. Use --source or --repo.");
  }
  await ensureUpstreamRegistration({
    id,
    source: locator,
    provider: provider || (requestedType === "git" ? "git" : "auto"),
    root,
    defaultRef
  });
}

export async function cmdUpstreamRemove({ id }) {
  const upstreamId = normalizeRequiredText(id, "Upstream id");
  const editable = await loadUpstreamsConfig();
  const before = editable.config.upstreams.length;
  editable.config.upstreams = editable.config.upstreams.filter((item) => item.id !== upstreamId);
  if (before === editable.config.upstreams.length) {
    throw new Error(`Upstream '${upstreamId}' not found.`);
  }

  await writeUpstreamsConfig(editable.config);
  logInfo(`Removed upstream '${upstreamId}'.`);

  const lockState = await loadLockfile();
  const initialPins = Array.isArray(lockState.lock.pins) ? lockState.lock.pins.length : 0;
  lockState.lock.pins = (lockState.lock.pins ?? []).filter((pin) => pin.upstream !== upstreamId);
  const initialImports = Array.isArray(lockState.lock.imports) ? lockState.lock.imports.length : 0;
  removeImportRecords(lockState.lock, (entry) => entry.upstream === upstreamId);
  const removedPins = initialPins - lockState.lock.pins.length;
  const removedImports = initialImports - lockState.lock.imports.length;
  if (removedPins > 0 || removedImports > 0) {
    await saveLockfile(lockState);
    if (removedPins > 0) {
      logInfo(`Removed ${removedPins} lock pin(s) for upstream '${upstreamId}'.`);
    }
    if (removedImports > 0) {
      logInfo(`Removed ${removedImports} import lock record(s) for upstream '${upstreamId}'.`);
    }
  }

  const consumers = await findProfilesUsingUpstream(upstreamId);
  if (consumers.length > 0) {
    logWarn(
      `Upstream '${upstreamId}' is still referenced by profile(s): ${consumers.join(", ")}. ` +
        "Update profile imports before the next sync."
    );
  }
}

export async function cmdProfileAddSkill({
  profile,
  upstream,
  source,
  provider = "auto",
  root = null,
  upstreamId = null,
  skillPath,
  skillPaths = [],
  all = false,
  ref,
  pin = false,
  destPrefix,
  build = false,
  apply = false
}) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const requestedPaths = [
    ...skillPaths,
    ...(typeof skillPath === "string" && skillPath.trim().length > 0 ? [skillPath] : [])
  ];

  let upstreamDoc = null;
  if (source) {
    upstreamDoc = await ensureUpstreamRegistration({
      id: upstreamId,
      source,
      provider,
      root,
      defaultRef: ref
    });
  } else {
    const upstreams = await loadUpstreamsConfig();
    upstreamDoc = upstreams.byId.get(normalizeRequiredText(upstream, "Upstream id"));
    if (!upstreamDoc) {
      throw new Error(`Unknown upstream '${upstream}'.`);
    }
  }

  const paths = await discoverPathsIfRequested({
    upstreamDoc,
    ref,
    all,
    skillPaths: requestedPaths
  });

  const { profile: profileDoc } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profileDoc);
  const sourcesPath = path.join(packRoot, "sources.json");
  const { sources } = await loadPackSources(packRoot);
  const upstreams = await loadUpstreamsConfig();
  const nextSources = cloneSourcesDocument(sources);
  const effectiveRef = upstreamDoc.provider === "git" ? normalizeOptionalText(ref) || upstreamDoc.defaultRef || "main" : null;
  const effectiveDestPrefix = normalizeDestPrefix(destPrefix, upstreamDoc.id, "Skill import");
  const effectiveTracking = pin === true ? "pinned" : "floating";

  let addedCount = 0;
  for (const selectionPath of paths) {
    let matchedEntry = null;
    for (const importEntry of nextSources.imports) {
      const entryRef = normalizeOptionalText(importEntry.ref) || upstreamDoc.defaultRef || null;
      const entryDestPrefix = normalizeDestPrefix(importEntry.destPrefix, upstreamDoc.id, "imports[]");
      const entryTracking = importEntry?.tracking === "pinned" ? "pinned" : "floating";
      if (
        importEntry.upstream === upstreamDoc.id &&
        entryRef === effectiveRef &&
        entryDestPrefix === effectiveDestPrefix &&
        entryTracking === effectiveTracking
      ) {
        matchedEntry = importEntry;
        break;
      }
    }

    if (!matchedEntry) {
      matchedEntry = {
        upstream: upstreamDoc.id,
        ...(effectiveRef ? { ref: effectiveRef } : {}),
        tracking: effectiveTracking,
        paths: [],
        destPrefix: effectiveDestPrefix
      };
      nextSources.imports.push(matchedEntry);
    }

    const normalizedPaths = normalizedImportPaths(matchedEntry);
    if (normalizedPaths.includes(selectionPath)) {
      continue;
    }
    matchedEntry.paths = uniqueSorted([...normalizedPaths, selectionPath]);
    if (effectiveRef) {
      matchedEntry.ref = effectiveRef;
    }
    matchedEntry.tracking = effectiveTracking;
    matchedEntry.destPrefix = effectiveDestPrefix;
    addedCount += 1;
  }

  for (const importEntry of nextSources.imports) {
    importEntry.paths = normalizedImportPaths(importEntry);
  }
  sortImports(nextSources.imports);
  await writeValidatedSources(sourcesPath, nextSources, upstreams.byId);

  logInfo(
    `Added ${addedCount} skill import entr${addedCount === 1 ? "y" : "ies"} to profile '${profileName}' from '${upstreamDoc.id}'.`
  );
  await maybeBuildAndApply(profileName, { build, apply });
}

export async function cmdProfileRemoveSkill({
  profile,
  upstream,
  skillPath,
  skillPaths = [],
  ref,
  destPrefix,
  pruneUpstream = false,
  build = false,
  apply = false
}) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const upstreamId = normalizeRequiredText(upstream, "Upstream id");
  const paths = uniqueSorted([
    ...skillPaths,
    ...(typeof skillPath === "string" && skillPath.trim().length > 0 ? [skillPath] : [])
  ].map((rawPath) => normalizeSelectionPath(rawPath, "Skill path")));

  if (paths.length === 0) {
    throw new Error("At least one --path is required.");
  }

  const { profile: profileDoc } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profileDoc);
  const sourcesPath = path.join(packRoot, "sources.json");
  const upstreams = await loadUpstreamsConfig();
  const upstreamDoc = upstreams.byId.get(upstreamId);
  if (!upstreamDoc) {
    throw new Error(`Unknown upstream '${upstreamId}'.`);
  }

  const desiredRef = normalizeOptionalText(ref);
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

    const entryRef = normalizeOptionalText(importEntry.ref) || upstreamDoc.defaultRef || null;
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
      if (paths.includes(existingPath)) {
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
      ...(entryRef ? { ref: entryRef } : {}),
      destPrefix: entryDestPrefix,
      paths: remainingPaths
    });
  }

  if (removedCount === 0) {
    throw new Error(`No matching imported skill path(s) found for profile '${profileName}' and upstream '${upstreamId}'.`);
  }

  nextSources.imports = filteredImports;
  sortImports(nextSources.imports);
  await writeValidatedSources(sourcesPath, nextSources, upstreams.byId);
  logInfo(`Removed ${removedCount} skill import entr${removedCount === 1 ? "y" : "ies"} from profile '${profileName}'.`);

  if (pruneUpstream === true) {
    const consumers = await findProfilesUsingUpstream(upstreamId);
    if (consumers.length === 0) {
      await cmdUpstreamRemove({ id: upstreamId });
    }
  }

  await maybeBuildAndApply(profileName, { build, apply });
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
  document.servers[serverName] = serverUrl
    ? { url: serverUrl }
    : {
        command: serverCommand,
        args: serverArgs,
        ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {})
      };

  const normalized = normalizeMcpServersDocument(document);
  await assertObjectMatchesSchema(normalized, SCHEMAS.mcpServers, mcpPath);
  await writeJsonFile(mcpPath, normalized);
  logInfo(`${existed ? "Updated" : "Added"} MCP server '${serverName}' for profile '${profileName}'.`);
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
