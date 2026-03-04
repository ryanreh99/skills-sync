import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests for: help
 */
export async function run() {
  // The `help` subcommand exits 0 and lists all known commands
  const result = runCli(["help"]);
  assert.equal(result.stdout.includes("build"), true, "help output should mention the build command.");
  assert.equal(result.stdout.includes("apply"), true, "help output should mention the apply command.");
  assert.equal(result.stdout.includes("init"), true, "help output should mention the init command.");
  assert.equal(result.stdout.includes("detect"), true, "help output should mention the detect command.");
  assert.equal(result.stdout.includes("list"), true, "help output should mention the list command.");
  assert.equal(result.stdout.includes("search"), true, "help output should mention the search command.");

  // --help exits 0 and should include command help text.
  const flagResult = runCli(["--help"]);
  assert.equal(flagResult.stdout.includes("build"), true, "--help stdout should mention the build command.");
}
