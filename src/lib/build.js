import fs from "fs-extra";
import path from "node:path";
import { CACHE_ROOT, RUNTIME_INTERNAL_ROOT, SCHEMAS, detectOsName, expandTargetPath, logInfo, logWarn } from "./core.js";
import { loadEffectiveTargets, loadPackSources, normalizeMcpManifest, resolvePack, resolveProfile } from "./config.js";
import {
  collectSourcePlanning,
  loadLockfile,
  loadUpstreamsConfig,
  resolveReferences,
  saveLockfile
} from "./upstreams.js";
import { assertJsonFileMatchesSchema } from "./core.js";
import { buildBundle } from "./bundle.js";
import { projectCodexFromBundle } from "./adapters/codex.js";
import { projectClaudeFromBundle } from "./adapters/claude.js";
import { projectCursorFromBundle } from "./adapters/cursor.js";
import { projectCopilotFromBundle } from "./adapters/copilot.js";
import { projectGeminiFromBundle } from "./adapters/gemini.js";

export { collectImportedSkillEntries, collectLocalSkillEntries } from "./bundle.js";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function removeDirectoryRobust(targetPath) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = code === "EPERM" || code === "ENOTEMPTY" || code === "EBUSY";
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      await sleep(150 * attempt);
    }
  }
}

export async function buildProfile(profileName, options = {}) {
  const { quiet = false, lockMode = "write", suggestNextStep = true } = options;

  const { profile } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profile);

  const packManifestPath = path.join(packRoot, "pack.json");
  await assertJsonFileMatchesSchema(packManifestPath, SCHEMAS.packManifest);

  const mcpServersPath = path.join(packRoot, "mcp", "servers.json");
  const mcpServersManifest = await assertJsonFileMatchesSchema(mcpServersPath, SCHEMAS.mcpServers);
  const normalizedMcp = normalizeMcpManifest(mcpServersManifest);

  const { sources } = await loadPackSources(packRoot);
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  const cacheExistsBeforeBuild = await fs.pathExists(CACHE_ROOT);

  const { references, skillImports } = collectSourcePlanning(sources, upstreams.byId);
  if (!quiet && !cacheExistsBeforeBuild && references.length > 0) {
    logInfo("First build may take longer while upstream cache is initialized.");
  }
  const lockConfigByMode = {
    read: {
      preferPinned: true,
      requirePinned: true,
      updatePins: false,
      allowLockUpdate: false
    },
    write: {
      preferPinned: true,
      requirePinned: false,
      updatePins: false,
      allowLockUpdate: true
    },
    refresh: {
      preferPinned: false,
      requirePinned: false,
      updatePins: true,
      allowLockUpdate: true
    }
  };
  const lockConfig = lockConfigByMode[lockMode];
  if (!lockConfig) {
    throw new Error(`Invalid lock mode '${lockMode}'. Use read, write, or refresh.`);
  }

  const resolvedReferences =
    references.length > 0
      ? await resolveReferences({
          references,
          upstreamById: upstreams.byId,
          lockState,
          ...lockConfig
        })
      : new Map();

  if (lockState.changed && lockConfig.allowLockUpdate) {
    await saveLockfile(lockState);
  }

  const runtimeInternalRoot = RUNTIME_INTERNAL_ROOT;
  await removeDirectoryRobust(runtimeInternalRoot);
  await fs.ensureDir(runtimeInternalRoot);

  let localConfigPolicy = {};
  try {
    const osName = detectOsName();
    const targets = await loadEffectiveTargets(osName);
    localConfigPolicy = {
      codex: {
        path: expandTargetPath(targets.codex.mcpConfig, osName),
        canOverride: Boolean(targets.codex?.canOverride)
      },
      claude: {
        path: expandTargetPath(targets.claude.mcpConfig, osName),
        canOverride: Boolean(targets.claude?.canOverride)
      },
      cursor: {
        path: expandTargetPath(targets.cursor.mcpConfig, osName),
        canOverride: Boolean(targets.cursor?.canOverride)
      },
      copilot: {
        path: expandTargetPath(targets.copilot.mcpConfig, osName),
        canOverride: Boolean(targets.copilot?.canOverride)
      },
      gemini: {
        path: expandTargetPath(targets.gemini.mcpConfig, osName),
        canOverride: Boolean(targets.gemini?.canOverride)
      }
    };
  } catch {
    if (!quiet) {
      logWarn("Could not resolve local target config for merge-friendly projection seeding.");
    }
  }

  const bundle = await buildBundle({
    profile,
    packRoot,
    skillImports,
    resolvedReferences,
    normalizedMcp,
    runtimeInternalRoot
  });

  const toolProjectors = [
    { tool: "codex", projector: projectCodexFromBundle },
    { tool: "claude", projector: projectClaudeFromBundle },
    { tool: "cursor", projector: projectCursorFromBundle },
    { tool: "copilot", projector: projectCopilotFromBundle },
    { tool: "gemini", projector: projectGeminiFromBundle }
  ];
  for (const { tool, projector } of toolProjectors) {
    await projector({
      runtimeInternalRoot,
      bundleSkillsPath: bundle.bundleSkillsPath,
      bundleMcpPath: bundle.bundleMcpPath,
      packRoot,
      localConfigPath: localConfigPolicy[tool]?.path ?? null,
      canOverride: localConfigPolicy[tool]?.canOverride ?? false
    });
  }

  if (!quiet) {
    logInfo(`Built profile '${profileName}'.`);
    logInfo(`Lock mode: ${lockMode} | Resolved upstream refs: ${references.length}`);
    if (suggestNextStep) {
      logInfo("Next step: run /apply.");
    }
    if (lockMode === "read" && references.length > 0) {
      logWarn("Build ran with --lock=read. No upstream pins were written.");
    }
  }

  return {
    profile,
    packRoot,
    runtimeInternalRoot,
    normalizedMcp,
    sources,
    skillEntries: bundle.skillEntries,
    references,
    resolvedReferences
  };
}
