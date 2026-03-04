import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests for: detect
 */
export async function run() {
  const result = runCli(["detect"]);
  // detect should produce some output describing found/not-found agents
  assert.equal(typeof result.stdout, "string", "detect should write to stdout.");
  assert.equal(result.stdout.includes("codex"), true, "detect should include codex section.");
  assert.equal(result.stdout.includes("copilot"), true, "detect should include copilot section.");

  const jsonResult = runCli(["detect", "--format", "json"]);
  const payload = JSON.parse(jsonResult.stdout.trim());
  assert.equal(typeof payload.os, "string", "detect --format json should include os.");
  assert.equal(Array.isArray(payload.tools), true, "detect --format json should include tools array.");
  assert.equal(payload.tools.some((tool) => tool.tool === "copilot"), true, "detect json should include copilot.");

  const filtered = runCli(["detect", "--format", "json", "--agents", "codex,claude"]);
  const filteredPayload = JSON.parse(filtered.stdout.trim());
  assert.equal(filteredPayload.tools.length, 2, "detect --agents should filter tool rows.");
  assert.equal(filteredPayload.tools[0].tool, "codex", "detect --agents should preserve canonical ordering.");
  assert.equal(filteredPayload.tools[1].tool, "claude", "detect --agents should include requested agents.");
}
