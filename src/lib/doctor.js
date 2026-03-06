import fs from "fs-extra";
import path from "node:path";
import {
  CACHE_ROOT,
  CODEX_MCP_BLOCK_END,
  CODEX_MCP_BLOCK_START,
  MCP_MANAGED_PREFIX,
  RUNTIME_INTERNAL_ROOT,
  SCHEMAS,
  assertJsonFileMatchesSchema,
  bindingMatches,
  existsOrLink,
  expandTargetPath,
  fileSha256,
  getTargetManifestPath,
  isInsidePath,
  logInfo,
  logWarn,
  pathsEqual,
  toFileSystemRelativePath
} from "./core.js";
import { getStatePath } from "./bindings.js";
import { collectImportedSkillEntries, collectLocalSkillEntries } from "./bundle.js";
import { loadEffectiveTargets, loadPackSources, normalizeMcpManifest, resolvePack, resolveProfile } from "./config.js";
import { collectSourcePlanning, getCommitObjectType, getLockKey, loadLockfile, loadUpstreamsConfig, resolveReferences, validateAllLockPins } from "./upstreams.js";
import { extractCodexMcpTables, renderCodexMcpTables } from "./adapters/codex.js";

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

function getExpectedTargetRaw(binding, targets) {
  const key = `${binding.tool}:${binding.kind}`;
  switch (key) {
    case "codex:dir":
      return targets.codex.skillsDir;
    case "claude:dir":
      return targets.claude.skillsDir;
    case "cursor:dir":
      return targets.cursor.skillsDir;
    case "copilot:dir":
      return targets.copilot.skillsDir;
    case "gemini:dir":
      return targets.gemini.skillsDir;
    case "codex:config":
      return targets.codex.mcpConfig;
    case "claude:config":
      return targets.claude.mcpConfig;
    case "cursor:config":
      return targets.cursor.mcpConfig;
    case "copilot:config":
      return targets.copilot.mcpConfig;
    case "gemini:config":
      return targets.gemini.mcpConfig;
    default:
      return null;
  }
}

function getManagedServerNames(canonicalMcp) {
  const names = Object.keys(canonicalMcp?.mcpServers ?? {}).sort((left, right) => left.localeCompare(right));
  return names.map((name) => `${MCP_MANAGED_PREFIX}${name}`);
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

async function validateBundleMcp(bundleMcpPath, errors) {
  try {
    const canonical = await fs.readJson(bundleMcpPath);
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new Error("MCP bundle must be a JSON object.");
    }
    if (!canonical.mcpServers || typeof canonical.mcpServers !== "object" || Array.isArray(canonical.mcpServers)) {
      throw new Error("MCP bundle must contain object field 'mcpServers'.");
    }

    const projected = { servers: {} };
    for (const [name, server] of Object.entries(canonical.mcpServers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) {
        throw new Error(`mcpServers['${name}'] must be an object.`);
      }
      if (typeof server.url === "string" && server.url.trim().length > 0) {
        projected.servers[name] = {
          url: server.url.trim()
        };
        continue;
      }
      if (typeof server.command !== "string" || server.command.trim().length === 0) {
        throw new Error(`mcpServers['${name}'] must define either non-empty url or command.`);
      }
      const projectedServer = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : []
      };
      if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
        const env = {};
        for (const key of Object.keys(server.env).sort((left, right) => left.localeCompare(right))) {
          if (key.length === 0) {
            continue;
          }
          env[key] = String(server.env[key]);
        }
        if (Object.keys(env).length > 0) {
          projectedServer.env = env;
        }
      }
      projected.servers[name] = projectedServer;
    }

    // Validate projected shape against the input MCP servers schema contract.
    const tempMcpShapePath = path.join(CACHE_ROOT, ".doctor-mcp-shape.json");
    await fs.ensureDir(path.dirname(tempMcpShapePath));
    await fs.writeFile(tempMcpShapePath, `${JSON.stringify(projected)}\n`, "utf8");
    await assertJsonFileMatchesSchema(tempMcpShapePath, SCHEMAS.mcpServers);
    await fs.remove(tempMcpShapePath).catch(() => {});
    return canonical;
  } catch (error) {
    errors.push(`Invalid canonical MCP at ${bundleMcpPath}: ${error.message}`);
    return null;
  }
}

async function validateRuntimeArtifacts({
  profile,
  packRoot,
  skillImports,
  resolvedReferences,
  normalizedMcp,
  errors
}) {
  const runtimeInternalRoot = RUNTIME_INTERNAL_ROOT;
  const bundleRoot = path.join(runtimeInternalRoot, "common");
  const bundleMetadataPath = path.join(bundleRoot, "bundle.json");
  const bundleSkillsPath = path.join(bundleRoot, "skills");
  const bundleMcpPath = path.join(bundleRoot, "mcp.json");

  for (const requiredPath of [bundleMetadataPath, bundleSkillsPath, bundleMcpPath]) {
    if (!(await fs.pathExists(requiredPath))) {
      errors.push(`Missing canonical bundle artifact: ${requiredPath}`);
    }
  }
  if (errors.length > 0) {
    return;
  }

  const bundleDoc = await assertJsonFileMatchesSchema(bundleMetadataPath, SCHEMAS.bundle).catch((error) => {
    errors.push(error.message);
    return null;
  });
  if (!bundleDoc) {
    return;
  }

  if (bundleDoc.profile !== profile.name) {
    errors.push(`Bundle profile mismatch. Expected '${profile.name}', found '${bundleDoc.profile}'.`);
  }
  if (bundleDoc.sources?.packPath !== packRoot) {
    errors.push(`Bundle packPath mismatch. Expected '${packRoot}', found '${bundleDoc.sources?.packPath}'.`);
  }

  const canonicalMcp = await fs.readJson(bundleMcpPath).catch((error) => {
    errors.push(`Failed to read canonical MCP: ${error.message}`);
    return null;
  });
  if (!canonicalMcp) {
    return;
  }

  const localEntries = await collectLocalSkillEntries(packRoot);
  const importedEntries = collectImportedSkillEntries(skillImports, resolvedReferences);
  const allEntries = [...localEntries, ...importedEntries];
  for (const entry of allEntries) {
    const bundled = path.join(bundleSkillsPath, toFileSystemRelativePath(entry.destRelative));
    if (!(await fs.pathExists(bundled))) {
      errors.push(`Expected bundled skill missing: ${bundled}`);
    }
  }

  const requiredProjectionPaths = [
    path.join(runtimeInternalRoot, ".codex", "skills"),
    path.join(runtimeInternalRoot, ".codex", "config.toml"),
    path.join(runtimeInternalRoot, ".claude", "skills"),
    path.join(runtimeInternalRoot, ".claude", "mcp.json"),
    path.join(runtimeInternalRoot, ".cursor", "skills"),
    path.join(runtimeInternalRoot, ".cursor", "mcp.json"),
    path.join(runtimeInternalRoot, ".copilot", "skills"),
    path.join(runtimeInternalRoot, ".copilot", "mcp-config.json"),
    path.join(runtimeInternalRoot, ".gemini", "skills"),
    path.join(runtimeInternalRoot, ".gemini", "settings.json")
  ];
  for (const projectionPath of requiredProjectionPaths) {
    if (!(await fs.pathExists(projectionPath))) {
      errors.push(`Missing projection artifact: ${projectionPath}`);
    }
  }

  for (const tool of ["codex", "claude", "cursor", "copilot", "gemini"]) {
    for (const entry of allEntries) {
      const target = path.join(runtimeInternalRoot, `.${tool}`, "skills", toFileSystemRelativePath(entry.destRelative));
      if (!(await fs.pathExists(target))) {
        errors.push(`Expected ${tool} projected skill missing: ${target}`);
      }
    }
  }

  const bundleMcpHash = await fileSha256(bundleMcpPath);
  for (const projectionPath of [path.join(runtimeInternalRoot, ".cursor", "mcp.json")]) {
    if (await fs.pathExists(projectionPath)) {
      const hash = await fileSha256(projectionPath);
      if (hash !== bundleMcpHash) {
        errors.push(`MCP projection does not match canonical bundle: ${projectionPath}`);
      }
    }
  }

  const expectedMcpServersNormalized = normalizedMcpServersString(canonicalMcp?.mcpServers ?? {});
  for (const projectionPath of [
    path.join(runtimeInternalRoot, ".claude", "mcp.json"),
    path.join(runtimeInternalRoot, ".copilot", "mcp-config.json"),
    path.join(runtimeInternalRoot, ".gemini", "settings.json")
  ]) {
    if (!(await fs.pathExists(projectionPath))) {
      continue;
    }
    try {
      const doc = await fs.readJson(projectionPath);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        errors.push(`Projection is not a JSON object: ${projectionPath}`);
        continue;
      }
      const actualMcpServers = doc.mcpServers;
      if (!actualMcpServers || typeof actualMcpServers !== "object" || Array.isArray(actualMcpServers)) {
        errors.push(`Projection is missing mcpServers object: ${projectionPath}`);
        continue;
      }
      if (normalizedMcpServersString(actualMcpServers) !== expectedMcpServersNormalized) {
        errors.push(`Projection mcpServers does not match canonical bundle: ${projectionPath}`);
      }
    } catch (error) {
      errors.push(`Failed to parse projection '${projectionPath}': ${error.message}`);
    }
  }

  const codexConfigPath = path.join(runtimeInternalRoot, ".codex", "config.toml");
  if (await fs.pathExists(codexConfigPath)) {
    const actual = await fs.readFile(codexConfigPath, "utf8");
    const actualMcpTables = extractCodexMcpTables(actual);
    const expectedMcpTables = renderCodexMcpTables(canonicalMcp);
    if (actualMcpTables !== expectedMcpTables) {
      errors.push(`Codex MCP tables in projection do not match canonical bundle: ${codexConfigPath}`);
    }
  }

  const normalizedCanonical = JSON.stringify(canonicalMcp);
  const normalizedExpected = JSON.stringify(normalizedMcp);
  if (normalizedCanonical !== normalizedExpected) {
    errors.push(`Canonical MCP differs from pack MCP normalization at ${bundleMcpPath}.`);
  }
}

async function validateStateAndBindings({ state, errors, warnings }) {
  if (!state) {
    warnings.push("No active profile state found.");
    return;
  }

  for (const key of ["profile", "os", "bindings"]) {
    if (!(key in state)) {
      errors.push(`State file is missing '${key}'.`);
    }
  }
  if (state.os !== "windows" && state.os !== "macos" && state.os !== "linux") {
    errors.push(`State os must be 'windows', 'macos', or 'linux'; found '${state.os}'.`);
    return;
  }

  const targets = await loadEffectiveTargets(state.os).catch((error) => {
    errors.push(error.message);
    return null;
  });
  if (!targets) {
    return;
  }

  const runtimeInternalRoot = RUNTIME_INTERNAL_ROOT;
  const bundleMcpPath = path.join(runtimeInternalRoot, "common", "mcp.json");
  const canonicalMcp = (await fs.pathExists(bundleMcpPath)) ? await fs.readJson(bundleMcpPath) : null;
  const expectedManagedNames = getManagedServerNames(canonicalMcp);

  for (const binding of Array.isArray(state.bindings) ? state.bindings : []) {
    const expectedRaw = getExpectedTargetRaw(binding, targets);
    if (!expectedRaw) {
      errors.push(`Unknown state binding type: ${binding.tool}:${binding.kind}`);
      continue;
    }
    const expectedTargetPath = expandTargetPath(expectedRaw, state.os);
    const codexNestedDirBinding =
      binding.kind === "dir" && binding.tool === "codex" && isInsidePath(expectedTargetPath, binding.targetPath);
    if (!pathsEqual(binding.targetPath, expectedTargetPath) && !codexNestedDirBinding) {
      errors.push(
        `Binding target mismatch for ${binding.tool}:${binding.kind}. Expected '${expectedTargetPath}', found '${binding.targetPath}'.`
      );
    }

    if (binding.kind === "config") {
      if (!(await fs.pathExists(binding.targetPath))) {
        errors.push(`Missing managed config target: ${binding.targetPath}`);
        continue;
      }

      if (binding.tool === "codex") {
        const content = await fs.readFile(binding.targetPath, "utf8");
        if (!content.includes(CODEX_MCP_BLOCK_START) || !content.includes(CODEX_MCP_BLOCK_END)) {
          errors.push(`Codex managed MCP block missing in ${binding.targetPath}`);
        }
      } else {
        let doc;
        try {
          doc = await fs.readJson(binding.targetPath);
        } catch (error) {
          errors.push(`Failed to parse JSON config '${binding.targetPath}': ${error.message}`);
          continue;
        }
        if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
          errors.push(`JSON config missing mcpServers object: ${binding.targetPath}`);
          continue;
        }
        for (const managedName of expectedManagedNames) {
          if (!(managedName in doc.mcpServers)) {
            errors.push(`Missing managed MCP entry '${managedName}' in ${binding.targetPath}`);
          }
        }
      }
      continue;
    }

    if (!(await fs.pathExists(binding.sourcePath))) {
      errors.push(`Missing binding source: ${binding.sourcePath}`);
      continue;
    }
    if (!isInsidePath(runtimeInternalRoot, binding.sourcePath)) {
      errors.push(`Binding source is outside runtime artifact root: ${binding.sourcePath}`);
    }
    if (!(await existsOrLink(binding.targetPath))) {
      errors.push(`Missing binding target: ${binding.targetPath}`);
      continue;
    }
    if (!(await bindingMatches(binding))) {
      errors.push(`Binding mismatch: ${binding.targetPath} no longer matches ${binding.sourcePath}.`);
    }
  }
}

export async function cmdDoctor(profileOverride) {
  const errors = [];
  const warnings = [];

  const requiredFiles = [
    getTargetManifestPath("windows"),
    getTargetManifestPath("macos"),
    getTargetManifestPath("linux"),
    SCHEMAS.profile,
    SCHEMAS.packManifest,
    SCHEMAS.mcpServers,
    SCHEMAS.bundle,
    SCHEMAS.targets,
    SCHEMAS.upstreams,
    SCHEMAS.upstreamsLock,
    SCHEMAS.packSources
  ];
  for (const requiredFile of requiredFiles) {
    if (!(await fs.pathExists(requiredFile))) {
      errors.push(`Missing required file: ${requiredFile}`);
    }
  }
  if (errors.length > 0) {
    // Continue to report all known issues.
  }

  let upstreams = null;
  let lockState = null;
  try {
    await assertJsonFileMatchesSchema(getTargetManifestPath("windows"), SCHEMAS.targets);
    await assertJsonFileMatchesSchema(getTargetManifestPath("macos"), SCHEMAS.targets);
    await assertJsonFileMatchesSchema(getTargetManifestPath("linux"), SCHEMAS.targets);
    upstreams = await loadUpstreamsConfig();
    lockState = await loadLockfile();
    if (lockState.exists) {
      await assertJsonFileMatchesSchema(lockState.path, SCHEMAS.upstreamsLock);
    }
  } catch (error) {
    errors.push(error.message);
  }

  const statePath = await getStatePath();
  const state = (await fs.pathExists(statePath)) ? await fs.readJson(statePath).catch(() => null) : null;
  if ((await fs.pathExists(statePath)) && !state) {
    errors.push(`Failed to parse state file: ${statePath}`);
  }
  await validateStateAndBindings({ state, errors, warnings });

  const profileName = profileOverride || state?.profile || null;
  if (!profileName) {
    warnings.push("No profile provided and no active state profile found; skipping profile-specific validation.");
  } else if (upstreams && lockState) {
    try {
      const { profilePath, profile } = await resolveProfile(profileName);
      const packRoot = await resolvePack(profile);
      await assertJsonFileMatchesSchema(profilePath, SCHEMAS.profile);
      await assertJsonFileMatchesSchema(path.join(packRoot, "pack.json"), SCHEMAS.packManifest);
      const mcpManifest = await assertJsonFileMatchesSchema(path.join(packRoot, "mcp", "servers.json"), SCHEMAS.mcpServers);
      const normalizedMcp = normalizeMcpManifest(mcpManifest);

      const { sources } = await loadPackSources(packRoot);
      const { references, skillImports } = collectSourcePlanning(sources, upstreams.byId);

      await validateAllLockPins(lockState, upstreams.byId, errors);
      const resolvedReferences =
        references.length > 0
          ? await resolveReferences({
              references,
              upstreamById: upstreams.byId,
              lockState,
              preferPinned: true,
              requirePinned: true,
              updatePins: false,
              allowLockUpdate: false
            })
          : new Map();

      for (const importEntry of skillImports) {
        const key = getLockKey(importEntry.upstreamId, importEntry.ref);
        const resolved = resolvedReferences.get(key);
        if (!resolved) {
          errors.push(`Missing resolved upstream reference for ${importEntry.upstreamId}@${importEntry.ref}.`);
          continue;
        }
        const objectType = await getCommitObjectType(resolved.repoPath, resolved.commit, importEntry.repoPath);
        if (objectType !== "tree") {
          errors.push(
            `Imported path '${importEntry.repoPath}' from '${importEntry.upstreamId}@${importEntry.ref}' is missing at commit ${resolved.commit}.`
          );
        }
      }

      await validateRuntimeArtifacts({
        profile,
        packRoot,
        skillImports,
        resolvedReferences,
        normalizedMcp,
        errors
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  const runtimeBundleMcpPath = path.join(RUNTIME_INTERNAL_ROOT, "common", "mcp.json");
  if (await fs.pathExists(runtimeBundleMcpPath)) {
    await validateBundleMcp(runtimeBundleMcpPath, errors);
  }

  for (const warning of warnings) {
    logWarn(redactPathDetails(warning));
  }

  if (errors.length > 0) {
    process.stdout.write("[skills-sync] Doctor found issues:\n");
    for (const error of errors) {
      process.stdout.write(` - ${redactPathDetails(error)}\n`);
    }
    process.stdout.write("\n");
    process.stdout.write("Remediation steps:\n");
    process.stdout.write("  1) Run init\n");
    process.stdout.write("  2) Run use <name>\n");
    process.stdout.write("  3) Run build\n");
    process.stdout.write("  4) Run apply\n");
    process.stdout.write("  5) Re-run doctor\n");
    process.exitCode = 1;
    return;
  }

  logInfo("Doctor checks passed.");
}
