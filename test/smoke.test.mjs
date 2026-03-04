import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "index.js");
const packageJsonPath = path.join(repoRoot, "package.json");
const smokeHome = path.join(repoRoot, ".tmp-smoke-home");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLS_SYNC_HOME: smokeHome
    }
  });
}

test.before(async () => {
  await fs.rm(smokeHome, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(smokeHome, { recursive: true, force: true });
});

test("--help exits 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("--version exits 0 and matches package.json", async () => {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("current command is a no-op with clean state", () => {
  const result = runCli(["current"]);
  assert.equal(result.status, 0);
});

test("dist entrypoint uses unix shebang line endings", async () => {
  const contents = await fs.readFile(cliPath, "utf8");
  assert.ok(contents.startsWith("#!/usr/bin/env node\n"));
  assert.equal(contents.includes("\r\n"), false);
});
