import fs from "fs-extra";
import path from "node:path";
import { collectImportedSkillEntries, collectLocalSkillEntries } from "../../../../infra/internal/bundle.js";
import { getCommitObjectType, getLockKey } from "../../../../infra/internal/upstreams.js";
import { loadAgentIntegrations, resolveAgentRuntimePath } from "../../../../infra/internal/agent-integrations.js";
import { validateProjectedHookConfigForAgent } from "../../../../infra/internal/hook-config.js";
import { validateProjectedMcpConfigForAgent } from "../../../../infra/internal/mcp-config.js";
import { SCHEMAS, assertJsonFileMatchesSchema, toFileSystemRelativePath } from "../../../../infra/internal/core.js";
import { addDoctorError, addDoctorWarning } from "../../../../domain/doctor/report.js";
import { getRuntimeBundlePath } from "../../../../infra/repositories/runtime-repository.js";
import {
  collectProfileSourcePlanning,
  loadProfileDoctorContext,
  resolveProfileReferences,
  validateProfileLockPins
} from "../../../../infra/repositories/workspace-repository.js";

async function validateRuntimeArtifacts({
  profile,
  packRoot,
  packRoots,
  skillImports,
  upstreamById,
  resolvedReferences,
  normalizedMcp,
  normalizedCommands,
  normalizedHooks,
  report
}) {
  const bundleMetadataPath = getRuntimeBundlePath("common", "bundle.json");
  const bundleSkillsPath = getRuntimeBundlePath("common", "skills");
  const bundleMcpPath = getRuntimeBundlePath("common", "mcp.json");
  const bundleCommandsPath = getRuntimeBundlePath("common", "commands.json");
  const bundleHooksPath = getRuntimeBundlePath("common", "hooks.json");

  for (const requiredPath of [bundleMetadataPath, bundleSkillsPath, bundleMcpPath, bundleCommandsPath, bundleHooksPath]) {
    if (!(await fs.pathExists(requiredPath))) {
      addDoctorError(report, `Missing canonical bundle artifact: ${requiredPath}`);
    }
  }
  if (report.errors.length > 0) {
    return;
  }

  const bundleDoc = await assertJsonFileMatchesSchema(bundleMetadataPath, SCHEMAS.bundle).catch((error) => {
    addDoctorError(report, error.message);
    return null;
  });
  if (!bundleDoc) {
    return;
  }

  if (bundleDoc.profile !== profile.name) {
    addDoctorError(report, `Bundle profile mismatch. Expected '${profile.name}', found '${bundleDoc.profile}'.`);
  }
  if (bundleDoc.sources?.packPath !== packRoot) {
    addDoctorError(report, `Bundle packPath mismatch. Expected '${packRoot}', found '${bundleDoc.sources?.packPath}'.`);
  }

  const canonicalMcp = await fs.readJson(bundleMcpPath).catch((error) => {
    addDoctorError(report, `Failed to read canonical MCP: ${error.message}`);
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
      addDoctorError(report, `Expected bundled skill missing: ${bundled}`);
    }
  }

  const requiredProjectionPaths = integrations.flatMap((integration) => [
    resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "skills"),
    resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "config"),
    ...(integration.commandKind !== "unsupported" ? [resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "commands")] : []),
    ...(integration.hookKind !== "unsupported" ? [resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "hooks")] : [])
  ]);
  for (const projectionPath of requiredProjectionPaths) {
    if (!(await fs.pathExists(projectionPath))) {
      addDoctorError(report, `Missing projection artifact: ${projectionPath}`);
    }
  }

  for (const integration of integrations) {
    for (const entry of allEntries) {
      const target = path.join(
        resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "skills"),
        toFileSystemRelativePath(entry.destRelative)
      );
      if (!(await fs.pathExists(target))) {
        addDoctorError(report, `Expected ${integration.id} projected skill missing: ${target}`);
      }
    }
  }

  for (const integration of integrations) {
    const projectionPath = resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "config");
    if (!(await fs.pathExists(projectionPath))) {
      continue;
    }
    const validationError = await validateProjectedMcpConfigForAgent({
      agent: integration,
      projectionPath,
      canonicalMcp
    });
    if (validationError) {
      addDoctorError(report, validationError);
    }
  }

  for (const integration of integrations.filter((item) => item.hookKind !== "unsupported")) {
    const projectionPath = resolveAgentRuntimePath(getRuntimeBundlePath(), integration, "hooks");
    if (!(await fs.pathExists(projectionPath))) {
      continue;
    }
    const validationError = await validateProjectedHookConfigForAgent({
      agent: integration,
      projectionPath
    });
    if (validationError) {
      addDoctorError(report, validationError);
    }
  }

  if (JSON.stringify(canonicalMcp) !== JSON.stringify(normalizedMcp)) {
    addDoctorError(report, `Canonical MCP differs from pack MCP normalization at ${bundleMcpPath}.`);
  }
  const canonicalCommands = await fs.readJson(bundleCommandsPath).catch(() => null);
  if (JSON.stringify(canonicalCommands) !== JSON.stringify(normalizedCommands)) {
    addDoctorError(report, `Canonical commands differ from pack command normalization at ${bundleCommandsPath}.`);
  }
  const canonicalHooks = await fs.readJson(bundleHooksPath).catch(() => null);
  if (JSON.stringify(canonicalHooks) !== JSON.stringify(normalizedHooks)) {
    addDoctorError(report, `Canonical hooks differ from pack hook normalization at ${bundleHooksPath}.`);
  }
}

export async function runProfileRuntimeCheck({
  report,
  profileName,
  upstreams,
  lockState
}) {
  if (!profileName) {
    addDoctorWarning(report, "No profile provided and no active state profile found; skipping profile-specific validation.");
    return;
  }
  if (!upstreams || !lockState) {
    return;
  }

  try {
    const { profile, packRoot, effectiveState } = await loadProfileDoctorContext(profileName);
    const normalizedMcp = effectiveState.normalizedMcp;
    const normalizedCommands = effectiveState.normalizedCommands;
    const normalizedHooks = effectiveState.normalizedHooks;
    const { references, skillImports } = collectProfileSourcePlanning(effectiveState, upstreams.byId);

    await validateProfileLockPins(lockState, upstreams.byId, report);
    const resolvedReferences = await resolveProfileReferences({
      references,
      upstreamById: upstreams.byId,
      lockState
    });

    for (const importEntry of skillImports) {
      const upstream = upstreams.byId.get(importEntry.upstreamId);
      if (!upstream || upstream.provider !== "git") {
        continue;
      }
      const key = getLockKey(importEntry.upstreamId, importEntry.ref);
      const resolved = resolvedReferences.get(key);
      if (!resolved) {
        addDoctorError(report, `Missing resolved upstream reference for ${importEntry.upstreamId}@${importEntry.ref}.`);
        continue;
      }
      const objectType = await getCommitObjectType(
        resolved.repoPath,
        resolved.commit,
        importEntry.selectionPath
      );
      if (objectType !== "tree") {
        addDoctorError(
          report,
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
      normalizedCommands,
      normalizedHooks,
      report
    });
  } catch (error) {
    addDoctorError(report, error.message);
  }
}
