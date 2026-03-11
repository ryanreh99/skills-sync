import { runCli } from "../helpers.mjs";

/**
 * Tests for: doctor
 */
export async function run() {
  const explicitDoctor = runCli(["doctor", "--profile", "personal"]);
  if (explicitDoctor.stderr.includes("[trust-policy-violation]")) {
    throw new Error("doctor should not surface removed trust-policy diagnostics.");
  }
  // doctor with no profile falls back to defaultProfile (set by earlier use call)
  const implicitDoctor = runCli(["doctor"]);
  if (implicitDoctor.stderr.includes("[trust-policy-violation]")) {
    throw new Error("doctor should not surface removed trust-policy diagnostics when using the default profile.");
  }
}
