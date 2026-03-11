import fs from "fs-extra";
import path from "node:path";
import { buildSkillProjectionPlan } from "./adapters/common.js";
import { collectLocalSkillEntries } from "./bundle.js";
import { getAgentRegistryById, parseAgentFilterOption, summarizeSkillFeatureSupport } from "./agent-registry.js";
import { LOCAL_OVERRIDES_ROOT, isInsidePath } from "./core.js";
import { listAvailableProfiles, readDefaultProfile, resolveProfile } from "./config.js";
import { hashPathContent } from "./digest.js";
import { loadImportLock, listProfileImportRecords } from "./import-lock.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { scanSkillDirectory } from "./skill-capabilities.js";
import {
  accent,
  formatBadge,
  muted,
  renderKeyValueRows,
  renderSection,
  renderSimpleList,
  renderTable,
  success,
  warning
} from "./terminal-ui.js";
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
  const targetAgentIds = selectedAgents ? Array.from(selectedAgents.values()) : Array.from(agentRegistryById.keys());
  const scanned = [];
  for (const entry of localEntries) {
    const metadata = await scanSkillDirectory(entry.sourcePath);
    const materializedAgents = [];
    for (const agentId of targetAgentIds) {
      const applied = activeAgents.get(agentId) ?? { mode: "unapplied" };
      const support = summarizeSkillFeatureSupport(metadata.capabilities, agentRegistryById.get(agentId));
      materializedAgents.push({
        id: agentId,
        installMode: applied.mode,
        featureChecks: support.checks,
        unsupportedFeatures: support.unsupported,
        compatibilityStatus: support.unsupported.length > 0 ? "degraded" : "ok"
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
      ref: null,
      selectionPath: entry.destRelative,
      tracking: null,
      resolvedRevision: null,
      latestRevision: null,
      flags: ["local"],
      capabilities: metadata.capabilities,
      materializedAgents,
      contentHash: await hashPathContent(entry.sourcePath),
      sourceIdentity: null,
      projectionAdapters: {},
      projectedPathsByAgent: {}
    });
  }
  return scanned.sort((left, right) => left.name.localeCompare(right.name));
}

function mergeImportRecords(
  importRecords,
  planningImports,
  upstreamById,
  activeAgents,
  agentRegistryById,
  selectedAgents = null
) {
  const byKey = new Map();
  const targetAgentIds = selectedAgents ? Array.from(selectedAgents.values()) : Array.from(agentRegistryById.keys());
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
    for (const agentId of targetAgentIds) {
      const applied = activeAgents.get(agentId) ?? { mode: "unapplied" };
      const support = summarizeSkillFeatureSupport(capabilities, agentRegistryById.get(agentId));
      materializedAgents.push({
        id: agentId,
        installMode: applied.mode,
        featureChecks: support.checks,
        unsupportedFeatures: support.unsupported,
        compatibilityStatus: support.unsupported.length > 0 ? "degraded" : "ok",
        projectionVersion: record?.projection?.adapters?.[agentId]?.contractVersion ?? null
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
      ref: entry.ref ?? record?.ref ?? record?.resolution?.ref ?? null,
      selectionPath: entry.selectionPath,
      tracking: entry.tracking,
      resolvedRevision: record?.resolvedRevision ?? null,
      latestRevision: record?.latestRevision ?? null,
      flags,
      capabilities,
      materializedAgents,
      contentHash: record?.contentHash ?? record?.digests?.contentSha256 ?? null,
      sourceIdentity: record?.sourceIdentity ?? record?.source?.identity ?? upstream.sourceIdentity ?? null,
      projectionAdapters: record?.projection?.adapters ?? {},
      projectedPathsByAgent: {}
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function applyProjectionPlans(items, agentRegistryById, selectedAgents = null) {
  const agentIds = selectedAgents ? Array.from(selectedAgents.values()) : Array.from(agentRegistryById.keys());
  for (const agentId of agentIds) {
      const metadata = agentRegistryById.get(agentId);
      const projectionPlan = buildSkillProjectionPlan(
      items.map((item) => item.name),
      metadata?.support?.skills?.nestedDiscovery !== false
    );
    for (const item of items) {
      item.projectedPathsByAgent[agentId] = projectionPlan.get(item.name) ?? [item.name];
    }
  }
  return items;
}

function formatAgentStatus(agent) {
  const unsupportedCount = Array.isArray(agent.unsupportedFeatures) ? agent.unsupportedFeatures.length : 0;
  const compatibilityLabel = agent.compatibilityStatus === "degraded"
    ? `degraded${unsupportedCount > 0 ? `:${unsupportedCount}` : ""}`
    : "ok";
  const compatibilityTone = agent.compatibilityStatus === "degraded" ? "warning" : "success";
  return [
    accent(agent.id, process.stdout),
    formatBadge(agent.installMode, "accent", process.stdout),
    formatBadge(compatibilityLabel, compatibilityTone, process.stdout)
  ].join(" ");
}

function findProjectionStaleAgents(item, agentRegistryById) {
  const stale = [];
  for (const agent of item.materializedAgents ?? []) {
    const expectedVersion = agentRegistryById.get(agent.id)?.projectionVersion ?? 1;
    if (Number.isInteger(agent.projectionVersion) && agent.projectionVersion !== expectedVersion) {
      stale.push(agent.id);
    }
  }
  return stale.sort((left, right) => left.localeCompare(right));
}

function toneForFlag(flag) {
  switch (flag) {
    case "imported":
      return "success";
    case "imported-local":
    case "local":
      return "accent";
    case "pinned":
      return "accent";
    case "floating":
      return "muted";
    case "stale":
      return "warning";
    default:
      return "muted";
  }
}

function formatFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    return muted("(none)", process.stdout);
  }
  return flags.map((flag) => formatBadge(flag, toneForFlag(flag), process.stdout)).join(" ");
}

function formatCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return muted("(none)", process.stdout);
  }
  return capabilities.join(", ");
}

function formatSkillSource(item) {
  return item.upstream ? `${item.upstream}:${item.selectionPath}` : item.source;
}

function formatSkillRows(items, detail, agentRegistryById) {
  if (detail !== "full") {
    return {
      headers: ["Name"],
      rows: items.map((item) => [item.name])
    };
  }

  const includeRevision = items.some((item) => typeof item.resolvedRevision === "string" && item.resolvedRevision.length > 0);
  const includeProjection = items.some((item) => findProjectionStaleAgents(item, agentRegistryById).length > 0);
  const headers = ["Name", "Type", "Source", "State", "Capabilities"];
  if (includeRevision) {
    headers.push("Revision");
  }
  if (includeProjection) {
    headers.push("Projection");
  }

  const rows = items.map((item) => {
    const row = [
      item.name,
      item.sourceType,
      formatSkillSource(item),
      formatFlags(item.flags),
      formatCapabilities(item.capabilities)
    ];
    if (includeRevision) {
      row.push(item.resolvedRevision ? item.resolvedRevision.slice(0, 12) : muted("-", process.stdout));
    }
    if (includeProjection) {
      const staleAgents = findProjectionStaleAgents(item, agentRegistryById);
      row.push(staleAgents.length > 0 ? warning(staleAgents.join(", "), process.stdout) : success("current", process.stdout));
    }
    return row;
  });

  return { headers, rows };
}

function formatMcpTarget(server) {
  if (typeof server.url === "string" && server.url.length > 0) {
    return server.url;
  }

  const args = Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  const envEntries = sortStrings(Object.keys(server.env ?? {})).map((key) =>
    formatEnvAssignment(key, server.env[key])
  );
  const env = envEntries.length > 0 ? ` [env: ${envEntries.join(", ")}]` : "";
  return `${server.command}${args}${env}`;
}

function formatSkillsBlock(inventory, detail, agentRegistryById) {
  const lines = [];
  lines.push(renderSection("Skills", { count: inventory.skills.total, stream: process.stdout }));
  if (inventory.skills.items.length === 0) {
    lines.push(renderSimpleList([], { empty: "(none)" }));
    return lines;
  }
  const { headers, rows } = formatSkillRows(inventory.skills.items, detail, agentRegistryById);
  lines.push(renderTable(headers, rows, { stream: process.stdout }));
  if (detail === "full") {
    const agentRows = inventory.skills.items
      .filter((item) => (item.materializedAgents ?? []).length > 0)
      .map((item) => ({
        key: item.name,
        value: item.materializedAgents.map((agent) => formatAgentStatus(agent)).join("  ")
      }));
    if (agentRows.length > 0) {
      lines.push("");
      lines.push(renderSection("Agent Materialization", { stream: process.stdout }));
      lines.push(renderKeyValueRows(agentRows, { indent: "  ", stream: process.stdout }));
    }
  }
  return lines;
}

function formatMcpBlock(inventory) {
  const lines = [];
  lines.push(renderSection("MCP Servers", { count: inventory.mcp.total, stream: process.stdout }));
  if (inventory.mcp.servers.length === 0) {
    lines.push(renderSimpleList([], { empty: "(none)" }));
    return lines;
  }
  lines.push(
    renderTable(
      ["Name", "Target"],
      inventory.mcp.servers.map((server) => [server.name, formatMcpTarget(server)]),
      { stream: process.stdout }
    )
  );
  return lines;
}

function profileText(inventory, detail, agentRegistryById) {
  const lines = [renderSection("Profile", { stream: process.stdout })];
  lines.push(
    renderKeyValueRows(
      [
        { key: "Name", value: accent(inventory.profile.name, process.stdout) },
        { key: "Source", value: inventory.profile.source },
        ...(inventory.profile.extends ? [{ key: "Extends", value: inventory.profile.extends }] : [])
      ],
      { stream: process.stdout }
    )
  );
  lines.push("");
  lines.push(...formatSkillsBlock(inventory, detail, agentRegistryById));
  lines.push("");
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
  const items = applyProjectionPlans(
    [...localItems, ...importedItems].sort((left, right) => left.name.localeCompare(right.name)),
    agentRegistryById,
    selectedAgents
  );

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
  const agentRegistryById = await getAgentRegistryById();
  process.stdout.write(`${profileText(inventory, detail, agentRegistryById)}\n`);
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
  const headers = detail === "full"
    ? ["Name", "Type", "Source", "State", "Capabilities"]
    : ["Name"];
  const rows = detail === "full"
    ? inventory.skills.items.map((item) => [
      item.name,
      item.sourceType,
      item.upstream ?? item.source,
      formatFlags(item.flags),
      formatCapabilities(item.capabilities)
    ])
    : inventory.skills.items.map((item) => [item.name]);
  process.stdout.write(`${renderTable(headers, rows, { stream: process.stdout })}\n`);
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
  process.stdout.write(
    `${renderTable(
      ["Name", "Target"],
      mcps.map((server) => [
        server.name,
        formatMcpTarget(server)
      ]),
      { stream: process.stdout }
    )}\n`
  );
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
      process.stdout.write(`${renderSection("Profile", { stream: process.stdout })}\n`);
      process.stdout.write(
        `${renderKeyValueRows(
          [
            { key: "Name", value: item.profile },
            { key: "Error", value: warning(item.error, process.stdout) }
          ],
          { stream: process.stdout }
        )}\n`
      );
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
