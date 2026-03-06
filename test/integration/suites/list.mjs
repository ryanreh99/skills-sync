import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests for: list skills
 */
export async function run() {
  // --- list local skills JSON format ---
  const jsonResult = runCli(["list", "skills", "--profile", "personal", "--format", "json"]);
  const listed = JSON.parse(jsonResult.stdout.trim());
  assert.equal(Array.isArray(listed.skills), true, "list skills --format json should return a skills array.");
  assert.equal(typeof listed.profile, "string", "list skills json should include resolved profile.");

  // Each skill entry should have a local name.
  for (const skill of listed.skills) {
    assert.equal(typeof skill.name, "string", "Each local skill should have a string name.");
  }

  // --- list skills text format (default) ---
  const textResult = runCli(["list", "skills", "--profile", "personal"]);
  assert.equal(textResult.stdout.trim().length > 0, true, "list skills text output should be non-empty.");

  // --- slash root alias should work ---
  const slashProfiles = runCli(["/list", "profiles"]);
  assert.equal(
    slashProfiles.stdout.includes("personal"),
    true,
    "slash-style root command should resolve to list."
  );

  // --- windows-path-like root (from MSYS path conversion) should work ---
  const msysConvertedProfiles = runCli(["C:\\list", "profiles"]);
  assert.equal(
    msysConvertedProfiles.stdout.includes("personal"),
    true,
    "MSYS-converted slash root should resolve via basename."
  );

  // --- list upstreams ---
  const listUpstreamsText = runCli(["list", "upstreams"]);
  assert.equal(listUpstreamsText.stdout.includes("anthropic"), true, "list upstreams should include anthropic.");
  const listUpstreamsJson = runCli(["list", "upstreams", "--format", "json"]);
  const upstreamsPayload = JSON.parse(listUpstreamsJson.stdout.trim());
  assert.equal(Array.isArray(upstreamsPayload.upstreams), true, "list upstreams json should return upstreams array.");
  assert.equal(upstreamsPayload.upstreams.length > 0, true, "Expected at least one configured upstream.");

  // --- list agents ---
  const listAgentsJson = runCli(["list", "agents", "--format", "json"]);
  const agentsPayload = JSON.parse(listAgentsJson.stdout.trim());
  assert.equal(Array.isArray(agentsPayload.agents), true, "list agents json should return agents array.");
  for (const agent of agentsPayload.agents) {
    assert.equal(typeof agent.tool, "string", "list agents should include tool name.");
  }

  // --- unknown subcommand of list fails ---
  runCli(["list", "unknown-resource"], 2);
}
