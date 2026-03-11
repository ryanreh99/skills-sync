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
export async function run({ runtimePath, localOverridesPath }) {
  const inventoryText = runCli(["agents", "inventory"]);
  assert.equal(
    inventoryText.stdout.includes("vendor__"),
    false,
    "agents inventory text should hide generated vendor alias skill names."
  );
  assert.equal(
    inventoryText.stdout.includes("skills-sync__"),
    false,
    "agents inventory text should hide managed MCP name prefixes."
  );
  assert.equal(inventoryText.stdout.includes("Host"), true, "agents inventory text should render the host section.");
  assert.equal(inventoryText.stdout.includes("Parse Errors"), true, "agents inventory text should render labeled sections.");
  assert.equal(inventoryText.stdout.includes("\t"), false, "agents inventory text should not rely on tab separators.");

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
  assert.equal(typeof driftPayload.summary?.byClass, "object", "agents drift should include aggregate class counts.");
  for (const agent of driftPayload.agents) {
    assert.deepEqual(
      agent.drift?.skills?.missing ?? [],
      [],
      `agents drift should not report missing projected skills after sync for ${agent.tool}.`
    );
    assert.deepEqual(
      agent.drift?.mcpServers?.missing ?? [],
      [],
      `agents drift should treat managed MCP names as expected for ${agent.tool}.`
    );
    assert.deepEqual(
      agent.drift?.mcpServers?.changed ?? [],
      [],
      `agents drift should not report changed managed MCP definitions immediately after sync for ${agent.tool}.`
    );
    assert.equal(Array.isArray(agent.classes), true, `agents drift should include structured classes for ${agent.tool}.`);
    assert.equal(typeof agent.summary?.byClass, "object", `agents drift should include class summary for ${agent.tool}.`);
  }
  assert.equal(
    driftPayload.agents.some((agent) => agent.classes.some((issue) => issue.code === "trust-policy-violation")),
    false,
    "agents drift should not classify removed trust-policy violations."
  );
  const driftText = runCli(["agents", "drift", "--profile", "personal", "--dry-run"]).stdout;
  assert.equal(driftText.includes("Agent Drift"), true, "agents drift text should render a summary heading.");
  assert.equal(driftText.includes("STATUS"), true, "agents drift text should render table headers.");
  assert.equal(driftText.includes("\t"), false, "agents drift text should not rely on tab separators.");

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

  const localSourceRoot = path.join(localOverridesPath, "fixtures", "agent-drift-source");
  const localSkillRoot = path.join(localSourceRoot, "agent-drift-skill");
  const lockPath = path.join(localOverridesPath, "skills-sync.lock.json");
  await fs.mkdir(path.join(localSkillRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(localSkillRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(localSkillRoot, "helpers"), { recursive: true });
  await fs.writeFile(
    path.join(localSkillRoot, "SKILL.md"),
    [
      "---",
      "title: agent-drift-skill",
      "summary: Drift classification fixture",
      "---",
      "",
      "# agent-drift-skill",
      "",
      "Drift classification fixture."
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(localSkillRoot, "scripts", "run.txt"), "echo drift\n", "utf8");
  await fs.writeFile(path.join(localSkillRoot, "assets", "note.txt"), "drift\n", "utf8");
  await fs.writeFile(path.join(localSkillRoot, "helpers", "note.txt"), "helper drift\n", "utf8");

  runCli([
    "profile",
    "add-skill",
    "personal",
    "--source",
    localSourceRoot,
    "--provider",
    "local-path",
    "--upstream-id",
    "agent-drift-fixtures",
    "--all"
  ]);

  const lockDoc = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const fixtureImport = lockDoc.imports.find((item) => item.upstream === "agent-drift-fixtures");
  assert.equal(Boolean(fixtureImport), true, "agent drift fixture should create a lockfile import row.");
  fixtureImport.projection = fixtureImport.projection ?? {};
  fixtureImport.projection.adapters = fixtureImport.projection.adapters ?? {};
  fixtureImport.projection.adapters.cursor = fixtureImport.projection.adapters.cursor ?? {};
  fixtureImport.projection.adapters.cursor.contractVersion = 999;
  await fs.writeFile(lockPath, `${JSON.stringify(lockDoc, null, 2)}\n`, "utf8");

  const classifiedDriftJson = runCli([
    "agents",
    "drift",
    "--profile",
    "personal",
    "--dry-run",
    "--format",
    "json",
    "--agents",
    "cursor"
  ]);
  const classifiedDriftPayload = JSON.parse(classifiedDriftJson.stdout.trim());
  const classifiedCodes = classifiedDriftPayload.agents[0].classes.map((issue) => issue.code);
  assert.equal(
    classifiedCodes.includes("projection-mismatch"),
    true,
    "agents drift should still classify projection-mismatch diagnostics."
  );
  assert.equal(
    classifiedCodes.includes("compatibility-degraded"),
    true,
    "agents drift should still classify compatibility-degraded diagnostics."
  );
  assert.equal(
    classifiedCodes.includes("trust-policy-violation"),
    false,
    "agents drift should not emit removed trust-policy diagnostics in classified output."
  );

  runCli([
    "profile",
    "remove-skill",
    "personal",
    "--upstream",
    "agent-drift-fixtures",
    "--all",
    "--prune-upstream",
    "--yes"
  ]);

  const cursorSkillPath = path.join(runtimePath, ".cursor", "skills", "anthropic", "frontend-design", "SKILL.md");
  const cursorMcpPath = path.join(runtimePath, ".cursor", "mcp.json");
  const originalCursorSkill = await fs.readFile(cursorSkillPath, "utf8");
  const originalCursorMcp = await fs.readFile(cursorMcpPath, "utf8");
  try {
    await fs.writeFile(cursorSkillPath, `${originalCursorSkill}\nDrifted content.\n`, "utf8");
    const cursorMcpDoc = JSON.parse(originalCursorMcp);
    cursorMcpDoc.mcpServers.unit_test_env_server.command = "python";
    await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcpDoc, null, 2), "utf8");

    const changedDriftJson = runCli([
      "agents",
      "drift",
      "--profile",
      "personal",
      "--dry-run",
      "--format",
      "json",
      "--agents",
      "cursor"
    ]);
    const changedDriftPayload = JSON.parse(changedDriftJson.stdout.trim());
    const changedCodes = changedDriftPayload.agents[0].classes.map((issue) => issue.code);
    assert.equal(
      changedCodes.includes("content-mismatch"),
      true,
      "agents drift should classify changed skill content."
    );
    assert.equal(
      changedCodes.includes("changed-managed-mcp"),
      true,
      "agents drift should classify changed managed MCP definitions."
    );
  } finally {
    await fs.writeFile(cursorSkillPath, originalCursorSkill, "utf8");
    await fs.writeFile(cursorMcpPath, originalCursorMcp, "utf8");
  }

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
