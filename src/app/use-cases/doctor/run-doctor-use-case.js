import { loadActiveStateDocument } from "../../../infra/repositories/runtime-repository.js";
import { loadDoctorDependencies } from "../../../infra/repositories/workspace-repository.js";
import { createDoctorReport, addDoctorError } from "../../../domain/doctor/report.js";
import { runBundleMcpCheck } from "./checks/bundle-mcp-check.js";
import { runProfileRuntimeCheck } from "./checks/profile-runtime-check.js";
import { runRequiredFilesCheck } from "./checks/required-files-check.js";
import { runStateBindingsCheck } from "./checks/state-bindings-check.js";

export async function runDoctorUseCase({ profileOverride } = {}) {
  const report = createDoctorReport();

  await runRequiredFilesCheck(report);

  let upstreams = null;
  let lockState = null;
  try {
    const loaded = await loadDoctorDependencies();
    upstreams = loaded.upstreams;
    lockState = loaded.lockState;
  } catch (error) {
    addDoctorError(report, error.message);
  }

  const activeState = await loadActiveStateDocument();
  if (activeState.exists && !activeState.state) {
    addDoctorError(report, `Failed to parse state file: ${activeState.path}`);
  }
  await runStateBindingsCheck(report, activeState.state);

  const profileName = profileOverride || activeState.state?.profile || null;
  await runProfileRuntimeCheck({
    report,
    profileName,
    upstreams,
    lockState
  });

  await runBundleMcpCheck(report);
  return report;
}
