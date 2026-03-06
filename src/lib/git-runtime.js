import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "fs-extra";
import path from "node:path";
import { CACHE_ROOT } from "./core.js";

const execFileAsync = promisify(execFile);
let checkedGitAvailability = false;

export async function runGit(args, options = {}) {
  const { cwd = process.cwd(), allowFailure = false } = options;
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const details = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }
}

export async function ensureGitAvailable() {
  if (checkedGitAvailability) {
    return;
  }
  await runGit(["--version"]);
  checkedGitAvailability = true;
}

export function getUpstreamRepoPath(upstreamId) {
  return path.join(CACHE_ROOT, upstreamId);
}

export async function ensureUpstreamClone(upstream) {
  await ensureGitAvailable();
  const repoPath = getUpstreamRepoPath(upstream.id);
  const gitDir = path.join(repoPath, ".git");
  if (!(await fs.pathExists(gitDir))) {
    await fs.ensureDir(path.dirname(repoPath));
    await runGit(["clone", "--filter=blob:none", "--no-checkout", upstream.repo, repoPath]);
  }
  return repoPath;
}

export async function fetchRefAndResolveCommit(repoPath, ref) {
  try {
    await runGit(["fetch", "--prune", "origin", ref], { cwd: repoPath });
  } catch {
    await runGit(["fetch", "--prune", "--force", "origin", ref], { cwd: repoPath });
  }
  return await runGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: repoPath });
}

export async function ensureCommitAvailable(repoPath, commit) {
  let available = await runGit(["cat-file", "-e", `${commit}^{commit}`], {
    cwd: repoPath,
    allowFailure: true
  });
  if (available !== null) {
    return;
  }

  await runGit(["fetch", "--prune", "origin", commit], { cwd: repoPath, allowFailure: true });
  available = await runGit(["cat-file", "-e", `${commit}^{commit}`], {
    cwd: repoPath,
    allowFailure: true
  });
  if (available === null) {
    throw new Error(`Commit '${commit}' is not available in upstream cache '${repoPath}'.`);
  }
}

export async function getCommitObjectType(repoPath, commit, repoRelativePath) {
  const gitPath = `${commit}:${repoRelativePath}`;
  const exists = await runGit(["cat-file", "-e", gitPath], { cwd: repoPath, allowFailure: true });
  if (exists === null) {
    return null;
  }
  const type = await runGit(["cat-file", "-t", gitPath], { cwd: repoPath });
  return type;
}

export async function checkoutCommit(repoPath, commit, checkoutTracker) {
  const existing = checkoutTracker.get(repoPath);
  if (existing && existing === commit) {
    return;
  }
  await runGit(["checkout", "--force", commit], { cwd: repoPath });
  checkoutTracker.set(repoPath, commit);
}

export async function detectDefaultRefFromRepo(repo) {
  const output = await runGit(["ls-remote", "--symref", repo, "HEAD"], { allowFailure: true });
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const branchMatch = line.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/);
    if (branchMatch?.[1]) {
      return branchMatch[1].trim();
    }

    const genericRefMatch = line.match(/^ref:\s+refs\/([^\s]+)\s+HEAD$/);
    if (genericRefMatch?.[1]) {
      return genericRefMatch[1].trim();
    }
  }

  return null;
}
