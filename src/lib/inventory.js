import fs from "fs-extra";
import path from "node:path";
import { collectLocalSkillEntries } from "./bundle.js";
import { getAgentRegistryById, parseAgentFilterOption, summarizeCapabilitySupport } from "./agent-registry.js";
import { LOCAL_OVERRIDES_ROOT, isInsidePath } from "./core.js";
import { listAvailableProfiles, readDefaultProfile, resolveProfile } from "./config.js";
import { loadImportLock, listProfileImportRecords } from "./import-lock.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { scanSkillDirectory } from "./skill-capabilities.js";
import { collectSourcePlanning, loadUpstreamsConfig } from "./upstreams.js";
import { getStatePath } from "./bindings.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function formatEnvAssignment(key, value) {
  const text = String(value ?? "");
  const quoted = text.length === 0 || /[\s,]/.test(text);
  return `${key}=${quoted ? JSON.stringify(text) : text}`;
}

function inferProfileSource(profilePath) {
  return isInsidePath(LOCAL_OVERRIDES_ROOT, profilePath) ? "local" : "seed";
}

async function loadActiveState() {
  const statePath = await getStatePath();
  if (!(await fs.pathExists(statePath))) {
    return null;
  }
  return fs.readJson(statePath).catch(() => null);
}

function mapMaterializedAgents(state, profileName) {
  if (!state || state.profile !== profileName) {
    return new Map();
  }
  const byTool = new Map();
  for (const binding of Array.isArray(state.bindings) ? state.bindings : []) {
    if (binding.kind !== "dir") {
      continue;
    }
    byTool.set(binding.tool, {
      mode: binding.method,
      targetPath: binding.targetPath
    });
  }
  return byTool;
}

async function collectLocalSkillInventory(packRoots, activeAgents, agentRegistryById, selectedAgents = null) {
  const localEntries = await collectLocalSkillEntries(packRoots);
  const scanned = [];
  for (const entry of localEntries) {
    const metadata = await scanSkillDirectory(entry.sourcePath);
    const materializedAgents = [];
    for (const [agentId, applied] of activeAgents.entries()) {
      if (selectedAgents && !selectedAgents.has(agentId)) {
        continue;
      }
      const support = summarizeCapabilitySupport(metadata.capabilities, agentRegistryById.get(agentId));
      materializedAgents.push({
        id: agentId,
        installMode: applied.mode,
        capabilitySupport: support.rows,
        capabilityMismatches: support.mismatches
      });
    }
    scanned.push({
      name: entry.destRelative,
      basename: path.posix.basename(entry.destRelative),
      title: metadata.title,
      summary: metadata.summary,
      sourceType: "local",
      provider: "local",
      source: entry.sourcePath,
      upstream: null,
      selectionPath: entry.destRelative,
      tracking: null,
      resolvedRevision: null,
      flags: ["local"],
      capabilities: metadata.capabilities,
      materializedAgents
    });
  }
  return scanned.sort((left, right) => left.name.localeCompare(right.name));
}

function mergeImportRecords(importRecords, planningImports, upstreamById, activeAgents, agentRegistryById, selectedAgents = null) {
  const byKey = new Map();
  for (const record of importRecords) {
    byKey.set(`${record.upstream}::${record.selectionPath}::${record.destRelative}`, record);
  }

  return planningImports.map((entry) => {
    const upstream = upstreamById.get(entry.upstreamId);
    const record = byKey.get(`${entry.upstreamId}::${entry.selectionPath}::${entry.destRelative}`);
    const capabilities = Array.isArray(record?.capabilities) ? [...record.capabilities] : [];
    const flags = [];
    flags.push(upstream.provider === "local-path" ? "imported-local" : "imported");
    flags.push(entry.tracking === "pinned" ? "pinned" : "floating");
    if (record?.resolvedRevision && record?.latestRevision && record.resolvedRevision !== record.latestRevision) {
      flags.push("stale");
    }

    const materializedAgents = [];
    for (const [agentId, applied] of activeAgents.entries()) {
      if (selectedAgents && !selectedAgents.has(agentId)) {
        continue;
      }
      const support = summarizeCapabilitySupport(capabilities, agentRegistryById.get(agentId));
      materializedAgents.push({
        id: agentId,
        installMode: applied.mode,
        capabilitySupport: support.rows,
        capabilityMismatches: support.mismatches
      });
    }

    return {
      name: entry.destRelative,
      basename: path.posix.basename(entry.destRelative),
      title: record?.title ?? path.posix.basename(entry.destRelative),
      summary: record?.summary ?? "",
      sourceType: "imported",
      provider: upstream.provider,
      source: upstream.provider === "local-path" ? upstream.path : upstream.repo,
      originalInput: upstream.originalInput ?? (upstream.provider === "local-path" ? upstream.path : upstream.repo),
      upstream: upstream.id,
      selectionPath: entry.selectionPath,
      tracking: entry.tracking,
      resolvedRevision: record?.resolvedRevision ?? null,
      latestRevision: record?.latestRevision ?? null,
      flags,
      capabilities,
      materializedAgents
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function formatSkillsBlock(inventory, detail) {
  const lines = [];
  lines.push(`Skills (${inventory.skills.total})`);
  if (inventory.skills.items.length === 0) {
    lines.push("  (none)");
    return lines;
  }

  for (const item of inventory.skills.items) {
    if (detail !== "full") {
      lines.push(`  ${item.name}`);
      continue;
    }
    const sourceLabel = item.upstream ? `${item.upstream}:${item.selectionPath}` : item.source;
    const flags = item.flags.length > 0 ? ` [${item.flags.join(", ")}]` : "";
    lines.push(`  ${item.name}\t${sourceLabel}${flags}`);
    if (item.materializedAgents.length > 0) {
      lines.push(`    agents: ${item.materializedAgents.map((agent) => `${agent.id}:${agent.installMode}`).join(", ")}`);
    }
    if (item.capabilities.length > 1) {
      lines.push(`    capabilities: ${item.capabilities.join(", ")}`);
    }
  }
  return lines;
}

function formatMcpBlock(inventory) {
  const lines = [];
  lines.push(`MCP Servers (${inventory.mcp.total})`);
  if (inventory.mcp.servers.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const server of inventory.mcp.servers) {
    if (typeof server.url === "string" && server.url.length > 0) {
      lines.push(`  ${server.name}\t${server.url}`);
      continue;
    }
    const args = server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
    const envEntries = sortStrings(Object.keys(server.env ?? {})).map((key) =>
      formatEnvAssignment(key, server.env[key])
    );
    const env = envEntries.length > 0 ? ` [env:${envEntries.join(", ")}]` : "";
    lines.push(`  ${server.name}\t${server.command}${args}${env}`);
  }
  return lines;
}

function profileText(inventory, detail) {
  const lines = [`Profile: ${inventory.profile.name}`];
  if (inventory.profile.extends) {
    lines.push(`Extends: ${inventory.profile.extends}`);
  }
  lines.push(...formatSkillsBlock(inventory, detail));
  lines.push(...formatMcpBlock(inventory));
  return lines.join("\n");
}

export async function buildProfileInventory(profileName, { detail = "concise", agents = null } = {}) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (!normalizedProfile) {
    throw new Error("Profile name is required.");
  }

  const effectiveState = await loadEffectiveProfileState(normalizedProfile);
  const activeState = await loadActiveState();
  const activeAgents = mapMaterializedAgents(activeState, normalizedProfile);
  const agentRegistryById = await getAgentRegistryById();
  const selectedAgents = agents ? new Set(await parseAgentFilterOption(agents)) : null;
  const upstreams = await loadUpstreamsConfig();
  const planning = collectSourcePlanning(effectiveState.effectiveSources, upstreams.byId);
  const lockState = await loadImportLock();
  const importRecords = listProfileImportRecords(lockState.lock, normalizedProfile);

  const localItems = await collectLocalSkillInventory(
      effectiveState.packs.map((item) => item.packRoot),
      activeAgents,
      agentRegistryById,
      selectedAgents
    );
  const importedItems = mergeImportRecords(
    importRecords,
    planning.skillImports,
    upstreams.byId,
    activeAgents,
    agentRegistryById,
    selectedAgents
  );
  const items = [...localItems, ...importedItems].sort((left, right) => left.name.localeCompare(right.name));

  const { profilePath, profile } = await resolveProfile(normalizedProfile);
  const mcpServers = Object.keys(effectiveState.effectiveMcpDocument.servers ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const server = effectiveState.effectiveMcpDocument.servers[name] ?? {};
      if (typeof server.url === "string" && server.url.trim().length > 0) {
        return {
          name,
          url: server.url.trim()
        };
      }
      const env = {};
      if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
        for (const key of sortStrings(Object.keys(server.env))) {
          env[key] = String(server.env[key]);
        }
      }
      return {
        name,
        command: server.command,
        args: Array.isArray(server.args) ? [...server.args] : [],
        env
      };
    });

  return {
    profile: {
      name: normalizedProfile,
      source: inferProfileSource(profilePath),
      description: profile.description,
      ...(profile.extends ? { extends: profile.extends } : {})
    },
    detail,
    skills: {
      total: items.length,
      items
    },
    mcp: {
      total: mcpServers.length,
      servers: mcpServers
    }
  };
}

export async function cmdShowProfileInventory({ profile, format, detail = "concise", agents = null }) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? await readDefaultProfile();
  if (!resolvedProfile) {
    throw new Error("Profile is required. Set a default first with 'use <name>'.");
  }

  const inventory = await buildProfileInventory(resolvedProfile, { detail, agents });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${profileText(inventory, detail)}\n`);
}

export async function cmdListLocalSkills({ profile, format, detail = "concise", agents = null }) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? await readDefaultProfile();
  if (!resolvedProfile) {
    throw new Error("Profile is required. Set a default first with 'use <name>'.");
  }

  const inventory = await buildProfileInventory(resolvedProfile, { detail, agents });
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          profile: resolvedProfile,
          detail,
          skills: inventory.skills.items
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (inventory.skills.items.length === 0) {
    process.stdout.write("(no skills)\n");
    return;
  }
  for (const item of inventory.skills.items) {
    if (detail === "full") {
      process.stdout.write(`${item.name}\t${item.sourceType}\t${item.upstream ?? item.source}\n`);
    } else {
      process.stdout.write(`${item.name}\n`);
    }
  }
}

export async function cmdListMcps({ profile, format }) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? await readDefaultProfile();
  if (!resolvedProfile) {
    throw new Error("Profile is required. Set a default first with 'use <name>'.");
  }

  const inventory = await buildProfileInventory(resolvedProfile, { detail: "concise" });
  const mcps = inventory.mcp.servers.map((server) => ({ ...server }));

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ profile: resolvedProfile, mcps }, null, 2)}\n`);
    return;
  }

  if (mcps.length === 0) {
    process.stdout.write("(no mcps)\n");
    return;
  }
  for (const server of mcps) {
    if (server.url) {
      process.stdout.write(`${server.name}\t${server.url}\n`);
    } else {
      process.stdout.write(`${server.name}\t${server.command}${server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}\n`);
    }
  }
}

export async function cmdListEverything({ format, detail = "concise" }) {
  const profiles = await listAvailableProfiles();
  if (profiles.length === 0) {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ profiles: [] }, null, 2)}\n`);
    } else {
      process.stdout.write("No profiles found.\n");
    }
    return;
  }

  const results = [];
  for (const item of profiles) {
    try {
      const inventory = await buildProfileInventory(item.name, { detail });
      results.push({
        profile: item.name,
        source: item.source,
        inventory
      });
    } catch (error) {
      results.push({
        profile: item.name,
        source: item.source,
        error: error.message
      });
    }
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ profiles: results }, null, 2)}\n`);
    return;
  }

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    if (item.error) {
      process.stdout.write(`Profile: ${item.profile}\n`);
      process.stdout.write(`Error: ${item.error}\n`);
    } else {
      process.stdout.write(profileText(item.inventory, detail));
    }
    if (index < results.length - 1) {
      process.stdout.write("\n\n");
    } else {
      process.stdout.write("\n");
    }
  }
}
