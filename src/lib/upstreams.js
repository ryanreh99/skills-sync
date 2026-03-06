import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fuse from "fuse.js";
import fs from "fs-extra";
import path from "node:path";
import {
  CACHE_ROOT,
  LOCKFILE_PATH,
  SCHEMAS,
  UPSTREAMS_CONFIG_PATHS,
  assertJsonFileMatchesSchema,
  assertObjectMatchesSchema,
  extractSkillTitleFromMarkdown,
  normalizeDestPrefix,
  normalizeRepoPath,
  writeJsonFile
} from "./core.js";
import { loadPackSources, resolvePack, resolveProfile } from "./config.js";
import { muted } from "./terminal-ui.js";

const execFileAsync = promisify(execFile);
let checkedGitAvailability = false;
const TEXT_SEARCH_RESULT_LIMIT = 20;

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

export function getLockKey(upstreamId, ref) {
  return `${upstreamId}::${ref}`;
}

export function sortPins(lockDocument) {
  lockDocument.pins.sort((left, right) => {
    const leftKey = `${left.upstream}::${left.ref}`;
    const rightKey = `${right.upstream}::${right.ref}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function findPin(lockDocument, upstreamId, ref) {
  return lockDocument.pins.find((pin) => pin.upstream === upstreamId && pin.ref === ref) ?? null;
}

export function setPin(lockDocument, upstreamId, ref, commit) {
  const existing = findPin(lockDocument, upstreamId, ref);
  if (existing) {
    if (existing.commit === commit) {
      return false;
    }
    existing.commit = commit;
    return true;
  }
  lockDocument.pins.push({
    upstream: upstreamId,
    ref,
    commit
  });
  return true;
}

export async function loadUpstreamsConfig() {
  const selectedPath = (await fs.pathExists(UPSTREAMS_CONFIG_PATHS.local))
    ? UPSTREAMS_CONFIG_PATHS.local
    : UPSTREAMS_CONFIG_PATHS.seed;

  if (!(await fs.pathExists(selectedPath))) {
    throw new Error("No upstream configuration found.");
  }

  const config = await assertJsonFileMatchesSchema(selectedPath, SCHEMAS.upstreams);
  const byId = new Map();
  for (const upstream of config.upstreams) {
    if (byId.has(upstream.id)) {
      throw new Error(`Duplicate upstream id '${upstream.id}'.`);
    }
    byId.set(upstream.id, upstream);
  }

  return {
    path: selectedPath,
    config,
    byId
  };
}

export async function loadLockfile() {
  if (!(await fs.pathExists(LOCKFILE_PATH))) {
    return {
      path: LOCKFILE_PATH,
      exists: false,
      changed: false,
      lock: { pins: [] }
    };
  }

  const lock = await assertJsonFileMatchesSchema(LOCKFILE_PATH, SCHEMAS.upstreamsLock);
  sortPins(lock);
  return {
    path: LOCKFILE_PATH,
    exists: true,
    changed: false,
    lock
  };
}

export async function saveLockfile(lockState) {
  sortPins(lockState.lock);
  await writeJsonFile(lockState.path, lockState.lock);
  lockState.exists = true;
  lockState.changed = false;
}

export function dedupeReferences(references) {
  const map = new Map();
  for (const reference of references) {
    map.set(getLockKey(reference.upstreamId, reference.ref), reference);
  }
  return Array.from(map.values()).sort((left, right) => {
    const leftKey = `${left.upstreamId}::${left.ref}`;
    const rightKey = `${right.upstreamId}::${right.ref}`;
    return leftKey.localeCompare(rightKey);
  });
}

function assertImportPathIsNarrow(rawPath, normalizedPath, importEntry, importIndex, pathIndex) {
  const label = `imports[${importIndex}].paths[${pathIndex}]`;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.trim() === ".") {
    throw new Error(`${label} must not be empty or '.'.`);
  }
  if (normalizedPath === "*") {
    throw new Error(`${label} must not be '*' at repository root.`);
  }
  if (normalizedPath === "skills" && importEntry.allowWholeSkillsTree !== true) {
    throw new Error(
      `${label} is 'skills', which imports the entire skills tree. ` +
        "Set allowWholeSkillsTree=true in this import to allow it explicitly."
    );
  }
}

export function collectSourcePlanning(sources, upstreamById) {
  const references = [];
  const skillImports = [];

  sources.imports.forEach((entry, importIndex) => {
    const upstream = upstreamById.get(entry.upstream);
    if (!upstream) {
      throw new Error(`Unknown upstream '${entry.upstream}' in imports[${importIndex}].`);
    }

    const effectiveRef = entry.ref || upstream.defaultRef;
    references.push({
      upstreamId: upstream.id,
      ref: effectiveRef
    });

    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new Error(`imports[${importIndex}] must contain one or more paths.`);
    }

    const destPrefix = normalizeDestPrefix(entry.destPrefix, upstream.id, `imports[${importIndex}]`);
    entry.paths.forEach((rawPath, pathIndex) => {
      const repoPath = normalizeRepoPath(rawPath, `imports[${importIndex}].paths[${pathIndex}]`);
      assertImportPathIsNarrow(rawPath, repoPath, entry, importIndex, pathIndex);
      const skillName = path.posix.basename(repoPath);
      skillImports.push({
        upstreamId: upstream.id,
        ref: effectiveRef,
        repoPath,
        destRelative: path.posix.join(destPrefix, skillName),
        label: `${upstream.id}:${repoPath}@${effectiveRef}`
      });
    });
  });

  return {
    references: dedupeReferences(references),
    skillImports
  };
}

export async function resolveReferenceCandidatesForSkillLookup({ upstreamId, ref, profileName }) {
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  let referenceCandidates = [];

  if (profileName) {
    const { profile } = await resolveProfile(profileName);
    const packRoot = await resolvePack(profile);
    const { sources } = await loadPackSources(packRoot);
    const planning = collectSourcePlanning(sources, upstreams.byId);
    referenceCandidates = [...planning.references];
  } else if (upstreamId) {
    const upstream = upstreams.byId.get(upstreamId);
    if (!upstream) {
      throw new Error(`Unknown upstream '${upstreamId}'.`);
    }
    referenceCandidates = [
      {
        upstreamId: upstream.id,
        ref: ref || upstream.defaultRef
      }
    ];
  } else {
    referenceCandidates = upstreams.config.upstreams.map((upstream) => ({
      upstreamId: upstream.id,
      ref: upstream.defaultRef
    }));
  }

  if (upstreamId) {
    referenceCandidates = referenceCandidates.filter((item) => item.upstreamId === upstreamId);
  }
  if (ref) {
    referenceCandidates = referenceCandidates.filter((item) => item.ref === ref);
  }

  if (referenceCandidates.length === 0) {
    throw new Error("No matching upstream/ref found for the provided filters.");
  }
  return {
    upstreams,
    lockState,
    references: referenceCandidates
  };
}

async function resolveReferenceSetForSkillLookup(filters) {
  const { upstreams, lockState, references } = await resolveReferenceCandidatesForSkillLookup(filters);
  const resolved = await resolveReferences({
    references,
    upstreamById: upstreams.byId,
    lockState,
    preferPinned: true,
    requirePinned: false,
    updatePins: false,
    allowLockUpdate: false
  });

  return references.map((reference) => {
    const resolvedItem = resolved.get(getLockKey(reference.upstreamId, reference.ref));
    return {
      upstreamId: reference.upstreamId,
      ref: reference.ref,
      commit: resolvedItem.commit,
      repoPath: resolvedItem.repoPath
    };
  });
}

export async function discoverUpstreamSkills(repoPath, commit, { verbose = false } = {}) {
  const listing = await runGit(["ls-tree", "-r", "--name-only", commit, "--", "skills"], {
    cwd: repoPath
  });
  const skillMdFiles = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith("skills/") && line.endsWith("/SKILL.md"));

  const skillEntries = skillMdFiles.map((skillMdPath) => {
    const skillPath = path.posix.dirname(skillMdPath);
    return {
      path: skillPath,
      basename: path.posix.basename(skillPath),
      skillMdPath
    };
  });
  skillEntries.sort((left, right) => left.path.localeCompare(right.path));

  if (!verbose) {
    return skillEntries.map(({ path: entryPath, basename }) => ({
      path: entryPath,
      basename
    }));
  }

  const skills = [];
  for (const entry of skillEntries) {
    const markdown = await runGit(["show", `${commit}:${entry.skillMdPath}`], {
      cwd: repoPath
    });
    const title = extractSkillTitleFromMarkdown(markdown, entry.basename);
    skills.push({
      path: entry.path,
      basename: entry.basename,
      title
    });
  }
  return skills;
}

export async function discoverUpstreamMcpServers(repoPath, commit) {
  const listing = await runGit(["ls-tree", "-r", "--name-only", commit], {
    cwd: repoPath
  });
  const manifestPaths = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && (line === "mcp/servers.json" || line.endsWith("/mcp/servers.json"))
    )
    .sort((left, right) => left.localeCompare(right));

  const warnings = [];
  const servers = [];

  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      const raw = await runGit(["show", `${commit}:${manifestPath}`], {
        cwd: repoPath
      });
      manifest = JSON.parse(raw);
      await assertObjectMatchesSchema(
        manifest,
        SCHEMAS.mcpServers,
        "upstream MCP manifest"
      );
    } catch (error) {
      warnings.push(error.message);
      continue;
    }

    for (const [name, server] of Object.entries(manifest.servers ?? {})) {
      const env = {};
      if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
        for (const key of Object.keys(server.env).sort((left, right) => left.localeCompare(right))) {
          if (key.length === 0) {
            continue;
          }
          env[key] = String(server.env[key]);
        }
      }
      servers.push({
        sourcePath: manifestPath,
        name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env
      });
    }
  }

  servers.sort((left, right) => {
    const leftKey = `${left.name}::${left.sourcePath}`;
    const rightKey = `${right.name}::${right.sourcePath}`;
    return leftKey.localeCompare(rightKey);
  });

  return {
    manifestPaths,
    servers,
    warnings
  };
}

export async function cmdListSkills({ upstream, ref, profile, format, verbose = false }) {
  const resolvedSet = await resolveReferenceSetForSkillLookup({
    upstreamId: upstream,
    ref,
    profileName: profile
  });
  const payloadItems = [];
  for (const resolved of resolvedSet) {
    const skills = await discoverUpstreamSkills(resolved.repoPath, resolved.commit, { verbose });
    payloadItems.push({
      upstream: resolved.upstreamId,
      ref: resolved.ref,
      commit: resolved.commit,
      skills: skills.map((skill) => ({
        path: skill.path,
        basename: skill.basename,
        ...(verbose ? { title: skill.title } : {})
      }))
    });
  }

  if (format === "json") {
    const payload = payloadItems.length === 1 ? payloadItems[0] : { results: payloadItems };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (payloadItems.length === 1) {
    for (const skill of payloadItems[0].skills) {
      if (verbose) {
        process.stdout.write(`${skill.path}\t${skill.title}\n`);
      } else {
        process.stdout.write(`${skill.path}\n`);
      }
    }
    return;
  }

  for (const item of payloadItems) {
    process.stdout.write(`${item.upstream}@${item.ref} (${item.commit.slice(0, 12)})\n`);
    if (item.skills.length === 0) {
      process.stdout.write("  (no skills found)\n\n");
      continue;
    }
    for (const skill of item.skills) {
      if (verbose) {
        process.stdout.write(`  ${skill.path}\t${skill.title}\n`);
      } else {
        process.stdout.write(`  ${skill.path}\n`);
      }
    }
    process.stdout.write("\n");
  }
}

export async function cmdListUpstreamContent({
  upstream,
  ref,
  profile,
  format,
  verbose = false
}) {
  const resolvedSet = await resolveReferenceSetForSkillLookup({
    upstreamId: upstream,
    ref,
    profileName: profile
  });

  const payloadItems = [];
  for (const resolved of resolvedSet) {
    const skills = await discoverUpstreamSkills(resolved.repoPath, resolved.commit, { verbose });
    const mcp = await discoverUpstreamMcpServers(resolved.repoPath, resolved.commit);
    payloadItems.push({
      upstream: resolved.upstreamId,
      ref: resolved.ref,
      commit: resolved.commit,
      skills: skills.map((skill) => ({
        path: skill.path,
        basename: skill.basename,
        ...(verbose ? { title: skill.title } : {})
      })),
      mcpServers: mcp.servers.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env
      })),
      warnings: mcp.warnings
    });
  }

  if (format === "json") {
    const payload = payloadItems.length === 1 ? payloadItems[0] : { results: payloadItems };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  for (let index = 0; index < payloadItems.length; index += 1) {
    const item = payloadItems[index];
    process.stdout.write(`${item.upstream}@${item.ref} (${item.commit.slice(0, 12)})\n`);
    process.stdout.write(`Skills (${item.skills.length})\n`);
    if (item.skills.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      for (const skill of item.skills) {
        if (verbose) {
          process.stdout.write(`  ${skill.path}\t${skill.title}\n`);
        } else {
          process.stdout.write(`  ${skill.path}\n`);
        }
      }
    }

    process.stdout.write(`MCP Servers (${item.mcpServers.length})\n`);
    if (item.mcpServers.length === 0) {
      process.stdout.write("  (none found in upstream manifests)\n");
    } else {
      for (const server of item.mcpServers) {
        const argsPart = server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
        const envKeys = Object.keys(server.env ?? {});
        const envPart = envKeys.length > 0 ? ` [env:${envKeys.join(",")}]` : "";
        process.stdout.write(`  ${server.name}\t${server.command}${argsPart}${envPart}\n`);
      }
    }

    if (item.warnings.length > 0) {
      process.stdout.write("Warnings\n");
      for (const warning of item.warnings) {
        process.stdout.write(`  ${warning}\n`);
      }
    }

    if (index < payloadItems.length - 1) {
      process.stdout.write("\n");
    }
  }
}

export async function cmdListUpstreams({ format }) {
  const upstreams = await loadUpstreamsConfig();
  const items = [...upstreams.config.upstreams]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      type: item.type,
      repo: item.repo,
      defaultRef: item.defaultRef
    }));

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ upstreams: items }, null, 2)}\n`);
    return;
  }

  for (const item of items) {
    process.stdout.write(`${item.id}\t${item.defaultRef}\t${item.repo}\n`);
  }
}

function createSearchStableKey(item) {
  return `${item.upstream}::${item.path}::${item.title ?? ""}`;
}

function buildSearchFuseOptions(verbose) {
  const keys = [
    { name: "path", weight: 0.75 },
    { name: "basename", weight: 0.25 }
  ];
  if (verbose) {
    keys.push({ name: "title", weight: 0.2 });
  }
  return {
    includeScore: true,
    shouldSort: true,
    ignoreLocation: true,
    threshold: 0.45,
    keys
  };
}

function limitResultsForText(results) {
  return {
    visible: results.slice(0, TEXT_SEARCH_RESULT_LIMIT),
    hiddenCount: Math.max(0, results.length - TEXT_SEARCH_RESULT_LIMIT)
  };
}

function writeSearchTruncationNotice(hiddenCount) {
  if (hiddenCount <= 0) {
    return;
  }
  process.stdout.write(
    `${muted(`Showing top ${TEXT_SEARCH_RESULT_LIMIT} matches. ${hiddenCount} additional match(es) hidden.`)}\n`
  );
}

async function collectSearchResults({ upstream, ref, profile, query, verbose = false }) {
  const normalizedQuery = query.trim();
  const resolvedSet = await resolveReferenceSetForSkillLookup({
    upstreamId: upstream,
    ref,
    profileName: profile
  });

  const indexedRows = [];
  for (const resolvedItem of resolvedSet) {
    const skills = await discoverUpstreamSkills(resolvedItem.repoPath, resolvedItem.commit, { verbose });
    for (const skill of skills) {
      indexedRows.push({
        upstream: resolvedItem.upstreamId,
        ref: resolvedItem.ref,
        commit: resolvedItem.commit,
        path: skill.path,
        basename: skill.basename,
        ...(verbose ? { title: skill.title } : {})
      });
    }
  }

  const fuse = new Fuse(indexedRows, buildSearchFuseOptions(verbose));
  const ranked = fuse.search(normalizedQuery).sort((left, right) => {
    const leftScore = typeof left.score === "number" ? left.score : Number.POSITIVE_INFINITY;
    const rightScore = typeof right.score === "number" ? right.score : Number.POSITIVE_INFINITY;
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return createSearchStableKey(left.item).localeCompare(createSearchStableKey(right.item));
  });

  return ranked.map((row) => row.item);
}

export async function cmdSearchSkills({ upstream, ref, profile, query, format, verbose = false }) {
  if (!query || query.trim().length === 0) {
    throw new Error("--query <text> is required.");
  }
  const allResults = await collectSearchResults({ upstream, ref, profile, query, verbose });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(allResults, null, 2)}\n`);
    return;
  }

  if (allResults.length === 0) {
    process.stdout.write(`No skills matched "${query}".\n`);
    return;
  }

  const { visible, hiddenCount } = limitResultsForText(allResults);
  for (const result of visible) {
    if (verbose) {
      process.stdout.write(`${result.upstream}  ${result.path}\t${result.title}\n`);
    } else {
      process.stdout.write(`${result.upstream}  ${result.path}\n`);
    }
  }
  writeSearchTruncationNotice(hiddenCount);
}

export async function resolveReferences({
  references,
  upstreamById,
  lockState,
  preferPinned,
  requirePinned,
  updatePins,
  allowLockUpdate
}) {
  const resolved = new Map();

  for (const reference of references) {
    const key = getLockKey(reference.upstreamId, reference.ref);
    const upstream = upstreamById.get(reference.upstreamId);
    if (!upstream) {
      throw new Error(`Unknown upstream '${reference.upstreamId}'.`);
    }

    const repoPath = await ensureUpstreamClone(upstream);
    const pin = findPin(lockState.lock, reference.upstreamId, reference.ref);
    let commit = null;

    if (preferPinned && pin) {
      commit = pin.commit;
      await ensureCommitAvailable(repoPath, commit);
    } else if (requirePinned) {
      throw new Error(
        `Missing lock pin for upstream '${reference.upstreamId}' ref '${reference.ref}'. ` +
          "Run build --lock=write or build --lock=refresh."
      );
    } else {
      commit = await fetchRefAndResolveCommit(repoPath, reference.ref);
    }

    if ((updatePins || (!pin && allowLockUpdate)) && allowLockUpdate) {
      if (setPin(lockState.lock, reference.upstreamId, reference.ref, commit)) {
        lockState.changed = true;
      }
    }

    resolved.set(key, {
      upstream,
      ref: reference.ref,
      commit,
      repoPath,
      pinUsed: Boolean(pin && preferPinned)
    });
  }

  return resolved;
}

export async function validateAllLockPins(lockState, upstreamById, errors) {
  for (const pin of lockState.lock.pins) {
    const upstream = upstreamById.get(pin.upstream);
    if (!upstream) {
      errors.push(`Lock pin references unknown upstream '${pin.upstream}'.`);
      continue;
    }
    try {
      const repoPath = await ensureUpstreamClone(upstream);
      await ensureCommitAvailable(repoPath, pin.commit);
    } catch (error) {
      errors.push(`Invalid lock pin ${pin.upstream}@${pin.ref} -> ${pin.commit}: ${error.message}`);
    }
  }
}
