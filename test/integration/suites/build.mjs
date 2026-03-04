import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli, pathExists } from "../helpers.mjs";

/**
 * Tests for: build --lock read|write|refresh
 */
export async function run({ localOverridesPath, distPath }) {
  const lockPath = path.join(localOverridesPath, "upstreams.lock.json");

  // --lock=read must refuse to create a lockfile
  await fs.rm(lockPath, { force: true });
  runCli(["build", "--profile", "personal", "--lock=read"], 1);
  assert.equal(await pathExists(lockPath), false, "--lock=read must not create lockfile.");

  // --lock=write creates the lockfile
  runCli(["build", "--profile", "personal", "--lock=write"]);
  assert.equal(await pathExists(lockPath), true, "--lock=write should create lockfile.");

  // --lock=refresh re-pins and writes a new lockfile
  runCli(["build", "--profile", "personal", "--lock=refresh"]);
  assert.equal(await pathExists(lockPath), true, "--lock=refresh should preserve/update lockfile.");

  // dist must exist after a successful build
  assert.equal(await pathExists(distPath), true, "build should produce dist output.");
}
