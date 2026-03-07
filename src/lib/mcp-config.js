import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MCP_BLOCK_END,
  CODEX_MCP_BLOCK_START,
  MCP_MANAGED_PREFIX,
  fileSha256
} from "./core.js";

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

export function buildManagedServerEntries(canonicalMcp) {
  const servers = canonicalMcp?.mcpServers ?? {};
  const names = Object.keys(servers).sort((left, right) => left.localeCompare(right));
  return names.map((name) => ({
    rawName: name,
    managedName: `${MCP_MANAGED_PREFIX}${name}`,
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

function normalizeCopilotRemoteType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "sse" ? "sse" : "http";
}

function buildToolJsonServer(server, tool) {
  if (typeof server.url === "string" && server.url.trim().length > 0) {
    if (tool === "copilot") {
      return {
        type: normalizeCopilotRemoteType(server.transport),
        url: server.url,
        tools: ["*"]
      };
    }
    return {
      url: server.url
    };
  }

  const base = {
    command: server.command,
    args: Array.isArray(server.args) ? server.args : []
  };
  if (server.env && Object.keys(server.env).length > 0) {
    base.env = server.env;
  }

  if (tool === "gemini") {
    return base;
  }
  if (tool === "copilot") {
    return {
      type: "stdio",
      ...base,
      tools: ["*"]
    };
  }
  return {
    transport: "stdio",
    ...base
  };
}

export function buildToolJsonMcpServers(canonicalMcp, tool, options = {}) {
  const { managed = false } = options;
  const projected = {};
  for (const entry of buildManagedServerEntries(canonicalMcp)) {
    projected[managed ? entry.managedName : entry.rawName] = buildToolJsonServer(entry.server, tool);
  }
  return projected;
}

function writeManagedJsonServers(document, canonicalMcp, tool) {
  if (!document.mcpServers) {
    document.mcpServers = {};
  }
  if (typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers)) {
    throw new Error("Target MCP document must contain an object 'mcpServers' field.");
  }

  for (const key of Object.keys(document.mcpServers)) {
    if (key.startsWith(MCP_MANAGED_PREFIX)) {
      delete document.mcpServers[key];
    }
  }

  for (const [name, server] of Object.entries(buildToolJsonMcpServers(canonicalMcp, tool, { managed: true }))) {
    document.mcpServers[name] = server;
  }
}

function renderCodexManagedBlock(canonicalMcp) {
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

export async function applyManagedMcpConfig({ tool, targetPath, canonicalMcp, dryRun = false }) {
  if (!dryRun) {
    await fs.ensureDir(path.dirname(targetPath));
  }
  const exists = await fs.pathExists(targetPath);
  const managedNames = buildManagedServerEntries(canonicalMcp).map((entry) => entry.managedName);

  if (tool === "codex") {
    let existing = "";
    if (exists) {
      existing = await fs.readFile(targetPath, "utf8");
    }
    const stripped = stripCodexManagedBlock(existing).trimEnd();
    const managedBlock = renderCodexManagedBlock(canonicalMcp).trimEnd();
    const next = `${stripped.length > 0 ? `${stripped}\n\n` : ""}${managedBlock}\n`;
    const wouldWrite = next !== existing;
    if (!dryRun) {
      await fs.writeFile(targetPath, next, "utf8");
    }
    return {
      method: "toml-namespace",
      hash: dryRun ? null : await fileSha256(targetPath),
      managedNames,
      wouldWrite
    };
  }

  let document = {};
  let before = "{}";
  if (exists) {
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
  writeManagedJsonServers(document, canonicalMcp, tool);
  const after = JSON.stringify(document);
  const wouldWrite = !exists || before !== after;
  if (!dryRun) {
    await fs.writeFile(targetPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return {
    method: "json-namespace",
    hash: dryRun ? null : await fileSha256(targetPath),
    managedNames,
    wouldWrite
  };
}

export async function removeManagedMcpConfig(binding, options = {}) {
  const { dryRun = false } = options;
  const { tool, targetPath } = binding;
  if (!(await fs.pathExists(targetPath))) {
    return { removed: false };
  }

  if (tool === "codex") {
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

  let changed = false;
  for (const key of Object.keys(document.mcpServers)) {
    if (key.startsWith(MCP_MANAGED_PREFIX)) {
      delete document.mcpServers[key];
      changed = true;
    }
  }
  if (changed) {
    if (!dryRun) {
      await fs.writeFile(targetPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
  }
  return { removed: changed };
}
