import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists } from "../helpers.mjs";

/**
 * Tests for: build --lock read|write|refresh
 */
export async function run({ localOverridesPath, distPath }) {
  const lockPath = path.join(localOverridesPath, "skills-sync.lock.json");
  const legacyLockPath = path.join(localOverridesPath, "upstreams.lock.json");

  // --lock=read must refuse to create a lockfile
  await fs.rm(lockPath, { force: true });
  await fs.rm(legacyLockPath, { force: true });
  runCli(["build", "--profile", "personal", "--lock=read"], 1);
  assert.equal(await pathExists(lockPath), false, "--lock=read must not create lockfile.");
  assert.equal(await pathExists(legacyLockPath), false, "Legacy upstreams.lock.json should not be recreated.");

  // --lock=write creates the lockfile
  runCli(["build", "--profile", "personal", "--lock=write"]);
  assert.equal(await pathExists(lockPath), true, "--lock=write should create lockfile.");
  assert.equal(await pathExists(legacyLockPath), false, "Legacy upstreams.lock.json should not be recreated.");
  const lockDoc = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lockDoc.schemaVersion, 3, "build should write lock schemaVersion 3.");
  assert.equal(Array.isArray(lockDoc.pins), true, "lockfile should include pins.");
  assert.equal(Array.isArray(lockDoc.imports), true, "lockfile should include imports.");
  assert.equal(
    lockDoc.imports.every((entry) =>
      entry.source &&
      entry.resolution &&
      entry.digests &&
      entry.projection &&
      entry.refresh &&
      entry.eval
    ),
    true,
    "lockfile imports should include v3 provenance, projection, refresh, and eval metadata."
  );
  assert.equal(
    lockDoc.imports.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "policy")),
    true,
    "lockfile imports should not include removed policy metadata."
  );
  assert.equal(
    lockDoc.imports.every((entry) => !Object.prototype.hasOwnProperty.call(entry.refresh ?? {}, "policyStatus")),
    true,
    "lockfile refresh metadata should not include removed policyStatus."
  );
  assert.equal(
    lockDoc.pins.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "policyStatus")),
    true,
    "lockfile pins should not include removed policyStatus."
  );

  // --lock=refresh re-pins and writes a new lockfile
  runCli(["build", "--profile", "personal", "--lock=refresh"]);
  assert.equal(await pathExists(lockPath), true, "--lock=refresh should preserve/update lockfile.");
  assert.equal(await pathExists(legacyLockPath), false, "Legacy upstreams.lock.json should not be recreated.");

  // dist must exist after a successful build
  assert.equal(await pathExists(distPath), true, "build should produce dist output.");
}
