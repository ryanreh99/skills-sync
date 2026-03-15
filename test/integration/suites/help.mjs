import assert from "node:assert/strict";
import { runCli, runCliWithInput } from "../helpers.mjs";

/**
 * Tests for: help
 */
export async function run() {
  // The `help` subcommand exits 0 and lists all known commands
  const result = runCli(["help"]);
  assert.equal(result.stdout.includes("sync"), true, "help output should mention the sync command.");
  assert.equal(result.stdout.includes("build"), false, "help output should not mention the hidden build command.");
  assert.equal(result.stdout.includes("apply"), false, "help output should not mention the hidden apply command.");
  assert.equal(result.stdout.includes("init"), true, "help output should mention the init command.");
  assert.equal(result.stdout.includes("detect"), true, "help output should mention the detect command.");
  assert.equal(result.stdout.includes("list"), true, "help output should mention the list command.");
  assert.equal(result.stdout.includes("search"), true, "help output should mention the search command.");
  assert.equal(result.stdout.includes("trust"), false, "help output should not mention the removed trust command.");
  assert.equal(result.stdout.includes("Typical workflow:"), true, "help output should include the sync workflow guidance.");

  // --help exits 0 and should include command help text.
  const flagResult = runCli(["--help"]);
  assert.equal(flagResult.stdout.includes("sync"), true, "--help stdout should mention the sync command.");

  // Running without arguments requires the full TTY shell.
  const shellResult = runCliWithInput([], {
    expectedStatus: 1,
    input: "exit\n"
  });
  assert.equal(
    shellResult.stderr.includes("Interactive shell requires a TTY terminal of at least 80x18."),
    true,
    "no-arg invocation should explain the TTY-only shell requirement."
  );
  assert.equal(
    shellResult.stderr.includes("Use normal CLI commands in non-interactive mode."),
    true,
    "no-arg invocation should point non-interactive usage back to normal commands."
  );
  assert.equal(shellResult.stdout.includes("build"), false, "shell help should not mention the hidden build command.");
  assert.equal(shellResult.stdout.includes("apply"), false, "shell help should not mention the hidden apply command.");
}
