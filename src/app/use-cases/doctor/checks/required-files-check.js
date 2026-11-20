import fs from "fs-extra";
import { SCHEMAS } from "../../../../infra/internal/core.js";
import { addDoctorError } from "../../../../domain/doctor/report.js";

export async function runRequiredFilesCheck(report) {
  const requiredFiles = [
    SCHEMAS.profile,
    SCHEMAS.packManifest,
    SCHEMAS.mcpServers,
    SCHEMAS.commands,
    SCHEMAS.hooks,
    SCHEMAS.bundle,
    SCHEMAS.agentIntegration,
    SCHEMAS.upstreams,
    SCHEMAS.upstreamsLock,
    SCHEMAS.packSources
  ];

  for (const requiredFile of requiredFiles) {
    if (!(await fs.pathExists(requiredFile))) {
      addDoctorError(report, `Missing required file: ${requiredFile}`);
    }
  }
}
