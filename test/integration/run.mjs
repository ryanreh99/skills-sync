#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  repoRoot,
  testHomePath,
  localOverridesPath,
  distPath,
  runCli,
  movePathIfExists,
  listBackupDirs
} from "./helpers.mjs";
import { writeTargetsOverride, seedUserConfigs } from "./fixtures.mjs";
import * as suiteInit from "./suites/init.mjs";
import * as suiteBuild from "./suites/build.mjs";
import * as suiteProfiles from "./suites/profiles.mjs";
import * as suiteManage from "./suites/manage.mjs";
import * as suiteList from "./suites/list.mjs";
import * as suiteSearch from "./suites/search.mjs";
import * as suiteDetect from "./suites/detect.mjs";
import * as suiteHelp from "./suites/help.mjs";
import * as suiteUnknown from "./suites/unknown.mjs";
import * as suiteApply from "./suites/apply.mjs";
import * as suiteAgent from "./suites/agent.mjs";
import * as suiteUnlink from "./suites/unlink.mjs";
import * as suiteDoctor from "./suites/doctor.mjs";
import * as suiteSync from "./suites/sync.mjs";

const runtimePath = path.join(repoRoot, ".tmp-test-runtime");
const localBackupPath = path.join(testHomePath, ".tmp-test-workspace-backup");
const distBackupPath = path.join(testHomePath, ".tmp-test-runtime-internal-backup");

const ctx = {
  repoRoot,
  localOverridesPath,
  distPath,
  runtimePath
};

async function runSuite(name, fn) {
  process.stdout.write(`[tests] Running suite: ${name}\n`);
  await fn();
}

async function runTests() {
  const beforeBackups = new Set(await listBackupDirs());
  const hadLocalOverrides = await movePathIfExists(localOverridesPath, localBackupPath);
  const hadDist = await movePathIfExists(distPath, distBackupPath);

  await fs.rm(runtimePath, { recursive: true, force: true });

  try {
    // Phase 1: scaffold and basic build output
    await runSuite("init", () => suiteInit.run(ctx));

    // Phase 2: build lock-mode behaviour (workspace exists from init --seed)
    await runSuite("build", () => suiteBuild.run(ctx));

    // Phase 3: profile management commands
    await runSuite("profiles (use/current/ls/new/remove)", () => suiteProfiles.run(ctx));

    // Phase 3b: profile/upstream mutation and inventory commands
    await runSuite("manage (profile/upstream inventory + mutations)", () => suiteManage.run(ctx));

    // Phase 4: upstream-list and search
    await runSuite("list skills", () => suiteList.run(ctx));
    await runSuite("search skills", () => suiteSearch.run(ctx));

    // Phase 5: standalone informational commands
    await runSuite("detect", () => suiteDetect.run(ctx));
    await runSuite("help", () => suiteHelp.run(ctx));

    // Phase 6: unknown/removed command rejection
    await runSuite("unknown commands", () => suiteUnknown.run(ctx));

    // Phase 7: integration - wire up test-scoped targets, seed user configs, rebuild
    await writeTargetsOverride(localOverridesPath, runtimePath);
    await seedUserConfigs(runtimePath);
    runCli(["build", "--profile", "personal"]);

    // Phase 8: apply / unlink integration (depends on Phase 7 build)
    await runSuite("apply", () => suiteApply.run(ctx));
    await runSuite("agent inventory/drift", () => suiteAgent.run(ctx));
    await runSuite("unlink", () => suiteUnlink.run(ctx));

    // Phase 9: doctor (depends on runtime artifacts from Phase 7)
    await runSuite("doctor", () => suiteDoctor.run(ctx));

    // Phase 10: sync UX and mutation auto-sync behaviour
    await runSuite("sync", () => suiteSync.run(ctx));
  } finally {
    await fs.rm(localOverridesPath, { recursive: true, force: true });
    await fs.rm(distPath, { recursive: true, force: true });
    await fs.rm(runtimePath, { recursive: true, force: true });

    if (hadLocalOverrides) {
      await fs.rename(localBackupPath, localOverridesPath);
    } else {
      await fs.rm(localBackupPath, { recursive: true, force: true });
    }
    if (hadDist) {
      await fs.rename(distBackupPath, distPath);
    } else {
      await fs.rm(distBackupPath, { recursive: true, force: true });
    }

    const afterBackups = await listBackupDirs();
    for (const folder of afterBackups) {
      if (!beforeBackups.has(folder)) {
        await fs.rm(path.join(testHomePath, folder), { recursive: true, force: true });
      }
    }
    await fs.rm(testHomePath, { recursive: true, force: true });
  }
}

runTests()
  .then(() => {
    process.stdout.write("[tests] All checks passed.\n");
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
