import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { fileSha256, readJsonFile } from "./core.js";
import { hashPathContent } from "./digest.js";

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

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function sanitizePathSegment(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\s:]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return normalized.length > 0 ? normalized.toLowerCase() : "command";
}

function splitCommandName(name, id) {
  const raw = normalizeOptionalText(name) ?? normalizeOptionalText(id) ?? "command";
  const segments = raw
    .split(/[\\/]+|:+/g)
    .map((segment) => sanitizePathSegment(segment))
    .filter(Boolean);
  return segments.length > 0 ? segments : [sanitizePathSegment(id ?? "command")];
}

function createRelativeCommandBase(command, usedBases) {
  const segments = splitCommandName(command.name, command.id);
  let candidateSegments = [...segments];
  let candidate = candidateSegments.join("/");
  if (!usedBases.has(candidate)) {
    usedBases.add(candidate);
    return candidate;
  }

  const suffix = command.id ? command.id.slice(0, 12) : "command";
  candidateSegments[candidateSegments.length - 1] = `${candidateSegments.at(-1)}-${sanitizePathSegment(suffix)}`;
  candidate = candidateSegments.join("/");
  let attempt = 2;
  while (usedBases.has(candidate)) {
    candidateSegments[candidateSegments.length - 1] = `${segments.at(-1)}-${sanitizePathSegment(suffix)}-${attempt}`;
    candidate = candidateSegments.join("/");
    attempt += 1;
  }
  usedBases.add(candidate);
  return candidate;
}

function normalizeYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function renderYamlFrontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of fields) {
    if (value === null || value === undefined || String(value).trim().length === 0) {
      continue;
    }
    lines.push(`${key}: ${normalizeYamlScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function buildArgumentHint(args) {
  const normalized = Array.isArray(args) ? args : [];
  if (normalized.length === 0) {
    return null;
  }
  return normalized
    .map((arg) => {
      const name = normalizeOptionalText(arg?.name) ?? "arg";
      return arg?.required === true ? `<${name}>` : `[${name}]`;
    })
    .join(" ");
}

function hasClaudeArgumentPlaceholders(body) {
  return /\$(?:ARGUMENTS|\d+)/.test(String(body ?? ""));
}

function hasGeminiArgumentPlaceholder(body) {
  return /\{\{\s*args\s*\}\}/i.test(String(body ?? ""));
}

function maybeAppendArgumentHint(body, line, shouldAppend) {
  const normalizedBody = String(body ?? "").trimEnd();
  if (!line || shouldAppend !== true) {
    return `${normalizedBody}\n`;
  }
  return `${normalizedBody}\n\n${line}\n`;
}

function renderClaudeCommandContent(command, support) {
  const argumentHint = support.args ? buildArgumentHint(command.args) : null;
  const body = support.args && Array.isArray(command.args) && command.args.length > 0
    ? maybeAppendArgumentHint(command.body, "User arguments: $ARGUMENTS", !hasClaudeArgumentPlaceholders(command.body))
    : `${String(command.body ?? "").trimEnd()}\n`;
  return (
    renderYamlFrontmatter([
      ["description", command.description ?? null],
      ["argument-hint", argumentHint]
    ]) + body
  );
}

function renderCursorCommandContent(command) {
  return `${String(command.body ?? "").trimEnd()}\n`;
}

function escapeTomlMultiline(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function renderGeminiCommandContent(command, support) {
  const lines = [];
  if (support.description && normalizeOptionalText(command.description)) {
    lines.push(`description = ${JSON.stringify(command.description)}`);
  }
  const promptBody = support.args && Array.isArray(command.args) && command.args.length > 0
    ? maybeAppendArgumentHint(command.body, "User arguments: {{args}}", !hasGeminiArgumentPlaceholder(command.body))
    : `${String(command.body ?? "").trimEnd()}\n`;
  lines.push("prompt = \"\"\"");
  lines.push(escapeTomlMultiline(promptBody).replace(/\r\n/g, "\n").trimEnd());
  lines.push("\"\"\"");
  return `${lines.join("\n")}\n`;
}

function renderCodexCommandSkill(command) {
  const lines = [
    renderYamlFrontmatter([
      ["title", command.name],
      ["summary", command.description ?? null]
    ]).trimEnd(),
    "",
    `# /${command.name}`,
    "",
    String(command.body ?? "").trimEnd()
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function hashVirtualDirectory(files) {
  const hash = crypto.createHash("sha256");
  hash.update("dir:\n");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(`file:${file.relativePath}\n`);
    hash.update(Buffer.from(String(file.content ?? ""), "utf8"));
  }
  return hash.digest("hex");
}

export function getEnabledCommandsForAgent(commandsDocument) {
  return (Array.isArray(commandsDocument?.commands) ? commandsDocument.commands : [])
    .filter((command) => command?.enabled !== false)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildLossyFields(command, support, projectionKind) {
  const fields = [];
  if (normalizeOptionalText(command.description) && support.description !== true) {
    fields.push("description");
  }
  if (Array.isArray(command.args) && command.args.length > 0 && support.args !== true) {
    fields.push("args");
  }
  if (Array.isArray(command.tags) && command.tags.length > 0 && support.tags !== true) {
    fields.push("tags");
  }
  if (projectionKind === "skills-backed" && Array.isArray(command.args) && command.args.length > 0) {
    if (!fields.includes("args")) {
      fields.push("args");
    }
  }
  return fields;
}

export function buildCommandProjection(commandsDocument, agent) {
  const agentId = String(agent?.id ?? "").trim();
  const projectionKind = agent?.commandKind ?? "unsupported";
  const support = agent?.support?.commands ?? {};
  const selectedCommands = getEnabledCommandsForAgent(commandsDocument);
  const usedBases = new Set();
  const commands = [];
  const skipped = [];
  const diagnostics = [];

  for (const command of selectedCommands) {
    if (projectionKind === "unsupported") {
      skipped.push({
        id: command.id,
        name: command.name,
        reason: "agent does not support profile-managed commands"
      });
      diagnostics.push({
        code: "unsupported-command",
        severity: "warning",
        commandId: command.id,
        commandName: command.name,
        message: `Agent '${agentId}' does not support managed commands for '${command.name}'.`
      });
      continue;
    }

    const lossyFields = buildLossyFields(command, support, projectionKind);
    if (lossyFields.length > 0) {
      diagnostics.push({
        code: "lossy-command-translation",
        severity: "warning",
        commandId: command.id,
        commandName: command.name,
        fields: lossyFields,
        message: `Command '${command.name}' loses ${lossyFields.join(", ")} metadata on agent '${agentId}'.`
      });
    }

    const relativeBase = createRelativeCommandBase(command, usedBases);
    if (projectionKind === "markdown-files") {
      const relativePath = `${relativeBase}.md`;
      const content = agentId === "claude"
        ? renderClaudeCommandContent(command, support)
        : renderCursorCommandContent(command);
      commands.push({
        id: command.id,
        name: command.name,
        relativePath,
        contentHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        type: "file",
        content
      });
      continue;
    }

    if (projectionKind === "toml-files") {
      const relativePath = `${relativeBase}.toml`;
      const content = renderGeminiCommandContent(command, support);
      commands.push({
        id: command.id,
        name: command.name,
        relativePath,
        contentHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        type: "file",
        content
      });
      continue;
    }

    if (projectionKind === "skills-backed") {
      const files = [
        {
          relativePath: "SKILL.md",
          content: renderCodexCommandSkill(command)
        }
      ];
      commands.push({
        id: command.id,
        name: command.name,
        relativePath: relativeBase,
        type: "dir",
        files,
        contentHash: hashVirtualDirectory(files)
      });
      continue;
    }
  }

  commands.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  skipped.sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => left.message.localeCompare(right.message));

  return {
    agentId,
    kind: projectionKind,
    support,
    commands,
    skipped,
    diagnostics
  };
}

export function indexProjectedCommands(projection) {
  return new Map((projection?.commands ?? []).map((entry) => [entry.relativePath, entry]));
}

export async function materializeCommandProjection(runtimeCommandsPath, projection) {
  await fs.remove(runtimeCommandsPath);
  await fs.ensureDir(runtimeCommandsPath);

  for (const entry of projection?.commands ?? []) {
    if (entry.type === "file") {
      const targetPath = path.join(runtimeCommandsPath, entry.relativePath.split("/").join(path.sep));
      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, entry.content, "utf8");
      continue;
    }

    if (entry.type === "dir") {
      const targetRoot = path.join(runtimeCommandsPath, entry.relativePath.split("/").join(path.sep));
      await fs.ensureDir(targetRoot);
      for (const file of entry.files ?? []) {
        const filePath = path.join(targetRoot, file.relativePath.split("/").join(path.sep));
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, file.content, "utf8");
      }
    }
  }

  return {
    commandsMethod: projection?.kind === "unsupported" ? "unsupported" : "generated",
    commandCount: Array.isArray(projection?.commands) ? projection.commands.length : 0,
    diagnostics: Array.isArray(projection?.diagnostics) ? projection.diagnostics : [],
    skipped: Array.isArray(projection?.skipped) ? projection.skipped : []
  };
}

export async function projectCommandsForAgent({ bundleCommandsPath, runtimeCommandsPath, agent }) {
  const commandsDocument = await readJsonFile(bundleCommandsPath);
  const projection = buildCommandProjection(commandsDocument, agent);
  const result = await materializeCommandProjection(runtimeCommandsPath, projection);
  return {
    ...result,
    projection
  };
}

async function walkFiles(rootPath, matcher, currentRelative = "", entries = []) {
  const absolutePath = currentRelative.length > 0 ? path.join(rootPath, currentRelative) : rootPath;
  const children = await fs.readdir(absolutePath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const nextRelative = currentRelative.length > 0 ? path.join(currentRelative, child.name) : child.name;
    if (child.isDirectory()) {
      await walkFiles(rootPath, matcher, nextRelative, entries);
      continue;
    }
    if (matcher(child.name)) {
      entries.push(toPosixPath(nextRelative));
    }
  }
  return entries;
}

async function discoverSkillLikeDirectories(rootPath, currentRelative = "", entries = []) {
  const absolutePath = currentRelative.length > 0 ? path.join(rootPath, currentRelative) : rootPath;
  const children = await fs.readdir(absolutePath, { withFileTypes: true });
  const hasSkill = children.some((child) => child.isFile() && child.name === "SKILL.md");
  if (hasSkill && currentRelative.length > 0) {
    entries.push(toPosixPath(currentRelative));
  }
  const directories = children
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort((left, right) => left.localeCompare(right));
  for (const directory of directories) {
    const nextRelative = currentRelative.length > 0 ? path.join(currentRelative, directory) : directory;
    await discoverSkillLikeDirectories(rootPath, nextRelative, entries);
  }
  return entries;
}

function logicalCommandNameFromPath(relativePath) {
  const posixPath = toPosixPath(relativePath);
  return posixPath.replace(/\.(md|toml)$/i, "");
}

export async function discoverInstalledCommandsForAgent({ agent, commandsPath }) {
  const commandKind = agent?.commandKind ?? "unsupported";
  if (!(await fs.pathExists(commandsPath))) {
    return [];
  }

  if (commandKind === "markdown-files") {
    const files = await walkFiles(commandsPath, (name) => name.toLowerCase().endsWith(".md"));
    const discovered = [];
    for (const relativePath of files) {
      discovered.push({
        type: "file",
        relativePath,
        name: logicalCommandNameFromPath(relativePath),
        contentHash: await fileSha256(path.join(commandsPath, relativePath.split("/").join(path.sep)))
      });
    }
    return discovered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  if (commandKind === "toml-files") {
    const files = await walkFiles(commandsPath, (name) => name.toLowerCase().endsWith(".toml"));
    const discovered = [];
    for (const relativePath of files) {
      discovered.push({
        type: "file",
        relativePath,
        name: logicalCommandNameFromPath(relativePath),
        contentHash: await fileSha256(path.join(commandsPath, relativePath.split("/").join(path.sep)))
      });
    }
    return discovered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  if (commandKind === "skills-backed") {
    const directories = await discoverSkillLikeDirectories(commandsPath);
    const discovered = [];
    for (const relativePath of sortStrings(directories)) {
      discovered.push({
        type: "dir",
        relativePath,
        name: logicalCommandNameFromPath(relativePath),
        contentHash: await hashPathContent(path.join(commandsPath, relativePath.split("/").join(path.sep)))
      });
    }
    return discovered;
  }

  return [];
}
