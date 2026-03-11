import fs from "fs-extra";
import path from "node:path";
import {
  CACHE_ROOT,
  RUNTIME_INTERNAL_ROOT,
  SCHEMAS,
  detectOsName,
  expandTargetPath,
  logInfo,
  logWarn,
  writeJsonFile
} from "./core.js";
import { loadEffectiveTargets, resolvePack, resolveProfile } from "./config.js";
import {
  collectSourcePlanning,
  loadLockfile,
  loadUpstreamsConfig,
  resolveReferences,
  setPin,
  saveLockfile
} from "./upstreams.js";
import { removeImportRecords, upsertImportRecord } from "./import-lock.js";
import { assertJsonFileMatchesSchema } from "./core.js";
import { buildBundle } from "./bundle.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { importAgentProjector, loadAgentIntegrations } from "./agent-integrations.js";
import { getAgentRegistryById } from "./agent-registry.js";
import { assertAgentSupportsMcp } from "./mcp-config.js";
import { getNormalizedSourceDescriptor } from "./source-normalization.js";

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

  const effectiveState = await loadEffectiveProfileState(profileName);
  const normalizedMcp = effectiveState.normalizedMcp;
  const sources = effectiveState.effectiveSources;
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  const agentRegistryById = await getAgentRegistryById();
  const cacheExistsBeforeBuild = await fs.pathExists(CACHE_ROOT);

  const { references, skillImports } = collectSourcePlanning(sources, upstreams.byId);
  if (!quiet && !cacheExistsBeforeBuild && references.length > 0) {
    logInfo("First sync may take longer while upstream cache is initialized.");
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

  const runtimeInternalRoot = RUNTIME_INTERNAL_ROOT;
  await removeDirectoryRobust(runtimeInternalRoot);
  await fs.ensureDir(runtimeInternalRoot);

  let localConfigPolicy = {};
  try {
    const osName = detectOsName();
    const targets = await loadEffectiveTargets(osName);
    const integrations = await loadAgentIntegrations();
    localConfigPolicy = {
      ...Object.fromEntries(
        integrations.map((integration) => [
            integration.id,
          {
            path: expandTargetPath(targets[integration.id].mcpConfig, osName),
            hasNonMcpConfig: Boolean(targets[integration.id]?.hasNonMcpConfig)
          }
        ])
      )
    };
  } catch {
    if (!quiet) {
      logWarn("Could not resolve local target config for merge-friendly projection seeding.");
    }
  }

  const bundle = await buildBundle({
    profile,
    packRoots: effectiveState.packs.map((item) => item.packRoot),
    packRoot,
    skillImports,
    upstreamById: upstreams.byId,
    resolvedReferences,
    normalizedMcp,
    runtimeInternalRoot
  });

  const buildTimestamp = new Date().toISOString();
  const previousImports = new Map(
    (Array.isArray(lockState.lock.imports) ? lockState.lock.imports : [])
      .filter((entry) => entry.profile === profile.name)
      .map((entry) => [
        [entry.profile, entry.upstream, entry.selectionPath, entry.destRelative].join("::"),
        entry
      ])
  );

  const integrations = await loadAgentIntegrations();
  const projectionContracts = {};
  for (const integration of integrations) {
    const tool = integration.id;
    assertAgentSupportsMcp(integration, {
      canonicalMcp: normalizedMcp,
      configKind: integration.mcpKind
    });
    const projector = await importAgentProjector(integration);
    const projectionResult = await projector({
      agent: integration,
      runtimeInternalRoot,
      bundleSkillsPath: bundle.bundleSkillsPath,
      bundleMcpPath: bundle.bundleMcpPath,
      packRoot,
      localConfigPath: localConfigPolicy[tool]?.path ?? null,
      hasNonMcpConfig: localConfigPolicy[tool]?.hasNonMcpConfig ?? false
    });
    projectionContracts[tool] = {
      contractVersion: agentRegistryById.get(tool)?.projectionVersion ?? 1,
      ...(projectionResult?.skillsMethod ? { skillsMethod: projectionResult.skillsMethod } : {}),
      ...(projectionResult?.mcpMethod ? { mcpMethod: projectionResult.mcpMethod } : {})
    };
  }

  const bundleDoc = await fs.readJson(bundle.bundleMetadataPath);
  bundleDoc.projectionContracts = projectionContracts;
  await writeJsonFile(bundle.bundleMetadataPath, bundleDoc);

  for (const reference of references) {
    const resolved = resolvedReferences.get(`${reference.upstreamId}::${reference.ref}`);
    const upstream = upstreams.byId.get(reference.upstreamId);
    if (!resolved || !upstream) {
      continue;
    }
    if (setPin(lockState.lock, upstream, reference.ref, resolved.commit)) {
      lockState.changed = true;
    }
  }

  removeImportRecords(lockState.lock, (entry) => entry.profile === profile.name);
  for (const entry of bundle.importedSkillEntries) {
    const previous = previousImports.get([profile.name, entry.upstreamId, entry.selectionPath, entry.destRelative].join("::"));
    const upstream = upstreams.byId.get(entry.upstreamId);
    const didChange =
      (previous?.contentHash ?? null) !== entry.contentHash || (previous?.resolvedRevision ?? null) !== (entry.commit ?? null);
    upsertImportRecord(lockState.lock, {
      profile: profile.name,
      upstream: entry.upstreamId,
      provider: entry.provider,
      originalInput: entry.originalInput,
      selectionPath: entry.selectionPath,
      destRelative: entry.destRelative,
      ...(entry.ref ? { ref: entry.ref } : {}),
      tracking: entry.tracking,
      ...(entry.commit ? { resolvedRevision: entry.commit, latestRevision: entry.commit } : {}),
      contentHash: entry.contentHash,
      installedAt: previous?.installedAt ?? buildTimestamp,
      refreshedAt: buildTimestamp,
      capabilities: entry.capabilities,
      materializedAgents: previous?.materializedAgents ?? [],
      sourceIdentity: upstream?.sourceIdentity,
      source: {
        provider: entry.provider,
        originalInput: entry.originalInput,
        identity: upstream?.sourceIdentity,
        descriptor: upstream ? getNormalizedSourceDescriptor(upstream) : {}
      },
      resolution: {
        tracking: entry.tracking,
        ...(entry.ref ? { ref: entry.ref } : {}),
        ...(entry.commit ? { resolvedRevision: entry.commit, latestRevision: entry.commit } : {})
      },
      digests: {
        contentSha256: entry.contentHash
      },
      projection: {
        adapters: projectionContracts,
        materializedAgents: previous?.materializedAgents ?? []
      },
      refresh: {
        installedAt: previous?.installedAt ?? buildTimestamp,
        lastRefreshedAt: buildTimestamp,
        lastOutcome: didChange ? "changed" : "unchanged",
        changed: didChange
      },
      eval: {
        status: previous?.eval?.status ?? "pending",
        updatedAt: previous?.eval?.updatedAt ?? null
      }
    });
  }
  lockState.changed = true;
  if (lockState.changed && lockConfig.allowLockUpdate) {
    await saveLockfile(lockState);
  }

  if (!quiet) {
    logInfo(`Prepared runtime artifacts for profile '${profileName}'.`);
    logInfo(`Lock mode: ${lockMode} | Resolved upstream refs: ${references.length}`);
    if (suggestNextStep) {
      logInfo("Next step: run sync.");
    }
    if (lockMode === "read" && references.length > 0) {
      logWarn("Artifact generation ran with --lock=read. No upstream pins were written.");
    }
  }

  return {
    profile,
    packRoot,
    runtimeInternalRoot,
    normalizedMcp,
    sources,
    skillEntries: bundle.skillEntries,
    importedSkillEntries: bundle.importedSkillEntries,
    projectionContracts,
    references,
    resolvedReferences
  };
}
