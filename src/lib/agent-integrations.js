import fs from "fs-extra";
import path from "node:path";
import { ASSETS_ROOT, SCHEMAS, assertObjectMatchesSchema } from "./core.js";

const SUPPORTED_OS_NAMES = ["windows", "macos", "linux"];
const MCP_SUPPORT_KEYS = Object.freeze({
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
const MCP_MERGE_STRATEGIES = new Set(["replace", "merge", "managed-block", "cli-managed"]);

/**
 * @typedef {"replace" | "merge" | "managed-block" | "cli-managed"} McpMergeStrategy
 * @typedef {{ stdio: boolean, streamableHttp: boolean, sse: boolean }} McpTransportSupport
 * @typedef {{ oauth: boolean, bearerToken: boolean, staticHeaders: boolean, envHeaders: boolean, providerAuth: boolean }} McpAuthSupport
 * @typedef {{ tools: boolean, resources: boolean, prompts: boolean }} McpCapabilitySupport
 * @typedef {{ sampling: boolean, roots: boolean, elicitation: boolean }} McpAdvancedSupport
 * @typedef {{
 *   command: boolean,
 *   args: boolean,
 *   env: boolean,
 *   cwd: boolean,
 *   url: boolean,
 *   envFile: boolean,
 *   enabled: boolean,
 *   required: boolean,
 *   startupTimeout: boolean,
 *   toolTimeout: boolean,
 *   enabledTools: boolean,
 *   disabledTools: boolean,
 *   scopes: boolean,
 *   managedBlock: boolean,
 *   mergeStrategy: McpMergeStrategy
 * }} McpConfigSupport
 * @typedef {{
 *   transports: McpTransportSupport,
 *   auth: McpAuthSupport,
 *   capabilities: McpCapabilitySupport,
 *   advanced: McpAdvancedSupport,
 *   config: McpConfigSupport
 * }} McpSupportMatrix
 */

export const DEFAULT_MCP_SUPPORT = Object.freeze({
  transports: Object.freeze({
    stdio: false,
    streamableHttp: false,
    sse: false
  }),
  auth: Object.freeze({
    oauth: false,
    bearerToken: false,
    staticHeaders: false,
    envHeaders: false,
    providerAuth: false
  }),
  capabilities: Object.freeze({
    tools: false,
    resources: false,
    prompts: false
  }),
  advanced: Object.freeze({
    sampling: false,
    roots: false,
    elicitation: false
  }),
  config: Object.freeze({
    command: false,
    args: false,
    env: false,
    cwd: false,
    url: false,
    envFile: false,
    enabled: false,
    required: false,
    startupTimeout: false,
    toolTimeout: false,
    enabledTools: false,
    disabledTools: false,
    scopes: false,
    managedBlock: false,
    mergeStrategy: "replace"
  })
});

function getAgentIntegrationsRoot() {
  return path.join(ASSETS_ROOT, "integrations", "agents");
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSkillsTargetEntry(value) {
  const target = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  const dir = normalizeOptionalText(target.dir ?? target.skillsDir);
  if (dir) {
    normalized.dir = dir;
  }
  return normalized;
}

function normalizeMcpTargetEntry(value) {
  const target = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    config: String(target.config ?? target.mcpConfig ?? "").trim()
  };
}

function normalizeLegacyHasNonMcpConfig(entry) {
  if (typeof entry?.mcp?.hasNonMcpConfig === "boolean") {
    return entry.mcp.hasNonMcpConfig;
  }
  if (typeof entry?.hasNonMcpConfig === "boolean") {
    return entry.hasNonMcpConfig;
  }

  const legacyValues = SUPPORTED_OS_NAMES
    .map((osName) => entry?.targets?.[osName]?.hasNonMcpConfig)
    .filter((value) => typeof value === "boolean");

  if (legacyValues.length === 0) {
    return false;
  }

  const firstValue = legacyValues[0];
  if (!legacyValues.every((value) => value === firstValue)) {
    throw new Error(
      `Agent integration '${String(entry?.id ?? "").trim() || "<unknown>"}' has conflicting legacy targets.<os>.hasNonMcpConfig values. Move this flag to mcp.hasNonMcpConfig.`
    );
  }

  return firstValue;
}

function cloneDefaultMcpSupport() {
  return {
    transports: { ...DEFAULT_MCP_SUPPORT.transports },
    auth: { ...DEFAULT_MCP_SUPPORT.auth },
    capabilities: { ...DEFAULT_MCP_SUPPORT.capabilities },
    advanced: { ...DEFAULT_MCP_SUPPORT.advanced },
    config: { ...DEFAULT_MCP_SUPPORT.config }
  };
}

function normalizeBooleanGroup(value, keys) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(keys.map((key) => [key, raw[key] === true]));
}

/**
 * Normalize persisted MCP support overrides into the full runtime matrix.
 *
 * Missing groups and fields default to conservative `false` values. The only
 * non-boolean MCP support field is `config.mergeStrategy`, which defaults to
 * `"replace"`.
 *
 * @param {unknown} value
 * @returns {McpSupportMatrix}
 */
export function normalizeMcpSupport(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = cloneDefaultMcpSupport();

  for (const [groupName, keys] of Object.entries(MCP_SUPPORT_KEYS)) {
    const rawGroup = raw[groupName];
    normalized[groupName] = {
      ...normalized[groupName],
      ...normalizeBooleanGroup(rawGroup, keys)
    };
  }

  const mergeStrategy = normalizeOptionalText(raw?.config?.mergeStrategy);
  if (mergeStrategy && MCP_MERGE_STRATEGIES.has(mergeStrategy)) {
    normalized.config.mergeStrategy = mergeStrategy;
  }

  return normalized;
}

function normalizeSkillsSupport(value) {
  const skills = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    nestedDiscovery: skills.nestedDiscovery !== false,
    instructions: skills.instructions !== false,
    frontmatter: skills.frontmatter === true,
    scripts: skills.scripts === true,
    assets: skills.assets === true,
    references: skills.references === true,
    helpers: skills.helpers === true
  };
}

function normalizeConfigSection(entry) {
  const config = entry?.config && typeof entry.config === "object" && !Array.isArray(entry.config)
    ? entry.config
    : {};
  return {
    order: Number.isInteger(config.order ?? entry?.order) ? (config.order ?? entry.order) : 1000,
    adapter: normalizeOptionalText(config.adapter ?? entry?.adapter) ?? String(entry?.id ?? "").trim(),
    projectionVersion: Number.isInteger(config.projectionVersion ?? entry?.projectionVersion)
      ? (config.projectionVersion ?? entry.projectionVersion)
      : 1
  };
}

function normalizeSkillsSection(entry) {
  const section = entry?.skills && typeof entry.skills === "object" && !Array.isArray(entry.skills)
    ? entry.skills
    : {};
  const internal = section.internal && typeof section.internal === "object" && !Array.isArray(section.internal)
    ? section.internal
    : {};
  const legacyInternal = entry?.internal && typeof entry.internal === "object" && !Array.isArray(entry.internal)
    ? entry.internal
    : {};

  return {
    internalDir: String(section.internalDir ?? internal.dir ?? legacyInternal.skillsDir ?? "").trim(),
    bindMode: (section.bindMode ?? internal.bindMode ?? legacyInternal.skillsBindMode) === "children"
      ? "children"
      : "root",
    targets: Object.fromEntries(
      SUPPORTED_OS_NAMES.map((osName) => [
        osName,
        normalizeSkillsTargetEntry(section.targets?.[osName] ?? {
          dir: entry?.targets?.[osName]?.skillsDir
        })
      ])
    ),
    support: normalizeSkillsSupport(section.support ?? entry?.support?.skills)
  };
}

function normalizeMcpSection(entry) {
  const section = entry?.mcp && typeof entry.mcp === "object" && !Array.isArray(entry.mcp)
    ? entry.mcp
    : {};
  const internal = section.internal && typeof section.internal === "object" && !Array.isArray(section.internal)
    ? section.internal
    : {};
  const legacyInternal = entry?.internal && typeof entry.internal === "object" && !Array.isArray(entry.internal)
    ? entry.internal
    : {};

  return {
    internalConfig: String(section.internalConfig ?? internal.config ?? legacyInternal.mcpConfig ?? "").trim(),
    kind: typeof (section.kind ?? entry?.mcpKind) === "string" && String(section.kind ?? entry.mcpKind).trim().length > 0
      ? String(section.kind ?? entry.mcpKind).trim()
      : "json-mcpServers",
    supportVersion: Number.isInteger(section.supportVersion ?? entry?.mcpSupportVersion)
      ? (section.supportVersion ?? entry.mcpSupportVersion)
      : 1,
    hasNonMcpConfig: normalizeLegacyHasNonMcpConfig(entry),
    targets: Object.fromEntries(
      SUPPORTED_OS_NAMES.map((osName) => [
        osName,
        normalizeMcpTargetEntry(section.targets?.[osName] ?? {
          config: entry?.targets?.[osName]?.mcpConfig
        })
      ])
    ),
    support: normalizeMcpSupport(section.support ?? entry?.support?.mcp)
  };
}

function coerceAgentIntegrationDocument(entry) {
  return {
    id: String(entry?.id ?? "").trim(),
    name: String(entry?.name ?? "").trim(),
    config: normalizeConfigSection(entry),
    skills: normalizeSkillsSection(entry),
    mcp: normalizeMcpSection(entry),
    notes: Array.isArray(entry?.notes) ? [...entry.notes] : []
  };
}

export function normalizeAgentIntegrationEntry(entry) {
  const authored = coerceAgentIntegrationDocument(entry);
  return {
    id: authored.id,
    name: authored.name,
    order: authored.config.order,
    adapter: authored.config.adapter,
    internal: {
      skillsDir: authored.skills.internalDir,
      mcpConfig: authored.mcp.internalConfig,
      skillsBindMode: authored.skills.bindMode
    },
    targets: Object.fromEntries(
      SUPPORTED_OS_NAMES.map((osName) => [
        osName,
        {
          ...(authored.skills.targets[osName]?.dir ? { skillsDir: authored.skills.targets[osName].dir } : {}),
          mcpConfig: authored.mcp.targets[osName].config
        }
      ])
    ),
    hasNonMcpConfig: authored.mcp.hasNonMcpConfig,
    notes: authored.notes,
    projectionVersion: authored.config.projectionVersion,
    mcpSupportVersion: authored.mcp.supportVersion,
    mcpKind: authored.mcp.kind,
    support: {
      skills: authored.skills.support,
      mcp: authored.mcp.support
    }
  };
}

export function buildTargetsDocument(integrations, osName) {
  if (!SUPPORTED_OS_NAMES.includes(osName)) {
    throw new Error(`Unsupported integration target OS '${osName}'.`);
  }

  return Object.fromEntries(
    (Array.isArray(integrations) ? integrations : []).map((integration) => [integration.id, {
      ...(integration.targets?.[osName]?.skillsDir ? { skillsDir: integration.targets[osName].skillsDir } : {}),
      mcpConfig: integration.targets?.[osName]?.mcpConfig,
      hasNonMcpConfig: integration.hasNonMcpConfig === true
    }])
  );
}

export async function loadAgentIntegrations() {
  const integrationsRoot = getAgentIntegrationsRoot();
  const entries = (await fs.readdir(integrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const seenIds = new Set();
  const integrations = [];
  for (const fileName of entries) {
    const filePath = path.join(integrationsRoot, fileName);
    const document = await fs.readJson(filePath);
    const authored = coerceAgentIntegrationDocument(document);
    await assertObjectMatchesSchema(authored, SCHEMAS.agentIntegration, filePath);
    const normalized = normalizeAgentIntegrationEntry(authored);
    if (seenIds.has(normalized.id)) {
      throw new Error(`Duplicate agent integration id '${normalized.id}' in ${fileName}.`);
    }
    seenIds.add(normalized.id);
    integrations.push(normalized);
  }

  integrations.sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.id.localeCompare(right.id);
  });

  return integrations;
}

export async function getAgentIntegrationsById() {
  const integrations = await loadAgentIntegrations();
  return new Map(integrations.map((integration) => [integration.id, integration]));
}

export function resolveAgentRuntimePath(runtimeInternalRoot, integration, kind) {
  const relativePath = kind === "skills"
    ? integration.internal.skillsDir
    : integration.internal.mcpConfig;
  return path.join(runtimeInternalRoot, relativePath.split("/").join(path.sep));
}

export async function importAgentProjector(integration) {
  const module = await import(`./adapters/${integration.adapter}.js`);
  if (typeof module.projectFromBundle !== "function") {
    throw new Error(`Agent adapter '${integration.adapter}' must export projectFromBundle().`);
  }
  return module.projectFromBundle;
}
