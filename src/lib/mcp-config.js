import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  getMcpMergeStrategy,
  supportsMcpAdvanced,
  supportsMcpAuth,
  supportsMcpCapability,
  supportsMcpConfigField,
  supportsMcpTransport
} from "./agent-registry.js";
import {
  CODEX_MCP_BLOCK_END,
  CODEX_MCP_BLOCK_START,
  MCP_MANAGED_PREFIX,
  fileSha256
} from "./core.js";
import { extractCodexMcpTables, renderCodexMcpTables } from "./adapters/codex.js";

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlArray(values) {
  const list = (Array.isArray(values) ? values : []).map((item) => tomlString(item));
  return `[${list.join(", ")}]`;
}

function tomlInlineTable(values) {
  const entries = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const keys = Object.keys(entries).sort((left, right) => left.localeCompare(right));
  const pairs = keys.map((key) => `${tomlTableKey(key)} = ${tomlString(entries[key])}`);
  return `{ ${pairs.join(", ")} }`;
}

function tomlTableKey(value) {
  return JSON.stringify(String(value ?? ""));
}

function runtimeHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function expandRuntimeValue(value) {
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

function normalizeRuntimeEnv(rawEnv) {
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return {};
  }
  const normalized = {};
  const keys = Object.keys(rawEnv).sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    if (key.length === 0) {
      continue;
    }
    normalized[key] = expandRuntimeValue(rawEnv[key]);
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

function normalizedMcpServersString(value) {
  return JSON.stringify(sortObjectDeep(value ?? {}));
}

function toCanonicalManagedName(name) {
  const normalized = String(name ?? "").trim();
  if (
    normalized.startsWith(MCP_MANAGED_PREFIX) &&
    normalized.length > MCP_MANAGED_PREFIX.length
  ) {
    return normalized.slice(MCP_MANAGED_PREFIX.length);
  }
  return normalized;
}

function toLegacyManagedName(name) {
  const canonical = toCanonicalManagedName(name);
  return canonical.length > 0 ? `${MCP_MANAGED_PREFIX}${canonical}` : canonical;
}

function buildManagedNameCandidates(names) {
  const candidates = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    const canonical = toCanonicalManagedName(name);
    if (canonical.length === 0) {
      continue;
    }
    candidates.add(canonical);
    candidates.add(toLegacyManagedName(canonical));
  }
  return candidates;
}

export function buildManagedServerEntries(canonicalMcp) {
  const servers = canonicalMcp?.mcpServers ?? {};
  const names = Object.keys(servers).sort((left, right) => left.localeCompare(right));
  return names.map((name) => ({
    rawName: name,
    managedName: name,
    legacyManagedName: toLegacyManagedName(name),
    server: (() => {
      const server = servers[name] ?? {};
      if (typeof server.url === "string" && server.url.trim().length > 0) {
        const normalized = {
          url: expandRuntimeValue(server.url.trim())
        };
        if (typeof server.transport === "string" && server.transport.trim().length > 0) {
          normalized.transport = server.transport.trim();
        }
        return normalized;
      }
      const normalized = {
        ...server,
        args: (Array.isArray(server?.args) ? server.args : []).map((arg) => expandRuntimeValue(arg))
      };
      const env = normalizeRuntimeEnv(server.env);
      if (Object.keys(env).length > 0) {
        normalized.env = env;
      } else {
        delete normalized.env;
      }
      return normalized;
    })()
  }));
}

function buildBaseCommandServer(server) {
  const projected = {
    command: server.command,
    args: Array.isArray(server.args) ? server.args : []
  };
  if (server.env && Object.keys(server.env).length > 0) {
    projected.env = server.env;
  }
  return projected;
}

function projectJsonMcpServer(server) {
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    return {
      url: server.url
    };
  }
  return {
    transport: "stdio",
    ...buildBaseCommandServer(server)
  };
}

function projectJsonCommandUrlServer(server) {
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    return {
      url: server.url
    };
  }
  return buildBaseCommandServer(server);
}

function normalizeCopilotRemoteType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "sse" ? "sse" : "http";
}

function projectCopilotServer(server) {
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    return {
      type: normalizeCopilotRemoteType(server.transport),
      url: server.url,
      tools: ["*"]
    };
  }
  return {
    type: "stdio",
    ...buildBaseCommandServer(server),
    tools: ["*"]
  };
}

function buildProjectedServersFromEntries(canonicalMcp, projectServer, options = {}) {
  const { managed = false } = options;
  const projected = {};
  for (const entry of buildManagedServerEntries(canonicalMcp)) {
    projected[managed ? entry.managedName : entry.rawName] = projectServer(entry.server);
  }
  return projected;
}

function parseTomlManagedBlock(canonicalMcp) {
  const lines = [CODEX_MCP_BLOCK_START];
  for (const entry of buildManagedServerEntries(canonicalMcp)) {
    lines.push(`[mcp_servers.${tomlTableKey(entry.managedName)}]`);
    if (typeof entry.server.url === "string" && entry.server.url.trim().length > 0) {
      lines.push(`url = ${tomlString(entry.server.url)}`);
    } else {
      lines.push('transport = "stdio"');
      lines.push(`command = ${tomlString(entry.server.command)}`);
      lines.push(`args = ${tomlArray(entry.server.args)}`);
      if (entry.server.env && Object.keys(entry.server.env).length > 0) {
        lines.push(`env = ${tomlInlineTable(entry.server.env)}`);
      }
    }
    lines.push("");
  }
  lines.push(CODEX_MCP_BLOCK_END);
  return `${lines.join("\n").trimEnd()}\n`;
}

function stripCodexManagedBlock(content) {
  const start = escapeForRegExp(CODEX_MCP_BLOCK_START);
  const end = escapeForRegExp(CODEX_MCP_BLOCK_END);
  const pattern = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
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

  return Object.keys(doc.mcpServers)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => normalizeJsonMcpServer(name, doc.mcpServers[name]));
}

async function readCodexInstalledMcpServers(configPath) {
  const content = await fs.readFile(configPath, "utf8");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const servers = [];

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

async function applyManagedJsonConfig({ targetPath, canonicalMcp, dryRun = false, kindDefinition }) {
  let document = {};
  let before = "{}";
  if (await fs.pathExists(targetPath)) {
    try {
      document = await fs.readJson(targetPath);
      before = JSON.stringify(document);
    } catch (error) {
      throw new Error(`Failed to parse JSON config at ${targetPath}: ${error.message}`);
    }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Target MCP document at ${targetPath} must be a JSON object.`);
  }
  if (!document.mcpServers) {
    document.mcpServers = {};
  }
  if (typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers)) {
    throw new Error("Target MCP document must contain an object 'mcpServers' field.");
  }

  const shadowedServers = {};
  for (const entry of buildManagedServerEntries(canonicalMcp)) {
    if (entry.managedName in document.mcpServers) {
      shadowedServers[entry.managedName] = sortObjectDeep(document.mcpServers[entry.managedName]);
    }
    delete document.mcpServers[entry.managedName];
    delete document.mcpServers[entry.legacyManagedName];
  }

  for (const [name, server] of Object.entries(kindDefinition.buildProjectedServers(canonicalMcp, { managed: true }))) {
    document.mcpServers[name] = server;
  }

  const after = JSON.stringify(document);
  const wouldWrite = before !== after || !(await fs.pathExists(targetPath));
  if (!dryRun) {
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return {
    method: kindDefinition.bindingMethod,
    hash: dryRun ? null : await fileSha256(targetPath),
    managedNames: buildManagedServerEntries(canonicalMcp).map((entry) => entry.managedName),
    shadowedServers,
    wouldWrite
  };
}

async function removeManagedJsonConfig({
  targetPath,
  dryRun = false,
  expectedManagedNames = [],
  shadowedServers = {}
}) {
  let document;
  try {
    document = await fs.readJson(targetPath);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${targetPath}: ${error.message}`);
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Target MCP document at ${targetPath} must be a JSON object.`);
  }
  if (!document.mcpServers || typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers)) {
    return { removed: false };
  }

  const managedCandidates = buildManagedNameCandidates(expectedManagedNames);
  if (managedCandidates.size === 0) {
    for (const key of Object.keys(document.mcpServers)) {
      if (key.startsWith(MCP_MANAGED_PREFIX)) {
        managedCandidates.add(key);
      }
    }
  }

  let changed = false;
  for (const key of managedCandidates) {
    if (key in document.mcpServers) {
      delete document.mcpServers[key];
      changed = true;
    }
  }
  for (const [name, server] of Object.entries(
    shadowedServers && typeof shadowedServers === "object" && !Array.isArray(shadowedServers)
      ? shadowedServers
      : {}
  )) {
    if (!(name in document.mcpServers)) {
      document.mcpServers[name] = server;
      changed = true;
    }
  }
  if (changed && !dryRun) {
    await fs.writeFile(targetPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return { removed: changed };
}

async function validateManagedJsonTarget({ targetPath, expectedManagedNames }) {
  let doc;
  try {
    doc = await fs.readJson(targetPath);
  } catch (error) {
    return `Failed to parse JSON config '${targetPath}': ${error.message}`;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return `JSON config is not an object: ${targetPath}`;
  }
  if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
    return `JSON config missing mcpServers object: ${targetPath}`;
  }
  for (const managedName of Array.isArray(expectedManagedNames) ? expectedManagedNames : []) {
    const candidates = buildManagedNameCandidates([managedName]);
    const found = Array.from(candidates).some((candidate) => candidate in doc.mcpServers);
    if (!found) {
      return `Missing managed MCP entry '${managedName}' in ${targetPath}`;
    }
  }
  return null;
}

async function validateProjectedJsonConfig({ projectionPath, canonicalMcp, kindDefinition }) {
  let doc;
  try {
    doc = await fs.readJson(projectionPath);
  } catch (error) {
    return `Failed to parse projection '${projectionPath}': ${error.message}`;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return `Projection is not a JSON object: ${projectionPath}`;
  }
  const actualMcpServers = doc.mcpServers;
  if (!actualMcpServers || typeof actualMcpServers !== "object" || Array.isArray(actualMcpServers)) {
    return `Projection is missing mcpServers object: ${projectionPath}`;
  }

  const expectedMcpServers = kindDefinition.buildRuntimeProjectionServers(canonicalMcp);
  if (normalizedMcpServersString(actualMcpServers) !== normalizedMcpServersString(expectedMcpServers)) {
    return `Projection mcpServers does not match canonical bundle: ${projectionPath}`;
  }
  return null;
}

async function applyManagedTomlConfig({ targetPath, canonicalMcp, dryRun = false, kindDefinition }) {
  let existing = "";
  if (await fs.pathExists(targetPath)) {
    existing = await fs.readFile(targetPath, "utf8");
  }
  const stripped = stripCodexManagedBlock(existing).trimEnd();
  const managedBlock = parseTomlManagedBlock(canonicalMcp).trimEnd();
  const next = `${stripped.length > 0 ? `${stripped}\n\n` : ""}${managedBlock}\n`;
  const wouldWrite = next !== existing;
  if (!dryRun) {
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, next, "utf8");
  }
  return {
    method: kindDefinition.bindingMethod,
    hash: dryRun ? null : await fileSha256(targetPath),
    managedNames: buildManagedServerEntries(canonicalMcp).map((entry) => entry.managedName),
    wouldWrite
  };
}

async function removeManagedTomlConfig({ targetPath, dryRun = false }) {
  const existing = await fs.readFile(targetPath, "utf8");
  const stripped = stripCodexManagedBlock(existing).trimEnd();
  const next = stripped.length > 0 ? `${stripped}\n` : "";
  if (next !== existing) {
    if (!dryRun) {
      await fs.writeFile(targetPath, next, "utf8");
    }
    return { removed: true };
  }
  return { removed: false };
}

async function validateManagedTomlTarget({ targetPath }) {
  const content = await fs.readFile(targetPath, "utf8");
  if (!content.includes(CODEX_MCP_BLOCK_START) || !content.includes(CODEX_MCP_BLOCK_END)) {
    return `Managed TOML MCP block missing in ${targetPath}`;
  }
  return null;
}

async function validateProjectedTomlConfig({ projectionPath, canonicalMcp }) {
  const actual = await fs.readFile(projectionPath, "utf8");
  const actualMcpTables = extractCodexMcpTables(actual);
  const expectedMcpTables = renderCodexMcpTables(canonicalMcp);
  if (actualMcpTables !== expectedMcpTables) {
    return `Managed TOML MCP tables in projection do not match canonical bundle: ${projectionPath}`;
  }
  return null;
}

const MCP_BINDING_METHODS = Object.freeze({
  "json-namespace": {
    id: "json-namespace",
    removeManagedConfig: removeManagedJsonConfig,
    validateAppliedBindingTarget: validateManagedJsonTarget
  },
  "toml-namespace": {
    id: "toml-namespace",
    removeManagedConfig: removeManagedTomlConfig,
    validateAppliedBindingTarget: validateManagedTomlTarget
  }
});

function createJsonKind(id, projectServer, buildRuntimeProjectionServers = null) {
  return {
    id,
    bindingMethod: "json-namespace",
    readInstalledServers: readJsonInstalledMcpServers,
    buildProjectedServers(canonicalMcp, options = {}) {
      return buildProjectedServersFromEntries(canonicalMcp, projectServer, options);
    },
    buildRuntimeProjectionServers(canonicalMcp) {
      if (typeof buildRuntimeProjectionServers === "function") {
        return buildRuntimeProjectionServers(canonicalMcp);
      }
      return canonicalMcp?.mcpServers ?? {};
    },
    applyManagedConfig(options) {
      return applyManagedJsonConfig({ ...options, kindDefinition: this });
    },
    validateRuntimeProjection(options) {
      return validateProjectedJsonConfig({ ...options, kindDefinition: this });
    }
  };
}

const MCP_CONFIG_KINDS = Object.freeze({
  "json-mcpServers": createJsonKind("json-mcpServers", projectJsonMcpServer),
  "json-command-url": createJsonKind("json-command-url", projectJsonCommandUrlServer),
  "copilot-json-type": createJsonKind(
    "copilot-json-type",
    projectCopilotServer,
    (canonicalMcp) => buildProjectedServersFromEntries(canonicalMcp, projectCopilotServer)
  ),
  "toml-managed-block": {
    id: "toml-managed-block",
    bindingMethod: "toml-namespace",
    readInstalledServers: readCodexInstalledMcpServers,
    applyManagedConfig(options) {
      return applyManagedTomlConfig({ ...options, kindDefinition: this });
    },
    validateRuntimeProjection(options) {
      return validateProjectedTomlConfig(options);
    }
  }
});

const DEFAULT_MCP_CONFIG_KIND_BY_TOOL = Object.freeze({
  codex: "toml-managed-block",
  copilot: "copilot-json-type",
  gemini: "json-command-url"
});
const MCP_SUPPORT_REQUIREMENT_KEYS = Object.freeze({
  transports: ["stdio", "streamableHttp", "sse"],
  auth: ["oauth", "bearerToken", "staticHeaders", "envHeaders", "providerAuth"],
  capabilities: ["tools", "resources", "prompts"],
  advanced: ["sampling", "roots", "elicitation"],
  config: [
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "envFile",
    "enabled",
    "required",
    "startupTimeout",
    "toolTimeout",
    "enabledTools",
    "disabledTools",
    "scopes",
    "managedBlock"
  ]
});
const MCP_SUPPORT_REQUIREMENT_MERGE_STRATEGIES = new Set(["replace", "merge", "managed-block", "cli-managed"]);

function resolveAgentToolName(agent) {
  if (typeof agent === "string" && agent.trim().length > 0) {
    return agent.trim();
  }
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return null;
  }
  const candidate = typeof agent.id === "string" && agent.id.trim().length > 0
    ? agent.id.trim()
    : typeof agent.tool === "string" && agent.tool.trim().length > 0
      ? agent.tool.trim()
      : null;
  return candidate;
}

function resolveAgentRequestedConfigKind(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return null;
  }
  return typeof agent.mcpKind === "string" && agent.mcpKind.trim().length > 0
    ? agent.mcpKind.trim()
    : null;
}

export function listSupportedMcpConfigKinds() {
  return Object.keys(MCP_CONFIG_KINDS).sort((left, right) => left.localeCompare(right));
}

export function resolveMcpConfigKind(tool, configKind) {
  const requested = typeof configKind === "string" && configKind.trim().length > 0
    ? configKind.trim()
    : (DEFAULT_MCP_CONFIG_KIND_BY_TOOL[tool] ?? "json-mcpServers");
  if (!(requested in MCP_CONFIG_KINDS)) {
    throw new Error(`Unsupported MCP config kind '${requested}'. Supported kinds: ${listSupportedMcpConfigKinds().join(", ")}.`);
  }
  return requested;
}

export function resolveAgentMcpConfigKind(agent, configKind = null) {
  return resolveMcpConfigKind(
    resolveAgentToolName(agent),
    configKind ?? resolveAgentRequestedConfigKind(agent)
  );
}

function createEmptyMcpSupportRequirements() {
  return {
    transports: Object.fromEntries(MCP_SUPPORT_REQUIREMENT_KEYS.transports.map((key) => [key, false])),
    auth: Object.fromEntries(MCP_SUPPORT_REQUIREMENT_KEYS.auth.map((key) => [key, false])),
    capabilities: Object.fromEntries(MCP_SUPPORT_REQUIREMENT_KEYS.capabilities.map((key) => [key, false])),
    advanced: Object.fromEntries(MCP_SUPPORT_REQUIREMENT_KEYS.advanced.map((key) => [key, false])),
    config: {
      ...Object.fromEntries(MCP_SUPPORT_REQUIREMENT_KEYS.config.map((key) => [key, false])),
      mergeStrategy: null
    }
  };
}

function normalizeMcpSupportRequirementGroup(value, keys) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(keys.map((key) => [key, raw[key] === true]));
}

export function normalizeMcpSupportRequirements(requirements) {
  const raw = requirements && typeof requirements === "object" && !Array.isArray(requirements) ? requirements : {};
  const normalized = createEmptyMcpSupportRequirements();

  for (const [groupName, keys] of Object.entries(MCP_SUPPORT_REQUIREMENT_KEYS)) {
    normalized[groupName] = {
      ...normalized[groupName],
      ...normalizeMcpSupportRequirementGroup(raw[groupName], keys)
    };
  }

  const mergeStrategy = typeof raw?.config?.mergeStrategy === "string" ? raw.config.mergeStrategy.trim() : null;
  if (mergeStrategy && MCP_SUPPORT_REQUIREMENT_MERGE_STRATEGIES.has(mergeStrategy)) {
    normalized.config.mergeStrategy = mergeStrategy;
  }

  return normalized;
}

export function summarizeRequiredMcpSupport(canonicalMcp, options = {}) {
  const requirements = createEmptyMcpSupportRequirements();
  const servers = canonicalMcp?.mcpServers && typeof canonicalMcp.mcpServers === "object" && !Array.isArray(canonicalMcp.mcpServers)
    ? canonicalMcp.mcpServers
    : {};
  const serverNames = Object.keys(servers);

  if (serverNames.length > 0) {
    requirements.capabilities.tools = true;
  }

  for (const name of serverNames) {
    const server = servers[name] ?? {};
    if (typeof server.url === "string" && server.url.trim().length > 0) {
      requirements.config.url = true;
      const normalizedTransport = typeof server.transport === "string" ? server.transport.trim().toLowerCase() : "";
      if (normalizedTransport === "sse") {
        requirements.transports.sse = true;
      } else {
        requirements.transports.streamableHttp = true;
      }
      continue;
    }

    requirements.transports.stdio = true;
    requirements.config.command = true;
    if (Array.isArray(server.args) && server.args.length > 0) {
      requirements.config.args = true;
    }
    if (server.env && typeof server.env === "object" && !Array.isArray(server.env) && Object.keys(server.env).length > 0) {
      requirements.config.env = true;
    }
  }

  const requestedKind = resolveMcpConfigKind(
    options.tool ?? resolveAgentToolName(options.agent),
    options.configKind ?? resolveAgentRequestedConfigKind(options.agent)
  );
  if (requestedKind === "toml-managed-block") {
    requirements.config.managedBlock = true;
    requirements.config.mergeStrategy = "managed-block";
  }

  return requirements;
}

function collectMcpSupportIssues(agent, requirements) {
  const normalizedRequirements = normalizeMcpSupportRequirements(requirements);
  const issues = [];
  const pushIssue = (group, key, message) => {
    issues.push({
      group,
      key,
      message
    });
  };

  for (const transport of MCP_SUPPORT_REQUIREMENT_KEYS.transports) {
    if (normalizedRequirements.transports[transport] && !supportsMcpTransport(agent, transport)) {
      pushIssue("transports", transport, `support.mcp.transports.${transport}`);
    }
  }
  for (const authMode of MCP_SUPPORT_REQUIREMENT_KEYS.auth) {
    if (normalizedRequirements.auth[authMode] && !supportsMcpAuth(agent, authMode)) {
      pushIssue("auth", authMode, `support.mcp.auth.${authMode}`);
    }
  }
  for (const capability of MCP_SUPPORT_REQUIREMENT_KEYS.capabilities) {
    if (normalizedRequirements.capabilities[capability] && !supportsMcpCapability(agent, capability)) {
      pushIssue("capabilities", capability, `support.mcp.capabilities.${capability}`);
    }
  }
  for (const feature of MCP_SUPPORT_REQUIREMENT_KEYS.advanced) {
    if (normalizedRequirements.advanced[feature] && !supportsMcpAdvanced(agent, feature)) {
      pushIssue("advanced", feature, `support.mcp.advanced.${feature}`);
    }
  }
  for (const field of MCP_SUPPORT_REQUIREMENT_KEYS.config) {
    if (normalizedRequirements.config[field] && !supportsMcpConfigField(agent, field)) {
      pushIssue("config", field, `support.mcp.config.${field}`);
    }
  }
  if (
    normalizedRequirements.config.mergeStrategy &&
    getMcpMergeStrategy(agent) !== normalizedRequirements.config.mergeStrategy
  ) {
    pushIssue(
      "config",
      "mergeStrategy",
      `support.mcp.config.mergeStrategy=${normalizedRequirements.config.mergeStrategy}`
    );
  }

  return {
    requirements: normalizedRequirements,
    issues
  };
}

export function assessAgentMcpSupport(agent, options = {}) {
  const requirements = options.requirements
    ? normalizeMcpSupportRequirements(options.requirements)
    : summarizeRequiredMcpSupport(options.canonicalMcp, {
        agent,
        tool: options.tool ?? null,
        configKind: options.configKind ?? null
      });
  return collectMcpSupportIssues(agent, requirements);
}

export function assertAgentSupportsMcp(agent, options = {}) {
  const assessment = assessAgentMcpSupport(agent, options);
  if (assessment.issues.length > 0) {
    const agentName = resolveAgentToolName(agent) ?? "unknown";
    throw new Error(
      `Agent '${agentName}' does not support the required MCP features: ${assessment.issues.map((issue) => issue.message).join(", ")}.`
    );
  }
  return assessment;
}

function getMcpConfigKindDefinition(configKind, tool = null) {
  return MCP_CONFIG_KINDS[resolveMcpConfigKind(tool, configKind)];
}

function getAgentMcpConfigKindDefinition(agent, configKind = null) {
  return MCP_CONFIG_KINDS[resolveAgentMcpConfigKind(agent, configKind)];
}

function getMcpBindingMethodDefinition(bindingMethod) {
  const definition = MCP_BINDING_METHODS[String(bindingMethod ?? "").trim()];
  if (!definition) {
    throw new Error(`Unsupported MCP binding method '${bindingMethod}'.`);
  }
  return definition;
}

export function buildProjectedMcpServers(canonicalMcp, options = {}) {
  const definition = getMcpConfigKindDefinition(options.configKind, options.tool ?? null);
  if (typeof definition.buildProjectedServers !== "function") {
    throw new Error(`MCP config kind '${definition.id}' does not support JSON server projection.`);
  }
  return definition.buildProjectedServers(canonicalMcp, options);
}

export function buildToolJsonMcpServers(canonicalMcp, tool, options = {}) {
  return buildProjectedMcpServers(canonicalMcp, {
    ...options,
    tool
  });
}

export function buildAgentJsonMcpServers(canonicalMcp, agent, options = {}) {
  const definition = getAgentMcpConfigKindDefinition(agent, options.configKind ?? null);
  assertAgentSupportsMcp(agent, {
    canonicalMcp,
    configKind: definition.id
  });
  if (typeof definition.buildProjectedServers !== "function") {
    throw new Error(`MCP config kind '${definition.id}' does not support JSON server projection.`);
  }
  return definition.buildProjectedServers(canonicalMcp, options);
}

export function buildAgentRuntimeMcpServers(canonicalMcp, agent, options = {}) {
  const definition = getAgentMcpConfigKindDefinition(agent, options.configKind ?? null);
  assertAgentSupportsMcp(agent, {
    canonicalMcp,
    configKind: definition.id
  });
  if (typeof definition.buildRuntimeProjectionServers !== "function") {
    throw new Error(`MCP config kind '${definition.id}' does not support runtime MCP projection.`);
  }
  return definition.buildRuntimeProjectionServers(canonicalMcp);
}

export async function readInstalledMcpServersForKind({ configKind, configPath, tool = null }) {
  const definition = getMcpConfigKindDefinition(configKind, tool);
  return definition.readInstalledServers(configPath);
}

export async function readInstalledMcpServersForAgent({ agent, configPath, configKind = null }) {
  const definition = getAgentMcpConfigKindDefinition(agent, configKind);
  return definition.readInstalledServers(configPath);
}

export async function validateProjectedMcpConfig({ configKind, projectionPath, canonicalMcp, tool = null }) {
  const definition = getMcpConfigKindDefinition(configKind, tool);
  return definition.validateRuntimeProjection({
    projectionPath,
    canonicalMcp
  });
}

export async function validateProjectedMcpConfigForAgent({ agent, projectionPath, canonicalMcp, configKind = null }) {
  const definition = getAgentMcpConfigKindDefinition(agent, configKind);
  const assessment = assessAgentMcpSupport(agent, {
    canonicalMcp,
    configKind: definition.id
  });
  if (assessment.issues.length > 0) {
    return `Agent '${resolveAgentToolName(agent) ?? "unknown"}' does not support required MCP features for projection: ${assessment.issues.map((issue) => issue.message).join(", ")}.`;
  }
  return definition.validateRuntimeProjection({
    projectionPath,
    canonicalMcp
  });
}

export async function validateManagedMcpBindingTarget({
  configKind = null,
  tool = null,
  bindingMethod = null,
  targetPath,
  expectedManagedNames
}) {
  const methodDefinition = bindingMethod
    ? getMcpBindingMethodDefinition(bindingMethod)
    : getMcpBindingMethodDefinition(getMcpConfigKindDefinition(configKind, tool).bindingMethod);
  return methodDefinition.validateAppliedBindingTarget({
    targetPath,
    expectedManagedNames
  });
}

export async function validateManagedMcpBindingTargetForAgent({
  agent,
  configKind = null,
  bindingMethod = null,
  targetPath,
  expectedManagedNames
}) {
  const methodDefinition = bindingMethod
    ? getMcpBindingMethodDefinition(bindingMethod)
    : getMcpBindingMethodDefinition(getAgentMcpConfigKindDefinition(agent, configKind).bindingMethod);
  return methodDefinition.validateAppliedBindingTarget({
    targetPath,
    expectedManagedNames
  });
}

export async function applyManagedMcpConfig({ tool, targetPath, canonicalMcp, dryRun = false, configKind = null }) {
  const definition = getMcpConfigKindDefinition(configKind, tool);
  return definition.applyManagedConfig({
    targetPath,
    canonicalMcp,
    dryRun
  });
}

export async function applyManagedMcpConfigForAgent({
  agent,
  targetPath,
  canonicalMcp,
  dryRun = false,
  configKind = null
}) {
  const definition = getAgentMcpConfigKindDefinition(agent, configKind);
  assertAgentSupportsMcp(agent, {
    canonicalMcp,
    configKind: definition.id
  });
  return definition.applyManagedConfig({
    targetPath,
    canonicalMcp,
    dryRun
  });
}

export async function removeManagedMcpConfig(binding, options = {}) {
  const { dryRun = false } = options;
  const { targetPath } = binding;
  if (!(await fs.pathExists(targetPath))) {
    return { removed: false };
  }

  const methodDefinition = binding.configKind
    ? getMcpBindingMethodDefinition(getMcpConfigKindDefinition(binding.configKind).bindingMethod)
    : getMcpBindingMethodDefinition(binding.method);
  return methodDefinition.removeManagedConfig({
    targetPath,
    dryRun,
    expectedManagedNames: binding.managedNames,
    shadowedServers: binding.shadowedServers
  });
}
