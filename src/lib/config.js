import fs from "fs-extra";
import merge from "deepmerge";
import path from "node:path";
import {
  ASSETS_ROOT,
  CONFIG_PATH,
  LOCAL_OVERRIDES_ROOT,
  SCHEMAS,
  assertJsonFileMatchesSchema,
  logInfo,
  logWarn,
  toAbsolutePath,
  writeJsonFile
} from "./core.js";
import { buildTargetsDocument, loadAgentIntegrations } from "./agent-integrations.js";
import { accent, muted, renderTable, success } from "./terminal-ui.js";

function normalizeProfileName(profileName) {
  if (typeof profileName !== "string") {
    throw new Error("Profile name must be a non-empty string.");
  }
  const normalized = profileName.trim();
  if (normalized.length === 0) {
    throw new Error("Profile name must be a non-empty string.");
  }
  return normalized;
}

function migrateProfileDocument(profileName, document) {
  const normalizedName = normalizeProfileName(profileName);
  return {
    schemaVersion: 2,
    name: normalizedName,
    packPath: document?.packPath || `workspace/packs/${normalizedName}`,
    description: typeof document?.description === "string" ? document.description : "",
    ...(typeof document?.extends === "string" && document.extends.trim().length > 0
      ? { extends: document.extends.trim() }
      : {}),
    ...(document?.agentOverrides && typeof document.agentOverrides === "object" && !Array.isArray(document.agentOverrides)
      ? { agentOverrides: document.agentOverrides }
      : {})
  };
}

function migrateSourcesDocument(document) {
  return {
    schemaVersion: 2,
    imports: Array.isArray(document?.imports)
      ? document.imports.map((entry) => ({
          upstream: entry.upstream,
          ...(typeof entry.ref === "string" && entry.ref.trim().length > 0 ? { ref: entry.ref.trim() } : {}),
          tracking: entry?.tracking === "pinned" ? "pinned" : "floating",
          paths: Array.isArray(entry.paths) ? [...entry.paths] : [],
          ...(typeof entry.destPrefix === "string" && entry.destPrefix.trim().length > 0
            ? { destPrefix: entry.destPrefix.trim() }
            : {}),
          ...(entry?.allowWholeSkillsTree === true ? { allowWholeSkillsTree: true } : {})
        }))
      : []
  };
}

async function scaffoldProfileFiles(profileName) {
  const normalizedName = normalizeProfileName(profileName);
  const profilesDir = path.join(LOCAL_OVERRIDES_ROOT, "profiles");
  const packRoot = path.join(LOCAL_OVERRIDES_ROOT, "packs", normalizedName);
  const mcpDir = path.join(packRoot, "mcp");

  await fs.ensureDir(profilesDir);
  await fs.ensureDir(mcpDir);

  const toCreate = [
    {
      path: path.join(profilesDir, `${normalizedName}.json`),
      value: migrateProfileDocument(normalizedName, { packPath: `workspace/packs/${normalizedName}` })
    },
    {
      path: path.join(packRoot, "pack.json"),
      value: { name: normalizedName, version: "0.0.0", description: "", maintainer: "", tags: [] }
    },
    { path: path.join(packRoot, "sources.json"), value: migrateSourcesDocument({ imports: [] }) },
    { path: path.join(mcpDir, "servers.json"), value: { servers: {} } }
  ];

  let created = 0;
  for (const file of toCreate) {
    if (!(await fs.pathExists(file.path))) {
      await writeJsonFile(file.path, file.value);
      created += 1;
    }
  }
  return { created, normalizedName };
}

export async function resolveProfile(profileName) {
  const localPath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${profileName}.json`);
  const seedPath = path.join(ASSETS_ROOT, "seed", "profiles", `${profileName}.json`);

  let profilePath = null;
  if (await fs.pathExists(localPath)) {
    profilePath = localPath;
  } else if (await fs.pathExists(seedPath)) {
    profilePath = seedPath;
  }
  if (!profilePath) {
    throw new Error(`Profile '${profileName}' not found. Run 'ls' to see available profiles.`);
  }

  const profile = migrateProfileDocument(
    profileName,
    await assertJsonFileMatchesSchema(profilePath, SCHEMAS.profile)
  );
  return { profilePath, profile };
}

export async function resolveProfileChain(profileName, seen = new Set()) {
  const normalizedName = normalizeProfileName(profileName);
  if (seen.has(normalizedName)) {
    throw new Error(`Profile inheritance cycle detected at '${normalizedName}'.`);
  }
  seen.add(normalizedName);

  const resolved = await resolveProfile(normalizedName);
  if (!resolved.profile.extends) {
    return [resolved];
  }
  return [...(await resolveProfileChain(resolved.profile.extends, seen)), resolved];
}

export async function resolvePack(profile) {
  const candidate = toAbsolutePath(profile.packPath);
  if (await fs.pathExists(candidate)) {
    return candidate;
  }
  if (profile.packPath.startsWith("local-overrides/")) {
    const migrated = toAbsolutePath(profile.packPath.replace(/^local-overrides\//, "workspace/"));
    if (await fs.pathExists(migrated)) {
      return migrated;
    }
  }
  if (profile.packPath.startsWith("workspace/")) {
    const legacy = toAbsolutePath(profile.packPath.replace(/^workspace\//, "local-overrides/"));
    if (await fs.pathExists(legacy)) {
      return legacy;
    }
  }
  const packName = path.basename(profile.packPath);
  const fallback = path.join(ASSETS_ROOT, "seed", "packs", packName);
  if (await fs.pathExists(fallback)) {
    return fallback;
  }
  throw new Error(`Pack for profile '${profile.name ?? "unknown"}' was not found.`);
}

export async function loadPackSources(packRoot) {
  const sourcesPath = path.join(packRoot, "sources.json");
  if (!(await fs.pathExists(sourcesPath))) {
    return {
      path: null,
      sources: migrateSourcesDocument({ imports: [] })
    };
  }

  const sources = migrateSourcesDocument(
    await assertJsonFileMatchesSchema(sourcesPath, SCHEMAS.packSources)
  );
  return {
    path: sourcesPath,
    sources
  };
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

function normalizeMcpTransport(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "stdio" || normalized === "http" || normalized === "sse") {
    return normalized;
  }
  return null;
}

function normalizeKnownRemoteMcpUrl(url, transport = null) {
  const normalizedUrl = typeof url === "string" ? url.trim() : "";
  if (normalizedUrl.length === 0) {
    return normalizedUrl;
  }
  if (transport === "sse") {
    return normalizedUrl;
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return normalizedUrl;
  }

  if (parsed.hostname === "mcp.atlassian.com" && /^\/v1\/sse\/?$/.test(parsed.pathname)) {
    parsed.pathname = "/v1/mcp";
    return parsed.toString();
  }

  return normalizedUrl;
}

export function normalizeMcpManifest(serversManifest) {
  const servers = serversManifest.servers ?? {};
  const sortedNames = Object.keys(servers).sort((left, right) => left.localeCompare(right));
  const normalizedServers = {};
  for (const name of sortedNames) {
    const server = servers[name] ?? {};
    if (typeof server.url === "string" && server.url.trim().length > 0) {
      const transport = normalizeMcpTransport(server.transport);
      const normalizedServer = {
        url: normalizeKnownRemoteMcpUrl(server.url.trim(), transport)
      };
      if (transport === "http" || transport === "sse") {
        normalizedServer.transport = transport;
      }
      normalizedServers[name] = normalizedServer;
      continue;
    }
    const normalizedServer = {
      transport: "stdio",
      command: server.command,
      args: Array.isArray(server.args) ? server.args : []
    };
    const env = normalizeMcpEnvMap(server.env);
    if (Object.keys(env).length > 0) {
      normalizedServer.env = env;
    }
    normalizedServers[name] = normalizedServer;
  }
  return { mcpServers: normalizedServers };
}

export async function readDefaultProfile() {
  if (!(await fs.pathExists(CONFIG_PATH))) {
    return null;
  }
  const config = await assertJsonFileMatchesSchema(CONFIG_PATH, SCHEMAS.config);
  const val = config.defaultProfile;
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

async function collectProfilesFromDir(dirPath, source, seen, profiles) {
  if (!(await fs.pathExists(dirPath))) {
    return;
  }
  const entries = await fs.readdir(dirPath);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const name = entry.slice(0, -5);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    profiles.push({
      name,
      source,
      path: path.join(dirPath, entry)
    });
  }
}

export async function listAvailableProfiles() {
  const localDir = path.join(LOCAL_OVERRIDES_ROOT, "profiles");
  const seedDir = path.join(ASSETS_ROOT, "seed", "profiles");
  const seen = new Set();
  const profiles = [];

  await collectProfilesFromDir(localDir, "local", seen, profiles);
  await collectProfilesFromDir(seedDir, "seed", seen, profiles);

  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

export async function writeDefaultProfile(profileName) {
  const normalizedName = normalizeProfileName(profileName);
  const localProfilePath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${normalizedName}.json`);
  const seedProfilePath = path.join(ASSETS_ROOT, "seed", "profiles", `${normalizedName}.json`);
  const hasLocalProfile = await fs.pathExists(localProfilePath);
  const hasSeedProfile = await fs.pathExists(seedProfilePath);

  if (!hasLocalProfile && !hasSeedProfile) {
    const { created } = await scaffoldProfileFiles(normalizedName);
    if (created > 0) {
      logInfo(`Profile '${normalizedName}' did not exist. Created empty scaffold.`);
    }
  }

  let existing = {};
  if (await fs.pathExists(CONFIG_PATH)) {
    existing = await fs.readJson(CONFIG_PATH);
  }
  await writeJsonFile(CONFIG_PATH, { ...existing, defaultProfile: normalizedName });
  logInfo(`Default profile set to '${normalizedName}'.`);
}

export async function cmdCurrentProfile() {
  const current = await readDefaultProfile();
  if (!current) {
    process.stdout.write("No default profile set. Run: use <name>\n");
    return;
  }
  process.stdout.write(`${current}\n`);
}

export async function cmdListProfiles({ format = "text" } = {}) {
  const current = await readDefaultProfile();
  const profiles = await listAvailableProfiles();

  if (profiles.length === 0) {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ current, profiles: [] }, null, 2)}\n`);
    } else {
      process.stdout.write("No profiles found.\n");
    }
    return;
  }

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          current,
          profiles: profiles.map((item) => ({
            name: item.name,
            source: item.source
          }))
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(
    `${renderTable(
      ["Profile", "Source", "Status"],
      profiles.map(({ name, source }) => [
        name === current ? accent(name, process.stdout) : name,
        source,
        name === current ? success("current", process.stdout) : muted("-", process.stdout)
      ]),
      { stream: process.stdout }
    )}\n`
  );
}

export async function cmdNewProfile(name) {
  const { created, normalizedName } = await scaffoldProfileFiles(name);

  if (created === 0) {
    logInfo(`Profile '${normalizedName}' already exists (no files overwritten).`);
    return;
  }
  logInfo(`Created profile '${normalizedName}'.`);
  process.stdout.write(`\nNext: use ${normalizedName}\n`);
}

export async function cmdRemoveProfile(name) {
  const profilePath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${name}.json`);
  if (!(await fs.pathExists(profilePath))) {
    throw new Error(`Profile '${name}' not found.`);
  }

  await fs.rm(profilePath);
  logInfo(`Removed profile '${name}'.`);

  if (await fs.pathExists(CONFIG_PATH)) {
    const config = await fs.readJson(CONFIG_PATH);
    if (config.defaultProfile === name) {
      delete config.defaultProfile;
      await writeJsonFile(CONFIG_PATH, config);
      logWarn(`Default profile '${name}' was cleared.`);
    }
  }

  const packPath = path.join(LOCAL_OVERRIDES_ROOT, "packs", name);
  if (await fs.pathExists(packPath)) {
    logWarn(`Pack for '${name}' still exists. Remove it manually if you no longer need it.`);
  }
}

export async function loadEffectiveTargets(osName) {
  const integrations = await loadAgentIntegrations();
  const baseTargets = buildTargetsDocument(integrations, osName);

  const overridePath = path.join(LOCAL_OVERRIDES_ROOT, "manifests", "targets.override.json");
  let effectiveTargets = baseTargets;
  if (await fs.pathExists(overridePath)) {
    const overrideTargets = await fs.readJson(overridePath);
    effectiveTargets = merge(baseTargets, overrideTargets, {
      arrayMerge: (_destinationArray, sourceArray) => sourceArray
    });
  }
  return effectiveTargets;
}
