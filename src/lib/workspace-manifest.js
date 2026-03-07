import fs from "fs-extra";
import path from "node:path";
import {
  CONFIG_PATH,
  LOCAL_OVERRIDES_ROOT,
  SCHEMAS,
  WORKSPACE_MANIFEST_PATH,
  assertObjectMatchesSchema,
  logInfo,
  readJsonFile,
  writeJsonFile
} from "./core.js";
import { listAvailableProfiles, readDefaultProfile, resolvePack, resolveProfile } from "./config.js";
import { loadUpstreamsConfig } from "./upstreams.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveWorkspaceManifestInputPath(input) {
  return path.resolve(normalizeOptionalText(input) || WORKSPACE_MANIFEST_PATH);
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
      files.push({
        path: relativePath,
        contentBase64: (await fs.readFile(absolutePath)).toString("base64")
      });
    }
  }

  await walk(rootPath);
  return files;
}

async function collectWorkspaceProfiles() {
  const profiles = await listAvailableProfiles();
  const entries = [];
  for (const item of profiles) {
    const { profile } = await resolveProfile(item.name);
    const packRoot = await resolvePack(profile);
    entries.push({
      profile,
      pack: {
        manifest: await readJsonIfExists(path.join(packRoot, "pack.json"), {}),
        sources: await readJsonIfExists(path.join(packRoot, "sources.json"), { imports: [] }),
        mcpServers: await readJsonIfExists(path.join(packRoot, "mcp", "servers.json"), { servers: {} }),
        skillFiles: await collectSkillFiles(path.join(packRoot, "skills"))
      }
    });
  }
  return entries.sort((left, right) => left.profile.name.localeCompare(right.profile.name));
}

async function buildWorkspaceManifest() {
  const upstreams = await loadUpstreamsConfig();
  return {
    schemaVersion: 1,
    workspace: {
      defaultProfile: await readDefaultProfile(),
      upstreams: upstreams.config.upstreams,
      profiles: await collectWorkspaceProfiles()
    }
  };
}

async function validateManifest(manifest) {
  await assertObjectMatchesSchema(manifest, SCHEMAS.workspaceManifest, "workspace manifest");
}

async function loadWorkspaceManifestInput(input) {
  const normalizedInput = normalizeOptionalText(input);
  const inputPath = resolveWorkspaceManifestInputPath(normalizedInput);

  if (!(await fs.pathExists(inputPath))) {
    if (normalizedInput) {
      throw new Error(`Workspace manifest not found at '${inputPath}'.`);
    }
    throw new Error(
      `Workspace manifest not found at '${inputPath}'. Run 'workspace export' first or pass --input <path>.`
    );
  }

  const manifest = await readJsonFile(inputPath);
  await validateManifest(manifest);
  return { inputPath, manifest };
}

function diffNameSets(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    onlyLeft: [...leftSet].filter((item) => !rightSet.has(item)).sort((a, b) => a.localeCompare(b)),
    onlyRight: [...rightSet].filter((item) => !leftSet.has(item)).sort((a, b) => a.localeCompare(b))
  };
}

async function writeProfileFromManifest(entry, replace = false) {
  const profileName = entry.profile?.name;
  if (!profileName) {
    throw new Error("Manifest profile entry is missing profile.name.");
  }
  const profilePath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${profileName}.json`);
  const packRoot = path.join(LOCAL_OVERRIDES_ROOT, "packs", profileName);

  if (!replace && (await fs.pathExists(profilePath))) {
    throw new Error(`Profile '${profileName}' already exists. Use workspace import --replace to overwrite.`);
  }

  if (replace) {
    await fs.remove(packRoot);
  }

  await fs.ensureDir(path.dirname(profilePath));
  await fs.ensureDir(path.join(packRoot, "mcp"));
  await writeJsonFile(profilePath, entry.profile);
  await writeJsonFile(path.join(packRoot, "pack.json"), entry.pack?.manifest ?? {});
  await writeJsonFile(path.join(packRoot, "sources.json"), entry.pack?.sources ?? { imports: [] });
  await writeJsonFile(path.join(packRoot, "mcp", "servers.json"), entry.pack?.mcpServers ?? { servers: {} });
  await fs.ensureDir(path.join(packRoot, "skills"));
  for (const skillFile of entry.pack?.skillFiles ?? []) {
    const targetPath = path.join(packRoot, "skills", skillFile.path.split("/").join(path.sep));
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, Buffer.from(skillFile.contentBase64, "base64"));
  }
}

export async function cmdWorkspaceExport({ output } = {}) {
  const manifest = await buildWorkspaceManifest();
  await validateManifest(manifest);
  const outputPath = normalizeOptionalText(output) ? path.resolve(output) : WORKSPACE_MANIFEST_PATH;
  await writeJsonFile(outputPath, manifest);
  logInfo(`Exported workspace manifest to '${outputPath}'.`);
}

export async function cmdWorkspaceImport({ input, replace = false } = {}) {
  const { inputPath, manifest } = await loadWorkspaceManifestInput(input);

  await writeJsonFile(path.join(LOCAL_OVERRIDES_ROOT, "upstreams.json"), {
    schemaVersion: 2,
    upstreams: manifest.workspace.upstreams ?? []
  });

  for (const entry of manifest.workspace.profiles ?? []) {
    await writeProfileFromManifest(entry, replace);
  }

  const existingConfig = (await fs.pathExists(CONFIG_PATH)) ? await fs.readJson(CONFIG_PATH) : {};
  const nextConfig = {
    ...existingConfig,
    ...(manifest.workspace.defaultProfile ? { defaultProfile: manifest.workspace.defaultProfile } : {})
  };
  await writeJsonFile(CONFIG_PATH, nextConfig);
  logInfo(`Imported workspace manifest from '${inputPath}'.`);
}

export async function cmdWorkspaceDiff({ input, format = "text" } = {}) {
  const { inputPath, manifest } = await loadWorkspaceManifestInput(input);
  const live = await buildWorkspaceManifest();

  const profileDiff = diffNameSets(
    (manifest.workspace.profiles ?? []).map((item) => item.profile?.name).filter(Boolean),
    (live.workspace.profiles ?? []).map((item) => item.profile?.name).filter(Boolean)
  );
  const upstreamDiff = diffNameSets(
    (manifest.workspace.upstreams ?? []).map((item) => item.id).filter(Boolean),
    (live.workspace.upstreams ?? []).map((item) => item.id).filter(Boolean)
  );
  const payload = {
    manifestDefaultProfile: manifest.workspace.defaultProfile ?? null,
    liveDefaultProfile: live.workspace.defaultProfile ?? null,
    profiles: profileDiff,
    upstreams: upstreamDiff
  };

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Workspace diff (${inputPath})\n`);
  process.stdout.write(`  default profile manifest/live: ${payload.manifestDefaultProfile ?? "(none)"} / ${payload.liveDefaultProfile ?? "(none)"}\n`);
  process.stdout.write(`  profiles only in manifest: ${payload.profiles.onlyLeft.join(", ") || "(none)"}\n`);
  process.stdout.write(`  profiles only in live: ${payload.profiles.onlyRight.join(", ") || "(none)"}\n`);
  process.stdout.write(`  upstreams only in manifest: ${payload.upstreams.onlyLeft.join(", ") || "(none)"}\n`);
  process.stdout.write(`  upstreams only in live: ${payload.upstreams.onlyRight.join(", ") || "(none)"}\n`);
}

export async function cmdWorkspaceSync({ input, dryRun = false } = {}) {
  if (dryRun) {
    await cmdWorkspaceDiff({ input, format: "text" });
    return;
  }
  await cmdWorkspaceImport({ input, replace: true });
}
