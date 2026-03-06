import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..");
export const cliPath = path.join(repoRoot, "dist", "index.js");
export const testHomePath = path.join(repoRoot, ".tmp-test-home");
export const localOverridesPath = path.join(testHomePath, "workspace");
export const distPath = path.join(testHomePath, "internal");

/**
 * Run the CLI with the given arguments.
 * Throws if the exit code does not match expectedStatus.
 * Returns the spawnSync result on success.
 */
export function runCli(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLS_SYNC_HOME: testHomePath
    }
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      [
        `Command failed: node ${path.relative(repoRoot, cliPath)} ${args.join(" ")}`,
        `Expected exit ${expectedStatus}, got ${result.status}`,
        "",
        "STDOUT:",
        result.stdout ?? "",
        "",
        "STDERR:",
        result.stderr ?? ""
      ].join("\n")
    );
  }
  return result;
}

/**
 * Run the CLI with stdin input and additional env overrides.
 */
export function runCliWithInput(args, {
  expectedStatus = 0,
  input = "",
  env = {}
} = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      SKILLS_SYNC_HOME: testHomePath,
      ...env
    }
  });

  if (result.status !== expectedStatus) {
    throw new Error(
      [
        `Command failed: node ${path.relative(repoRoot, cliPath)} ${args.join(" ")}`,
        `Expected exit ${expectedStatus}, got ${result.status}`,
        "",
        "STDOUT:",
        result.stdout ?? "",
        "",
        "STDERR:",
        result.stderr ?? ""
      ].join("\n")
    );
  }
  return result;
}

/**
 * Returns true if the path exists (any kind: file, dir, symlink).
 */
export async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts skill directories (containing a SKILL.md) under skillsRoot.
 */
export async function countDiscoverableSkills(skillsRoot) {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const skillFilePath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (await pathExists(skillFilePath)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Moves fromPath to toPath (removing toPath first if it exists).
 * Returns true if fromPath existed and was moved.
 *
 * Falls back to fs.cp + fs.rm when fs.rename is blocked by Windows file
 * watchers (EPERM) or cross-device moves (EXDEV). The copy uses
 * dereference:true so that junctions / symlinks are materialized as regular
 * files/directories in the destination.
 */
export async function movePathIfExists(fromPath, toPath) {
  if (!(await pathExists(fromPath))) {
    return false;
  }
  if (await pathExists(toPath)) {
    await fs.rm(toPath, { recursive: true, force: true });
  }
  try {
    await fs.rename(fromPath, toPath);
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EXDEV") {
      throw err;
    }
    await fs.cp(fromPath, toPath, { recursive: true, dereference: true });
    await fs.rm(fromPath, { recursive: true, force: true });
  }
  return true;
}

/**
 * Returns a sorted list of workspace backup directory names.
 */
export async function listBackupDirs() {
  await fs.mkdir(testHomePath, { recursive: true });
  const entries = await fs.readdir(testHomePath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("workspace.backup"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}
