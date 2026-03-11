import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { loadAgentRegistry, parseAgentFilterOption as parseAgentFilterOptionFromRegistry, summarizeSkillFeatureSupport } from "./agent-registry.js";
import {
  MCP_MANAGED_PREFIX,
  SCHEMAS,
  assertJsonFileMatchesSchema,
  assertObjectMatchesSchema,
  detectOsName,
  expandTargetPath,
  logInfo,
  logWarn,
  writeJsonFile
} from "./core.js";
import { readInstalledMcpServersForAgent, resolveAgentMcpConfigKind } from "./mcp-config.js";
import { applyBindings } from "./bindings.js";
import { getStatePath } from "./bindings.js";
import { loadAgentIntegrations } from "./agent-integrations.js";
import { buildProfile } from "./build.js";
import { collectImportedSkillEntries, collectLocalSkillEntries } from "./bundle.js";
import { loadEffectiveTargets, readDefaultProfile, resolvePack, resolveProfile } from "./config.js";
import { hashPathContent } from "./digest.js";
import { buildProfileInventory } from "./inventory.js";
import { materializeProjectedSkillDirectory } from "./adapters/common.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import {
  accent,
  danger,
  formatBadge,
  muted,
  renderKeyValueRows,
  renderSection,
  renderSimpleList,
  renderTable,
  success,
  warning
} from "./terminal-ui.js";
import { collectSourcePlanning, loadLockfile, loadUpstreamsConfig, resolveReferences } from "./upstreams.js";

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

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

function normalizeDriftMcpName(value) {
  const normalized = String(value ?? "").trim();
  if (
    normalized.startsWith(MCP_MANAGED_PREFIX) &&
    normalized.length > MCP_MANAGED_PREFIX.length
  ) {
    return normalized.slice(MCP_MANAGED_PREFIX.length);
  }
  return normalized;
}

function normalizeDriftMcpNames(values) {
  const names = new Set();
  for (const value of values) {
    const normalized = normalizeDriftMcpName(value);
    if (normalized.length === 0) {
      continue;
    }
    names.add(normalized);
  }
  return sortStrings(Array.from(names));
}

function normalizeManagedBindingNames(values) {
  const names = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeDriftMcpName(value);
    if (normalized.length > 0) {
      names.add(normalized);
    }
  }
  return names;
}

async function loadManagedMcpNamesByTool() {
  const statePath = await getStatePath();
  if (!(await fs.pathExists(statePath))) {
    return new Map();
  }
  const state = await fs.readJson(statePath).catch(() => null);
  const bindings = Array.isArray(state?.bindings) ? state.bindings : [];
  const byTool = new Map();
  for (const binding of bindings) {
    if (binding?.kind !== "config" || typeof binding?.tool !== "string") {
      continue;
    }
    const current = byTool.get(binding.tool) ?? new Set();
    for (const name of normalizeManagedBindingNames(binding.managedNames)) {
      current.add(name);
    }
    byTool.set(binding.tool, current);
  }
  return byTool;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export async function parseAgentFilterOption(rawAgents) {
  return parseAgentFilterOptionFromRegistry(rawAgents);
}

function normalizeCyclePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function runtimeHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function expandRuntimeMcpValue(value) {
  const text = String(value ?? "");
  const home = runtimeHomeDir();
  if (text === "~") {
    return home;
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return `${home}${text.slice(1)}`;
  }
  return text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home)
    .replace(/%USERPROFILE%/gi, home);
}

async function isDirectoryDirent(absoluteParentPath, entry) {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return (await fs.stat(path.join(absoluteParentPath, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

async function detectSkillDirectories(skillsRoot, currentRelative = "", entries = [], ancestorRealpaths = new Set()) {
  const absolute = currentRelative.length > 0 ? path.join(skillsRoot, currentRelative) : skillsRoot;
  let nextAncestors = ancestorRealpaths;
  try {
    const realAbsolute = normalizeCyclePath(await fs.realpath(absolute));
    if (ancestorRealpaths.has(realAbsolute)) {
      return entries;
    }
    nextAncestors = new Set(ancestorRealpaths);
    nextAncestors.add(realAbsolute);
  } catch {
    nextAncestors = ancestorRealpaths;
  }
  const children = await fs.readdir(absolute, { withFileTypes: true });

  let hasSkill = false;
  for (const child of children) {
    if (child.isFile() && child.name === "SKILL.md") {
      hasSkill = true;
      break;
    }
  }

  if (hasSkill && currentRelative.length > 0) {
    entries.push(toPosixPath(currentRelative));
  }

  const directories = [];
  for (const child of children) {
    if (await isDirectoryDirent(absolute, child)) {
      directories.push(child.name);
    }
  }
  directories.sort((left, right) => left.localeCompare(right));

  for (const directory of directories) {
    const nextRelative = currentRelative.length > 0 ? path.join(currentRelative, directory) : directory;
    await detectSkillDirectories(skillsRoot, nextRelative, entries, nextAncestors);
  }

  return entries;
}

async function collectInstalledSkillDetails(skillsRoot, skillPaths) {
  const details = [];
  for (const relativeSkillPath of Array.isArray(skillPaths) ? skillPaths : []) {
    const absoluteSkillPath = path.join(skillsRoot, relativeSkillPath.split("/").join(path.sep));
    const contentHash = await hashPathContent(absoluteSkillPath).catch(() => null);
    details.push({
      path: relativeSkillPath,
      contentHash
    });
  }
  return details.sort((left, right) => left.path.localeCompare(right.path));
}

function buildAgentRows(osName, targets, integrations, selectedAgents) {
  return integrations
    .filter((integration) => !selectedAgents || selectedAgents.has(integration.id))
    .map((integration) => {
    const tool = integration.id;
    const target = targets?.[tool];
    if (!target) {
      throw new Error(`Missing target mapping for agent '${tool}'.`);
    }
    const skillsRaw = typeof target.skillsDir === "string" && target.skillsDir.trim().length > 0 ? target.skillsDir : null;
    const mcpRaw = typeof target.mcpConfig === "string" && target.mcpConfig.trim().length > 0 ? target.mcpConfig : null;
    if (!mcpRaw) {
      throw new Error(`Missing MCP config target path for agent '${tool}'.`);
    }
    return {
      tool,
      name: integration.name ?? tool,
      metadata: integration,
      managedSurface: skillsRaw ? "skills+mcp" : "mcp-only",
      skillsDir: skillsRaw ? expandTargetPath(skillsRaw, osName) : null,
      mcpConfig: expandTargetPath(mcpRaw, osName),
      hasNonMcpConfig: Boolean(target?.hasNonMcpConfig),
      notes: Array.isArray(integration?.notes) ? [...integration.notes] : [],
      support: integration?.support ?? { skills: {}, mcp: {} },
      mcpConfigKind: resolveAgentMcpConfigKind(integration)
    };
  });
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function collectAgentInventories({ agents } = {}) {
  const osName = detectOsName();
  const targets = await loadEffectiveTargets(osName);
  const selectedAgentIds = await parseAgentFilterOption(agents);
  const integrations = await loadAgentIntegrations();
  const managedMcpNamesByTool = await loadManagedMcpNamesByTool();
  const rows = buildAgentRows(osName, targets, integrations, new Set(selectedAgentIds));

  const detailedRows = [];
  for (const row of rows) {
    const hasSkillsPath = row.skillsDir ? await fs.pathExists(row.skillsDir).catch(() => false) : false;
    const hasMcpPath = await fs.pathExists(row.mcpConfig).catch(() => false);

    const parseErrors = [];
    let skills = [];
    let skillDetails = [];
    if (row.skillsDir && hasSkillsPath) {
      try {
        skills = sortStrings(await detectSkillDirectories(row.skillsDir));
        skillDetails = await collectInstalledSkillDetails(row.skillsDir, skills);
      } catch (error) {
        parseErrors.push({
          kind: "skills",
          path: row.skillsDir,
          message: formatErrorMessage(error)
        });
      }
    }

    let mcpServers = [];
    if (hasMcpPath) {
      try {
        mcpServers = await readInstalledMcpServersForAgent({
          agent: row.metadata,
          configKind: row.mcpConfigKind,
          configPath: row.mcpConfig
        });
        const managedNames = managedMcpNamesByTool.get(row.tool) ?? new Set();
        mcpServers = mcpServers.map((server) => ({
          ...server,
          managed:
            managedNames.has(normalizeDriftMcpName(server.name)) ||
            String(server.name ?? "").startsWith(MCP_MANAGED_PREFIX)
        }));
      } catch (error) {
        parseErrors.push({
          kind: "mcp",
          path: row.mcpConfig,
          message: formatErrorMessage(error)
        });
      }
    }

    detailedRows.push({
      ...row,
      hasSkillsPath,
      hasMcpPath,
      installed: hasSkillsPath || hasMcpPath,
      inventory: {
        skills,
        skillDetails,
        mcpServers
      },
      parseErrors
    });
  }

  return {
    os: osName,
    agents: detailedRows
  };
}

function normalizeDisplaySkillPath(skillPath) {
  const value = String(skillPath ?? "").trim();
  if (!value.startsWith("vendor__")) {
    return value;
  }
  const trimmed = value.slice("vendor__".length);
  return trimmed.includes("__") ? trimmed.split("__").join("/") : value;
}

function buildDisplaySkills(skills) {
  const canonical = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const normalized = normalizeDisplaySkillPath(skill);
    if (normalized.length > 0) {
      canonical.add(normalized);
    }
  }
  return sortStrings(Array.from(canonical));
}

function buildDisplayMcpServers(servers) {
  const names = new Set();
  for (const server of Array.isArray(servers) ? servers : []) {
    const normalized = normalizeDriftMcpName(server?.name);
    if (normalized.length > 0) {
      names.add(normalized);
    }
  }
  return sortStrings(Array.from(names)).map((name) => ({ name }));
}

function formatParseErrors(parseErrors) {
  if (parseErrors.length === 0) {
    return renderSimpleList([success("none", process.stdout)], { indent: "  " });
  }
  return renderSimpleList(
    parseErrors.map((issue) => `[${danger(issue.kind, process.stdout)}] ${redactPathDetails(issue.message)}`),
    { indent: "  " }
  );
}

function formatSummaryCount(count) {
  return count > 0 ? warning(String(count), process.stdout) : success("0", process.stdout);
}

function isAgentInSync(agent) {
  return (
    agent.summary.missingTotal === 0 &&
    agent.summary.extraTotal === 0 &&
    agent.summary.changedTotal === 0 &&
    agent.summary.parseErrors === 0 &&
    agent.summary.featureWarnings === 0 &&
    agent.classes.length === 0
  );
}

function formatInventoryStatus(agent) {
  return agent.installed ? success("detected", process.stdout) : warning("not detected", process.stdout);
}

function formatDriftStatus(agent) {
  if (isAgentInSync(agent)) {
    return success("in sync", process.stdout);
  }
  if (!agent.installed) {
    return warning("not detected", process.stdout);
  }
  return warning("attention", process.stdout);
}

function inventoryToText(payload) {
  const lines = [
    renderSection("Host", { stream: process.stdout }),
    renderKeyValueRows([{ key: "OS", value: accent(payload.os, process.stdout) }], { stream: process.stdout })
  ];
  for (const agent of payload.agents) {
    const displaySkills = buildDisplaySkills(agent.inventory.skills);
    const displayMcpServers = buildDisplayMcpServers(agent.inventory.mcpServers);
    lines.push("");
    lines.push(accent(agent.tool, process.stdout));
    lines.push(
      renderKeyValueRows(
        [
          { key: "Status", value: formatInventoryStatus(agent) },
          { key: "Surface", value: agent.managedSurface },
          { key: "Skills", value: String(displaySkills.length) },
          { key: "MCP Servers", value: String(displayMcpServers.length) },
          {
            key: "Parse Errors",
            value: agent.parseErrors.length === 0
              ? success("none", process.stdout)
              : warning(String(agent.parseErrors.length), process.stdout)
          }
        ],
        { stream: process.stdout }
      )
    );
    lines.push("");
    lines.push(renderSection("Skills", { count: displaySkills.length, stream: process.stdout }));
    lines.push(
      displaySkills.length === 0
        ? renderSimpleList([], { empty: "(none)" })
        : renderTable(["Name"], displaySkills.map((item) => [item]), { stream: process.stdout })
    );
    lines.push("");
    lines.push(renderSection("MCP Servers", { count: displayMcpServers.length, stream: process.stdout }));
    lines.push(
      displayMcpServers.length === 0
        ? renderSimpleList([], { empty: "(none)" })
        : renderTable(["Name"], displayMcpServers.map((server) => [server.name]), { stream: process.stdout })
    );
    lines.push("");
    lines.push(renderSection("Parse Errors", { count: agent.parseErrors.length, stream: process.stdout }));
    lines.push(formatParseErrors(agent.parseErrors));
  }
  return lines.join("\n").trimEnd();
}

function computeDifference(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [];
  const extra = [];

  for (const item of expectedSet) {
    if (!actualSet.has(item)) {
      missing.push(item);
    }
  }
  for (const item of actualSet) {
    if (!expectedSet.has(item)) {
      extra.push(item);
    }
  }

  return {
    missing: sortStrings(missing),
    extra: sortStrings(extra)
  };
}

function indexSkillDetails(skillDetails) {
  return new Map(
    (Array.isArray(skillDetails) ? skillDetails : []).map((detail) => [detail.path, detail])
  );
}

async function computeExpectedProjectedSkillHash(sourceSkillPath, integration, projectionHashCache, tempRoot) {
  if (!sourceSkillPath || !integration) {
    return null;
  }
  const cacheKey = `${integration.id}::${sourceSkillPath}`;
  if (projectionHashCache.has(cacheKey)) {
    return projectionHashCache.get(cacheKey);
  }

  const targetPath = path.join(tempRoot, String(projectionHashCache.size + 1));
  await materializeProjectedSkillDirectory(sourceSkillPath, targetPath, integration.support?.skills);
  const contentHash = await hashPathContent(targetPath).catch(() => null);
  projectionHashCache.set(cacheKey, contentHash);
  return contentHash;
}

async function buildExpectedSkillMap(expectedInventory, integration, sourceSkillPathsByDestRelative, projectionHashCache, tempRoot) {
  const tool = integration?.id;
  const expectedByPath = new Map();
  for (const item of expectedInventory.skills.items) {
    const agentView = item.materializedAgents.find((entry) => entry.id === tool) ?? {
      unsupportedFeatures: [],
      compatibilityStatus: "ok"
    };
    const projectedPaths = Array.isArray(item.projectedPathsByAgent?.[tool]) && item.projectedPathsByAgent[tool].length > 0
      ? item.projectedPathsByAgent[tool]
      : [item.name];
    const sourceSkillPath = sourceSkillPathsByDestRelative.get(item.name) ?? null;
    const projectedContentHash = await computeExpectedProjectedSkillHash(
      sourceSkillPath,
      integration,
      projectionHashCache,
      tempRoot
    );
    for (const projectedPath of projectedPaths) {
      expectedByPath.set(projectedPath, {
        canonicalName: item.name,
        projectedPath,
        contentHash: projectedContentHash,
        sourceType: item.sourceType,
        upstream: item.upstream,
        compatibilityStatus: agentView.compatibilityStatus ?? "ok",
        unsupportedFeatures: Array.isArray(agentView.unsupportedFeatures) ? agentView.unsupportedFeatures : [],
        projectionVersion: item.projectionAdapters?.[tool]?.contractVersion ?? null
      });
    }
  }
  return expectedByPath;
}

function buildExpectedMcpMap(expectedInventory) {
  const expectedByName = new Map();
  for (const server of expectedInventory.mcp.servers ?? []) {
    const normalized = normalizeStoredProfileMcpSpec(server);
    if (!normalized) {
      continue;
    }
    expectedByName.set(server.name, normalized);
  }
  return expectedByName;
}

function buildActualMcpMap(agentInventory) {
  const actualByName = new Map();
  for (const server of agentInventory.inventory?.mcpServers ?? []) {
    const logicalName = normalizeDriftMcpName(server.name);
    const normalized = normalizeDiscoveredMcpServerSpec(server);
    actualByName.set(logicalName, {
      rawName: server.name,
      logicalName,
      managed: server?.managed === true || String(server.name ?? "").startsWith(MCP_MANAGED_PREFIX),
      spec: normalized
    });
  }
  return actualByName;
}

function countByClass(classes) {
  const counts = {};
  for (const entry of classes) {
    counts[entry.code] = (counts[entry.code] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function sortDriftClasses(classes) {
  return [...classes].sort((left, right) => {
    const leftKey = [
      left.severity,
      left.code,
      left.skillPath ?? "",
      left.skillName ?? "",
      left.mcpName ?? "",
      left.agentId ?? ""
    ].join("::");
    const rightKey = [
      right.severity,
      right.code,
      right.skillPath ?? "",
      right.skillName ?? "",
      right.mcpName ?? "",
      right.agentId ?? ""
    ].join("::");
    return leftKey.localeCompare(rightKey);
  });
}

function formatByClassSummary(byClass) {
  const entries = Object.entries(byClass ?? {});
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([code, count]) => `${code}=${count}`).join(", ");
}

function driftToText(driftReport) {
  const lines = [
    renderSection("Agent Drift", { stream: process.stdout }),
    renderKeyValueRows(
      [
        { key: "Profile", value: accent(driftReport.profile, process.stdout) },
        { key: "Expected Skills", value: String(driftReport.expected.skills.length) },
        { key: "Expected MCP Servers", value: String(driftReport.expected.mcpServers.length) }
      ],
      { stream: process.stdout }
    ),
    "",
    renderSection("Agents", { count: driftReport.agents.length, stream: process.stdout }),
    renderTable(
      ["Agent", "Status", "Missing", "Extra", "Changed", "Warnings", "Parse"],
      driftReport.agents.map((agent) => [
        accent(agent.tool, process.stdout),
        formatDriftStatus(agent),
        { text: formatSummaryCount(agent.summary.missingTotal), align: "right" },
        { text: formatSummaryCount(agent.summary.extraTotal), align: "right" },
        { text: formatSummaryCount(agent.summary.changedTotal), align: "right" },
        { text: formatSummaryCount(agent.summary.featureWarnings), align: "right" },
        { text: formatSummaryCount(agent.summary.parseErrors), align: "right" }
      ]),
      { stream: process.stdout }
    )
  ];

  const detailedAgents = driftReport.agents.filter((agent) => !isAgentInSync(agent));
  if (detailedAgents.length === 0) {
    return lines.join("\n").trimEnd();
  }

  lines.push("");
  lines.push(renderSection("Details", { count: detailedAgents.length, stream: process.stdout }));
  for (const agent of detailedAgents) {
    lines.push(accent(agent.tool, process.stdout));
    lines.push(
      renderKeyValueRows(
        [
          { key: "Surface", value: agent.managedSurface },
          { key: "Installed", value: agent.installed ? success("yes", process.stdout) : warning("no", process.stdout) },
          {
            key: "Class Summary",
            value: formatByClassSummary(agent.summary.byClass) || muted("(none)", process.stdout)
          }
        ],
        { stream: process.stdout }
      )
    );

    if (agent.parseErrors.length > 0) {
      lines.push(renderSection("Parse Errors", { count: agent.parseErrors.length, stream: process.stdout }));
      lines.push(formatParseErrors(agent.parseErrors));
    }

    if (agent.classes.length > 0) {
      lines.push(renderSection("Issues", { count: agent.classes.length, stream: process.stdout }));
      lines.push(
        renderTable(
          ["Class", "Severity", "Message"],
          agent.classes.slice(0, 3).map((issue) => [
            issue.code,
            issue.severity === "error"
              ? danger(issue.severity, process.stdout)
              : warning(issue.severity, process.stdout),
            issue.message
          ]),
          { stream: process.stdout }
        )
      );
    }

    const driftBadges = [];
    if (agent.drift.skills.missing.length > 0) {
      driftBadges.push(formatBadge(`skills-missing:${agent.drift.skills.missing.length}`, "warning", process.stdout));
    }
    if (agent.drift.skills.extra.length > 0) {
      driftBadges.push(formatBadge(`skills-extra:${agent.drift.skills.extra.length}`, "warning", process.stdout));
    }
    if ((agent.drift.skills.changed ?? []).length > 0) {
      driftBadges.push(formatBadge(`skills-changed:${agent.drift.skills.changed.length}`, "warning", process.stdout));
    }
    if (agent.drift.mcpServers.missing.length > 0) {
      driftBadges.push(formatBadge(`mcp-missing:${agent.drift.mcpServers.missing.length}`, "warning", process.stdout));
    }
    if (agent.drift.mcpServers.extra.length > 0) {
      driftBadges.push(formatBadge(`mcp-extra:${agent.drift.mcpServers.extra.length}`, "warning", process.stdout));
    }
    if ((agent.drift.mcpServers.changed ?? []).length > 0) {
      driftBadges.push(formatBadge(`mcp-changed:${agent.drift.mcpServers.changed.length}`, "warning", process.stdout));
    }
    if (driftBadges.length > 0) {
      lines.push(renderSection("Drift Summary", { stream: process.stdout }));
      lines.push(`  ${driftBadges.join(" ")}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function toPublicParseErrors(parseErrors) {
  return parseErrors.map((issue) => ({
    kind: issue.kind,
    message: redactPathDetails(issue.message)
  }));
}

function toPublicInventoryPayload(payload) {
  return {
    os: payload.os,
    agents: payload.agents.map((agent) => ({
      tool: agent.tool,
      name: agent.name,
      managedSurface: agent.managedSurface,
      hasNonMcpConfig: agent.hasNonMcpConfig,
      installed: agent.installed,
      hasSkillsPath: agent.hasSkillsPath,
      hasMcpPath: agent.hasMcpPath,
      inventory: agent.inventory,
      notes: agent.notes,
      support: agent.support,
      parseErrors: toPublicParseErrors(agent.parseErrors)
    }))
  };
}

function toPublicDriftPayload(payload) {
  return {
    os: payload.os,
    profile: payload.profile,
    expected: payload.expected,
    summary: payload.summary,
    agents: payload.agents.map((agent) => ({
      tool: agent.tool,
      name: agent.name,
      managedSurface: agent.managedSurface,
      installed: agent.installed,
      parseErrors: toPublicParseErrors(agent.parseErrors),
      featureWarnings: agent.featureWarnings,
      classes: agent.classes,
      drift: agent.drift,
      summary: agent.summary
    }))
  };
}

function normalizeMcpEnv(rawEnv) {
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return {};
  }
  const normalized = {};
  for (const key of Object.keys(rawEnv).sort((left, right) => left.localeCompare(right))) {
    if (key.length === 0) {
      continue;
    }
    normalized[key] = String(rawEnv[key]);
  }
  return normalized;
}

function normalizeDiscoveredMcpServerSpec(server) {
  if (!server || typeof server !== "object") {
    return null;
  }
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    return {
      url: server.url.trim()
    };
  }
  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    return null;
  }
  const normalized = {
    command: server.command.trim(),
    args: Array.isArray(server.args) ? server.args.map((item) => String(item)) : []
  };
  const env = normalizeMcpEnv(server.env);
  if (Object.keys(env).length > 0) {
    normalized.env = env;
  }
  return normalized;
}

function normalizeStoredProfileMcpSpec(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return null;
  }
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    return {
      url: expandRuntimeMcpValue(server.url.trim())
    };
  }
  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    return null;
  }
  const normalized = {
    command: server.command.trim(),
    args: Array.isArray(server.args) ? server.args.map((item) => expandRuntimeMcpValue(item)) : []
  };
  const env = normalizeMcpEnv(
    server.env && typeof server.env === "object" && !Array.isArray(server.env)
      ? Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [key, expandRuntimeMcpValue(value)])
        )
      : {}
  );
  if (Object.keys(env).length > 0) {
    normalized.env = env;
  }
  return normalized;
}

function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectDeep(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sorted = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortObjectDeep(value[key]);
  }
  return sorted;
}

function mcpServerSignature(server) {
  return JSON.stringify(sortObjectDeep(server ?? {}));
}

function collectExtraMcpCandidates({ drift, inventory }) {
  const inventoryByTool = new Map(
    (inventory?.agents ?? []).map((agent) => [agent.tool, agent])
  );
  const byName = new Map();
  const unresolved = [];

  for (const driftAgent of drift.agents) {
    const agentInventory = inventoryByTool.get(driftAgent.tool);
    if (!agentInventory) {
      continue;
    }
    const extras = driftAgent.drift?.mcpServers?.extra ?? [];
    for (const extraName of extras) {
      const matched = (agentInventory.inventory?.mcpServers ?? []).find(
        (server) => normalizeDriftMcpName(server.name) === extraName
      );
      if (!matched) {
        unresolved.push({
          name: extraName,
          tool: driftAgent.tool,
          reason: "server definition not found in detected inventory"
        });
        continue;
      }
      const normalized = normalizeDiscoveredMcpServerSpec(matched);
      if (!normalized) {
        unresolved.push({
          name: extraName,
          tool: driftAgent.tool,
          reason: "unsupported server definition"
        });
        continue;
      }
      const candidates = byName.get(extraName) ?? [];
      candidates.push({
        tool: driftAgent.tool,
        server: normalized
      });
      byName.set(extraName, candidates);
    }
  }

  return {
    byName,
    unresolved
  };
}

function chooseMcpCandidate(candidates) {
  const sorted = [...candidates].sort((left, right) => left.tool.localeCompare(right.tool));
  const selected = sorted[0] ?? null;
  const conflicts = [];
  if (!selected) {
    return { selected: null, conflicts };
  }
  const selectedSignature = mcpServerSignature(selected.server);
  for (const candidate of sorted.slice(1)) {
    if (mcpServerSignature(candidate.server) !== selectedSignature) {
      conflicts.push({
        keptTool: selected.tool,
        ignoredTool: candidate.tool
      });
    }
  }
  return { selected, conflicts };
}

async function promoteExtraMcpServersIntoProfile({ profile, drift, agents }) {
  const candidates = collectExtraMcpCandidates({ drift, inventory: agents });
  const selectedByName = new Map();
  const conflicts = [];

  for (const [name, entries] of candidates.byName.entries()) {
    const { selected, conflicts: selectionConflicts } = chooseMcpCandidate(entries);
    if (!selected) {
      continue;
    }
    selectedByName.set(name, selected.server);
    for (const conflict of selectionConflicts) {
      conflicts.push({
        name,
        ...conflict
      });
    }
  }

  if (selectedByName.size === 0) {
    return {
      added: [],
      unchanged: [],
      conflicts,
      unresolved: candidates.unresolved
    };
  }

  const { profile: profileDoc } = await resolveProfile(profile);
  const packRoot = await resolvePack(profileDoc);
  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  const doc = (await fs.pathExists(mcpPath))
    ? await assertJsonFileMatchesSchema(mcpPath, SCHEMAS.mcpServers)
    : { servers: {} };
  if (!doc.servers || typeof doc.servers !== "object" || Array.isArray(doc.servers)) {
    doc.servers = {};
  }

  const added = [];
  const unchanged = [];
  for (const name of Array.from(selectedByName.keys()).sort((left, right) => left.localeCompare(right))) {
    const proposed = selectedByName.get(name);
    const existing = normalizeStoredProfileMcpSpec(doc.servers[name]);
    if (existing) {
      if (mcpServerSignature(existing) === mcpServerSignature(proposed)) {
        unchanged.push(name);
      } else {
        conflicts.push({
          name,
          keptTool: "profile",
          ignoredTool: "detected-agents"
        });
      }
      continue;
    }
    doc.servers[name] = proposed;
    added.push(name);
  }

  await assertObjectMatchesSchema(doc, SCHEMAS.mcpServers, mcpPath);
  await writeJsonFile(mcpPath, doc);

  return {
    added,
    unchanged,
    conflicts,
    unresolved: candidates.unresolved
  };
}

export async function buildAgentDrift({ profile, agents } = {}) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? (await readDefaultProfile());
  if (!resolvedProfile) {
    throw new Error(
      "Profile is required. Set a default first with 'use <name>'."
    );
  }

  const expectedInventory = await buildProfileInventory(resolvedProfile, { detail: "full" });
  const effectiveState = await loadEffectiveProfileState(resolvedProfile);
  const expectedSkills = sortStrings(expectedInventory.skills.items.map((item) => item.name));
  const expectedMcpServers = normalizeDriftMcpNames(
    expectedInventory.mcp.servers.map((item) => item.name)
  );
  const expectedMcpByName = buildExpectedMcpMap(expectedInventory);
  const registry = await loadAgentRegistry();
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const integrations = await loadAgentIntegrations();
  const integrationsById = new Map(integrations.map((entry) => [entry.id, entry]));
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  const planning = collectSourcePlanning(effectiveState.effectiveSources, upstreams.byId);
  const resolvedReferences = planning.references.length > 0
    ? await resolveReferences({
        references: planning.references,
        upstreamById: upstreams.byId,
        lockState,
        preferPinned: true,
        requirePinned: true,
        updatePins: false,
        allowLockUpdate: false
      })
    : new Map();
  const localEntries = await collectLocalSkillEntries(effectiveState.packs.map((item) => item.packRoot));
  const importedEntries = await collectImportedSkillEntries(planning.skillImports, upstreams.byId, resolvedReferences);
  const sourceSkillPathsByDestRelative = new Map(
    [...localEntries, ...importedEntries].map((entry) => [entry.destRelative, entry.sourcePath])
  );
  const projectionHashCache = new Map();
  const projectionHashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-expected-skill-"));

  try {
    const detected = await collectAgentInventories({ agents });
    const driftAgents = detected.agents.map((agent) => ({
      agent,
      integration: integrationsById.get(agent.tool)
    }));
    const resolvedDriftAgents = [];
    for (const candidate of driftAgents) {
      const { agent, integration } = candidate;
      const expectedSkillsByPath = await buildExpectedSkillMap(
        expectedInventory,
        integration,
        sourceSkillPathsByDestRelative,
        projectionHashCache,
        projectionHashRoot
      );
    const expectedSkillPaths = sortStrings(Array.from(expectedSkillsByPath.keys()));
    const actualSkills = sortStrings(agent.inventory.skills);
    const actualSkillDetailsByPath = indexSkillDetails(agent.inventory.skillDetails);
    const actualMcp = normalizeDriftMcpNames(
      agent.inventory.mcpServers.map((item) => item.name)
    );
    const actualMcpByName = buildActualMcpMap(agent);
    const skillsDrift = computeDifference(expectedSkillPaths, actualSkills);
    const mcpDrift = computeDifference(expectedMcpServers, actualMcp);
    const changedSkills = [];
    const changedMcpServers = [];
    const classes = [];

    for (const skillPath of skillsDrift.missing) {
      const expectedSkill = expectedSkillsByPath.get(skillPath);
      classes.push({
        code: "missing-skill",
        severity: "error",
        agentId: agent.tool,
        skillName: expectedSkill?.canonicalName ?? skillPath,
        skillPath,
        message: `Expected skill '${skillPath}' is missing from agent '${agent.tool}'.`
      });
    }
    for (const skillPath of skillsDrift.extra) {
      classes.push({
        code: "extra-skill",
        severity: "warning",
        agentId: agent.tool,
        skillPath,
        message: `Agent '${agent.tool}' has unexpected skill '${skillPath}'.`
      });
    }
    for (const skillPath of expectedSkillPaths) {
      const expectedSkill = expectedSkillsByPath.get(skillPath);
      const actualSkill = actualSkillDetailsByPath.get(skillPath);
      if (!expectedSkill || !actualSkill) {
        continue;
      }
      if (
        expectedSkill.contentHash &&
        actualSkill.contentHash &&
        expectedSkill.contentHash !== actualSkill.contentHash
      ) {
        changedSkills.push(skillPath);
        classes.push({
          code: "content-mismatch",
          severity: "error",
          agentId: agent.tool,
          skillName: expectedSkill.canonicalName,
          skillPath,
          message: `Installed skill '${skillPath}' does not match expected content for '${expectedSkill.canonicalName}'.`
        });
      }
    }

    for (const mcpName of mcpDrift.missing) {
      classes.push({
        code: "missing-managed-mcp",
        severity: "error",
        agentId: agent.tool,
        mcpName,
        message: `Managed MCP '${mcpName}' is missing from agent '${agent.tool}'.`
      });
    }
    for (const mcpName of expectedMcpServers) {
      const expectedSpec = expectedMcpByName.get(mcpName);
      const actualEntry = actualMcpByName.get(mcpName);
      if (!expectedSpec || !actualEntry?.spec) {
        continue;
      }
      if (mcpServerSignature(expectedSpec) !== mcpServerSignature(actualEntry.spec)) {
        changedMcpServers.push(mcpName);
        classes.push({
          code: "changed-managed-mcp",
          severity: "error",
          agentId: agent.tool,
          mcpName,
          message: `Managed MCP '${mcpName}' differs from profile expectation on agent '${agent.tool}'.`
        });
      }
    }
    for (const mcpName of mcpDrift.extra) {
      const actualEntry = actualMcpByName.get(mcpName);
      if (!actualEntry?.managed) {
        continue;
      }
      classes.push({
        code: "extra-managed-mcp",
        severity: "warning",
        agentId: agent.tool,
        mcpName,
        message: `Agent '${agent.tool}' has extra managed MCP '${mcpName}'.`
      });
    }

    let featureWarnings = 0;
    for (const item of expectedInventory.skills.items) {
      const support = summarizeSkillFeatureSupport(item.capabilities, registryById.get(agent.tool));
      featureWarnings += support.unsupported.length;
      if (support.unsupported.length > 0) {
        classes.push({
          code: "compatibility-degraded",
          severity: "warning",
          agentId: agent.tool,
          skillName: item.name,
          message: `Skill '${item.name}' has ${support.unsupported.length} unsupported feature warning(s) for agent '${agent.tool}'.`
        });
      }

      if (item.sourceType === "imported") {
        const expectedProjectionVersion = registryById.get(agent.tool)?.projectionVersion ?? 1;
        const actualProjectionVersion = item.projectionAdapters?.[agent.tool]?.contractVersion ?? null;
        if (actualProjectionVersion !== null && actualProjectionVersion !== expectedProjectionVersion) {
          classes.push({
            code: "projection-mismatch",
            severity: "error",
            agentId: agent.tool,
            skillName: item.name,
            message: `Projection metadata for '${item.name}' is stale for agent '${agent.tool}'.`
          });
        }
      }
    }

    const sortedClasses = sortDriftClasses(classes);
    const byClass = countByClass(sortedClasses);

    resolvedDriftAgents.push({
      tool: agent.tool,
      name: agent.name,
      managedSurface: agent.managedSurface,
      installed: agent.installed,
      parseErrors: agent.parseErrors,
      featureWarnings,
      classes: sortedClasses,
      drift: {
        skills: {
          ...skillsDrift,
          changed: sortStrings(changedSkills)
        },
        mcpServers: {
          ...mcpDrift,
          changed: sortStrings(changedMcpServers)
        }
      },
      summary: {
        missingTotal: skillsDrift.missing.length + mcpDrift.missing.length,
        extraTotal: skillsDrift.extra.length + mcpDrift.extra.length,
        changedTotal: changedSkills.length + changedMcpServers.length,
        parseErrors: agent.parseErrors.length,
        featureWarnings,
        byClass
      }
    });
    }

    const summary = {
      missingTotal: resolvedDriftAgents.reduce((count, agent) => count + agent.summary.missingTotal, 0),
      extraTotal: resolvedDriftAgents.reduce((count, agent) => count + agent.summary.extraTotal, 0),
      changedTotal: resolvedDriftAgents.reduce((count, agent) => count + agent.summary.changedTotal, 0),
      parseErrors: resolvedDriftAgents.reduce((count, agent) => count + agent.summary.parseErrors, 0),
      featureWarnings: resolvedDriftAgents.reduce((count, agent) => count + agent.summary.featureWarnings, 0),
      byClass: countByClass(resolvedDriftAgents.flatMap((agent) => agent.classes))
    };

    return {
      os: detected.os,
      profile: resolvedProfile,
      expected: {
        skills: expectedSkills,
        mcpServers: expectedMcpServers
      },
      summary,
      agents: resolvedDriftAgents
    };
  } finally {
    await fs.rm(projectionHashRoot, { recursive: true, force: true });
  }
}

export async function cmdAgentInventory({ format = "text", agents } = {}) {
  const inventory = await collectAgentInventories({ agents });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(toPublicInventoryPayload(inventory), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${inventoryToText(inventory)}\n`);
}

export async function cmdListAgents({ format = "text", agents } = {}) {
  const inventory = await collectAgentInventories({ agents });
  const detectedAgents = inventory.agents
    .filter((agent) => agent.installed)
    .map((agent) => agent.tool);

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(detectedAgents, null, 2)}\n`);
    return;
  }

  if (detectedAgents.length === 0) {
    process.stdout.write("No agents detected.\n");
    return;
  }
  for (const agent of detectedAgents) {
    process.stdout.write(`${agent}\n`);
  }
}

export async function cmdAgentDrift({ profile, dryRun = false, format = "text", agents } = {}) {
  const initialDrift = await buildAgentDrift({ profile, agents });
  if (!dryRun) {
    const detectedInventory = await collectAgentInventories({ agents });
    const promotion = await promoteExtraMcpServersIntoProfile({
      profile: initialDrift.profile,
      drift: initialDrift,
      agents: detectedInventory
    });
    if (format !== "json") {
      if (promotion.added.length > 0) {
        logInfo(
          `Adopted ${promotion.added.length} MCP drift entr${promotion.added.length === 1 ? "y" : "ies"} into profile '${initialDrift.profile}': ${promotion.added.join(", ")}`
        );
      }
      for (const issue of promotion.unresolved) {
        logWarn(`Could not adopt MCP drift '${issue.name}' from ${issue.tool}: ${issue.reason}.`);
      }
      for (const issue of promotion.conflicts) {
        logWarn(
          `MCP drift conflict for '${issue.name}': kept ${issue.keptTool}, ignored ${issue.ignoredTool}.`
        );
      }
    }
    await buildProfile(initialDrift.profile, { lockMode: "write", quiet: format === "json" });
    await applyBindings(initialDrift.profile, { dryRun: false, quiet: format === "json" });
  }

  const drift = dryRun ? initialDrift : await buildAgentDrift({ profile: initialDrift.profile, agents });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(toPublicDriftPayload(drift), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${driftToText(drift)}\n`);
}
