import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists, listBackupDirs } from "../helpers.mjs";

/**
 * Tests for: init, init --seed
 */
export async function run({ localOverridesPath, distPath }) {
  const configPath = path.join(localOverridesPath, "config.json");

  // --- init --dry-run (non-mutating preview) ---
  const dryRunResult = runCli(["init", "--dry-run"]);
  assert.equal(
    dryRunResult.stdout.includes("Dry-run init"),
    true,
    "init --dry-run should print dry-run output."
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "profiles", "personal.json")),
    false,
    "init --dry-run should not create profiles/personal.json"
  );
  assert.equal(
    await pathExists(configPath),
    false,
    "init --dry-run should not create workspace/config.json"
  );
  assert.equal(await pathExists(distPath), false, "init --dry-run must not create runtime artifacts.");

  // --- init (non-destructive scaffold) ---
  runCli(["init"]);
  assert.equal(
    await pathExists(path.join(localOverridesPath, "profiles", "personal.json")),
    true,
    "init should create profiles/personal.json"
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", "personal", "sources.json")),
    true,
    "init should create packs/personal/sources.json"
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", "personal", "mcp", "servers.json")),
    true,
    "init should create packs/personal/mcp/servers.json"
  );
  const initialConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(initialConfig.defaultProfile, "personal", "init should set default profile to personal when missing.");
  assert.equal(await pathExists(distPath), false, "init must not create runtime artifacts.");

  // --- init is idempotent: running again must not fail ---
  runCli(["init"]);
  const afterSecondInitConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(afterSecondInitConfig.defaultProfile, "personal", "init should preserve existing default profile.");

  // --- init --profile should scaffold and set default profile ---
  runCli(["init", "--profile", "work"]);
  assert.equal(
    await pathExists(path.join(localOverridesPath, "profiles", "work.json")),
    true,
    "init --profile should create profiles/work.json"
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", "work", "sources.json")),
    true,
    "init --profile should create packs/work/sources.json"
  );
  const afterProfileInitConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(afterProfileInitConfig.defaultProfile, "work", "init --profile should set default profile.");

  // --- init --seed: replaces workspace and creates a backup ---
  const backupsBeforeSeed = new Set(await listBackupDirs());
  runCli(["init", "--seed"]);
  const backupsAfterSeed = new Set(await listBackupDirs());
  const newBackups = [...backupsAfterSeed].filter((name) => !backupsBeforeSeed.has(name));
  assert.equal(newBackups.length > 0, true, "init --seed should create a backup directory.");
  assert.equal(backupsAfterSeed.size, 1, "init --seed should keep only one backup directory.");

  // Running seed again should overwrite the same backup path, not create additional backups.
  runCli(["init", "--seed"]);
  const backupsAfterSecondSeed = new Set(await listBackupDirs());
  assert.equal(backupsAfterSecondSeed.size, 1, "Repeated init --seed must not create multiple backup directories.");

  // init --seed should not trigger a build
  assert.equal(await pathExists(distPath), false, "init --seed must not create runtime artifacts.");
}
