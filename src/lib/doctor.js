import fs from "fs-extra";
import path from "node:path";
import {
  CACHE_ROOT,
  RUNTIME_INTERNAL_ROOT,
  SCHEMAS,
  assertJsonFileMatchesSchema,
  bindingMatches,
  existsOrLink,
  expandTargetPath,
  isInsidePath,
  logInfo,
  logWarn,
  pathsEqual,
  toFileSystemRelativePath
} from "./core.js";
import { getAgentIntegrationsById, loadAgentIntegrations, resolveAgentRuntimePath } from "./agent-integrations.js";
import { getStatePath } from "./bindings.js";
import { collectImportedSkillEntries, collectLocalSkillEntries } from "./bundle.js";
import { loadEffectiveTargets, resolvePack, resolveProfile } from "./config.js";
import { validateManagedMcpBindingTargetForAgent, validateProjectedMcpConfigForAgent } from "./mcp-config.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { collectSourcePlanning, getCommitObjectType, getLockKey, loadLockfile, loadUpstreamsConfig, resolveReferences, validateAllLockPins } from "./upstreams.js";
import { renderSection, renderSimpleList } from "./terminal-ui.js";

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

function getExpectedTargetRaw(binding, targets) {
  const target = targets?.[binding.tool];
  if (!target) {
    return null;
  }
  if (binding.kind === "dir") {
    return target.skillsDir ?? null;
  }
  if (binding.kind === "config") {
    return target.mcpConfig ?? null;
  }
  return null;
}

function getManagedServerNames(canonicalMcp) {
  const names = Object.keys(canonicalMcp?.mcpServers ?? {}).sort((left, right) => left.localeCompare(right));
  return names;
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
  packRoots,
  skillImports,
  upstreamById,
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
  const integrations = await loadAgentIntegrations();

  const localEntries = await collectLocalSkillEntries(packRoots);
  const importedEntries = await collectImportedSkillEntries(skillImports, upstreamById, resolvedReferences);
  const allEntries = [...localEntries, ...importedEntries];
  for (const entry of allEntries) {
    const bundled = path.join(bundleSkillsPath, toFileSystemRelativePath(entry.destRelative));
    if (!(await fs.pathExists(bundled))) {
      errors.push(`Expected bundled skill missing: ${bundled}`);
    }
  }

  const requiredProjectionPaths = integrations.flatMap((integration) => [
    resolveAgentRuntimePath(runtimeInternalRoot, integration, "skills"),
    resolveAgentRuntimePath(runtimeInternalRoot, integration, "config")
  ]);
  for (const projectionPath of requiredProjectionPaths) {
    if (!(await fs.pathExists(projectionPath))) {
      errors.push(`Missing projection artifact: ${projectionPath}`);
    }
  }

  for (const integration of integrations) {
    for (const entry of allEntries) {
      const target = path.join(
        resolveAgentRuntimePath(runtimeInternalRoot, integration, "skills"),
        toFileSystemRelativePath(entry.destRelative)
      );
      if (!(await fs.pathExists(target))) {
        errors.push(`Expected ${integration.id} projected skill missing: ${target}`);
      }
    }
  }

  for (const integration of integrations) {
    const projectionPath = resolveAgentRuntimePath(runtimeInternalRoot, integration, "config");
    if (!(await fs.pathExists(projectionPath))) {
      continue;
    }
    const validationError = await validateProjectedMcpConfigForAgent({
      agent: integration,
      projectionPath,
      canonicalMcp
    });
    if (validationError) {
      errors.push(validationError);
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
  const integrationsById = await getAgentIntegrationsById().catch((error) => {
    errors.push(error.message);
    return null;
  });
  if (!integrationsById) {
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
    const integration = integrationsById.get(binding.tool);
    const nestedDirBinding =
      binding.kind === "dir" &&
      integration?.internal?.skillsBindMode === "children" &&
      isInsidePath(expectedTargetPath, binding.targetPath);
    if (!pathsEqual(binding.targetPath, expectedTargetPath) && !nestedDirBinding) {
      errors.push(
        `Binding target mismatch for ${binding.tool}:${binding.kind}. Expected '${expectedTargetPath}', found '${binding.targetPath}'.`
      );
    }

    if (binding.kind === "config") {
      if (!(await fs.pathExists(binding.targetPath))) {
        errors.push(`Missing managed config target: ${binding.targetPath}`);
        continue;
      }

      const validationError = await validateManagedMcpBindingTargetForAgent({
        agent: integration ?? { id: binding.tool, mcpKind: binding.configKind ?? null },
        configKind: binding.configKind ?? integration?.mcpKind ?? null,
        bindingMethod: binding.method,
        targetPath: binding.targetPath,
        expectedManagedNames
      });
      if (validationError) {
        errors.push(validationError);
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
    SCHEMAS.profile,
    SCHEMAS.packManifest,
    SCHEMAS.mcpServers,
    SCHEMAS.bundle,
    SCHEMAS.agentIntegration,
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
    await loadAgentIntegrations();
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
      const effectiveState = await loadEffectiveProfileState(profileName);
      await assertJsonFileMatchesSchema(profilePath, SCHEMAS.profile);
      await assertJsonFileMatchesSchema(path.join(packRoot, "pack.json"), SCHEMAS.packManifest);
      const normalizedMcp = effectiveState.normalizedMcp;
      const sources = effectiveState.effectiveSources;
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
        const upstream = upstreams.byId.get(importEntry.upstreamId);
        if (!upstream || upstream.provider !== "git") {
          continue;
        }
        const key = getLockKey(importEntry.upstreamId, importEntry.ref);
        const resolved = resolvedReferences.get(key);
        if (!resolved) {
          errors.push(`Missing resolved upstream reference for ${importEntry.upstreamId}@${importEntry.ref}.`);
          continue;
        }
        const objectType = await getCommitObjectType(
          resolved.repoPath,
          resolved.commit,
          importEntry.selectionPath
        );
        if (objectType !== "tree") {
          errors.push(
            `Imported path '${importEntry.selectionPath}' from '${importEntry.upstreamId}@${importEntry.ref}' is missing at commit ${resolved.commit}.`
          );
        }
      }

      await validateRuntimeArtifacts({
        profile,
        packRoot,
        packRoots: effectiveState.packs.map((item) => item.packRoot),
        skillImports,
        upstreamById: upstreams.byId,
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
    process.stdout.write(`${renderSection("Doctor Issues", { count: errors.length, stream: process.stdout })}\n`);
    process.stdout.write(`${renderSimpleList(errors.map((error) => `- ${redactPathDetails(error)}`), { indent: "" })}\n\n`);
    process.stdout.write(`${renderSection("Remediation", { stream: process.stdout })}\n`);
    process.stdout.write(`${renderSimpleList(["1. Run init", "2. Run use <name>", "3. Run sync", "4. Re-run doctor"])}\n`);
    process.exitCode = 1;
    return;
  }

  logInfo("Doctor checks passed.");
}
