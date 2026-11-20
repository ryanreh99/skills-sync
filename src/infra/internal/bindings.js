import fs from "fs-extra";
import path from "node:path";
import {
  LOCAL_OVERRIDES_ROOT,
  MANAGED_BY,
  RUNTIME_INTERNAL_ROOT,
  bindingMatches,
  createDirectoryBinding,
  detectOsName,
  existsOrLink,
  expandTargetPath,
  logInfo,
  logWarn,
  pathsEqual,
  readJsonFile,
  resolveLinkTarget,
  writeJsonFile
} from "./core.js";
import { loadAgentIntegrations, resolveAgentRuntimePath } from "./agent-integrations.js";
import { parseEntityFilterOption, entitySelectionIncludes, bindingMatchesSelectedEntities } from "./entity-surfaces.js";
import { parseAgentFilterOption } from "./agent-registry.js";
import { applyManagedHookConfigForAgent, removeManagedHookConfig } from "./hook-config.js";
import { loadEffectiveTargets } from "./config.js";
import { loadImportLock, saveImportLock } from "./import-lock.js";
import {
  applyManagedMcpConfigForAgent,
  removeManagedMcpConfig,
  resolveAgentMcpConfigKind
} from "./mcp-config.js";

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

export async function getStatePath() {
  const stateDir = path.join(LOCAL_OVERRIDES_ROOT, "state");
  await fs.ensureDir(stateDir);
  return path.join(stateDir, "active-profile.json");
}

function getDirectoryBindingSpecs(
  integrations,
  effectiveTargets,
  runtimeInternalRoot,
  selectedAgents = null,
  selectedEntities = null
) {
  const specs = [];
  for (const integration of integrations) {
    if (selectedAgents && !selectedAgents.has(integration.id)) {
      continue;
    }
    const target = effectiveTargets[integration.id] ?? {};
    if (entitySelectionIncludes(selectedEntities, "skills") && normalizeTargetValue(target.skillsDir)) {
      specs.push({
        tool: integration.id,
        kind: "dir",
        surface: "skills",
        sourcePath: resolveAgentRuntimePath(runtimeInternalRoot, integration, "skills"),
        targetRawPath: target.skillsDir,
        bindMode: integration.internal.skillsBindMode
      });
    }
    if (
      entitySelectionIncludes(selectedEntities, "commands") &&
      integration.commandKind !== "unsupported" &&
      normalizeTargetValue(target.commandsDir)
    ) {
      specs.push({
        tool: integration.id,
        kind: "command-dir",
        surface: "commands",
        sourcePath: resolveAgentRuntimePath(runtimeInternalRoot, integration, "commands"),
        targetRawPath: target.commandsDir,
        bindMode: "root"
      });
    }
  }
  return specs;
}

function normalizeTargetValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getConfigSpecs(
  integrations,
  effectiveTargets,
  runtimeInternalRoot,
  selectedAgents = null,
  selectedEntities = null
) {
  const specs = [];
  for (const integration of integrations) {
    if (selectedAgents && !selectedAgents.has(integration.id)) {
      continue;
    }
    const target = effectiveTargets[integration.id] ?? {};
    if (entitySelectionIncludes(selectedEntities, "mcp")) {
      specs.push({
        tool: integration.id,
        kind: "config",
        surface: "mcp",
        agent: integration,
        sourcePath: resolveAgentRuntimePath(runtimeInternalRoot, integration, "config"),
        targetRawPath: target.mcpConfig,
        configKind: resolveAgentMcpConfigKind(integration)
      });
    }
    if (
      entitySelectionIncludes(selectedEntities, "hooks") &&
      integration.hookKind !== "unsupported" &&
      normalizeTargetValue(target.hooksConfig)
    ) {
      specs.push({
        tool: integration.id,
        kind: "hook-config",
        surface: "hooks",
        agent: integration,
        sourcePath: resolveAgentRuntimePath(runtimeInternalRoot, integration, "hooks"),
        targetRawPath: target.hooksConfig
      });
    }
  }
  return specs;
}

function filterBindings(bindings, selectedAgents, selectedEntities) {
  if ((!selectedAgents || selectedAgents.size === 0) && (!selectedEntities || selectedEntities.size === 0)) {
    return {
      targeted: [...bindings],
      untouched: []
    };
  }
  const targeted = [];
  const untouched = [];
  for (const binding of bindings) {
    const matchesAgent = !selectedAgents || selectedAgents.size === 0 || selectedAgents.has(binding.tool);
    const matchesEntity = bindingMatchesSelectedEntities(binding, selectedEntities);
    if (matchesAgent && matchesEntity) {
      targeted.push(binding);
    } else {
      untouched.push(binding);
    }
  }
  return {
    targeted,
    untouched
  };
}

async function updateImportMaterialization(profileName, selectedAgents, modeByAgent, remove = false) {
  const lockState = await loadImportLock();
  const targetAgents = selectedAgents ? [...selectedAgents] : [];
  let changed = false;

  for (const entry of lockState.lock.imports) {
    if (entry.profile !== profileName) {
      continue;
    }
    const existing = new Map(
      (Array.isArray(entry.materializedAgents) ? entry.materializedAgents : []).map((item) => [item.id, item])
    );
    for (const agentId of targetAgents) {
      if (remove) {
        if (existing.delete(agentId)) {
          changed = true;
        }
        continue;
      }
      const nextValue = {
        id: agentId,
        mode: modeByAgent.get(agentId) ?? "unknown",
        appliedAt: new Date().toISOString()
      };
      const previous = existing.get(agentId);
      if (!previous || previous.mode !== nextValue.mode) {
        changed = true;
      }
      existing.set(agentId, nextValue);
    }
    entry.materializedAgents = Array.from(existing.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  if (changed) {
    await saveImportLock(lockState);
  }
}

function formatUnmanagedPathError(targetPath, profileName) {
  void targetPath;
  return (
    "Refusing to replace an unmanaged existing target.\n" +
    "Remediation:\n" +
    " - Move or remove the existing target manually.\n" +
    ` - Re-run sync for profile '${profileName}'.`
  );
}

async function isAdoptableDirectoryBinding(sourcePath, targetPath) {
  const linkTarget = await resolveLinkTarget(targetPath);
  return Boolean(linkTarget) && pathsEqual(linkTarget, sourcePath);
}

async function bindNestedDirectoryEntries({
  tool,
  bindingKind,
  sourcePath,
  targetPath,
  osName,
  profileName,
  bindings,
  createdTargets,
  dryRun = false,
  plannedActions = null
}) {
  if (!dryRun) {
    await fs.ensureDir(targetPath);
  }
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));

  for (const directory of directories) {
    const sourceChildPath = path.join(sourcePath, directory.name);
    const targetChildPath = path.join(targetPath, directory.name);

    if (await existsOrLink(targetChildPath)) {
      const adopted = dryRun
        ? await isAdoptableDirectoryBinding(sourceChildPath, targetChildPath)
        : await adoptExistingDirectoryBinding({
            tool,
            bindingKind,
            sourcePath: sourceChildPath,
            targetPath: targetChildPath,
            osName,
            bindings
          });
      if (!adopted) {
        throw new Error(formatUnmanagedPathError(targetChildPath, profileName));
      }
      if (plannedActions) {
        plannedActions.push({
          tool,
          kind: bindingKind,
          targetPath: targetChildPath,
          sourcePath: sourceChildPath,
          action: "adopt-existing"
        });
      }
      continue;
    }

      if (!dryRun) {
        const method = await createDirectoryBinding(sourceChildPath, targetChildPath, osName);
        createdTargets.push(targetChildPath);
      bindings.push({
        tool,
        kind: bindingKind,
        targetPath: targetChildPath,
        sourcePath: sourceChildPath,
        method,
        hash: null,
        managedBy: MANAGED_BY
      });
    }
    if (plannedActions) {
      plannedActions.push({
        tool,
        kind: bindingKind,
        targetPath: targetChildPath,
        sourcePath: sourceChildPath,
        action: "create-binding"
      });
    }
  }
}

async function adoptExistingDirectoryBinding({ tool, bindingKind, sourcePath, targetPath, osName, bindings }) {
  if (!(await isAdoptableDirectoryBinding(sourcePath, targetPath))) {
    return false;
  }

  bindings.push({
    tool,
    kind: bindingKind,
    targetPath,
    sourcePath,
    method: osName === "windows" ? "junction" : "symlink",
    hash: null,
    managedBy: MANAGED_BY
  });
  return true;
}

export async function unlinkInternal(options = {}) {
  const { suppressNoStateMessage = false, dryRun = false, agents = null, entities = null } = options;
  const statePath = await getStatePath();
  if (!(await fs.pathExists(statePath))) {
    if (!suppressNoStateMessage) {
      logInfo("No active bindings to unlink.");
    }
    return { removed: 0, skipped: 0, remainingBindings: [] };
  }

  const state = await fs.readJson(statePath);
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  const selectedAgents = agents ? new Set(await parseAgentFilterOption(agents)) : null;
  const selectedEntities = entities ? new Set(parseEntityFilterOption(entities)) : null;
  const filtered = filterBindings(bindings, selectedAgents, selectedEntities);
  let removed = 0;
  let skipped = 0;
  const remainingBindings = [...filtered.untouched];

  for (const binding of filtered.targeted) {
    if (binding.kind === "config") {
      try {
        const result = await removeManagedMcpConfig(binding, { dryRun });
        if (result.removed) {
          removed += 1;
        }
      } catch (error) {
        skipped += 1;
        logWarn(`Skipping a config binding because managed MCP removal failed: ${redactPathDetails(error.message)}`);
        remainingBindings.push(binding);
      }
      continue;
    }
    if (binding.kind === "hook-config") {
      try {
        const result = await removeManagedHookConfig(binding, { dryRun });
        if (result.removed) {
          removed += 1;
        }
      } catch (error) {
        skipped += 1;
        logWarn(`Skipping a hook config binding because managed hook removal failed: ${redactPathDetails(error.message)}`);
        remainingBindings.push(binding);
      }
      continue;
    }

    if (!(await existsOrLink(binding.targetPath))) {
      continue;
    }
    if (!(await bindingMatches(binding))) {
      skipped += 1;
      logWarn("Skipping a binding because it no longer matches managed metadata.");
      remainingBindings.push(binding);
      continue;
    }
    if (!dryRun) {
      await fs.remove(binding.targetPath);
    }
    removed += 1;
  }

  if (dryRun) {
    return { removed, skipped, remainingBindings };
  }

  const removedSkillAgents = new Set(
    filtered.targeted.filter((binding) => binding.kind === "dir").map((binding) => binding.tool)
  );
  if (state.profile && removedSkillAgents.size > 0) {
    await updateImportMaterialization(state.profile, removedSkillAgents, new Map(), true);
  }

  if (remainingBindings.length > 0) {
    await writeJsonFile(statePath, {
      ...state,
      updatedAt: new Date().toISOString(),
      bindings: remainingBindings
    });
  } else {
    await fs.remove(statePath);
  }
  return { removed, skipped, remainingBindings };
}

export async function applyBindings(profileName, options = {}) {
  const { dryRun = false, quiet = false, agents = null, entities = null } = options;
  const info = (message) => {
    if (!quiet) {
      logInfo(message);
    }
  };
  const osName = detectOsName();
  const runtimeInternalRoot = RUNTIME_INTERNAL_ROOT;
  const bundlePath = path.join(runtimeInternalRoot, "common", "bundle.json");
  const bundleMcpPath = path.join(runtimeInternalRoot, "common", "mcp.json");
  const requestedProfile = typeof profileName === "string" && profileName.trim().length > 0 ? profileName.trim() : null;
  const profileHint = requestedProfile ?? "<name>";
  const syncGuidance = `Set active profile: use ${profileHint}\nRun sync: sync`;

  if (!(await fs.pathExists(bundlePath))) {
    throw new Error(`Missing runtime bundle metadata.\n${syncGuidance}`);
  }
  if (!(await fs.pathExists(bundleMcpPath))) {
    throw new Error(`Missing runtime bundle MCP manifest.\n${syncGuidance}`);
  }

  let bundle;
  try {
    bundle = await fs.readJson(bundlePath);
  } catch (error) {
    throw new Error(`Failed to read runtime bundle metadata: ${error.message}`);
  }
  const bundleProfile = typeof bundle.profile === "string" && bundle.profile.trim().length > 0 ? bundle.profile.trim() : null;
  const effectiveProfile = requestedProfile ?? bundleProfile;
  if (!effectiveProfile) {
    throw new Error("Could not determine profile for runtime sync. Set one first with 'use <name>', then run sync.");
  }
  if (requestedProfile && bundleProfile && bundleProfile !== requestedProfile) {
    throw new Error(
      `Runtime artifacts are stale for requested profile '${requestedProfile}'. Found bundle profile '${bundleProfile}'.\n` +
        `Set active profile: use ${requestedProfile}\n` +
        "Run sync: sync"
    );
  }
  const canonicalMcp = await fs.readJson(bundleMcpPath);
  const selectedAgents = agents ? new Set(await parseAgentFilterOption(agents)) : null;
  const selectedEntities = entities ? new Set(parseEntityFilterOption(entities)) : null;
  const integrations = await loadAgentIntegrations();

  const effectiveTargets = await loadEffectiveTargets(osName);
  const statePath = await getStatePath();
  if (await fs.pathExists(statePath)) {
    const existingState = await fs.readJson(statePath).catch(() => null);
    if (
      existingState?.profile &&
      existingState.profile !== effectiveProfile &&
      ((selectedAgents && selectedAgents.size > 0) || (selectedEntities && selectedEntities.size > 0))
    ) {
      throw new Error(
        `Cannot partially sync profile '${effectiveProfile}' while active state belongs to '${existingState.profile}'. Run unlink first.`
      );
    }
    if (dryRun) {
      info("Dry-run: existing state file detected. Sync would unlink previous managed bindings first.");
      } else {
        const unlinkResult = await unlinkInternal({
          suppressNoStateMessage: true,
          agents,
          entities
        });
      if (unlinkResult.remainingBindings.length > 0) {
        const remainingOutsideSelection = unlinkResult.remainingBindings.every(
          (binding) => {
            const matchesAgent = !selectedAgents || selectedAgents.size === 0 || selectedAgents.has(binding.tool);
            const matchesEntity = bindingMatchesSelectedEntities(binding, selectedEntities);
            return !(matchesAgent && matchesEntity);
          }
        );
        if (!remainingOutsideSelection) {
          throw new Error(
            "Cannot continue sync because some previous bindings could not be safely unlinked.\n" +
              "Run unlink/doctor, resolve reported paths manually, then retry sync."
          );
        }
      }
    }
  }

  const directorySpecs = getDirectoryBindingSpecs(
    integrations,
    effectiveTargets,
    runtimeInternalRoot,
    selectedAgents,
    selectedEntities
  );
  const configSpecs = getConfigSpecs(
    integrations,
    effectiveTargets,
    runtimeInternalRoot,
    selectedAgents,
    selectedEntities
  );
  const bindings = [];
  const createdTargets = [];
  const plannedActions = [];

  try {
    for (const spec of directorySpecs) {
      const sourcePath = path.resolve(spec.sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(
          "Source directory missing for runtime sync.\n" +
            `Set active profile: use ${effectiveProfile}\n` +
            "Run sync: sync"
        );
      }

      const targetPath = expandTargetPath(spec.targetRawPath, osName);
      if (!dryRun) {
        await fs.ensureDir(path.dirname(targetPath));
      }
      if (await existsOrLink(targetPath)) {
        const adopted = dryRun
          ? await isAdoptableDirectoryBinding(sourcePath, targetPath)
          : await adoptExistingDirectoryBinding({
              tool: spec.tool,
              bindingKind: spec.kind,
              sourcePath,
              targetPath,
              osName,
              bindings
            });
        if (adopted) {
          plannedActions.push({
            tool: spec.tool,
            kind: spec.kind,
            sourcePath,
            targetPath,
            action: "adopt-existing"
          });
          continue;
        }

        if (spec.bindMode === "children") {
          const targetLstat = await fs.lstat(targetPath);
          if (targetLstat.isSymbolicLink()) {
            throw new Error(formatUnmanagedPathError(targetPath, effectiveProfile));
          }
          const targetStats = await fs.stat(targetPath);
          if (!targetStats.isDirectory()) {
            throw new Error(formatUnmanagedPathError(targetPath, effectiveProfile));
          }
          await bindNestedDirectoryEntries({
            tool: spec.tool,
            bindingKind: spec.kind,
            sourcePath,
            targetPath,
            osName,
            profileName: effectiveProfile,
            bindings,
            createdTargets,
            dryRun,
            plannedActions
          });
          continue;
        }
        throw new Error(formatUnmanagedPathError(targetPath, effectiveProfile));
      }

      if (!dryRun) {
        const method = await createDirectoryBinding(sourcePath, targetPath, osName);
        createdTargets.push(targetPath);
        bindings.push({
          tool: spec.tool,
          kind: spec.kind,
          targetPath,
          sourcePath,
          method,
          hash: null,
          managedBy: MANAGED_BY
        });
      }
      plannedActions.push({
        tool: spec.tool,
        kind: spec.kind,
        sourcePath,
        targetPath,
        action: "create-binding"
      });
    }

    for (const spec of configSpecs) {
      const sourcePath = path.resolve(spec.sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(
          "Source config missing for runtime sync.\n" +
            `Set active profile: use ${effectiveProfile}\n` +
            "Run sync: sync"
        );
      }

      const targetPath = expandTargetPath(spec.targetRawPath, osName);
      const result = spec.kind === "config"
        ? await applyManagedMcpConfigForAgent({
            agent: spec.agent,
            targetPath,
            canonicalMcp,
            dryRun,
            configKind: spec.configKind
          })
        : await applyManagedHookConfigForAgent({
            agent: spec.agent,
            targetPath,
            projectedHooks: await readJsonFile(sourcePath),
            dryRun
          });

      plannedActions.push({
        tool: spec.tool,
        kind: spec.kind,
        sourcePath,
        targetPath,
        action: result.wouldWrite ? "update-config" : "no-change"
      });

      if (!dryRun) {
        bindings.push({
          tool: spec.tool,
          kind: spec.kind,
          targetPath,
          sourcePath,
          method: result.method,
          hash: result.hash,
          ...(spec.kind === "config" ? { configKind: spec.configKind } : {}),
          ...(result.managedNames ? { managedNames: result.managedNames } : {}),
          ...(result.managedKeys ? { managedKeys: result.managedKeys } : {}),
          ...(result.shadowedServers && Object.keys(result.shadowedServers).length > 0
            ? { shadowedServers: result.shadowedServers }
            : {}),
          ...(result.shadowedHooks && Object.keys(result.shadowedHooks).length > 0
            ? { shadowedHooks: result.shadowedHooks }
            : {}),
          managedBy: MANAGED_BY
        });
      }
    }
  } catch (error) {
    if (!dryRun) {
      for (const createdTarget of createdTargets) {
        if (await existsOrLink(createdTarget)) {
          await fs.remove(createdTarget);
        }
      }
    }
    throw error;
  }

  if (dryRun) {
    const byTool = new Map();
    for (const action of plannedActions) {
      byTool.set(action.tool, (byTool.get(action.tool) ?? 0) + 1);
    }
    info(`Dry-run sync preview for profile '${effectiveProfile}' complete. No files were modified.`);
    for (const tool of Array.from(byTool.keys()).sort((left, right) => left.localeCompare(right))) {
      info(`  ${tool}: ${byTool.get(tool)} planned action(s)`);
    }
    return {
      dryRun: true,
      profile: effectiveProfile,
      os: osName,
      plannedActions
    };
  }

  const stateDocument = {
    managedBy: MANAGED_BY,
    profile: effectiveProfile,
    os: osName,
    appliedAt: new Date().toISOString(),
    bindings
  };
  let existingState = null;
  if (await fs.pathExists(statePath)) {
    existingState = await fs.readJson(statePath).catch(() => null);
  }
  if (
    existingState &&
    ((selectedAgents && selectedAgents.size > 0) || (selectedEntities && selectedEntities.size > 0))
  ) {
    const existingBindings = Array.isArray(existingState.bindings) ? existingState.bindings : [];
    const untouched = filterBindings(existingBindings, selectedAgents, selectedEntities).untouched;
    stateDocument.bindings = [...untouched, ...bindings];
  }
  await writeJsonFile(statePath, stateDocument);

  const modeByAgent = new Map();
  for (const binding of bindings) {
    if (binding.kind === "dir") {
      modeByAgent.set(binding.tool, binding.method);
    }
  }
  await updateImportMaterialization(
    effectiveProfile,
    selectedAgents ?? new Set(bindings.map((binding) => binding.tool)),
    modeByAgent,
    false
  );

  info(`Synced profile '${effectiveProfile}'.`);
  info(`Target OS: ${osName}`);
}

export async function unlinkBindings(options = {}) {
  const { dryRun = false, agents = null, entities = null } = options;
  const { removed, skipped, remainingBindings } = await unlinkInternal({ dryRun, agents, entities });
  if (dryRun) {
    logInfo(`Dry-run unlink complete. Would remove ${removed} binding(s), skip ${skipped} binding(s).`);
    return { dryRun: true, removed, skipped, remainingBindings };
  }
  logInfo(`Unlink complete. Removed ${removed} binding(s), skipped ${skipped} binding(s).`);
  if (remainingBindings.length > 0) {
    logWarn("State file still contains unresolved bindings. Run doctor for remediation steps.");
  }
  return { dryRun: false, removed, skipped, remainingBindings };
}

export async function cmdApply(profileName, options = {}) {
  return applyBindings(profileName, options);
}

export async function cmdUnlink(options = {}) {
  return unlinkBindings(options);
}
