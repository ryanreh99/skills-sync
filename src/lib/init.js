import fs from "fs-extra";
import path from "node:path";
import {
  ASSETS_ROOT,
  LOCAL_OVERRIDES_ROOT,
  SKILLS_SYNC_HOME,
  logInfo,
  logWarn,
  writeJsonFile,
  writeJsonFileIfMissing
} from "./core.js";

const DEFAULT_PROFILE_NAME = "personal";

function resolveProfileName(rawProfile) {
  if (typeof rawProfile !== "string") {
    return DEFAULT_PROFILE_NAME;
  }
  const normalized = rawProfile.trim();
  return normalized.length > 0 ? normalized : DEFAULT_PROFILE_NAME;
}

function getScaffoldFiles(localRoot, profileName) {
  const profilesDir = path.join(localRoot, "profiles");
  const packRoot = path.join(localRoot, "packs", profileName);
  const mcpDir = path.join(packRoot, "mcp");
  const skillsDir = path.join(packRoot, "skills");
  const manifestsDir = path.join(localRoot, "manifests");
  const stateDir = path.join(localRoot, "state");

  return [
    {
      path: path.join(localRoot, "README.md"),
      value: [
        "# workspace",
        "",
        "Machine-local config for skills-sync.",
        "",
        "Edit these files:",
        "- `packs/<name>/sources.json`",
        "- `packs/<name>/mcp/servers.json`",
        "- optional `profiles/<name>.json`",
        "",
        "Workflow:",
        "1. Run `use <name>`",
        "2. Run `build`",
        "3. Run `apply`",
        ""
      ].join("\n"),
      type: "text"
    },
    {
      path: path.join(profilesDir, `${profileName}.json`),
      value: {
        name: profileName,
        packPath: `workspace/packs/${profileName}`
      },
      type: "json"
    },
    {
      path: path.join(packRoot, "pack.json"),
      value: {
        name: profileName,
        version: "0.0.0",
        description: "",
        maintainer: "",
        tags: []
      },
      type: "json"
    },
    {
      path: path.join(mcpDir, "servers.json"),
      value: {
        servers: {}
      },
      type: "json"
    },
    {
      path: path.join(packRoot, "sources.json"),
      value: {
        imports: []
      },
      type: "json"
    },
    {
      path: path.join(skillsDir, ".keep"),
      value: "",
      type: "text"
    },
    {
      path: path.join(manifestsDir, ".keep"),
      value: "",
      type: "text"
    },
    {
      path: path.join(stateDir, ".keep"),
      value: "",
      type: "text"
    }
  ];
}

async function ensureWorkspaceScaffold(localRoot, profileName) {
  const files = getScaffoldFiles(localRoot, profileName);
  let created = 0;
  let skipped = 0;
  for (const file of files) {
    let wrote = false;
    if (file.type === "json") {
      wrote = await writeJsonFileIfMissing(file.path, file.value);
    } else if (!(await fs.pathExists(file.path))) {
      await fs.ensureDir(path.dirname(file.path));
      await fs.writeFile(file.path, file.value, "utf8");
      wrote = true;
    }
    if (wrote) {
      created += 1;
    } else {
      skipped += 1;
    }
  }
  return { created, skipped };
}

async function previewWorkspaceScaffold(localRoot, profileName) {
  const files = getScaffoldFiles(localRoot, profileName);
  let created = 0;
  let skipped = 0;
  for (const file of files) {
    if (await fs.pathExists(file.path)) {
      skipped += 1;
    } else {
      created += 1;
    }
  }
  return { created, skipped };
}

async function inspectDefaultProfileUpdate({ force }) {
  const configPath = path.join(LOCAL_OVERRIDES_ROOT, "config.json");
  let existing = {};
  let currentDefault = null;
  if (await fs.pathExists(configPath)) {
    existing = await fs.readJson(configPath);
    if (typeof existing.defaultProfile === "string" && existing.defaultProfile.trim().length > 0) {
      currentDefault = existing.defaultProfile.trim();
    }
  }

  if (!force && currentDefault) {
    return { shouldUpdate: false, currentDefault, existing, configPath };
  }

  return { shouldUpdate: true, currentDefault, existing, configPath };
}

async function ensureDefaultProfile({ profileName, force }) {
  const inspection = await inspectDefaultProfileUpdate({ profileName, force });
  if (!inspection.shouldUpdate) {
    return { updated: false, defaultProfile: inspection.currentDefault };
  }

  await writeJsonFile(inspection.configPath, { ...inspection.existing, defaultProfile: profileName });
  return { updated: true, defaultProfile: profileName, previousDefault: inspection.currentDefault };
}

async function previewDefaultProfile({ profileName, force }) {
  const inspection = await inspectDefaultProfileUpdate({ profileName, force });
  if (!inspection.shouldUpdate) {
    return { updated: false, defaultProfile: inspection.currentDefault };
  }
  return {
    updated: true,
    defaultProfile: profileName,
    previousDefault: inspection.currentDefault
  };
}

export async function cmdInit({ seed = false, dryRun = false, profile = null } = {}) {
  const selectedProfile = resolveProfileName(profile);
  const profileWasExplicit = typeof profile === "string" && profile.trim().length > 0;

  if (seed) {
    const seedRoot = path.join(ASSETS_ROOT, "seed");
    const localRoot = LOCAL_OVERRIDES_ROOT;
    const backupPath = path.join(SKILLS_SYNC_HOME, "workspace.backup");
    if (!(await fs.pathExists(seedRoot))) {
      throw new Error("Seed content was not found.");
    }

    if (dryRun) {
      const hasWorkspace = await fs.pathExists(localRoot);
      const existingEntries = hasWorkspace ? await fs.readdir(localRoot) : [];
      const defaultProfileResult = await previewDefaultProfile({
        profileName: selectedProfile,
        force: profileWasExplicit
      });

      logInfo(`Dry-run init --seed for profile '${selectedProfile}' complete. No files were modified.`);
      if (existingEntries.length > 0) {
        logInfo("Existing workspace would be backed up.");
      } else {
        logInfo("Seed content would be copied to workspace.");
      }
      if (defaultProfileResult.updated) {
        logInfo(`Would set default profile to '${defaultProfileResult.defaultProfile}'.`);
      } else {
        logInfo(`Default profile would remain '${defaultProfileResult.defaultProfile}'.`);
      }
      return {
        dryRun: true,
        seed: true,
        profile: selectedProfile
      };
    }

    if (await fs.pathExists(localRoot)) {
      const entries = await fs.readdir(localRoot);
      if (entries.length > 0) {
        await fs.remove(backupPath);
        await fs.move(localRoot, backupPath);
        logWarn("Backed up existing workspace.");
      } else {
        await fs.remove(localRoot);
      }
    }
    await fs.copy(seedRoot, localRoot, { overwrite: true, errorOnExist: false });
    const scaffold = await ensureWorkspaceScaffold(localRoot, selectedProfile);
    const defaultProfileResult = await ensureDefaultProfile({
      profileName: selectedProfile,
      force: profileWasExplicit
    });
    logInfo(`Initialized workspace from seed for profile '${selectedProfile}'.`);
    if (scaffold.created > 0) {
      logInfo(
        `Created ${scaffold.created} additional workspace files for profile '${selectedProfile}', skipped ${scaffold.skipped}.`
      );
    }
    if (defaultProfileResult.updated) {
      logInfo(`Default profile set to '${defaultProfileResult.defaultProfile}'.`);
    }
    process.stdout.write("\n");
    process.stdout.write("Next steps:\n");
    process.stdout.write("  1) Run: build\n");
    process.stdout.write("  2) Run: apply\n");
    return;
  }

  const localRoot = LOCAL_OVERRIDES_ROOT;
  if (dryRun) {
    const scaffold = await previewWorkspaceScaffold(localRoot, selectedProfile);
    const defaultProfileResult = await previewDefaultProfile({
      profileName: selectedProfile,
      force: profileWasExplicit
    });

    logInfo(`Dry-run init for profile '${selectedProfile}' complete. No files were modified.`);
    logInfo(`Would create ${scaffold.created} files, skip ${scaffold.skipped} existing files.`);
    if (defaultProfileResult.updated) {
      logInfo(`Would set default profile to '${defaultProfileResult.defaultProfile}'.`);
    } else {
      logInfo(`Default profile would remain '${defaultProfileResult.defaultProfile}'.`);
    }
    return {
      dryRun: true,
      seed: false,
      profile: selectedProfile,
      created: scaffold.created,
      skipped: scaffold.skipped
    };
  }

  const { created, skipped } = await ensureWorkspaceScaffold(localRoot, selectedProfile);
  const defaultProfileResult = await ensureDefaultProfile({
    profileName: selectedProfile,
    force: profileWasExplicit
  });

  logInfo(`Initialized workspace for profile '${selectedProfile}'.`);
  logInfo(`Created ${created} files for profile '${selectedProfile}', skipped ${skipped} existing files.`);
  if (defaultProfileResult.updated) {
    logInfo(`Default profile set to '${defaultProfileResult.defaultProfile}'.`);
  } else {
    logInfo(`Default profile remains '${defaultProfileResult.defaultProfile}'.`);
  }
  process.stdout.write("\n");
  process.stdout.write("Next steps:\n");
  process.stdout.write(`  1) Run: use ${selectedProfile}\n`);
  process.stdout.write("  2) Run: build\n");
  process.stdout.write("  3) Run: apply\n");
  process.stdout.write("  4) Run: doctor\n");
}
