import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests for: list skills
 */
export async function run() {
  // --- list skills JSON format (single upstream, fast path mode) ---
  const jsonResult = runCli(["list", "skills", "--upstream", "anthropic", "--format", "json"]);
  const listed = JSON.parse(jsonResult.stdout.trim());
  assert.equal(Array.isArray(listed.skills), true, "list skills --format json should return a skills array.");
  assert.equal(listed.skills.length > 0, true, "Expected at least one skill from the anthropic upstream.");

  // Each skill entry should have a path.
  for (const skill of listed.skills) {
    assert.equal(typeof skill.path, "string", "Each skill should have a string path.");
    assert.equal(
      Object.prototype.hasOwnProperty.call(skill, "title"),
      false,
      "list skills should omit title unless --verbose is passed."
    );
  }

  // --- verbose mode includes titles ---
  const verboseJsonResult = runCli([
    "list",
    "skills",
    "--upstream",
    "anthropic",
    "--format",
    "json",
    "--verbose"
  ]);
  const listedVerbose = JSON.parse(verboseJsonResult.stdout.trim());
  assert.equal(Array.isArray(listedVerbose.skills), true, "list skills --verbose should return a skills array.");
  assert.equal(listedVerbose.skills.length > 0, true, "Expected skills in verbose mode.");
  for (const skill of listedVerbose.skills) {
    assert.equal(typeof skill.title, "string", "Verbose listing should include skill titles.");
  }

  // --- list skills text format (default) ---
  const textResult = runCli(["list", "skills", "--upstream", "anthropic"]);
  assert.equal(textResult.stdout.trim().length > 0, true, "list skills text output should be non-empty.");

  // --- list skills with no upstream (profile-derived refs) ---
  const profileJsonResult = runCli(["list", "skills", "--profile", "personal", "--format", "json"]);
  const profileListed = JSON.parse(profileJsonResult.stdout.trim());
  assert.equal(
    Array.isArray(profileListed.results) || Array.isArray(profileListed.skills),
    true,
    "list skills without --upstream should still return JSON output."
  );

  // --- list upstreams ---
  const listUpstreamsText = runCli(["list", "upstreams"]);
  assert.equal(listUpstreamsText.stdout.includes("anthropic"), true, "list upstreams should include anthropic.");
  const listUpstreamsJson = runCli(["list", "upstreams", "--format", "json"]);
  const upstreamsPayload = JSON.parse(listUpstreamsJson.stdout.trim());
  assert.equal(Array.isArray(upstreamsPayload.upstreams), true, "list upstreams json should return upstreams array.");
  assert.equal(upstreamsPayload.upstreams.length > 0, true, "Expected at least one configured upstream.");

  // --- unknown subcommand of list fails ---
  runCli(["list", "unknown-resource"], 2);
}
