import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists } from "../helpers.mjs";
import { assertManagedJsonRemoved } from "../fixtures.mjs";

/**
 * Tests for: unlink
 * Depends on: apply having already run.
 */
export async function run({ distPath, runtimePath }) {
  const codexVendorImportsPath = path.join(runtimePath, ".codex", "skills", "vendor_imports");

  // Collect skill entries that apply placed
  const codexSkillEntries = (
    await fs.readdir(path.join(distPath, ".codex", "skills"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  runCli(["unlink", "--dry-run"]);
  const codexAfterDryRun = await fs.readFile(path.join(runtimePath, ".codex", "config.toml"), "utf8");
  assert.equal(
    codexAfterDryRun.includes("skills-sync managed mcp start"),
    true,
    "unlink --dry-run should not remove managed config blocks."
  );

  runCli(["unlink"]);

  // --- Codex skill bindings removed, unmanaged files preserved ---
  for (const entryName of codexSkillEntries) {
    assert.equal(
      await pathExists(path.join(codexVendorImportsPath, entryName)),
      false,
      `unlink should remove codex managed skill binding: ${entryName}`
    );
  }
  const codexUnmanagedMarkerPath = path.join(codexVendorImportsPath, "README.local.txt");
  const codexUnmanagedDirPath = path.join(codexVendorImportsPath, "manual-skills");
  assert.equal(await pathExists(codexUnmanagedMarkerPath), true, "unlink should preserve codex unmanaged files.");
  assert.equal(await pathExists(codexUnmanagedDirPath), true, "unlink should preserve codex unmanaged directories.");

  // --- Skills symlinks removed ---
  assert.equal(
    await pathExists(path.join(runtimePath, ".claude", "skills")),
    false,
    "unlink should remove claude skills binding."
  );
  assert.equal(
    await pathExists(path.join(runtimePath, ".cursor", "skills")),
    false,
    "unlink should remove cursor skills binding."
  );
  assert.equal(
    await pathExists(path.join(runtimePath, ".copilot", "skills")),
    false,
    "unlink should remove copilot skills binding."
  );
  assert.equal(
    await pathExists(path.join(runtimePath, ".gemini", "skills")),
    false,
    "unlink should remove gemini skills binding."
  );

  // --- Codex managed MCP block removed, unmanaged table preserved ---
  const codexAfterUnlink = await fs.readFile(path.join(runtimePath, ".codex", "config.toml"), "utf8");
  assert.equal(
    codexAfterUnlink.includes("skills-sync managed mcp start"),
    false,
    "unlink should remove codex managed block."
  );
  assert.equal(
    codexAfterUnlink.includes('[mcp_servers."keep_me"]'),
    true,
    "unlink should preserve unmanaged codex table."
  );

  // --- Claude, Cursor, Copilot, Gemini: managed keys removed, unmanaged key survives ---
  assertManagedJsonRemoved(await fs.readFile(path.join(runtimePath, ".claude.json"), "utf8"), "claude");
  assertManagedJsonRemoved(await fs.readFile(path.join(runtimePath, ".cursor", "mcp.json"), "utf8"), "cursor");
  assertManagedJsonRemoved(await fs.readFile(path.join(runtimePath, ".copilot", "mcp-config.json"), "utf8"), "copilot");
  assertManagedJsonRemoved(
    await fs.readFile(path.join(runtimePath, ".gemini", "settings.json"), "utf8"),
    "gemini"
  );

  // --- Running unlink again is a no-op (idempotent) ---
  runCli(["unlink"]);
}
