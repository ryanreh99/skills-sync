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
  resolveLinkTarget,
  writeJsonFile
} from "./core.js";
import { loadEffectiveTargets } from "./config.js";
import { applyManagedMcpConfig, removeManagedMcpConfig } from "./mcp-config.js";

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

function getDirectoryBindingSpecs(effectiveTargets, runtimeInternalRoot) {
  const specs = [
    {
      tool: "codex",
      sourcePath: path.join(runtimeInternalRoot, ".codex", "skills"),
      targetRawPath: effectiveTargets.codex.skillsDir
    },
    {
      tool: "claude",
      sourcePath: path.join(runtimeInternalRoot, ".claude", "skills"),
      targetRawPath: effectiveTargets.claude.skillsDir
    },
    {
      tool: "cursor",
      sourcePath: path.join(runtimeInternalRoot, ".cursor", "skills"),
      targetRawPath: effectiveTargets.cursor.skillsDir
    },
    {
      tool: "copilot",
      sourcePath: path.join(runtimeInternalRoot, ".copilot", "skills"),
      targetRawPath: effectiveTargets.copilot.skillsDir
    },
    {
      tool: "gemini",
      sourcePath: path.join(runtimeInternalRoot, ".gemini", "skills"),
      targetRawPath: effectiveTargets.gemini.skillsDir
    }
  ];
  return specs.filter((spec) => typeof spec.targetRawPath === "string" && spec.targetRawPath.trim().length > 0);
}

function getConfigSpecs(effectiveTargets, runtimeInternalRoot) {
  return [
    {
      tool: "codex",
      sourcePath: path.join(runtimeInternalRoot, ".codex", "config.toml"),
      targetRawPath: effectiveTargets.codex.mcpConfig
    },
    {
      tool: "claude",
      sourcePath: path.join(runtimeInternalRoot, ".claude", "mcp.json"),
      targetRawPath: effectiveTargets.claude.mcpConfig
    },
    {
      tool: "cursor",
      sourcePath: path.join(runtimeInternalRoot, ".cursor", "mcp.json"),
      targetRawPath: effectiveTargets.cursor.mcpConfig
    },
    {
      tool: "copilot",
      sourcePath: path.join(runtimeInternalRoot, ".copilot", "mcp-config.json"),
      targetRawPath: effectiveTargets.copilot.mcpConfig
    },
    {
      tool: "gemini",
      sourcePath: path.join(runtimeInternalRoot, ".gemini", "settings.json"),
      targetRawPath: effectiveTargets.gemini.mcpConfig
    }
  ];
}

function formatUnmanagedPathError(targetPath, profileName) {
  void targetPath;
  return (
    "Refusing to replace an unmanaged existing target.\n" +
    "Remediation:\n" +
    " - Move or remove the existing target manually.\n" +
    ` - Re-run apply for profile '${profileName}'.`
  );
}

async function isAdoptableDirectoryBinding(sourcePath, targetPath) {
  const linkTarget = await resolveLinkTarget(targetPath);
  return Boolean(linkTarget) && pathsEqual(linkTarget, sourcePath);
}

async function bindNestedDirectoryEntries({
  tool,
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
          kind: "dir",
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
        kind: "dir",
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
        kind: "dir",
        targetPath: targetChildPath,
        sourcePath: sourceChildPath,
        action: "create-binding"
      });
    }
  }
}

async function adoptExistingDirectoryBinding({ tool, sourcePath, targetPath, osName, bindings }) {
  if (!(await isAdoptableDirectoryBinding(sourcePath, targetPath))) {
    return false;
  }

  bindings.push({
    tool,
    kind: "dir",
    targetPath,
    sourcePath,
    method: osName === "windows" ? "junction" : "symlink",
    hash: null,
    managedBy: MANAGED_BY
  });
  return true;
}

export async function unlinkInternal(options = {}) {
  const { suppressNoStateMessage = false, dryRun = false } = options;
  const statePath = await getStatePath();
  if (!(await fs.pathExists(statePath))) {
    if (!suppressNoStateMessage) {
      logInfo("No active bindings to unlink.");
    }
    return { removed: 0, skipped: 0, remainingBindings: [] };
  }

  const state = await fs.readJson(statePath);
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  let removed = 0;
  let skipped = 0;
  const remainingBindings = [];

  for (const binding of bindings) {
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
  const { dryRun = false, quiet = false } = options;
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
  const buildGuidance = `Set active profile: use ${profileHint}\nRun build first: /build`;

  if (!(await fs.pathExists(bundlePath))) {
    throw new Error(`Missing runtime bundle metadata.\n${buildGuidance}`);
  }
  if (!(await fs.pathExists(bundleMcpPath))) {
    throw new Error(`Missing runtime bundle MCP manifest.\n${buildGuidance}`);
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
    throw new Error("Could not determine profile for apply. Set one first with 'use <name>', then run build.");
  }
  if (requestedProfile && bundleProfile && bundleProfile !== requestedProfile) {
    throw new Error(
      `Runtime artifacts are stale for requested profile '${requestedProfile}'. Found bundle profile '${bundleProfile}'.\n` +
        `Set active profile: use ${requestedProfile}\n` +
        "Run build first: /build"
    );
  }
  const canonicalMcp = await fs.readJson(bundleMcpPath);

  const effectiveTargets = await loadEffectiveTargets(osName);
  const statePath = await getStatePath();
  if (await fs.pathExists(statePath)) {
    if (dryRun) {
      info("Dry-run: existing state file detected. Apply would unlink previous managed bindings first.");
    } else {
      const unlinkResult = await unlinkInternal({ suppressNoStateMessage: true });
      if (unlinkResult.remainingBindings.length > 0) {
        throw new Error(
          "Cannot continue apply because some previous bindings could not be safely unlinked.\n" +
            "Run /unlink/doctor, resolve reported paths manually, then retry apply."
        );
      }
    }
  }

  const directorySpecs = getDirectoryBindingSpecs(effectiveTargets, runtimeInternalRoot);
  const configSpecs = getConfigSpecs(effectiveTargets, runtimeInternalRoot);
  const bindings = [];
  const createdTargets = [];
  const plannedActions = [];

  try {
    for (const spec of directorySpecs) {
      const sourcePath = path.resolve(spec.sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(
          "Source directory missing for apply.\n" +
            `Set active profile: use ${effectiveProfile}\n` +
            "Run build first: /build"
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
              sourcePath,
              targetPath,
              osName,
              bindings
            });
        if (adopted) {
          plannedActions.push({
            tool: spec.tool,
            kind: "dir",
            sourcePath,
            targetPath,
            action: "adopt-existing"
          });
          continue;
        }

        // Codex skills target may already exist as a user-managed parent directory.
        if (spec.tool === "codex") {
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
          kind: "dir",
          targetPath,
          sourcePath,
          method,
          hash: null,
          managedBy: MANAGED_BY
        });
      }
      plannedActions.push({
        tool: spec.tool,
        kind: "dir",
        sourcePath,
        targetPath,
        action: "create-binding"
      });
    }

    for (const spec of configSpecs) {
      const sourcePath = path.resolve(spec.sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(
          "Source config missing for apply.\n" +
            `Set active profile: use ${effectiveProfile}\n` +
            "Run build first: /build"
        );
      }

      const targetPath = expandTargetPath(spec.targetRawPath, osName);
      const result = await applyManagedMcpConfig({
        tool: spec.tool,
        targetPath,
        canonicalMcp,
        dryRun
      });

      plannedActions.push({
        tool: spec.tool,
        kind: "config",
        sourcePath,
        targetPath,
        action: result.wouldWrite ? "update-config" : "no-change"
      });

      if (!dryRun) {
        bindings.push({
          tool: spec.tool,
          kind: "config",
          targetPath,
          sourcePath,
          method: result.method,
          hash: result.hash,
          managedNames: result.managedNames,
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
    info(`Dry-run apply for profile '${effectiveProfile}' complete. No files were modified.`);
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
  await writeJsonFile(statePath, stateDocument);

  info(`Applied profile '${effectiveProfile}'.`);
  info(`Target OS: ${osName}`);
}

export async function unlinkBindings(options = {}) {
  const { dryRun = false } = options;
  const { removed, skipped, remainingBindings } = await unlinkInternal({ dryRun });
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
