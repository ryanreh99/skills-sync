import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists, countDiscoverableSkills } from "../helpers.mjs";
import { assertManagedJsonMerged } from "../fixtures.mjs";

/**
 * Tests for: apply (and apply --build)
 * Depends on: build having already run with targets override + seeded user configs.
 */
export async function run({ distPath, runtimePath }) {
  const codexVendorImportsPath = path.join(runtimePath, ".codex", "skills", "vendor_imports");

  // Collect expected skill entries built by the previous build step
  const codexSkillEntries = (
    await fs.readdir(path.join(distPath, ".codex", "skills"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  assert.equal(codexSkillEntries.length > 0, true, "Expected codex skill directories in dist.");

  // --- Pre-apply dist assertions: verify build output correctness ---

  // Codex (hasNonMcpConfig:true): build merges pre-existing non-MCP user settings into dist
  const distCodexToml = await fs.readFile(path.join(distPath, ".codex", "config.toml"), "utf8");
  assert.equal(
    distCodexToml.includes('model = "gpt-5-codex"'),
    true,
    "Dist Codex config should preserve local non-MCP settings."
  );
  assert.equal(
    distCodexToml.includes('[mcp_servers."filesystem"]'),
    true,
    "Dist Codex config should include canonical MCP server."
  );
  assert.equal(
    distCodexToml.includes('[mcp_servers."keep_me"]'),
    false,
    "Dist Codex config should replace (not merge) local MCP tables."
  );

  // Claude (hasNonMcpConfig:false): build produces a clean config — no user settings bleed through
  const distClaudeDoc = JSON.parse(await fs.readFile(path.join(distPath, ".claude", "mcp.json"), "utf8"));
  assert.equal(
    distClaudeDoc.settings?.verbose,
    undefined,
    "Dist Claude config should be fully overrideable (no verbose setting)."
  );
  assert.equal(
    "keep_me" in (distClaudeDoc.mcpServers ?? {}),
    false,
    "Dist Claude config should replace local MCP servers."
  );

  // Cursor (hasNonMcpConfig:false): clean config, no user keys
  const distCursorDoc = JSON.parse(await fs.readFile(path.join(distPath, ".cursor", "mcp.json"), "utf8"));
  assert.equal(
    "keep_me" in (distCursorDoc.mcpServers ?? {}),
    false,
    "Dist Cursor config should replace local MCP servers."
  );

  // Copilot (hasNonMcpConfig:false): clean config, no user keys
  const distCopilotDoc = JSON.parse(await fs.readFile(path.join(distPath, ".copilot", "mcp-config.json"), "utf8"));
  assert.equal(
    "keep_me" in (distCopilotDoc.mcpServers ?? {}),
    false,
    "Dist Copilot config should replace local MCP servers."
  );
  assert.equal(
    distCopilotDoc.editor,
    undefined,
    "Dist Copilot config should be fully overrideable (no editor settings)."
  );
  assert.equal(
    distCopilotDoc.mcpServers?.filesystem?.type,
    "stdio",
    "Dist Copilot stdio servers should use Copilot's 'type' field."
  );
  assert.deepEqual(
    distCopilotDoc.mcpServers?.filesystem?.tools,
    ["*"],
    "Dist Copilot managed MCP entries should include a permissive tools allowlist."
  );
  assert.equal(
    "transport" in (distCopilotDoc.mcpServers?.filesystem ?? {}),
    false,
    "Dist Copilot stdio servers should not include the legacy transport field."
  );

  // Gemini (hasNonMcpConfig:true): build merges pre-existing non-MCP user settings
  const distGeminiDoc = JSON.parse(await fs.readFile(path.join(distPath, ".gemini", "settings.json"), "utf8"));
  assert.equal(distGeminiDoc.ui?.theme, "dark", "Dist Gemini config should preserve local non-MCP settings.");
  assert.equal(
    "keep_me" in (distGeminiDoc.mcpServers ?? {}),
    false,
    "Dist Gemini config should replace local MCP servers."
  );

  runCli(["apply", "--dry-run"]);
  const codexAfterDryRun = await fs.readFile(path.join(runtimePath, ".codex", "config.toml"), "utf8");
  assert.equal(
    codexAfterDryRun.includes("skills-sync managed mcp start"),
    false,
    "apply --dry-run should not mutate target configs."
  );

  runCli(["apply"]);

  // --- Codex: managed MCP block injected, unmanaged table preserved, $HOME resolved ---
  const codexToml = await fs.readFile(path.join(runtimePath, ".codex", "config.toml"), "utf8");
  assert.equal(codexToml.includes('[mcp_servers."keep_me"]'), true, "Codex should preserve unmanaged table.");
  assert.equal(codexToml.includes("skills-sync managed mcp start"), true, "Codex should inject managed block.");
  assert.equal(codexToml.includes("$HOME"), false, "Codex managed MCP args should resolve $HOME to a runtime path.");
  assert.equal(
    codexToml.includes('[mcp_servers."unit_test_env_server"]'),
    true,
    "Codex should include managed env-bearing server."
  );
  assert.equal(
    codexToml.includes('"MCP_TEST_HOME" = "$HOME"'),
    false,
    "Codex managed MCP env should resolve $HOME to a runtime path."
  );

  // --- Claude, Cursor, Gemini: managed keys merged, unmanaged keys kept ---
  const claudeRuntimeDoc = JSON.parse(await fs.readFile(path.join(runtimePath, ".claude.json"), "utf8"));
  const cursorRuntimeDoc = JSON.parse(await fs.readFile(path.join(runtimePath, ".cursor", "mcp.json"), "utf8"));
  const copilotRuntimeDoc = JSON.parse(await fs.readFile(path.join(runtimePath, ".copilot", "mcp-config.json"), "utf8"));
  assertManagedJsonMerged(JSON.stringify(claudeRuntimeDoc), "claude");
  assertManagedJsonMerged(JSON.stringify(cursorRuntimeDoc), "cursor");
  assertManagedJsonMerged(JSON.stringify(copilotRuntimeDoc), "copilot");
  assert.equal(
    copilotRuntimeDoc.mcpServers?.filesystem?.type,
    "stdio",
    "Copilot managed stdio servers should use the 'type' field."
  );
  assert.deepEqual(
    copilotRuntimeDoc.mcpServers?.filesystem?.tools,
    ["*"],
    "Copilot managed stdio servers should include a permissive tools allowlist."
  );
  assert.equal(
    "transport" in (copilotRuntimeDoc.mcpServers?.filesystem ?? {}),
    false,
    "Copilot managed stdio servers should not include the legacy transport field."
  );

  const geminiRuntimeDoc = JSON.parse(
    await fs.readFile(path.join(runtimePath, ".gemini", "settings.json"), "utf8")
  );
  assertManagedJsonMerged(JSON.stringify(geminiRuntimeDoc), "gemini");

  for (const [label, doc] of [
    ["claude", claudeRuntimeDoc],
    ["cursor", cursorRuntimeDoc],
    ["copilot", copilotRuntimeDoc],
    ["gemini", geminiRuntimeDoc]
  ]) {
    const envValue = doc.mcpServers?.unit_test_env_server?.env?.MCP_TEST_HOME;
    assert.equal(typeof envValue, "string", `${label}: env-bearing managed server should include MCP_TEST_HOME.`);
    assert.equal(envValue === "$HOME", false, `${label}: MCP_TEST_HOME should be expanded at apply time.`);
  }

  // Gemini managed entries must not include a transport field
  for (const [name, server] of Object.entries(geminiRuntimeDoc.mcpServers ?? {})) {
    if (name !== "keep_me") {
      assert.equal(
        "transport" in server,
        false,
        "Gemini managed MCP entries should not include transport."
      );
    }
  }

  // --- Codex vendor_imports: managed skill dirs copied, unmanaged files preserved ---
  const codexUnmanagedMarkerPath = path.join(codexVendorImportsPath, "README.local.txt");
  const codexUnmanagedDirPath = path.join(codexVendorImportsPath, "manual-skills");
  assert.equal(await pathExists(codexUnmanagedMarkerPath), true, "Codex unmanaged marker should remain after apply.");
  assert.equal(await pathExists(codexUnmanagedDirPath), true, "Codex unmanaged directory should remain after apply.");

  for (const entryName of codexSkillEntries) {
    assert.equal(
      await pathExists(path.join(codexVendorImportsPath, entryName)),
      true,
      `Expected codex managed skill binding: ${entryName}`
    );
  }

  // --- Claude, Cursor, Copilot, and Gemini: skills directories linked ---
  for (const skillsPath of [
    path.join(runtimePath, ".claude", "skills"),
    path.join(runtimePath, ".cursor", "skills"),
    path.join(runtimePath, ".copilot", "skills"),
    path.join(runtimePath, ".gemini", "skills")
  ]) {
    assert.equal(await pathExists(skillsPath), true, `Expected linked skills path: ${skillsPath}`);
  }

  assert.equal(
    (await countDiscoverableSkills(path.join(runtimePath, ".claude", "skills"))) > 0,
    true,
    "Claude skills projection should provide at least one top-level discoverable skill."
  );

  assert.equal(
    (await countDiscoverableSkills(path.join(runtimePath, ".cursor", "skills"))) > 0,
    true,
    "Cursor skills projection should provide at least one top-level discoverable skill."
  );

  assert.equal(
    (await countDiscoverableSkills(path.join(runtimePath, ".gemini", "skills"))) > 0,
    true,
    "Gemini skills projection should provide at least one top-level discoverable skill."
  );

  // --- apply --build: re-builds then applies without error ---
  runCli(["apply", "--build", "--profile", "personal"]);
}
