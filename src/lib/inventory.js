import fs from "fs-extra";
import path from "node:path";
import { collectLocalSkillEntries } from "./bundle.js";
import {
  LOCAL_OVERRIDES_ROOT,
  SCHEMAS,
  assertJsonFileMatchesSchema,
  isInsidePath
} from "./core.js";
import {
  listAvailableProfiles,
  loadPackSources,
  readDefaultProfile,
  resolvePack,
  resolveProfile
} from "./config.js";
import { collectSourcePlanning, loadUpstreamsConfig } from "./upstreams.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function formatEnvAssignment(key, value) {
  const text = String(value ?? "");
  const quoted = text.length === 0 || /[\s,]/.test(text);
  return `${key}=${quoted ? JSON.stringify(text) : text}`;
}

function inferProfileSource(profilePath) {
  return isInsidePath(LOCAL_OVERRIDES_ROOT, profilePath) ? "local" : "seed";
}

function formatSkillsBlock(inventory) {
  const lines = [];
  lines.push(`Skills (${inventory.skills.total} total)`);
  lines.push(`  Local (${inventory.skills.local.length})`);
  if (inventory.skills.local.length === 0) {
    lines.push("    (none)");
  } else {
    for (const item of inventory.skills.local) {
      lines.push(`    ${item.name}`);
    }
  }

  lines.push(`  Imported (${inventory.skills.imports.length})`);
  if (inventory.skills.imports.length === 0) {
    lines.push("    (none)");
  } else {
    for (const item of inventory.skills.imports) {
      lines.push(
        `    ${item.upstream}@${item.ref}  ${item.repoPath} -> ${item.destRelative}`
      );
    }
  }
  return lines;
}

function formatMcpBlock(inventory) {
  const lines = [];
  lines.push(`MCP Servers (${inventory.mcp.total})`);
  if (inventory.mcp.servers.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const server of inventory.mcp.servers) {
    if (typeof server.url === "string" && server.url.length > 0) {
      lines.push(`  ${server.name}\t${server.url}`);
      continue;
    }
    const args = server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
    const envEntries = sortStrings(Object.keys(server.env ?? {})).map((key) =>
      formatEnvAssignment(key, server.env[key])
    );
    const env = envEntries.length > 0 ? ` [env:${envEntries.join(", ")}]` : "";
    lines.push(`  ${server.name}\t${server.command}${args}${env}`);
  }
  return lines;
}

function profileText(inventory) {
  const lines = [`Profile: ${inventory.profile.name} (${inventory.profile.source})`];
  lines.push(...formatSkillsBlock(inventory));
  lines.push(...formatMcpBlock(inventory));
  return lines.join("\n");
}

export async function buildProfileInventory(profileName) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (!normalizedProfile) {
    throw new Error("Profile name is required.");
  }

  const { profilePath, profile } = await resolveProfile(normalizedProfile);
  const packRoot = await resolvePack(profile);

  const { sources } = await loadPackSources(packRoot);
  const upstreams = await loadUpstreamsConfig();
  const planning = collectSourcePlanning(sources, upstreams.byId);

  const localSkills = (await collectLocalSkillEntries(packRoot)).map((entry) => ({
    name: entry.destRelative
  }));
  localSkills.sort((left, right) => left.name.localeCompare(right.name));

  const imports = planning.skillImports
    .map((entry) => ({
      upstream: entry.upstreamId,
      ref: entry.ref,
      repoPath: entry.repoPath,
      destRelative: entry.destRelative
    }))
    .sort((left, right) => {
      const leftKey = `${left.upstream}::${left.ref}::${left.repoPath}::${left.destRelative}`;
      const rightKey = `${right.upstream}::${right.ref}::${right.repoPath}::${right.destRelative}`;
      return leftKey.localeCompare(rightKey);
    });

  const mcpPath = path.join(packRoot, "mcp", "servers.json");
  const mcpDoc = (await fs.pathExists(mcpPath))
    ? await assertJsonFileMatchesSchema(mcpPath, SCHEMAS.mcpServers)
    : { servers: {} };
  const mcpServers = sortStrings(Object.keys(mcpDoc.servers ?? {})).map((name) => {
    const server = mcpDoc.servers[name] ?? {};
    const url = typeof server.url === "string" && server.url.trim().length > 0 ? server.url.trim() : null;
    const env = {};
    if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
      for (const key of sortStrings(Object.keys(server.env))) {
        env[key] = String(server.env[key]);
      }
    }
    if (url) {
      return {
        name,
        url
      };
    }
    return {
      name,
      command: server.command,
      args: Array.isArray(server.args) ? [...server.args] : [],
      env
    };
  });

  return {
    profile: {
      name: normalizedProfile,
      source: inferProfileSource(profilePath)
    },
    skills: {
      total: localSkills.length + imports.length,
      local: localSkills,
      imports
    },
    mcp: {
      total: mcpServers.length,
      servers: mcpServers
    }
  };
}

export async function cmdShowProfileInventory({ profile, format }) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? await readDefaultProfile();
  if (!resolvedProfile) {
    throw new Error(
      "Profile is required. Set a default first with 'use <name>'."
    );
  }

  const inventory = await buildProfileInventory(resolvedProfile);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${profileText(inventory)}\n`);
}

export async function cmdListLocalSkills({ profile, format }) {
  const explicitProfile = normalizeOptionalText(profile);
  const resolvedProfile = explicitProfile ?? await readDefaultProfile();
  if (!resolvedProfile) {
    throw new Error(
      "Profile is required. Set a default first with 'use <name>'."
    );
  }

  const { profile: profileDoc } = await resolveProfile(resolvedProfile);
  const packRoot = await resolvePack(profileDoc);
  const skills = (await collectLocalSkillEntries(packRoot))
    .map((entry) => ({ name: entry.destRelative }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          profile: resolvedProfile,
          skills
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (skills.length === 0) {
    process.stdout.write("(no local skills)\n");
    return;
  }
  for (const skill of skills) {
    process.stdout.write(`${skill.name}\n`);
  }
}

export async function cmdListEverything({ format }) {
  const profiles = await listAvailableProfiles();
  if (profiles.length === 0) {
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ profiles: [] }, null, 2)}\n`);
    } else {
      process.stdout.write("No profiles found.\n");
    }
    return;
  }

  const results = [];
  for (const item of profiles) {
    try {
      const inventory = await buildProfileInventory(item.name);
      results.push({
        profile: item.name,
        source: item.source,
        inventory
      });
    } catch (error) {
      results.push({
        profile: item.name,
        source: item.source,
        error: error.message
      });
    }
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ profiles: results }, null, 2)}\n`);
    return;
  }

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    if (item.error) {
      process.stdout.write(`Profile: ${item.profile} (${item.source})\n`);
      process.stdout.write(`Error: ${item.error}\n`);
    } else {
      process.stdout.write(profileText(item.inventory));
    }
    if (index < results.length - 1) {
      process.stdout.write("\n\n");
    } else {
      process.stdout.write("\n");
    }
  }
}
