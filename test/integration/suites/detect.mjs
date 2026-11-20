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
  assert.equal(
    payload.tools.some((tool) => tool.tool === "codex"),
    true,
    "detect json should include codex."
  );
  assert.equal(
    payload.tools.some((tool) => tool.tool === "claude"),
    true,
    "detect json should include claude."
  );
}
