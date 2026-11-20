import { logInfo, logWarn } from "../../infra/internal/core.js";
import { renderSection, renderSimpleList } from "../../infra/internal/terminal-ui.js";
import { hasDoctorErrors } from "../../domain/doctor/report.js";
import { redactPathDetails } from "../../shared/text.js";

export function presentDoctorReport(report, { stream = process.stdout } = {}) {
  for (const warning of report.warnings) {
    logWarn(redactPathDetails(warning));
  }

  if (hasDoctorErrors(report)) {
    stream.write(`${renderSection("Doctor Issues", { count: report.errors.length, stream })}\n`);
    stream.write(
      `${renderSimpleList(report.errors.map((error) => `- ${redactPathDetails(error)}`), { indent: "" })}\n\n`
    );
    stream.write(`${renderSection("Remediation", { stream })}\n`);
    stream.write(`${renderSimpleList(report.remediation)}\n`);
    process.exitCode = 1;
    return;
  }

  logInfo("Doctor checks passed.");
}
