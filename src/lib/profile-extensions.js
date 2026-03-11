import fs from "fs-extra";
import path from "node:path";
import { buildProfile } from "./build.js";
import { cmdApply } from "./bindings.js";
import { loadImportLock, saveImportLock, upsertImportRecord } from "./import-lock.js";
import { getAgentRegistryById } from "./agent-registry.js";
import { buildProfileInventory } from "./inventory.js";
import { getProvider } from "./providers/index.js";
import { loadEffectiveProfileState } from "./profile-runtime.js";
import { collectSourcePlanning, loadUpstreamsConfig } from "./upstreams.js";
import { LOCAL_OVERRIDES_ROOT, logInfo, writeJsonFile } from "./core.js";
import { resolvePack, resolveProfile } from "./config.js";
import { getNormalizedSourceDescriptor } from "./source-normalization.js";
import {
  accent,
  formatBadge,
  muted,
  renderKeyValueRows,
  renderSection,
  renderSimpleList,
  renderTable,
  success,
  warning
} from "./terminal-ui.js";

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

function toneForImportFlag(flag) {
  switch (flag) {
    case "imported":
      return "success";
    case "imported-local":
      return "accent";
    case "stale":
      return "warning";
    case "pinned":
      return "accent";
    case "floating":
      return "muted";
    default:
      return "muted";
  }
}

function formatImportState(flags, staleProjectionAgents) {
  const badges = (Array.isArray(flags) ? flags : []).map((flag) =>
    formatBadge(flag, toneForImportFlag(flag), process.stdout)
  );
  if (Array.isArray(staleProjectionAgents) && staleProjectionAgents.length > 0) {
    badges.push(formatBadge(`projection:${staleProjectionAgents.join(",")}`, "warning", process.stdout));
  }
  return badges.length > 0 ? badges.join(" ") : muted("(none)", process.stdout);
}

function formatRefreshStatus(status) {
  switch (status) {
    case "changed":
      return warning(status, process.stdout);
    case "unchanged":
      return success(status, process.stdout);
    case "pinned":
      return accent(status, process.stdout);
    case "error":
      return warning(status, process.stdout);
    default:
      return status;
  }
}

export async function cmdProfileInspect({ profile, format = "text" }) {
  const profileName = normalizeRequiredText(profile, "Profile name");
  const inventory = await buildProfileInventory(profileName, { detail: "full" });
  const agentRegistryById = await getAgentRegistryById();
  const imported = inventory.skills.items.filter((item) => item.sourceType === "imported");
  const summary = {
    imports: imported.length,
    stale: imported.filter((item) => item.flags.includes("stale")).length,
    pinned: imported.filter((item) => item.flags.includes("pinned")).length,
    floating: imported.filter((item) => item.flags.includes("floating")).length,
    projectionStale: imported.filter((item) =>
      Object.entries(item.projectionAdapters ?? {}).some(
        ([agentId, adapter]) => (agentRegistryById.get(agentId)?.projectionVersion ?? 1) !== adapter.contractVersion
      )
    ).length,
    featureWarnings: imported.reduce(
      (count, item) => count + item.materializedAgents.reduce((inner, agent) => inner + agent.unsupportedFeatures.length, 0),
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

  const lines = [renderSection("Profile", { stream: process.stdout })];
  lines.push(
    renderKeyValueRows(
      [
        { key: "Name", value: accent(inventory.profile.name, process.stdout) },
        { key: "Imported Skills", value: String(summary.imports) },
        { key: "Stale Imports", value: summary.stale > 0 ? warning(String(summary.stale), process.stdout) : success("0", process.stdout) },
        { key: "Pinned", value: String(summary.pinned) },
        { key: "Floating", value: String(summary.floating) },
        {
          key: "Projection Stale",
          value: summary.projectionStale > 0 ? warning(String(summary.projectionStale), process.stdout) : success("0", process.stdout)
        },
        {
          key: "Feature Warnings",
          value: summary.featureWarnings > 0
            ? warning(String(summary.featureWarnings), process.stdout)
            : success("0", process.stdout)
        }
      ],
      { stream: process.stdout }
    )
  );
  lines.push("");
  lines.push(renderSection("Imports", { count: imported.length, stream: process.stdout }));
  if (imported.length === 0) {
    lines.push(renderSimpleList([], { empty: "(none)" }));
  } else {
    lines.push(
      renderTable(
        ["Name", "Source", "State"],
        imported.map((item) => {
          const staleProjectionAgents = Object.entries(item.projectionAdapters ?? {})
            .filter(([agentId, adapter]) => (agentRegistryById.get(agentId)?.projectionVersion ?? 1) !== adapter.contractVersion)
            .map(([agentId]) => agentId)
            .sort((left, right) => left.localeCompare(right));
          return [
            item.name,
            `${item.upstream}:${item.selectionPath}`,
            formatImportState(item.flags, staleProjectionAgents)
          ];
        }),
        { stream: process.stdout }
      )
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
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
        const installedAt = record?.installedAt ?? new Date().toISOString();
        upsertImportRecord(lockState.lock, {
          profile: profileName,
          upstream: entry.upstreamId,
          provider: upstreamDoc.provider,
          originalInput: upstreamDoc.originalInput ?? (upstreamDoc.provider === "local-path" ? upstreamDoc.path : upstreamDoc.repo),
          selectionPath: entry.selectionPath,
          destRelative: entry.destRelative,
          ...(entry.ref ? { ref: entry.ref } : {}),
          tracking: entry.tracking,
          resolvedRevision: nextRevision,
          latestRevision: nextRevision,
          contentHash: nextHash,
          installedAt,
          refreshedAt: new Date().toISOString(),
          capabilities: materialized.capabilities,
          materializedAgents: record?.materializedAgents ?? [],
          sourceIdentity: upstreamDoc.sourceIdentity,
          source: {
            provider: upstreamDoc.provider,
            originalInput: upstreamDoc.originalInput ?? (upstreamDoc.provider === "local-path" ? upstreamDoc.path : upstreamDoc.repo),
            identity: upstreamDoc.sourceIdentity,
            descriptor: getNormalizedSourceDescriptor(upstreamDoc)
          },
          resolution: {
            tracking: entry.tracking,
            ...(entry.ref ? { ref: entry.ref } : {}),
            resolvedRevision: nextRevision,
            latestRevision: nextRevision
          },
          digests: {
            contentSha256: nextHash
          },
          projection: {
            adapters: record?.projection?.adapters ?? {},
            materializedAgents: record?.materializedAgents ?? []
          },
          refresh: {
            installedAt,
            lastRefreshedAt: new Date().toISOString(),
            lastOutcome: didChange ? "changed" : "unchanged",
            changed: didChange
          },
          eval: {
            status: record?.eval?.status ?? "pending",
            updatedAt: record?.eval?.updatedAt ?? null
          }
        });
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

  const lines = [renderSection("Profile Refresh", { stream: process.stdout })];
  lines.push(
    renderKeyValueRows(
      [
        { key: "Profile", value: accent(profileName, process.stdout) },
        { key: "Mode", value: dryRun ? warning("dry-run", process.stdout) : success("apply", process.stdout) },
        { key: "Changed", value: String(summary.changed) },
        { key: "Unchanged", value: String(summary.unchanged) },
        { key: "Pinned", value: String(summary.pinned) },
        { key: "Errors", value: summary.errors > 0 ? warning(String(summary.errors), process.stdout) : success("0", process.stdout) }
      ],
      { stream: process.stdout }
    )
  );
  lines.push("");
  lines.push(renderSection("Results", { count: rows.length, stream: process.stdout }));
  if (rows.length === 0) {
    lines.push(renderSimpleList([], { empty: "(none)" }));
  } else {
    lines.push(
      renderTable(
        ["Target", "Status", "Detail"],
        rows.map((row) => [
          `${row.upstream}:${row.path}`,
          formatRefreshStatus(row.status),
          row.status === "error"
            ? warning(row.error, process.stdout)
            : row.nextRevision ?? row.resolvedRevision ?? muted("-", process.stdout)
        ]),
        { stream: process.stdout }
      )
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
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

  const lines = [renderSection("Profile Diff", { stream: process.stdout })];
  lines.push(
    renderKeyValueRows(
      [
        { key: "Left", value: accent(leftProfile, process.stdout) },
        { key: "Right", value: accent(rightProfile, process.stdout) }
      ],
      { stream: process.stdout }
    )
  );
  lines.push("");
  lines.push(renderSection("Skills", { stream: process.stdout }));
  lines.push(
    renderKeyValueRows(
      [
        { key: `Only In ${leftProfile}`, value: skillDiff.onlyLeft.join(", ") || muted("(none)", process.stdout) },
        { key: `Only In ${rightProfile}`, value: skillDiff.onlyRight.join(", ") || muted("(none)", process.stdout) }
      ],
      { stream: process.stdout }
    )
  );
  lines.push("");
  lines.push(renderSection("MCP Servers", { stream: process.stdout }));
  lines.push(
    renderKeyValueRows(
      [
        { key: `Only In ${leftProfile}`, value: mcpDiff.onlyLeft.join(", ") || muted("(none)", process.stdout) },
        { key: `Only In ${rightProfile}`, value: mcpDiff.onlyRight.join(", ") || muted("(none)", process.stdout) }
      ],
      { stream: process.stdout }
    )
  );
  process.stdout.write(`${lines.join("\n")}\n`);
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
