import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "../helpers.mjs";

/**
 * Tests for:
 * - agents inventory
 * - agents drift
 * - --agents filtering
 * - parse failure reporting in agent config files
 */
export async function run({ runtimePath }) {
  const inventoryJson = runCli(["agents", "inventory", "--format", "json"]);
  const inventoryPayload = JSON.parse(inventoryJson.stdout.trim());
  assert.equal(Array.isArray(inventoryPayload.agents), true, "agents inventory json should include agents[].");
  assert.equal(
    inventoryPayload.agents.some((agent) => agent.tool === "codex"),
    true,
    "agents inventory should include codex."
  );

  const filteredInventoryJson = runCli([
    "agents",
    "inventory",
    "--format",
    "json",
    "--agents",
    "codex,claude"
  ]);
  const filteredInventory = JSON.parse(filteredInventoryJson.stdout.trim());
  assert.deepEqual(
    filteredInventory.agents.map((agent) => agent.tool),
    ["codex", "claude"],
    "agents inventory --agents should filter output."
  );

  const driftJson = runCli(["agents", "drift", "--profile", "personal", "--dry-run", "--format", "json"]);
  const driftPayload = JSON.parse(driftJson.stdout.trim());
  assert.equal(driftPayload.profile, "personal", "agents drift should report selected profile.");
  assert.equal(Array.isArray(driftPayload.expected.skills), true, "agents drift should include expected skills.");
  assert.equal(Array.isArray(driftPayload.expected.mcpServers), true, "agents drift should include expected mcpServers.");
  assert.equal(Array.isArray(driftPayload.agents), true, "agents drift should include per-agent rows.");
  for (const agent of driftPayload.agents) {
    assert.deepEqual(
      agent.drift?.mcpServers?.missing ?? [],
      [],
      `agents drift should treat managed MCP names as expected for ${agent.tool}.`
    );
  }

  const filteredDriftJson = runCli([
    "agents",
    "drift",
    "--profile",
    "personal",
    "--dry-run",
    "--format",
    "json",
    "--agents",
    "codex"
  ]);
  const filteredDrift = JSON.parse(filteredDriftJson.stdout.trim());
  assert.deepEqual(
    filteredDrift.agents.map((agent) => agent.tool),
    ["codex"],
    "agents drift --agents should filter output."
  );

  const reconcileDriftJson = runCli(["agents", "drift", "--profile", "personal", "--format", "json"]);
  const reconcileDriftPayload = JSON.parse(reconcileDriftJson.stdout.trim());
  assert.equal(reconcileDriftPayload.profile, "personal", "agents drift reconcile should report selected profile.");
  assert.equal(Array.isArray(reconcileDriftPayload.agents), true, "agents drift reconcile should include per-agent rows.");
  assert.equal(
    reconcileDriftPayload.expected?.mcpServers?.includes("keep_me"),
    true,
    "agents drift reconcile should promote detected extra MCP servers into profile expectations."
  );

  const claudePath = path.join(runtimePath, ".claude.json");
  const originalClaude = await fs.readFile(claudePath, "utf8");
  try {
    await fs.writeFile(claudePath, "{ not valid json", "utf8");
    const parseIssueJson = runCli([
      "agents",
      "inventory",
      "--format",
      "json",
      "--agents",
      "claude"
    ]);
    const parseIssuePayload = JSON.parse(parseIssueJson.stdout.trim());
    assert.equal(parseIssuePayload.agents.length, 1, "filtered parse error inventory should include one agent.");
    assert.equal(
      parseIssuePayload.agents[0].parseErrors.length > 0,
      true,
      "agents inventory should report parse errors for invalid config."
    );
  } finally {
    await fs.writeFile(claudePath, originalClaude, "utf8");
  }
}
