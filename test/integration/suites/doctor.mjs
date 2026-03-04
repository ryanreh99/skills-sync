import { runCli } from "../helpers.mjs";

/**
 * Tests for: doctor
 */
export async function run() {
  runCli(["doctor", "--profile", "personal"]);
  // doctor with no profile falls back to defaultProfile (set by earlier use call)
  runCli(["doctor"]);
}
