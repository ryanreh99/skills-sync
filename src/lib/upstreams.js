import Fuse from "fuse.js";
import fs from "fs-extra";
import path from "node:path";
import {
  SCHEMAS,
  UPSTREAMS_CONFIG_PATHS,
  assertJsonFileMatchesSchema,
  assertObjectMatchesSchema,
  normalizeDestPrefix,
  writeJsonFile
} from "./core.js";
import { readDefaultProfile, loadPackSources, resolvePack, resolveProfile } from "./config.js";
import {
  checkoutCommit,
  detectDefaultRefFromRepo,
  ensureCommitAvailable,
  ensureUpstreamClone,
  fetchRefAndResolveCommit,
  getCommitObjectType,
  getUpstreamRepoPath,
  runGit,
  ensureGitAvailable
} from "./git-runtime.js";
import {
  loadImportLock,
  saveImportLock
} from "./import-lock.js";
import { getProvider } from "./providers/index.js";
import {
  inferUpstreamIdFromSourceDescriptor,
  normalizeOptionalRoot,
  normalizeSelectionPath,
  normalizeSourceInput
} from "./source-normalization.js";
import { muted } from "./terminal-ui.js";

const TEXT_SEARCH_RESULT_LIMIT = 20;

export {
  runGit,
  ensureGitAvailable,
  getUpstreamRepoPath,
  ensureUpstreamClone,
  fetchRefAndResolveCommit,
  ensureCommitAvailable,
  getCommitObjectType,
  checkoutCommit,
  detectDefaultRefFromRepo
};

function normalizeRequiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneUpstreamDocument(doc) {
  return {
    schemaVersion: 2,
    upstreams: Array.isArray(doc?.upstreams)
      ? doc.upstreams.map((entry) => ({ ...entry }))
      : []
  };
}

function migrateUpstreamEntry(entry) {
  const provider = entry?.provider || (entry?.path ? "local-path" : "git");
  return {
    id: normalizeRequiredText(entry.id, "Upstream id"),
    provider,
    ...(provider === "git"
      ? {
          type: "git",
          repo: normalizeRequiredText(entry.repo, "Upstream repo"),
          defaultRef: normalizeOptionalText(entry.defaultRef) || "main"
        }
      : {
          path: normalizeRequiredText(entry.path, "Upstream path")
        }),
    ...(normalizeOptionalText(entry.originalInput) ? { originalInput: entry.originalInput.trim() } : {}),
    ...(normalizeOptionalText(entry.root) ? { root: normalizeOptionalRoot(entry.root) } : {}),
    ...(normalizeOptionalText(entry.displayName) ? { displayName: entry.displayName.trim() } : {})
  };
}

function migrateUpstreamsDocument(doc) {
  const migrated = cloneUpstreamDocument(doc);
  migrated.schemaVersion = 2;
  migrated.upstreams = migrated.upstreams.map(migrateUpstreamEntry).sort((left, right) => left.id.localeCompare(right.id));
  return migrated;
}

function inferImportedSkillName(upstream, selectionPath) {
  if (selectionPath !== ".") {
    return path.posix.basename(selectionPath);
  }

  if (typeof upstream.root === "string" && upstream.root.length > 0) {
    return path.posix.basename(upstream.root);
  }
  if (upstream.provider === "local-path" && typeof upstream.path === "string" && upstream.path.length > 0) {
    return path.basename(upstream.path);
  }
  if (typeof upstream.displayName === "string" && upstream.displayName.length > 0) {
    return upstream.displayName;
  }
  return upstream.id;
}

export function getLockKey(upstreamId, ref) {
  return `${upstreamId}::${ref}`;
}

export function sortPins(lockDocument) {
  lockDocument.pins = Array.isArray(lockDocument.pins) ? lockDocument.pins : [];
  lockDocument.pins.sort((left, right) => {
    const leftKey = `${left.upstream}::${left.ref}`;
    const rightKey = `${right.upstream}::${right.ref}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function findPin(lockDocument, upstreamId, ref) {
  return (Array.isArray(lockDocument.pins) ? lockDocument.pins : []).find(
    (pin) => pin.upstream === upstreamId && pin.ref === ref
  ) ?? null;
}

export function setPin(lockDocument, upstreamId, ref, commit) {
  lockDocument.pins = Array.isArray(lockDocument.pins) ? lockDocument.pins : [];
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

  const config = migrateUpstreamsDocument(await assertJsonFileMatchesSchema(selectedPath, SCHEMAS.upstreams));
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

export async function writeUpstreamsConfig(configDocument) {
  const migrated = migrateUpstreamsDocument(configDocument);
  await assertObjectMatchesSchema(migrated, SCHEMAS.upstreams, "upstreams config");
  await writeJsonFile(UPSTREAMS_CONFIG_PATHS.local, migrated);
}

export async function loadLockfile() {
  const lockState = await loadImportLock();
  lockState.lock.pins = Array.isArray(lockState.lock.pins) ? lockState.lock.pins : [];
  lockState.lock.imports = Array.isArray(lockState.lock.imports) ? lockState.lock.imports : [];
  sortPins(lockState.lock);
  return lockState;
}

export async function saveLockfile(lockState) {
  sortPins(lockState.lock);
  await saveImportLock(lockState);
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
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (normalizedPath === "." && importEntry.allowWholeSkillsTree !== true) {
    return;
  }
}

export function collectSourcePlanning(sources, upstreamById) {
  const references = [];
  const skillImports = [];

  for (let importIndex = 0; importIndex < sources.imports.length; importIndex += 1) {
    const entry = sources.imports[importIndex];
    const upstream = upstreamById.get(entry.upstream);
    if (!upstream) {
      throw new Error(`Unknown upstream '${entry.upstream}' in imports[${importIndex}].`);
    }

    const tracking = entry?.tracking === "pinned" ? "pinned" : "floating";
    const effectiveRef = upstream.provider === "git"
      ? normalizeOptionalText(entry.ref) || upstream.defaultRef || "main"
      : null;

    if (upstream.provider === "git") {
      references.push({
        upstreamId: upstream.id,
        ref: effectiveRef,
        tracking
      });
    }

    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new Error(`imports[${importIndex}] must contain one or more paths.`);
    }

    const destPrefix = normalizeDestPrefix(entry.destPrefix, upstream.id, `imports[${importIndex}]`);
    for (let pathIndex = 0; pathIndex < entry.paths.length; pathIndex += 1) {
      const rawPath = entry.paths[pathIndex];
      const selectionPath = normalizeSelectionPath(rawPath, `imports[${importIndex}].paths[${pathIndex}]`);
      assertImportPathIsNarrow(rawPath, selectionPath, entry, importIndex, pathIndex);
      const skillName = inferImportedSkillName(upstream, selectionPath);
      skillImports.push({
        provider: upstream.provider,
        sourceType: upstream.provider === "git" ? "upstream" : "local-path",
        upstreamId: upstream.id,
        ref: effectiveRef,
        tracking,
        selectionPath,
        destRelative: path.posix.join(destPrefix, skillName),
        label: `${upstream.id}:${selectionPath}${effectiveRef ? `@${effectiveRef}` : ""}`
      });
    }
  }

  return {
    references: dedupeReferences(references),
    skillImports
  };
}

async function createAdHocUpstream({ source, provider, root, ref, upstreamId }) {
  const descriptor = await normalizeSourceInput(source, { provider, root, defaultRef: ref });
  return {
    id: upstreamId || inferUpstreamIdFromSourceDescriptor(descriptor),
    ...descriptor,
    ...(descriptor.provider === "git"
      ? { defaultRef: descriptor.defaultRef || "main" }
      : {})
  };
}

async function resolveReferenceCandidatesForSkillLookup({
  upstreamId,
  ref,
  profileName,
  source,
  provider,
  root
}) {
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  let referenceCandidates = [];
  let adHocUpstream = null;

  if (source) {
    adHocUpstream = await createAdHocUpstream({ source, provider, root, ref, upstreamId: upstreamId || "adhoc" });
    upstreams.byId.set(adHocUpstream.id, adHocUpstream);
    referenceCandidates = adHocUpstream.provider === "git"
      ? [{
          upstreamId: adHocUpstream.id,
          ref: ref || adHocUpstream.defaultRef || "main",
          tracking: "floating"
        }]
      : [];
  } else if (profileName) {
    const { profile } = await resolveProfile(profileName);
    const packRoot = await resolvePack(profile);
    const { sources: packSources } = await loadPackSources(packRoot);
    const planning = collectSourcePlanning(packSources, upstreams.byId);
    referenceCandidates = [...planning.references];
  } else if (upstreamId) {
    const upstream = upstreams.byId.get(upstreamId);
    if (!upstream) {
      throw new Error(`Unknown upstream '${upstreamId}'.`);
    }
    referenceCandidates = upstream.provider === "git"
      ? [{
          upstreamId: upstream.id,
          ref: ref || upstream.defaultRef,
          tracking: "floating"
        }]
      : [];
  } else {
    referenceCandidates = upstreams.config.upstreams
      .filter((upstream) => upstream.provider === "git")
      .map((upstream) => ({
        upstreamId: upstream.id,
        ref: upstream.defaultRef,
        tracking: "floating"
      }));
  }

  if (upstreamId && !source) {
    referenceCandidates = referenceCandidates.filter((item) => item.upstreamId === upstreamId);
  }
  if (ref && !source) {
    referenceCandidates = referenceCandidates.filter((item) => item.ref === ref);
  }

  return {
    upstreams,
    lockState,
    references: referenceCandidates,
    adHocUpstream
  };
}

async function resolveInspectableUpstreams(filters) {
  const { upstreams, lockState, references, adHocUpstream } = await resolveReferenceCandidatesForSkillLookup(filters);
  const candidates = [];

  if (adHocUpstream && adHocUpstream.provider === "local-path") {
    candidates.push({
      upstream: adHocUpstream,
      ref: null,
      commit: null
    });
  } else if (filters.source && adHocUpstream) {
    const resolved = await resolveReferences({
      references,
      upstreamById: upstreams.byId,
      lockState,
      preferPinned: true,
      requirePinned: false,
      updatePins: false,
      allowLockUpdate: false
    });
    const resolvedReference = references[0]
      ? resolved.get(getLockKey(references[0].upstreamId, references[0].ref))
      : null;
    candidates.push({
      upstream: adHocUpstream,
      ref: resolvedReference?.ref ?? references[0]?.ref ?? null,
      commit: resolvedReference?.commit ?? null
    });
  } else if (filters.upstreamId) {
    const upstream = upstreams.byId.get(filters.upstreamId);
    if (!upstream) {
      throw new Error(`Unknown upstream '${filters.upstreamId}'.`);
    }
    if (upstream.provider === "local-path") {
      candidates.push({
        upstream,
        ref: null,
        commit: null
      });
    } else {
      const resolved = await resolveReferences({
        references,
        upstreamById: upstreams.byId,
        lockState,
        preferPinned: true,
        requirePinned: false,
        updatePins: false,
        allowLockUpdate: false
      });
      for (const reference of references) {
        const resolvedReference = resolved.get(getLockKey(reference.upstreamId, reference.ref));
        candidates.push({
          upstream,
          ref: resolvedReference?.ref ?? reference.ref,
          commit: resolvedReference?.commit ?? null
        });
      }
    }
  } else {
    const resolved = references.length > 0
      ? await resolveReferences({
          references,
          upstreamById: upstreams.byId,
          lockState,
          preferPinned: true,
          requirePinned: false,
          updatePins: false,
          allowLockUpdate: false
        })
      : new Map();
    for (const upstream of upstreams.config.upstreams) {
      if (upstream.provider === "local-path") {
        candidates.push({
          upstream,
          ref: null,
          commit: null
        });
        continue;
      }
      const reference = references.find((item) => item.upstreamId === upstream.id) ?? {
        upstreamId: upstream.id,
        ref: upstream.defaultRef
      };
      const resolvedReference = resolved.get(getLockKey(reference.upstreamId, reference.ref));
      candidates.push({
        upstream,
        ref: resolvedReference?.ref ?? reference.ref,
        commit: resolvedReference?.commit ?? null
      });
    }
  }

  return candidates.sort((left, right) => left.upstream.id.localeCompare(right.upstream.id));
}

async function discoverSkillsForUpstream(upstream, { ref = null, commit = null } = {}) {
  const provider = getProvider(upstream.provider);
  const result = await provider.discover(upstream, {
    ref,
    revision: commit
  });
  return {
    revision: result.revision ?? commit ?? null,
    ref: result.ref ?? ref ?? null,
    rootPath: result.rootPath,
    skills: result.skills.map((skill) => ({
      path: skill.path,
      basename: skill.path === "." ? inferImportedSkillName(upstream, ".") : path.posix.basename(skill.path),
      title: skill.title,
      summary: skill.summary,
      capabilities: Array.isArray(skill.capabilities) ? [...skill.capabilities] : [],
      frontmatter: skill.frontmatter ?? {}
    }))
  };
}

async function discoverMcpServersFromRoot(rootPath) {
  const manifestPaths = [];
  const servers = [];
  const warnings = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || entry.name !== "servers.json") {
        continue;
      }
      if (!absolute.split(path.sep).includes("mcp")) {
        continue;
      }
      const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
      manifestPaths.push(relative);
      try {
        const manifest = JSON.parse(await fs.readFile(absolute, "utf8"));
        await assertObjectMatchesSchema(manifest, SCHEMAS.mcpServers, "upstream MCP manifest");
        for (const [name, server] of Object.entries(manifest.servers ?? {})) {
          const env = {};
          if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
            for (const key of Object.keys(server.env).sort((left, right) => left.localeCompare(right))) {
              env[key] = String(server.env[key]);
            }
          }
          servers.push({
            sourcePath: relative,
            name,
            command: server.command,
            url: server.url,
            args: Array.isArray(server.args) ? server.args.map((item) => String(item)) : [],
            env
          });
        }
      } catch (error) {
        warnings.push(error.message);
      }
    }
  }

  await walk(rootPath);
  servers.sort((left, right) => {
    const leftKey = `${left.name}::${left.sourcePath}`;
    const rightKey = `${right.name}::${right.sourcePath}`;
    return leftKey.localeCompare(rightKey);
  });
  return {
    manifestPaths: manifestPaths.sort((left, right) => left.localeCompare(right)),
    servers,
    warnings
  };
}

export async function discoverUpstreamSkills(repoPath, commit, { verbose = false, upstream = null } = {}) {
  if (!upstream) {
    throw new Error("discoverUpstreamSkills now requires upstream metadata.");
  }
  const skills = await discoverSkillsForUpstream(upstream, { commit });
  if (!verbose) {
    return skills.skills.map((skill) => ({
      path: skill.path,
      basename: skill.basename,
      capabilities: skill.capabilities
    }));
  }
  return skills.skills;
}

export async function discoverUpstreamMcpServers(repoPath, commit, { upstream = null } = {}) {
  if (!upstream) {
    throw new Error("discoverUpstreamMcpServers now requires upstream metadata.");
  }
  const provider = getProvider(upstream.provider);
  const result = await provider.discover(upstream, { revision: commit });
  return discoverMcpServersFromRoot(result.rootPath);
}

function formatUpstreamForOutput(upstream) {
  return {
    id: upstream.id,
    provider: upstream.provider,
    source: upstream.provider === "local-path" ? upstream.path : upstream.repo,
    originalInput: upstream.originalInput ?? (upstream.provider === "local-path" ? upstream.path : upstream.repo),
    ...(upstream.root ? { root: upstream.root } : {}),
    ...(upstream.defaultRef ? { defaultRef: upstream.defaultRef } : {}),
    ...(upstream.displayName ? { displayName: upstream.displayName } : {})
  };
}

export async function cmdListUpstreams({ format }) {
  const upstreams = await loadUpstreamsConfig();
  const items = [...upstreams.config.upstreams].map(formatUpstreamForOutput);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ upstreams: items }, null, 2)}\n`);
    return;
  }
  for (const item of items) {
    const ref = item.defaultRef ?? "-";
    const root = item.root ?? "-";
    process.stdout.write(`${item.id}\t${item.provider}\t${ref}\t${root}\t${item.source}\n`);
  }
}

export async function cmdListUpstreamContent({
  upstream,
  ref,
  profile,
  format,
  verbose = false,
  source = null,
  provider = "auto",
  root = null
}) {
  const inspectable = await resolveInspectableUpstreams({
    upstreamId: upstream,
    ref,
    profileName: profile,
    source,
    provider,
    root
  });

  const payloadItems = [];
  for (const item of inspectable) {
    const discovered = await discoverSkillsForUpstream(item.upstream, { ref: item.ref, commit: item.commit });
    const providerInstance = getProvider(item.upstream.provider);
    const providerResult = await providerInstance.discover(item.upstream, {
      ref: item.ref,
      revision: item.commit
    });
    const mcp = await discoverMcpServersFromRoot(providerResult.rootPath);
    payloadItems.push({
      ...formatUpstreamForOutput(item.upstream),
      ref: discovered.ref,
      revision: discovered.revision,
      skills: discovered.skills.map((skill) => ({
        path: skill.path,
        basename: skill.basename,
        ...(verbose
          ? {
              title: skill.title,
              summary: skill.summary,
              capabilities: skill.capabilities,
              frontmatter: skill.frontmatter
            }
          : {})
      })),
      mcpServers: mcp.servers.map((server) => ({
        name: server.name,
        command: server.command,
        url: server.url,
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
    const revisionLabel = item.revision ? ` (${String(item.revision).slice(0, 12)})` : "";
    process.stdout.write(`${item.id} [${item.provider}]${revisionLabel}\n`);
    process.stdout.write(`Skills (${item.skills.length})\n`);
    if (item.skills.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      for (const skill of item.skills) {
        if (verbose) {
          process.stdout.write(`  ${skill.path}\t${skill.title}\t[${(skill.capabilities ?? []).join(",")}]\n`);
        } else {
          process.stdout.write(`  ${skill.path}\n`);
        }
      }
    }
    process.stdout.write(`MCP Servers (${item.mcpServers.length})\n`);
    if (item.mcpServers.length === 0) {
      process.stdout.write("  (none found in source manifests)\n");
    } else {
      for (const server of item.mcpServers) {
        const transport = server.url ? server.url : `${server.command}${server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}`;
        process.stdout.write(`  ${server.name}\t${transport}\n`);
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

function createSearchStableKey(item) {
  return `${item.sourceScope}::${item.upstream ?? "local"}::${item.path}::${item.title ?? ""}`;
}

function buildSearchFuseOptions(verbose) {
  const keys = [
    { name: "path", weight: 0.6 },
    { name: "basename", weight: 0.2 },
    { name: "summary", weight: 0.2 }
  ];
  if (verbose) {
    keys.push({ name: "title", weight: 0.3 });
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

async function collectInstalledSearchRows(profileName) {
  const resolvedProfile = normalizeOptionalText(profileName) || await readDefaultProfile();
  if (!resolvedProfile) {
    return [];
  }
  const inventoryModule = await import("./inventory.js");
  const inventory = await inventoryModule.buildProfileInventory(resolvedProfile, { detail: "full" });
  return inventory.skills.items.map((item) => ({
    sourceScope: "installed",
    upstream: item.upstream ?? null,
    provider: item.provider ?? item.sourceType,
    path: item.name,
    basename: item.basename,
    title: item.title ?? item.basename,
    summary: item.summary ?? "",
    source: item.source,
    revision: item.resolvedRevision ?? null
  }));
}

async function collectDiscoverableSearchRows({ upstream, ref, profile, verbose, source, provider, root }) {
  const inspectable = await resolveInspectableUpstreams({
    upstreamId: upstream,
    ref,
    profileName: profile,
    source,
    provider,
    root
  });

  const rows = [];
  for (const item of inspectable) {
    const discovered = await discoverSkillsForUpstream(item.upstream, { ref: item.ref, commit: item.commit });
    for (const skill of discovered.skills) {
      rows.push({
        sourceScope: "discoverable",
        upstream: item.upstream.id,
        provider: item.upstream.provider,
        path: skill.path,
        basename: skill.basename,
        title: verbose ? skill.title : undefined,
        summary: verbose ? skill.summary : "",
        source: item.upstream.provider === "local-path" ? item.upstream.path : item.upstream.repo,
        revision: discovered.revision
      });
    }
  }
  return rows;
}

export async function cmdSearchSkills({
  upstream,
  ref,
  profile,
  query,
  format,
  verbose = false,
  scope = "discoverable",
  source = null,
  provider = "auto",
  root = null
}) {
  if (!query || query.trim().length === 0) {
    throw new Error("--query <text> is required.");
  }

  const normalizedScope = String(scope || "discoverable").trim().toLowerCase();
  if (!["installed", "discoverable", "all"].includes(normalizedScope)) {
    throw new Error("Invalid --scope value. Use installed, discoverable, or all.");
  }

  const indexedRows = [];
  if (normalizedScope === "installed" || normalizedScope === "all") {
    indexedRows.push(...(await collectInstalledSearchRows(profile)));
  }
  if (normalizedScope === "discoverable" || normalizedScope === "all") {
    indexedRows.push(...(await collectDiscoverableSearchRows({ upstream, ref, profile, verbose, source, provider, root })));
  }

  const fuse = new Fuse(indexedRows, buildSearchFuseOptions(verbose));
  const ranked = fuse.search(query.trim()).sort((left, right) => {
    const leftScore = typeof left.score === "number" ? left.score : Number.POSITIVE_INFINITY;
    const rightScore = typeof right.score === "number" ? right.score : Number.POSITIVE_INFINITY;
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return createSearchStableKey(left.item).localeCompare(createSearchStableKey(right.item));
  });
  const allResults = ranked.map((row) => row.item);

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
    const prefix = result.upstream ? `${result.sourceScope}:${result.upstream}` : result.sourceScope;
    const title = result.title ? `\t${result.title}` : "";
    process.stdout.write(`${prefix}  ${result.path}${title}\n`);
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
    if (upstream.provider !== "git") {
      continue;
    }

    const repoPath = await ensureUpstreamClone(upstream);
    const pin = findPin(lockState.lock, reference.upstreamId, reference.ref);
    let commit = null;
    let resolvedRef = reference.ref;

    if (preferPinned && pin) {
      commit = pin.commit;
      await ensureCommitAvailable(repoPath, commit);
    } else if (requirePinned) {
      throw new Error(
        `Missing lock pin for upstream '${reference.upstreamId}' ref '${reference.ref}'. ` +
          "Run sync to refresh local runtime artifacts and lock state."
      );
    } else {
      const fetched = await fetchRefAndResolveCommit(repoPath, reference.ref, { repo: upstream.repo });
      commit = fetched.commit;
      resolvedRef = fetched.ref;
    }

    if ((updatePins || (!pin && allowLockUpdate)) && allowLockUpdate) {
      if (setPin(lockState.lock, reference.upstreamId, reference.ref, commit)) {
        lockState.changed = true;
      }
    }

    resolved.set(key, {
      upstream,
      ref: resolvedRef,
      commit,
      repoPath,
      pinUsed: Boolean(pin && preferPinned)
    });
  }

  return resolved;
}

export async function validateAllLockPins(lockState, upstreamById, errors) {
  for (const pin of Array.isArray(lockState.lock.pins) ? lockState.lock.pins : []) {
    const upstream = upstreamById.get(pin.upstream);
    if (!upstream) {
      errors.push(`Lock pin references unknown upstream '${pin.upstream}'.`);
      continue;
    }
    if (upstream.provider !== "git") {
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

export async function resolveImportedMaterialization(upstream, skillImport, resolvedReferences) {
  const provider = getProvider(upstream.provider);
  if (upstream.provider === "git") {
    const resolved = resolvedReferences.get(getLockKey(skillImport.upstreamId, skillImport.ref));
    if (!resolved) {
      throw new Error(`Internal error: unresolved upstream reference for ${skillImport.upstreamId}@${skillImport.ref}`);
    }
    return provider.materialize(upstream, skillImport.selectionPath, {
      ref: resolved.ref,
      revision: resolved.commit
    });
  }
  return provider.materialize(upstream, skillImport.selectionPath);
}

export async function createUpstreamFromSourceInput({ id, source, provider, root, defaultRef }) {
  const descriptor = await normalizeSourceInput(source, { provider, root, defaultRef });
  let resolvedDefaultRef = descriptor.defaultRef || null;
  if (descriptor.provider === "git" && !resolvedDefaultRef && typeof descriptor.repo === "string") {
    try {
      resolvedDefaultRef = await detectDefaultRefFromRepo(descriptor.repo);
    } catch {
      resolvedDefaultRef = null;
    }
  }
  return {
    id: normalizeOptionalText(id) || inferUpstreamIdFromSourceDescriptor(descriptor),
    ...descriptor,
    ...(descriptor.provider === "git"
      ? { defaultRef: resolvedDefaultRef || "main", type: "git" }
      : {})
  };
}
