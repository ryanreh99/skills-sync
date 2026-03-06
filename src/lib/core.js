import Ajv from "ajv";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { formatSkillsSyncTag, warning } from "./terminal-ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runtimeHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function expandUserPath(rawPath) {
  if (typeof rawPath !== "string") {
    return rawPath;
  }
  const home = runtimeHomeDir();
  if (rawPath === "~") {
    return home;
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(home, rawPath.slice(2));
  }
  return rawPath
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home)
    .replace(/%USERPROFILE%/gi, home);
}

function resolveSkillsSyncHome() {
  const configured = process.env.SKILLS_SYNC_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(expandUserPath(configured.trim()));
  }
  return path.join(runtimeHomeDir(), ".skills-sync");
}

export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const ASSETS_ROOT = path.join(PACKAGE_ROOT, "assets");
export const SKILLS_SYNC_HOME = resolveSkillsSyncHome();
export const RUNTIME_INTERNAL_ROOT = path.join(SKILLS_SYNC_HOME, "internal");
export const LOCAL_OVERRIDES_ROOT = path.join(SKILLS_SYNC_HOME, "workspace");
export const MANAGED_BY = "skills-sync";
export const TOOL_NAMES = ["codex", "claude", "cursor", "copilot", "gemini"];
export const SKILLS_TOOL_NAMES = ["codex", "claude", "cursor", "copilot", "gemini"];
export const CACHE_ROOT = path.join(SKILLS_SYNC_HOME, "upstreams_cache");
export const MCP_MANAGED_PREFIX = "skills-sync__";
export const CODEX_MCP_BLOCK_START = "# skills-sync managed mcp start";
export const CODEX_MCP_BLOCK_END = "# skills-sync managed mcp end";

export function getTargetManifestPath(osName) {
  return path.join(ASSETS_ROOT, "manifests", `targets.${osName}.json`);
}

export const SCHEMAS = {
  profile: path.join(ASSETS_ROOT, "contracts", "inputs", "profile.schema.json"),
  packManifest: path.join(ASSETS_ROOT, "contracts", "inputs", "pack-manifest.schema.json"),
  mcpServers: path.join(ASSETS_ROOT, "contracts", "inputs", "mcp-servers.schema.json"),
  packSources: path.join(ASSETS_ROOT, "contracts", "inputs", "pack-sources.schema.json"),
  upstreams: path.join(ASSETS_ROOT, "contracts", "inputs", "upstreams.schema.json"),
  config: path.join(ASSETS_ROOT, "contracts", "inputs", "config.schema.json"),
  targets: path.join(ASSETS_ROOT, "contracts", "runtime", "targets.schema.json"),
  upstreamsLock: path.join(ASSETS_ROOT, "contracts", "state", "upstreams-lock.schema.json"),
  bundle: path.join(ASSETS_ROOT, "contracts", "build", "bundle.schema.json"),
  workspaceManifest: path.join(ASSETS_ROOT, "contracts", "inputs", "workspace-manifest.schema.json"),
  agentRegistry: path.join(ASSETS_ROOT, "contracts", "runtime", "agents.schema.json")
};

export const CONFIG_PATH = path.join(LOCAL_OVERRIDES_ROOT, "config.json");
export const WORKSPACE_MANIFEST_PATH = path.join(LOCAL_OVERRIDES_ROOT, "skills-sync.manifest.json");

export const UPSTREAMS_CONFIG_PATHS = {
  local: path.join(LOCAL_OVERRIDES_ROOT, "upstreams.json"),
  seed: path.join(ASSETS_ROOT, "seed", "upstreams.json")
};

export const LEGACY_LOCKFILE_PATH = path.join(LOCAL_OVERRIDES_ROOT, "upstreams.lock.json");
export const LOCKFILE_PATH = path.join(LOCAL_OVERRIDES_ROOT, "skills-sync.lock.json");

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map();

export function logInfo(message) {
  process.stdout.write(`${formatSkillsSyncTag(process.stdout)} ${message}\n`);
}

export function logWarn(message) {
  process.stderr.write(`${formatSkillsSyncTag(process.stderr)} ${warning("WARN:", process.stderr)} ${message}\n`);
}

export function normalizePathForCompare(inputPath) {
  const normalized = path.resolve(inputPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export function isInsidePath(basePath, candidatePath) {
  const base = normalizePathForCompare(basePath);
  const candidate = normalizePathForCompare(candidatePath);
  const sep = process.platform === "win32" ? "\\" : "/";
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

export function detectOsName() {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  throw new Error("Unsupported host OS. Expected Windows, macOS, or Linux.");
}

export function toAbsolutePath(inputPath, basePath = SKILLS_SYNC_HOME) {
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(basePath, inputPath);
}

export function expandTargetPath(rawPath, osName) {
  let expanded = rawPath;
  const homePath = process.env.HOME || os.homedir();
  const userProfile = process.env.USERPROFILE || homePath;

  if (osName === "windows") {
    expanded = expanded.replace(/%([^%]+)%/g, (_, key) => {
      const value = process.env[key];
      if (!value) {
        throw new Error(`Environment variable %${key}% is not set for target expansion.`);
      }
      return value;
    });
    expanded = expanded.replace(/\$HOME|\$\{HOME\}/g, userProfile);
  } else {
    if (expanded.startsWith("~")) {
      expanded = `${homePath}${expanded.slice(1)}`;
    }
    expanded = expanded.replace(/\$HOME|\$\{HOME\}/g, homePath);
  }

  return path.resolve(expanded);
}

export function normalizeRepoPath(rawPath, label) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`Invalid repository path for ${label}.`);
  }
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error(`Invalid repository path for ${label}.`);
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "." || part === ".." || part.length === 0) {
      throw new Error(`Invalid repository path '${rawPath}' for ${label}.`);
    }
  }
  return parts.join("/");
}

export function normalizeDestPrefix(rawPrefix, fallbackPrefix, label) {
  const base = typeof rawPrefix === "string" && rawPrefix.trim().length > 0 ? rawPrefix : fallbackPrefix;
  return normalizeRepoPath(base, `${label}.destPrefix`);
}

function normalizeSimpleYamlValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSimpleFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return {
      frontmatter: {},
      bodyLines: lines
    };
  }

  const frontmatter = {};
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      endIndex = index;
      break;
    }
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (match) {
      frontmatter[match[1].toLowerCase()] = normalizeSimpleYamlValue(match[2]);
    }
  }

  if (endIndex === -1) {
    return {
      frontmatter: {},
      bodyLines: lines
    };
  }

  return {
    frontmatter,
    bodyLines: lines.slice(endIndex + 1)
  };
}

export function extractFirstMarkdownHeading(lines) {
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const match = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

export function extractSkillTitleFromMarkdown(markdown, fallbackTitle) {
  const { frontmatter, bodyLines } = parseSimpleFrontmatter(markdown);
  const frontmatterTitle = frontmatter.title;
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim().length > 0) {
    return frontmatterTitle.trim();
  }
  const heading = extractFirstMarkdownHeading(bodyLines);
  if (heading && heading.length > 0) {
    return heading;
  }
  return fallbackTitle;
}

export async function extractSkillSummary(skillFilePath) {
  if (!(await fs.pathExists(skillFilePath))) {
    return "No summary provided.";
  }

  const raw = await fs.readFile(skillFilePath, "utf8");
  const { frontmatter, bodyLines } = parseSimpleFrontmatter(raw);
  const frontmatterSummary = frontmatter.summary ?? frontmatter.description;
  if (typeof frontmatterSummary === "string" && frontmatterSummary.trim().length > 0) {
    return frontmatterSummary.trim();
  }

  const paragraph = [];
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(trimmed);
  }

  if (paragraph.length > 0) {
    return paragraph.join(" ");
  }
  return "No summary provided.";
}

export async function readJsonFile(filePath) {
  try {
    return await fs.readJson(filePath);
  } catch (error) {
    throw new Error(`Failed to read JSON file ${filePath}: ${error.message}`);
  }
}

export async function writeJsonFile(filePath, value) {
  await fs.ensureDir(path.dirname(filePath));
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, serialized, "utf8");
}

export async function writeJsonFileIfMissing(filePath, value) {
  if (await fs.pathExists(filePath)) {
    return false;
  }
  await writeJsonFile(filePath, value);
  return true;
}

async function getValidator(schemaPath) {
  if (validatorCache.has(schemaPath)) {
    return validatorCache.get(schemaPath);
  }
  const schema = await readJsonFile(schemaPath);
  const validate = ajv.compile(schema);
  validatorCache.set(schemaPath, validate);
  return validate;
}

function formatAjvErrors(errors = []) {
  return errors
    .map((item) => {
      const location = item.instancePath && item.instancePath.length > 0 ? item.instancePath : "$";
      return `${location}: ${item.message}`;
    })
    .join("; ");
}

export async function assertObjectMatchesSchema(value, schemaPath, label) {
  const validate = await getValidator(schemaPath);
  const valid = validate(value);
  if (!valid) {
    throw new Error(`Schema validation failed for ${label}: ${formatAjvErrors(validate.errors)}`);
  }
}

export async function assertJsonFileMatchesSchema(jsonPath, schemaPath) {
  const value = await readJsonFile(jsonPath);
  await assertObjectMatchesSchema(value, schemaPath, jsonPath);
  return value;
}

export async function existsOrLink(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function fileSha256(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function resolveLinkTarget(targetPath) {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch {
    return null;
  }

  if (!stats.isSymbolicLink()) {
    return null;
  }

  let linkTarget = await fs.readlink(targetPath);
  if (process.platform === "win32") {
    if (linkTarget.startsWith("\\\\?\\")) {
      linkTarget = linkTarget.slice(4);
    }
    if (linkTarget.startsWith("\\??\\")) {
      linkTarget = linkTarget.slice(4);
    }
  }
  if (!path.isAbsolute(linkTarget)) {
    linkTarget = path.resolve(path.dirname(targetPath), linkTarget);
  }
  return path.resolve(linkTarget);
}

export async function bindingMatches(binding) {
  if (!(await existsOrLink(binding.targetPath))) {
    return false;
  }

  if (binding.method === "symlink" || binding.method === "junction") {
    const target = await resolveLinkTarget(binding.targetPath);
    return Boolean(target) && pathsEqual(target, binding.sourcePath);
  }

  if (binding.method === "hardlink") {
    const targetHash = await fileSha256(binding.targetPath);
    if (binding.hash) {
      return targetHash === binding.hash;
    }
    if (!(await fs.pathExists(binding.sourcePath))) {
      return true;
    }
    const sourceHash = await fileSha256(binding.sourcePath);
    return targetHash === sourceHash;
  }

  if (binding.method === "copy") {
    if (binding.kind === "file") {
      if (binding.hash) {
        const targetHash = await fileSha256(binding.targetPath);
        return targetHash === binding.hash;
      }
      if (await fs.pathExists(binding.sourcePath)) {
        const left = await fileSha256(binding.targetPath);
        const right = await fileSha256(binding.sourcePath);
        return left === right;
      }
    }
    return true;
  }

  return false;
}

export async function createDirectoryBinding(sourcePath, targetPath, osName) {
  await fs.ensureDir(path.dirname(targetPath));
  if (osName === "windows") {
    try {
      await fs.symlink(sourcePath, targetPath, "junction");
      return "junction";
    } catch {
      await fs.symlink(sourcePath, targetPath, "dir");
      return "symlink";
    }
  }
  await fs.symlink(sourcePath, targetPath, "dir");
  return "symlink";
}

export async function createFileBinding(sourcePath, targetPath, osName) {
  await fs.ensureDir(path.dirname(targetPath));
  if (osName === "windows") {
    try {
      await fs.link(sourcePath, targetPath);
      return { method: "hardlink", hash: await fileSha256(sourcePath) };
    } catch {
      await fs.copyFile(sourcePath, targetPath);
      return { method: "copy", hash: await fileSha256(targetPath) };
    }
  }
  await fs.symlink(sourcePath, targetPath, "file");
  return { method: "symlink", hash: null };
}

export function collisionKey(relativePath) {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

export function toFileSystemRelativePath(relativePosixPath) {
  return relativePosixPath.split("/").join(path.sep);
}
