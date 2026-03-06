import path from "node:path";
import { ASSETS_ROOT, SCHEMAS, assertJsonFileMatchesSchema } from "./core.js";

const AGENT_ORDER = ["codex", "claude", "cursor", "copilot", "gemini"];

function getRegistryPath() {
  return path.join(ASSETS_ROOT, "manifests", "agents.json");
}

function sortCapabilities(capabilities) {
  const normalized = {};
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return normalized;
  }
  for (const key of Object.keys(capabilities).sort((left, right) => left.localeCompare(right))) {
    normalized[key] = String(capabilities[key]);
  }
  return normalized;
}

export async function loadAgentRegistry() {
  const registry = await assertJsonFileMatchesSchema(getRegistryPath(), SCHEMAS.agentRegistry);
  return registry
    .map((entry) => ({
      ...entry,
      notes: Array.isArray(entry.notes) ? [...entry.notes] : [],
      capabilities: sortCapabilities(entry.capabilities)
    }))
    .sort((left, right) => AGENT_ORDER.indexOf(left.id) - AGENT_ORDER.indexOf(right.id));
}

export async function getAgentRegistryById() {
  const registry = await loadAgentRegistry();
  return new Map(registry.map((entry) => [entry.id, entry]));
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

export function assessCapabilitySupport(skillCapabilities, agentMetadata) {
  const results = [];
  const supported = agentMetadata?.capabilities ?? {};
  for (const capability of Array.isArray(skillCapabilities) ? skillCapabilities : []) {
    const support = supported[capability] ?? "ignored";
    if (capability === "instructions") {
      continue;
    }
    results.push({
      capability,
      support
    });
  }
  return results;
}

export function summarizeCapabilitySupport(skillCapabilities, agentMetadata) {
  const supportRows = assessCapabilitySupport(skillCapabilities, agentMetadata);
  const mismatches = supportRows.filter((item) => item.support !== "native");
  return {
    rows: supportRows,
    mismatches
  };
}
