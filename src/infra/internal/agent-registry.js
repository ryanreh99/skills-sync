import { loadAgentIntegrations, normalizeMcpSupport } from "./agent-integrations.js";

function sortBooleanFlags(flags) {
  const normalized = {};
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return normalized;
  }
  for (const key of Object.keys(flags).sort((left, right) => left.localeCompare(right))) {
    normalized[key] = flags[key] === true;
  }
  return normalized;
}

function normalizeSupportMatrix(support) {
  const normalizedSupport = support && typeof support === "object" && !Array.isArray(support) ? support : {};
  return {
    skills: sortBooleanFlags(normalizedSupport.skills),
    commands: sortBooleanFlags(normalizedSupport.commands),
    mcp: normalizeMcpSupport(normalizedSupport.mcp),
    hooks: normalizeHookSupport(normalizedSupport.hooks)
  };
}

function cloneDefaultHookSupport() {
  return {
    actions: {
      shell: false,
      prompt: false,
      http: false,
      other: false
    },
    events: {
      sessionStart: false,
      beforeAgent: false,
      afterAgent: false,
      beforeTool: false,
      afterTool: false,
      notification: false
    },
    config: {
      conditions: false,
      timeoutMs: false,
      retry: false,
      async: false
    }
  };
}

function normalizeHookSupport(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = cloneDefaultHookSupport();
  for (const groupName of Object.keys(normalized)) {
    const group = raw[groupName] && typeof raw[groupName] === "object" && !Array.isArray(raw[groupName])
      ? raw[groupName]
      : {};
    normalized[groupName] = Object.fromEntries(
      Object.keys(normalized[groupName]).sort((left, right) => left.localeCompare(right)).map((key) => [key, group[key] === true])
    );
  }
  return normalized;
}

export async function loadAgentRegistry() {
  const integrations = await loadAgentIntegrations();
  return integrations.map((integration) => ({
    id: integration.id,
    name: integration.name,
    projectionVersion: Number.isInteger(integration.projectionVersion) ? integration.projectionVersion : 1,
    commandSupportVersion: Number.isInteger(integration.commandSupportVersion) ? integration.commandSupportVersion : 1,
    mcpSupportVersion: Number.isInteger(integration.mcpSupportVersion) ? integration.mcpSupportVersion : 1,
    hookSupportVersion: Number.isInteger(integration.hookSupportVersion) ? integration.hookSupportVersion : 1,
    commandKind: typeof integration.commandKind === "string" && integration.commandKind.trim().length > 0
      ? integration.commandKind.trim()
      : "unsupported",
    mcpKind: typeof integration.mcpKind === "string" && integration.mcpKind.trim().length > 0
      ? integration.mcpKind.trim()
      : "json-mcpServers",
    hookKind: typeof integration.hookKind === "string" && integration.hookKind.trim().length > 0
      ? integration.hookKind.trim()
      : "unsupported",
    notes: Array.isArray(integration.notes) ? [...integration.notes] : [],
    support: normalizeSupportMatrix(integration.support)
  }));
}

export async function getAgentRegistryById() {
  const registry = await loadAgentRegistry();
  return new Map(registry.map((entry) => [entry.id, entry]));
}

function getNormalizedMcpSupport(agentMetadata) {
  return normalizeSupportMatrix(agentMetadata?.support).mcp;
}

function getNormalizedCommandSupport(agentMetadata) {
  return normalizeSupportMatrix(agentMetadata?.support).commands;
}

function getNormalizedHookSupport(agentMetadata) {
  return normalizeSupportMatrix(agentMetadata?.support).hooks;
}

function hasMcpSupport(agentMetadata, group, key) {
  return getNormalizedMcpSupport(agentMetadata)?.[group]?.[key] === true;
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

export async function parseAgentFilterOption(rawAgents) {
  const registry = await loadAgentRegistry();
  const known = new Set(registry.map((entry) => entry.id));
  const tokens = parseAgentTokenList(rawAgents);
  if (tokens.length === 0) {
    return registry.map((entry) => entry.id);
  }

  const requested = new Set();
  for (const token of tokens) {
    if (!known.has(token)) {
      throw new Error(`Unknown agent '${token}'. Valid values: ${registry.map((entry) => entry.id).join(", ")}.`);
    }
    requested.add(token);
  }
  return registry.map((entry) => entry.id).filter((id) => requested.has(id));
}

export function supportsMcpTransport(agentMetadata, transport) {
  return hasMcpSupport(agentMetadata, "transports", transport);
}

export function supportsMcpAuth(agentMetadata, authMode) {
  return hasMcpSupport(agentMetadata, "auth", authMode);
}

export function supportsMcpCapability(agentMetadata, capability) {
  return hasMcpSupport(agentMetadata, "capabilities", capability);
}

export function supportsMcpAdvanced(agentMetadata, feature) {
  return hasMcpSupport(agentMetadata, "advanced", feature);
}

export function supportsMcpConfigField(agentMetadata, field) {
  return hasMcpSupport(agentMetadata, "config", field);
}

export function getMcpMergeStrategy(agentMetadata) {
  return getNormalizedMcpSupport(agentMetadata)?.config?.mergeStrategy ?? "replace";
}

export function supportsToolFiltering(agentMetadata) {
  return (
    supportsMcpConfigField(agentMetadata, "enabledTools") ||
    supportsMcpConfigField(agentMetadata, "disabledTools")
  );
}

export function assessSkillFeatureSupport(skillFeatures, agentMetadata) {
  const results = [];
  const supportedSkillFeatures = agentMetadata?.support?.skills ?? {};
  for (const feature of Array.isArray(skillFeatures) ? skillFeatures : []) {
    if (feature === "instructions") {
      continue;
    }
    results.push({
      feature,
      supported: supportedSkillFeatures[feature] === true
    });
  }
  return results;
}

export function summarizeSkillFeatureSupport(skillFeatures, agentMetadata) {
  const checks = assessSkillFeatureSupport(skillFeatures, agentMetadata);
  const unsupported = checks.filter((item) => item.supported !== true);
  return {
    checks,
    unsupported
  };
}

export function supportsCommandField(agentMetadata, field) {
  return getNormalizedCommandSupport(agentMetadata)?.[field] === true;
}

export function supportsCommandArgs(agentMetadata) {
  return supportsCommandField(agentMetadata, "args");
}

export function supportsHookAction(agentMetadata, actionType) {
  return getNormalizedHookSupport(agentMetadata)?.actions?.[actionType] === true;
}

export function supportsHookEvent(agentMetadata, eventName) {
  return getNormalizedHookSupport(agentMetadata)?.events?.[eventName] === true;
}

export function supportsHookConfigField(agentMetadata, field) {
  return getNormalizedHookSupport(agentMetadata)?.config?.[field] === true;
}
