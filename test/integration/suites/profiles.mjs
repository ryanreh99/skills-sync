import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists } from "../helpers.mjs";

/**
 * Tests for: use, current, ls, new, remove
 */
export async function run({ localOverridesPath }) {
  const profilesDir = path.join(localOverridesPath, "profiles");

  // --- use: sets the default profile ---
  runCli(["use", "personal"]);
  const configPath = path.join(localOverridesPath, "config.json");
  assert.equal(await pathExists(configPath), true, "use should create config.json.");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.defaultProfile, "personal", "use should write defaultProfile to config.json.");

  // --- current: prints the default profile ---
  const currentResult = runCli(["current"]);
  assert.equal(currentResult.stdout.trim(), "personal", "current should print the active profile name.");

  // --- ls: lists profiles, marking the active one ---
  const lsResult = runCli(["ls"]);
  assert.equal(lsResult.stdout.includes("personal"), true, "ls should list the personal profile.");
  assert.equal(lsResult.stdout.includes("->"), true, "ls should mark the active profile with ->.");

  // --- new: scaffolds a fresh profile ---
  const testProfileName = "test-profile-tmp";
  runCli(["new", testProfileName]);
  assert.equal(
    await pathExists(path.join(profilesDir, `${testProfileName}.json`)),
    true,
    "new should create the profile JSON."
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", testProfileName, "sources.json")),
    true,
    "new should scaffold sources.json inside the new pack."
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", testProfileName, "mcp", "servers.json")),
    true,
    "new should scaffold mcp/servers.json inside the new pack."
  );

  // new is idempotent: running again must not fail
  runCli(["new", testProfileName]);

  // --- ls: new profile should appear in list ---
  const lsAfterNew = runCli(["ls"]);
  assert.equal(lsAfterNew.stdout.includes(testProfileName), true, "ls should include the newly created profile.");

  // --- use on missing profile: auto-creates empty profile scaffold and sets default ---
  const autoProfileName = "auto-created-by-use";
  runCli(["use", autoProfileName]);
  assert.equal(
    await pathExists(path.join(profilesDir, `${autoProfileName}.json`)),
    true,
    "use should create missing profile JSON."
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", autoProfileName, "sources.json")),
    true,
    "use should scaffold sources.json for missing profile."
  );
  assert.equal(
    await pathExists(path.join(localOverridesPath, "packs", autoProfileName, "mcp", "servers.json")),
    true,
    "use should scaffold mcp/servers.json for missing profile."
  );
  const configAfterAutoUse = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(configAfterAutoUse.defaultProfile, autoProfileName, "use should set auto-created profile as default.");

  // --- remove: deletes the profile JSON ---
  runCli(["remove", testProfileName]);
  assert.equal(
    await pathExists(path.join(profilesDir, `${testProfileName}.json`)),
    false,
    "remove should delete the profile JSON."
  );

  // remove a profile that does not exist must exit with an error
  runCli(["remove", "does-not-exist-xyz"], 1);

  // --- current after setting default ---
  runCli(["use", "personal"]);
  const currentAfter = runCli(["current"]);
  assert.equal(currentAfter.stdout.trim().length > 0, true, "current should print something after use.");
}
