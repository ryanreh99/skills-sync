import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests for: search skills
 */
export async function run() {
  const seedSearchJson = runCli(["search", "skills", "--query", "skills", "--upstream", "anthropic", "--format", "json"]);
  const listedSkills = JSON.parse(seedSearchJson.stdout.trim());
  assert.equal(Array.isArray(listedSkills), true, "search skills should provide results[] for fuzzy search test setup.");
  assert.equal(listedSkills.length > 0, true, "Expected at least one discoverable skill for fuzzy search tests.");

  const samplePath = listedSkills[0].path;
  const fuzzyQuery = samplePath.replace(/\//g, " ");

  const fuzzyJsonResult = runCli([
    "search",
    "skills",
    "--query",
    fuzzyQuery,
    "--upstream",
    "anthropic",
    "--format",
    "json"
  ]);
  const fuzzyPayload = JSON.parse(fuzzyJsonResult.stdout.trim());
  assert.equal(Array.isArray(fuzzyPayload), true, "fuzzy search json output should be an array.");
  assert.equal(
    fuzzyPayload.length > 0,
    true,
    "Expected fuzzy search query to return one or more matches."
  );
  assert.equal(
    fuzzyPayload.some((item) => item.path === samplePath),
    true,
    "fuzzy search should match skill paths even when separators differ."
  );

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

  // --- text output is capped at top N results ---
  const broadJson = runCli(["search", "skills", "--query", "skills", "--upstream", "anthropic", "--format", "json"]);
  const broadPayload = JSON.parse(broadJson.stdout.trim());
  if (broadPayload.length > 20) {
    const broadText = runCli(["search", "skills", "--query", "skills", "--upstream", "anthropic"]);
    assert.equal(
      broadText.stdout.includes("Showing top 20 matches."),
      true,
      "text search output should report truncation when more than 20 matches are found."
    );
  }

  // --- query that matches nothing should still exit 0 ---
  runCli(["search", "skills", "--query", "xyzzy-no-match-ever-12345", "--upstream", "anthropic"]);

  // --- missing query fails ---
  runCli(["search", "skills", "--upstream", "anthropic"], 1);  // missing --query

  // --- unknown subcommand of search fails ---
  runCli(["search", "unknown-resource"], 2);
}
