import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cliPath, repoRoot, testHomePath, runCli } from "../helpers.mjs";

/**
 * Tests for: search skills
 */
export async function run() {
  // --- JSON format (fast path mode, no title extraction) ---
  const jsonResult = runCli(["search", "skills", "--query", "git", "--upstream", "anthropic", "--format", "json"]);
  const searched = JSON.parse(jsonResult.stdout.trim());
  // search returns a plain array of matching skill objects
  assert.equal(Array.isArray(searched), true, "search skills --format json should return an array.");
  // results may or may not be empty depending on the upstream, but each item should have a path
  for (const item of searched) {
    assert.equal(typeof item.path, "string", "Each search result should have a string path.");
    assert.equal(
      Object.prototype.hasOwnProperty.call(item, "title"),
      false,
      "search results should omit title unless --verbose is passed."
    );
  }

  // --- verbose JSON format includes title metadata ---
  const verboseJsonResult = runCli([
    "search",
    "skills",
    "--query",
    "git",
    "--upstream",
    "anthropic",
    "--format",
    "json",
    "--verbose"
  ]);
  const searchedVerbose = JSON.parse(verboseJsonResult.stdout.trim());
  assert.equal(Array.isArray(searchedVerbose), true, "search skills --verbose --format json should return an array.");
  for (const item of searchedVerbose) {
    assert.equal(typeof item.title, "string", "Verbose search results should include titles.");
  }

  // --- text format (default) ---
  const textResult = runCli(["search", "skills", "--query", "git", "--upstream", "anthropic"]);
  assert.equal(typeof textResult.stdout, "string", "search skills text output should be a string.");

  // --- upstream optional when profile is provided ---
  const profileSearchResult = runCli(["search", "skills", "--query", "git", "--profile", "personal"]);
  assert.equal(typeof profileSearchResult.stdout, "string", "search skills should work without --upstream.");

  // --- query that matches nothing should still exit 0 ---
  runCli(["search", "skills", "--query", "xyzzy-no-match-ever-12345", "--upstream", "anthropic"]);

  // --- interactive mode ---
  const interactiveResult = spawnSync(
    process.execPath,
    [cliPath, "search", "skills", "--interactive", "--upstream", "anthropic"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: "git\n\n",
      env: {
        ...process.env,
        SKILLS_SYNC_HOME: testHomePath
      }
    }
  );
  assert.equal(interactiveResult.status, 0, "interactive search should exit 0 when input stream closes.");
  assert.equal(
    interactiveResult.stdout.includes("Interactive skill search"),
    true,
    "interactive search should print an interactive prompt header."
  );

  // --- missing query fails in non-interactive mode ---
  runCli(["search", "skills", "--upstream", "anthropic"], 1);  // missing --query

  // --- unknown subcommand of search fails ---
  runCli(["search", "unknown-resource"], 2);
}
