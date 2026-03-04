import fs from "fs-extra";
import path from "node:path";
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
import { applyBindings } from "./bindings.js";
import { buildProfile } from "./build.js";
import { loadEffectiveTargets, readDefaultProfile, resolvePack, resolveProfile } from "./config.js";
import { buildProfileInventory } from "./inventory.js";

const AGENT_ORDER = ["codex", "claude", "cursor", "copilot", "gemini"];
const AGENT_SET = new Set(AGENT_ORDER);

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

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function parseAgentTokenList(rawAgents) {
  if (!rawAgents) {
    return [];
  }
  const raw = Array.isArray(rawAgents) ? rawAgents.join(",") : String(rawAgents);
  return raw
    .split(/[,\s]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export function parseAgentFilterOption(rawAgents) {
  const tokens = parseAgentTokenList(rawAgents);
  if (tokens.length === 0) {
    return [...AGENT_ORDER];
  }

  const requested = new Set();
  for (const token of tokens) {
    if (!AGENT_SET.has(token)) {
      throw new Error(`Unknown agent '${token}'. Valid values: ${AGENT_ORDER.join(", ")}.`);
    }
    requested.add(token);
  }

  return AGENT_ORDER.filter((name) => requested.has(name));
}

async function detectSkillDirectories(skillsRoot, currentRelative = "", entries = []) {
  const absolute = currentRelative.length > 0 ? path.join(skillsRoot, currentRelative) : skillsRoot;
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

  const directories = children
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort((left, right) => left.localeCompare(right));

  for (const directory of directories) {
    const nextRelative = currentRelative.length > 0 ? path.join(currentRelative, directory) : directory;
    await detectSkillDirectories(skillsRoot, nextRelative, entries);
  }

  return entries;
}

function parseTomlTableKey(rawToken) {
  const token = String(rawToken ?? "").trim();
  if (token.length === 0) {
    throw new Error("Empty MCP server table key.");
  }
  if (token.startsWith("\"")) {
    try {
      const parsed = JSON.parse(token);
      if (typeof parsed !== "string" || parsed.trim().length === 0) {
        throw new Error("Expected non-empty string.");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid quoted MCP server key '${token}': ${error.message}`);
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error(`Invalid bare MCP server key '${token}'.`);
  }
  return token;
}

function parseTomlStringValue(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
      }
      return null;
    }
  }
  return trimmed;
}

function parseTomlArrayValue(rawValue) {
  const parsed = parseTomlStringValue(rawValue);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => String(item));
  }
  if (typeof rawValue !== "string") {
    return [];
  }
  const trimmed = rawValue.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return [];
  }
  try {
    const jsonParsed = JSON.parse(trimmed);
    return Array.isArray(jsonParsed) ? jsonParsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseTomlInlineTableValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!(value.startsWith("{") && value.endsWith("}"))) {
    return {};
  }
  const body = value.slice(1, -1).trim();
  if (body.length === 0) {
    return {};
  }

  const env = {};
  const pairPattern = /("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^,}]+)/g;
  for (const match of body.matchAll(pairPattern)) {
    const rawKey = match[1];
    const rawVal = match[2];
    const key = parseTomlTableKey(rawKey);
    const parsedValue = parseTomlStringValue(rawVal);
    env[key] = parsedValue === null ? String(rawVal).trim() : String(parsedValue);
  }
  return env;
}

function parseCodexMcpTableHeader(line) {
  const trimmed = String(line ?? "").trim();
  const match = trimmed.match(/^\[mcp_servers\.(.+)\]$/);
  if (!match) {
    return null;
  }
  return parseTomlTableKey(match[1]);
}

function parseCodexMcpServerBlock(name, blockLines) {
  let command = null;
  let url = null;
  let transport = null;
  let args = [];
  let env = {};

  for (const line of blockLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const pairMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!pairMatch) {
      continue;
    }
    const key = pairMatch[1];
    const value = pairMatch[2];
    switch (key) {
      case "command":
        command = parseTomlStringValue(value);
        break;
      case "url":
        url = parseTomlStringValue(value);
        break;
      case "transport":
        transport = parseTomlStringValue(value);
        break;
      case "args":
        args = parseTomlArrayValue(value);
        break;
      case "env":
        env = parseTomlInlineTableValue(value);
        break;
      default:
        break;
    }
  }

  return {
    name,
    command: typeof command === "string" && command.trim().length > 0 ? command.trim() : null,
    url: typeof url === "string" && url.trim().length > 0 ? url.trim() : null,
    transport: typeof transport === "string" && transport.trim().length > 0 ? transport.trim() : null,
    args: Array.isArray(args) ? args : [],
    env
  };
}

async function readCodexInstalledMcpServers(configPath) {
  const content = await fs.readFile(configPath, "utf8");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const servers = [];

  let index = 0;
  while (index < lines.length) {
    const tableName = parseCodexMcpTableHeader(lines[index]);
    if (!tableName) {
      index += 1;
      continue;
    }
    index += 1;
    const blockLines = [];
    while (index < lines.length) {
      const candidate = lines[index].trim();
      if (/^\[.+\]$/.test(candidate)) {
        break;
      }
      blockLines.push(lines[index]);
      index += 1;
    }
    servers.push(parseCodexMcpServerBlock(tableName, blockLines));
  }

  return servers.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeJsonMcpServer(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mcpServers['${name}'] must be an object.`);
  }
  return {
    name,
    command: typeof value.command === "string" ? value.command : null,
    url: typeof value.url === "string" ? value.url : null,
    transport: typeof value.transport === "string" ? value.transport : null,
    args: Array.isArray(value.args) ? value.args.map((item) => String(item)) : [],
    env:
      value.env && typeof value.env === "object" && !Array.isArray(value.env)
        ? Object.fromEntries(
            Object.entries(value.env)
              .filter(([key]) => key.length > 0)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, envValue]) => [key, String(envValue)])
          )
        : {}
  };
}

async function readJsonInstalledMcpServers(configPath) {
  let doc;
  try {
    doc = await fs.readJson(configPath);
  } catch (error) {
    throw new Error(`Failed to parse JSON config: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Expected JSON object root.");
  }
  if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
    throw new Error("Expected object field 'mcpServers'.");
  }

  return sortStrings(Object.keys(doc.mcpServers)).map((name) => normalizeJsonMcpServer(name, doc.mcpServers[name]));
}

async function readInstalledMcpServers(tool, configPath) {
  if (tool === "codex") {
    return readCodexInstalledMcpServers(configPath);
  }
  return readJsonInstalledMcpServers(configPath);
}

function buildAgentRows(osName, targets, agents) {
  return agents.map((tool) => {
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
      support: skillsRaw ? "skills+mcp" : "mcp-only",
      skillsDir: skillsRaw ? expandTargetPath(skillsRaw, osName) : null,
      mcpConfig: expandTargetPath(mcpRaw, osName),
      canOverride: Boolean(target?.canOverride)
    };
  });
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function collectAgentInventories({ agents } = {}) {
  const osName = detectOsName();
  const targets = await loadEffectiveTargets(osName);
  const selectedAgents = parseAgentFilterOption(agents);
  const rows = buildAgentRows(osName, targets, selectedAgents);

  const detailedRows = [];
  for (const row of rows) {
    const hasSkillsPath = row.skillsDir ? await fs.pathExists(row.skillsDir).catch(() => false) : false;
    const hasMcpPath = await fs.pathExists(row.mcpConfig).catch(() => false);

    const parseErrors = [];
    let skills = [];
    if (row.skillsDir && hasSkillsPath) {
      try {
        skills = sortStrings(await detectSkillDirectories(row.skillsDir));
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
        mcpServers = await readInstalledMcpServers(row.tool, row.mcpConfig);
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

function formatSkillsList(skills) {
  if (skills.length === 0) {
    return ["    (none)"];
  }
  return skills.map((item) => `    ${item}`);
}

function formatMcpServersList(servers) {
  if (servers.length === 0) {
    return ["    (none)"];
  }
  return servers.map((server) => `    ${server.name}`);
}

function formatParseErrors(parseErrors) {
  if (parseErrors.length === 0) {
    return ["  parse errors : none"];
  }
  const lines = [`  parse errors : ${parseErrors.length}`];
  for (const issue of parseErrors) {
    lines.push(`    [${issue.kind}] ${redactPathDetails(issue.message)}`);
  }
  return lines;
}

function inventoryToText(payload) {
  const lines = [`Detected host OS: ${payload.os}`, ""];
  for (const agent of payload.agents) {
    lines.push(agent.tool);
    lines.push(`  status       : ${agent.installed ? "detected" : "not detected"}`);
    lines.push(`  support      : ${agent.support}`);
    lines.push(`  skills       : ${agent.inventory.skills.length}`);
    lines.push(...formatSkillsList(agent.inventory.skills));
    lines.push(`  mcp servers  : ${agent.inventory.mcpServers.length}`);
    lines.push(...formatMcpServersList(agent.inventory.mcpServers));
    lines.push(...formatParseErrors(agent.parseErrors));
    lines.push("");
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

function formatDriftSection(label, drift) {
  const lines = [`  ${label} missing (${drift.missing.length})`];
  if (drift.missing.length === 0) {
    lines.push("    (none)");
  } else {
    for (const item of drift.missing) {
      lines.push(`    ${item}`);
    }
  }

  lines.push(`  ${label} extra (${drift.extra.length})`);
  if (drift.extra.length === 0) {
    lines.push("    (none)");
  } else {
    for (const item of drift.extra) {
      lines.push(`    ${item}`);
    }
  }

  return lines;
}

function driftToText(driftReport) {
  const lines = [];
  lines.push(`Profile: ${driftReport.profile}`);
  lines.push(`Expected skills: ${driftReport.expected.skills.length}`);
  lines.push(`Expected MCP servers: ${driftReport.expected.mcpServers.length}`);
  lines.push("");

  for (const agent of driftReport.agents) {
    lines.push(agent.tool);
    lines.push(`  status : ${agent.installed ? "detected" : "not detected"}`);
    lines.push(...formatDriftSection("skills", agent.drift.skills));
    lines.push(...formatDriftSection("mcp", agent.drift.mcpServers));
    lines.push(...formatParseErrors(agent.parseErrors));
    lines.push(
      `  summary      : missing=${agent.summary.missingTotal} extra=${agent.summary.extraTotal} parseErrors=${agent.summary.parseErrors}`
    );
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
      support: agent.support,
      canOverride: agent.canOverride,
      installed: agent.installed,
      hasSkillsPath: agent.hasSkillsPath,
      hasMcpPath: agent.hasMcpPath,
      inventory: agent.inventory,
      parseErrors: toPublicParseErrors(agent.parseErrors)
    }))
  };
}

function toPublicDriftPayload(payload) {
  return {
    os: payload.os,
    profile: payload.profile,
    expected: payload.expected,
    agents: payload.agents.map((agent) => ({
      tool: agent.tool,
      support: agent.support,
      installed: agent.installed,
      parseErrors: toPublicParseErrors(agent.parseErrors),
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
  const sorted = [...candidates].sort(
    (left, right) => AGENT_ORDER.indexOf(left.tool) - AGENT_ORDER.indexOf(right.tool)
  );
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
      "Profile is required. Provide --profile <name> or set a default with 'skills-sync use <name>'."
    );
  }

  const expectedInventory = await buildProfileInventory(resolvedProfile);
  const expectedSkills = sortStrings([
    ...expectedInventory.skills.local.map((item) => item.name),
    ...expectedInventory.skills.imports.map((item) => item.destRelative)
  ]);
  const expectedMcpServers = normalizeDriftMcpNames(
    expectedInventory.mcp.servers.map((item) => item.name)
  );

  const detected = await collectAgentInventories({ agents });
  const driftAgents = detected.agents.map((agent) => {
    const actualSkills = sortStrings(agent.inventory.skills);
    const actualMcp = normalizeDriftMcpNames(
      agent.inventory.mcpServers.map((item) => item.name)
    );
    const skillsDrift = computeDifference(expectedSkills, actualSkills);
    const mcpDrift = computeDifference(expectedMcpServers, actualMcp);

    return {
      tool: agent.tool,
      support: agent.support,
      installed: agent.installed,
      parseErrors: agent.parseErrors,
      drift: {
        skills: skillsDrift,
        mcpServers: mcpDrift
      },
      summary: {
        missingTotal: skillsDrift.missing.length + mcpDrift.missing.length,
        extraTotal: skillsDrift.extra.length + mcpDrift.extra.length,
        parseErrors: agent.parseErrors.length
      }
    };
  });

  return {
    os: detected.os,
    profile: resolvedProfile,
    expected: {
      skills: expectedSkills,
      mcpServers: expectedMcpServers
    },
    agents: driftAgents
  };
}

export async function cmdAgentInventory({ format = "text", agents } = {}) {
  const inventory = await collectAgentInventories({ agents });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(toPublicInventoryPayload(inventory), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${inventoryToText(inventory)}\n`);
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
