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

  // --- list mcps JSON format ---
  const mcpsJsonResult = runCli(["list", "mcps", "--profile", "personal", "--format", "json"]);
  const listedMcps = JSON.parse(mcpsJsonResult.stdout.trim());
  assert.equal(Array.isArray(listedMcps.mcps), true, "list mcps --format json should return an mcps array.");
  assert.equal(typeof listedMcps.profile, "string", "list mcps json should include resolved profile.");
  for (const mcp of listedMcps.mcps) {
    assert.equal(typeof mcp.name, "string", "Each MCP entry should include a string name.");
  }

  // --- list mcps text format (default) ---
  const mcpsTextResult = runCli(["list", "mcps", "--profile", "personal"]);
  assert.equal(mcpsTextResult.stdout.trim().length > 0, true, "list mcps text output should be non-empty.");

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
  assert.equal(Array.isArray(agentsPayload), true, "list agents json should return an array.");
  for (const agent of agentsPayload) {
    assert.equal(typeof agent, "string", "list agents should return agent names.");
  }

  // --- unknown subcommand of list fails ---
  runCli(["list", "unknown-resource"], 2);
}
