export function createDoctorReport() {
  return {
    errors: [],
    warnings: [],
    remediation: ["1. Run init", "2. Run use <name>", "3. Run sync", "4. Re-run doctor"]
  };
}

export function addDoctorError(report, message) {
  report.errors.push(String(message));
}

export function addDoctorWarning(report, message) {
  report.warnings.push(String(message));
}

export function hasDoctorErrors(report) {
  return report.errors.length > 0;
}
