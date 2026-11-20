import fs from "fs-extra";
import {
  bindingMatches,
  existsOrLink,
  expandTargetPath,
  isInsidePath,
  pathsEqual
} from "../../../../infra/internal/core.js";
import { getAgentIntegrationsById } from "../../../../infra/internal/agent-integrations.js";
import { loadEffectiveTargets } from "../../../../infra/internal/config.js";
import { validateManagedHookBindingTargetForAgent } from "../../../../infra/internal/hook-config.js";
import { validateManagedMcpBindingTargetForAgent } from "../../../../infra/internal/mcp-config.js";
import {
  addDoctorError,
  addDoctorWarning
} from "../../../../domain/doctor/report.js";
import {
  getRuntimeBundlePath,
  runtimePathExists
} from "../../../../infra/repositories/runtime-repository.js";

function getExpectedTargetRaw(binding, targets) {
  const target = targets?.[binding.tool];
  if (!target) {
    return null;
  }
  if (binding.kind === "dir") {
    return target.skillsDir ?? null;
  }
  if (binding.kind === "command-dir") {
    return target.commandsDir ?? null;
  }
  if (binding.kind === "config") {
    return target.mcpConfig ?? null;
  }
  if (binding.kind === "hook-config") {
    return target.hooksConfig ?? null;
  }
  return null;
}

function getManagedServerNames(canonicalMcp) {
  return Object.keys(canonicalMcp?.mcpServers ?? {}).sort((left, right) => left.localeCompare(right));
}

export async function runStateBindingsCheck(report, state) {
  if (!state) {
    addDoctorWarning(report, "No active profile state found.");
    return;
  }

  for (const key of ["profile", "os", "bindings"]) {
    if (!(key in state)) {
      addDoctorError(report, `State file is missing '${key}'.`);
    }
  }
  if (state.os !== "windows" && state.os !== "macos" && state.os !== "linux") {
    addDoctorError(report, `State os must be 'windows', 'macos', or 'linux'; found '${state.os}'.`);
    return;
  }

  const targets = await loadEffectiveTargets(state.os).catch((error) => {
    addDoctorError(report, error.message);
    return null;
  });
  if (!targets) {
    return;
  }

  const integrationsById = await getAgentIntegrationsById().catch((error) => {
    addDoctorError(report, error.message);
    return null;
  });
  if (!integrationsById) {
    return;
  }

  const bundleMcpPath = getRuntimeBundlePath("common", "mcp.json");
  const canonicalMcp = (await runtimePathExists("common", "mcp.json")) ? await fs.readJson(bundleMcpPath) : null;
  const expectedManagedNames = getManagedServerNames(canonicalMcp);

  for (const binding of Array.isArray(state.bindings) ? state.bindings : []) {
    const expectedRaw = getExpectedTargetRaw(binding, targets);
    if (!expectedRaw) {
      addDoctorError(report, `Unknown state binding type: ${binding.tool}:${binding.kind}`);
      continue;
    }

    const expectedTargetPath = expandTargetPath(expectedRaw, state.os);
    const integration = integrationsById.get(binding.tool);
    const nestedDirBinding =
      binding.kind === "dir" &&
      integration?.internal?.skillsBindMode === "children" &&
      isInsidePath(expectedTargetPath, binding.targetPath);
    if (!pathsEqual(binding.targetPath, expectedTargetPath) && !nestedDirBinding) {
      addDoctorError(
        report,
        `Binding target mismatch for ${binding.tool}:${binding.kind}. Expected '${expectedTargetPath}', found '${binding.targetPath}'.`
      );
    }

    if (binding.kind === "config") {
      if (!(await fs.pathExists(binding.targetPath))) {
        addDoctorError(report, `Missing managed config target: ${binding.targetPath}`);
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
        addDoctorError(report, validationError);
      }
      continue;
    }

    if (binding.kind === "hook-config") {
      if (!(await fs.pathExists(binding.targetPath))) {
        addDoctorError(report, `Missing managed hooks target: ${binding.targetPath}`);
        continue;
      }

      const validationError = await validateManagedHookBindingTargetForAgent({
        targetPath: binding.targetPath,
        expectedManagedKeys: binding.managedKeys
      });
      if (validationError) {
        addDoctorError(report, validationError);
      }
      continue;
    }

    if (!(await fs.pathExists(binding.sourcePath))) {
      addDoctorError(report, `Missing binding source: ${binding.sourcePath}`);
      continue;
    }
    if (!isInsidePath(getRuntimeBundlePath(), binding.sourcePath)) {
      addDoctorError(report, `Binding source is outside runtime artifact root: ${binding.sourcePath}`);
    }
    if (!(await existsOrLink(binding.targetPath))) {
      addDoctorError(report, `Missing binding target: ${binding.targetPath}`);
      continue;
    }
    if (!(await bindingMatches(binding))) {
      addDoctorError(report, `Binding mismatch: ${binding.targetPath} no longer matches ${binding.sourcePath}.`);
    }
  }
}
