import fs from "fs-extra";
import path from "node:path";
import { buildProfile } from "./build.js";
import { cmdApply } from "./bindings.js";
import { loadImportLock, saveImportLock } from "./import-lock.js";
import { buildProfileInventory } from "./inventory.js";
import { getProvider } from "./providers/index.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { collectSourcePlanning, loadUpstreamsConfig } from "./upstreams.js";
import { LOCAL_OVERRIDES_ROOT, logInfo, writeJsonFile } from "./core.js";
import { resolvePack, resolveProfile } from "./config.js";

function normalizeRequiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function asPathSet(values) {
  return new Set(
    (Array.isArray(values) ? values : []).map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
  );
}

function summarizeRefreshRows(rows) {
  return {
    changed: rows.filter((row) => row.status === "changed").length,
    unchanged: rows.filter((row) => row.status === "unchanged").length,
    pinned: rows.filter((row) => row.status === "pinned").length,
    errors: rows.filter((row) => row.status === "error").length
  };
}

export async function cmdProfileInspect({ profile, format = "text" }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const inventory = await buildProfileInventory(profileName, { detail: "full" });
  const imported = inventory.skills.items.filter((item) => item.sourceType === "imported");
  const summary = {
    imports: imported.length,
    stale: imported.filter((item) => item.flags.includes("stale")).length,
    pinned: imported.filter((item) => item.flags.includes("pinned")).length,
    floating: imported.filter((item) => item.flags.includes("floating")).length,
    capabilityMismatches: imported.reduce(
      (count, item) => count + item.materializedAgents.reduce((inner, agent) => inner + agent.capabilityMismatches.length, 0),
      0
    )
  };

  const payload = {
    profile: inventory.profile,
    summary,
    imports: imported
  };

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Profile: ${inventory.profile.name}\n`);
  process.stdout.write(
    `Imported skills: ${summary.imports} | stale: ${summary.stale} | pinned: ${summary.pinned} | floating: ${summary.floating}\n`
  );
  process.stdout.write(`Capability mismatches: ${summary.capabilityMismatches}\n`);
  for (const item of imported) {
    process.stdout.write(`  ${item.name}\t${item.upstream}:${item.selectionPath}\t${item.flags.join(",")}\n`);
  }
}

export async function cmdProfileRefresh({
  profile,
  upstream = null,
  skillPaths = [],
  all = false,
  dryRun = false,
  build = false,
  apply = false,
  format = "text"
}) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const effectiveState = await loadEffectiveProfileState(profileName);
  const upstreams = await loadUpstreamsConfig();
  const planning = collectSourcePlanning(effectiveState.effectiveSources, upstreams.byId);
  const pathFilter = asPathSet(skillPaths);
  const lockState = await loadImportLock();
  const rows = [];
  let changed = false;

  for (const entry of planning.skillImports) {
    if (upstream && entry.upstreamId !== upstream) {
      continue;
    }
    if (!all && pathFilter.size > 0 && !pathFilter.has(entry.selectionPath)) {
      continue;
    }
    if (!all && pathFilter.size === 0 && upstream && entry.upstreamId !== upstream) {
      continue;
    }

    const upstreamDoc = upstreams.byId.get(entry.upstreamId);
    if (!upstreamDoc) {
      continue;
    }

    const provider = getProvider(upstreamDoc.provider);
    const record = (lockState.lock.imports ?? []).find(
      (item) =>
        item.profile === profileName &&
        item.upstream === entry.upstreamId &&
        item.selectionPath === entry.selectionPath &&
        item.destRelative === entry.destRelative
    );

    try {
      if (entry.tracking === "pinned" && upstreamDoc.provider === "git") {
        rows.push({
          upstream: entry.upstreamId,
          path: entry.selectionPath,
          status: "pinned",
          resolvedRevision: record?.resolvedRevision ?? null
        });
        continue;
      }

      const materialized = await provider.refresh(upstreamDoc, entry.selectionPath, {
        ref: entry.ref || upstreamDoc.defaultRef || undefined
      });
      const nextRevision = materialized.resolvedRevision ?? null;
      const nextHash = materialized.contentHash;
      const didChange =
        (record?.resolvedRevision ?? null) !== nextRevision ||
        (record?.contentHash ?? null) !== nextHash;

      rows.push({
        upstream: entry.upstreamId,
        path: entry.selectionPath,
        status: didChange ? "changed" : "unchanged",
        previousRevision: record?.resolvedRevision ?? null,
        nextRevision,
        previousHash: record?.contentHash ?? null,
        nextHash
      });

      if (!dryRun) {
        const target = record ?? {
          profile: profileName,
          upstream: entry.upstreamId,
          provider: upstreamDoc.provider,
          originalInput: upstreamDoc.originalInput ?? (upstreamDoc.provider === "local-path" ? upstreamDoc.path : upstreamDoc.repo),
          selectionPath: entry.selectionPath,
          destRelative: entry.destRelative,
          installedAt: new Date().toISOString()
        };
        target.ref = entry.ref ?? target.ref;
        target.tracking = entry.tracking;
        target.resolvedRevision = nextRevision;
        target.latestRevision = nextRevision;
        target.contentHash = nextHash;
        target.refreshedAt = new Date().toISOString();
        target.capabilities = materialized.capabilities;
        target.title = materialized.title;
        target.summary = materialized.summary;
        if (!record) {
          lockState.lock.imports.push(target);
        }
        changed = changed || didChange;
      }
    } catch (error) {
      rows.push({
        upstream: entry.upstreamId,
        path: entry.selectionPath,
        status: "error",
        error: error.message
      });
    }
  }

  if (!dryRun && changed) {
    await saveImportLock(lockState);
  }
  if (!dryRun && changed && (build === true || apply === true)) {
    await buildProfile(profileName, { lockMode: "write" });
    if (apply === true) {
      await cmdApply(profileName);
    }
  }

  const summary = summarizeRefreshRows(rows);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ profile: profileName, dryRun, summary, results: rows }, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `Profile refresh ${dryRun ? "(dry-run) " : ""}for '${profileName}': changed=${summary.changed} unchanged=${summary.unchanged} pinned=${summary.pinned} errors=${summary.errors}\n`
  );
  for (const row of rows) {
    if (row.status === "error") {
      process.stdout.write(`  ${row.upstream}:${row.path}\terror\t${row.error}\n`);
      continue;
    }
    process.stdout.write(`  ${row.upstream}:${row.path}\t${row.status}\n`);
  }
}

export async function cmdProfileNewSkill({
  profile,
  name,
  skillPath = null,
  frontmatter = false,
  includeScripts = false,
  includeReferences = false
}) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const skillName = normalizeRequiredText(name, "Skill name");
  const { profile: profileDoc } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profileDoc);
  const targetRoot = skillPath
    ? path.resolve(skillPath)
    : path.join(packRoot, "skills", skillName);

  if (await fs.pathExists(targetRoot)) {
    throw new Error(`Skill path '${targetRoot}' already exists.`);
  }

  await fs.ensureDir(targetRoot);
  if (includeScripts) {
    await fs.ensureDir(path.join(targetRoot, "scripts"));
    await fs.writeFile(path.join(targetRoot, "scripts", ".keep"), "", "utf8");
  }
  if (includeReferences) {
    await fs.ensureDir(path.join(targetRoot, "references"));
    await fs.writeFile(path.join(targetRoot, "references", ".keep"), "", "utf8");
  }

  const frontmatterBlock = frontmatter
    ? [
        "---",
        `title: ${skillName}`,
        "summary: Add a concise summary here.",
        "---",
        ""
      ].join("\n")
    : "";

  await fs.writeFile(
    path.join(targetRoot, "SKILL.md"),
    [
      frontmatterBlock,
      `# ${skillName}`,
      "",
      "Describe when this skill should be used.",
      "",
      "## Workflow",
      "",
      "1. Define the task this skill solves.",
      "2. Add any implementation guidance, scripts, references, or assets needed by the skill.",
      ""
    ].join("\n"),
    "utf8"
  );

  logInfo(`Created skill scaffold at '${targetRoot}'.`);
}

function diffSets(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    onlyLeft: [...leftSet].filter((item) => !rightSet.has(item)).sort((a, b) => a.localeCompare(b)),
    onlyRight: [...rightSet].filter((item) => !leftSet.has(item)).sort((a, b) => a.localeCompare(b))
  };
}

export async function cmdProfileDiff({ left, right, format = "text" }) {
  const leftProfile = normalizeRequiredText(left, "Left profile");
  const rightProfile = normalizeRequiredText(right, "Right profile");
  const leftInventory = await buildProfileInventory(leftProfile, { detail: "full" });
  const rightInventory = await buildProfileInventory(rightProfile, { detail: "full" });
  const skillDiff = diffSets(
    leftInventory.skills.items.map((item) => item.name),
    rightInventory.skills.items.map((item) => item.name)
  );
  const mcpDiff = diffSets(
    leftInventory.mcp.servers.map((item) => item.name),
    rightInventory.mcp.servers.map((item) => item.name)
  );

  const payload = {
    left: leftProfile,
    right: rightProfile,
    skills: skillDiff,
    mcps: mcpDiff
  };
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Profile diff: ${leftProfile} vs ${rightProfile}\n`);
  process.stdout.write(`  skills only in ${leftProfile}: ${skillDiff.onlyLeft.join(", ") || "(none)"}\n`);
  process.stdout.write(`  skills only in ${rightProfile}: ${skillDiff.onlyRight.join(", ") || "(none)"}\n`);
  process.stdout.write(`  mcps only in ${leftProfile}: ${mcpDiff.onlyLeft.join(", ") || "(none)"}\n`);
  process.stdout.write(`  mcps only in ${rightProfile}: ${mcpDiff.onlyRight.join(", ") || "(none)"}\n`);
}

export async function cmdProfileClone({ source, target }) {
  const sourceName = normalizeRequiredText(source, "Source profile");
  const targetName = normalizeRequiredText(target, "Target profile");
  const sourceResolved = await resolveProfile(sourceName);
  const sourcePackRoot = await resolvePack(sourceResolved.profile);
  const targetProfilePath = path.join(LOCAL_OVERRIDES_ROOT, "profiles", `${targetName}.json`);
  const targetPackRoot = path.join(LOCAL_OVERRIDES_ROOT, "packs", targetName);

  if (await fs.pathExists(targetProfilePath)) {
    throw new Error(`Profile '${targetName}' already exists.`);
  }

  await fs.ensureDir(path.dirname(targetProfilePath));
  await fs.copy(sourcePackRoot, targetPackRoot);
  await writeJsonFile(targetProfilePath, {
    schemaVersion: 2,
    name: targetName,
    packPath: `workspace/packs/${targetName}`,
    description: sourceResolved.profile.description ?? "",
    ...(sourceResolved.profile.extends ? { extends: sourceResolved.profile.extends } : {}),
    ...(sourceResolved.profile.agentOverrides ? { agentOverrides: sourceResolved.profile.agentOverrides } : {})
  });
  logInfo(`Cloned profile '${sourceName}' to '${targetName}'.`);
}
