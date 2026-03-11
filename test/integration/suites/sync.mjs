import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, runCli } from "../helpers.mjs";

/**
 * Tests for:
 * - sync
 * - sync --dry-run
 * - mutation auto-sync / --no-sync
 */
export async function run({ localOverridesPath, runtimePath }) {
  const statePath = path.join(localOverridesPath, "state", "active-profile.json");
  const cursorMcpPath = path.join(runtimePath, ".cursor", "mcp.json");
  const localSourceRoot = path.join(localOverridesPath, "fixtures", "sync-source");
  const localSkillPath = path.join(localSourceRoot, "auto-sync-skill");
  const runtimeSkillPath = path.join(runtimePath, ".cursor", "skills", "sync-fixtures", "auto-sync-skill", "SKILL.md");

  await fs.rm(statePath, { force: true });

  const syncDryRun = runCli(["sync", "--profile", "personal", "--dry-run"]);
  assert.equal(
    syncDryRun.stdout.includes("Dry-run sync preview for profile 'personal' complete."),
    true,
    "sync --dry-run should print the sync preview summary."
  );
  assert.equal(await pathExists(statePath), false, "sync --dry-run should not write active binding state.");

  const syncResult = runCli(["sync", "--profile", "personal"]);
  assert.equal(await pathExists(statePath), true, "sync should write active binding state.");
  const stateAfterSync = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(stateAfterSync.profile, "personal", "sync should apply the requested profile.");
  assert.equal(
    syncResult.stdout.includes("Sync gates"),
    false,
    "sync should not surface removed sync-gate output."
  );
  assert.equal(
    syncResult.stdout.includes("trust approve"),
    false,
    "sync should not suggest removed trust commands."
  );
  assert.equal(
    syncResult.stdout.includes("workspace/source-policy.json"),
    false,
    "sync should not reference the removed workspace/source-policy.json file."
  );
  assert.equal(
    syncResult.stdout.includes("trust-policy-violation"),
    false,
    "sync should not print removed trust-policy diagnostics."
  );

  runCli([
    "profile",
    "add-mcp",
    "personal",
    "sync_no_sync_server",
    "--command",
    "node",
    "--args",
    "noop",
    "--no-sync"
  ]);
  let cursorMcpDoc = JSON.parse(await fs.readFile(cursorMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(cursorMcpDoc.mcpServers ?? {}, "sync_no_sync_server"),
    false,
    "--no-sync should prevent runtime MCP changes."
  );

  runCli([
    "profile",
    "add-mcp",
    "personal",
    "sync_auto_server",
    "--command",
    "node",
    "--args",
    "noop"
  ]);
  cursorMcpDoc = JSON.parse(await fs.readFile(cursorMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(cursorMcpDoc.mcpServers ?? {}, "sync_auto_server"),
    true,
    "profile add-mcp should auto-sync by default."
  );

  runCli(["profile", "remove-mcp", "personal", "sync_auto_server"]);
  cursorMcpDoc = JSON.parse(await fs.readFile(cursorMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(cursorMcpDoc.mcpServers ?? {}, "sync_auto_server"),
    false,
    "profile remove-mcp should auto-sync by default."
  );

  await fs.mkdir(localSkillPath, { recursive: true });
  await fs.writeFile(
    path.join(localSkillPath, "SKILL.md"),
    [
      "---",
      "title: auto-sync-skill",
      "summary: Version one",
      "---",
      "",
      "# auto-sync-skill",
      "",
      "Version one."
    ].join("\n"),
    "utf8"
  );

  runCli([
    "profile",
    "add-skill",
    "personal",
    "--source",
    localSourceRoot,
    "--provider",
    "local-path",
    "--upstream-id",
    "sync-fixtures",
    "--all"
  ]);
  assert.equal(await pathExists(runtimeSkillPath), true, "profile add-skill should auto-sync by default.");

  await fs.writeFile(
    path.join(localSkillPath, "SKILL.md"),
    [
      "---",
      "title: auto-sync-skill",
      "summary: Version two",
      "---",
      "",
      "# auto-sync-skill",
      "",
      "Version two."
    ].join("\n"),
    "utf8"
  );

  runCli(["profile", "refresh", "personal", "--upstream", "sync-fixtures"]);
  const refreshedRuntimeSkill = await fs.readFile(runtimeSkillPath, "utf8");
  assert.equal(
    refreshedRuntimeSkill.includes("Version two."),
    true,
    "profile refresh should auto-sync updated imported skills by default."
  );

  runCli([
    "profile",
    "remove-skill",
    "personal",
    "--upstream",
    "sync-fixtures",
    "--all",
    "--prune-upstream",
    "--yes"
  ]);
  assert.equal(await pathExists(runtimeSkillPath), false, "profile remove-skill should auto-sync by default.");

  const exportPath = path.join(localOverridesPath, "exports", "sync-profile.json");
  runCli(["profile", "export", "personal", "--output", exportPath]);

  const importedProfileName = "sync-imported-profile";
  runCli(["profile", "import", importedProfileName, "--input", exportPath]);
  const stateAfterImport = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(
    stateAfterImport.profile,
    importedProfileName,
    "profile import should auto-sync the imported profile by default."
  );
}
