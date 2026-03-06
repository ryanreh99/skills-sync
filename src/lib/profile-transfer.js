import fs from "fs-extra";
import path from "node:path";
import {
  LOCAL_OVERRIDES_ROOT,
  SCHEMAS,
  assertObjectMatchesSchema,
  logInfo,
  writeJsonFile
} from "./core.js";
import { readDefaultProfile, resolvePack, resolveProfile } from "./config.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRequiredText(value, label) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeRelativePath(rawPath, label) {
  const normalized = String(rawPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`Invalid relative path '${rawPath}' for ${label}.`);
    }
  }
  return segments.join("/");
}

async function readJsonIfExists(filePath, fallbackValue) {
  if (!(await fs.pathExists(filePath))) {
    return fallbackValue;
  }
  return fs.readJson(filePath);
}

async function collectSkillFiles(rootPath) {
  if (!(await fs.pathExists(rootPath))) {
    return [];
  }

  const files = [];
  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      const content = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        contentBase64: content.toString("base64")
      });
    }
  }

  await walk(rootPath);
  return files;
}

export async function cmdProfileExport({ profile, output } = {}) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? (await readDefaultProfile());
  if (!resolvedProfile) {
    throw new Error(
      "Profile is required. Provide profile name or set a default with 'use <name>'."
    );
  }

  const { profile: profileDoc } = await resolveProfile(resolvedProfile);
  const packRoot = await resolvePack(profileDoc);
  const packManifestPath = path.join(packRoot, "pack.json");
  const sourcesPath = path.join(packRoot, "sources.json");
  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  const skillsRoot = path.join(packRoot, "skills");

  const packManifest = await readJsonIfExists(packManifestPath, {
    name: resolvedProfile,
    version: "0.0.0",
    description: "",
    maintainer: "",
    tags: []
  });
  const sources = await readJsonIfExists(sourcesPath, { imports: [] });
  const mcpServers = await readJsonIfExists(mcpPath, { servers: {} });

  await assertObjectMatchesSchema(packManifest, SCHEMAS.packManifest, packManifestPath);
  await assertObjectMatchesSchema(sources, SCHEMAS.packSources, sourcesPath);
  await assertObjectMatchesSchema(mcpServers, SCHEMAS.mcpServers, mcpPath);

  const skillFiles = await collectSkillFiles(skillsRoot);

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    profile: {
      document: profileDoc,
      name: resolvedProfile,
      pack: {
        manifest: packManifest,
        sources,
        mcpServers,
        skillFiles
      }
    }
  };

  const outputPath = normalizeOptionalText(output);
  if (outputPath) {
    await writeJsonFile(path.resolve(outputPath), payload);
    logInfo(`Exported profile '${resolvedProfile}'.`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function decodeSkillFileContent(contentBase64, filePath) {
  if (typeof contentBase64 !== "string") {
    throw new Error(`Skill file '${filePath}' is missing base64 content.`);
  }
  try {
    return Buffer.from(contentBase64, "base64");
  } catch (error) {
    throw new Error(`Failed to decode skill file '${filePath}': ${error.message}`);
  }
}

async function writeSkillFiles(skillsRoot, skillFiles) {
  for (const file of skillFiles) {
    const relativePath = normalizeRelativePath(file.path, "skill file path");
    const targetPath = path.join(skillsRoot, relativePath.split("/").join(path.sep));
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, decodeSkillFileContent(file.contentBase64, relativePath));
  }
}

export async function cmdProfileImport({ profile, input, replace = false } = {}) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const inputPath = path.resolve(normalizeRequiredText(input, "Input path"));
  if (!(await fs.pathExists(inputPath))) {
    throw new Error("Input file not found.");
  }

  let payload;
  try {
    payload = await fs.readJson(inputPath);
  } catch (error) {
    throw new Error(`Failed to parse import file: ${error.message}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Import payload must be a JSON object.");
  }
  if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported import schemaVersion '${payload.schemaVersion}'.`);
  }

  const packDoc = payload.profile?.pack;
  if (!packDoc || typeof packDoc !== "object" || Array.isArray(packDoc)) {
    throw new Error("Import payload is missing profile.pack.");
  }

  const manifest = packDoc.manifest ?? {};
  const sources = packDoc.sources ?? { imports: [] };
  const mcpServers = packDoc.mcpServers ?? { servers: {} };
  const skillFiles = Array.isArray(packDoc.skillFiles) ? packDoc.skillFiles : [];

  await assertObjectMatchesSchema(manifest, SCHEMAS.packManifest, "import.pack.manifest");
  await assertObjectMatchesSchema(sources, SCHEMAS.packSources, "import.pack.sources");
  await assertObjectMatchesSchema(mcpServers, SCHEMAS.mcpServers, "import.pack.mcpServers");

  const profilePath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${profileName}.json`);
  const packRoot = path.join(LOCAL_OVERRIDES_ROOT, "packs", profileName);
  const packManifestPath = path.join(packRoot, "pack.json");
  const sourcesPath = path.join(packRoot, "sources.json");
  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  const skillsRoot = path.join(packRoot, "skills");

  if (!replace && (await fs.pathExists(profilePath))) {
    throw new Error(`Profile '${profileName}' already exists. Use --replace to overwrite local files.`);
  }

  await fs.ensureDir(path.dirname(profilePath));
  await fs.ensureDir(path.dirname(mcpPath));
  await writeJsonFile(profilePath, {
    schemaVersion: 2,
    ...(payload.profile?.document && typeof payload.profile.document === "object" ? payload.profile.document : {}),
    name: profileName,
    packPath: `workspace/packs/${profileName}`
  });
  await writeJsonFile(packManifestPath, manifest);
  await writeJsonFile(sourcesPath, sources);
  await writeJsonFile(mcpPath, mcpServers);

  if (replace) {
    await fs.remove(skillsRoot);
  }
  await fs.ensureDir(skillsRoot);
  await writeSkillFiles(skillsRoot, skillFiles);

  logInfo(`Imported profile '${profileName}'.`);
}
