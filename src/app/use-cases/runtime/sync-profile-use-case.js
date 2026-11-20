import fs from "node:fs/promises";
import path from "node:path";
import { applyBindings, cmdApply } from "../../../infra/internal/bindings.js";
import { buildProfile } from "../../../infra/internal/build.js";
import { readDefaultProfile } from "../../../infra/internal/config.js";
import { RUNTIME_INTERNAL_ROOT } from "../../../infra/internal/core.js";
import { normalizeOptionalText } from "../../../shared/text.js";

async function readRuntimeBundleProfile() {
  const bundlePath = path.join(RUNTIME_INTERNAL_ROOT, "common", "bundle.json");
  try {
    const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
    return normalizeOptionalText(bundle?.profile);
  } catch {
    return null;
  }
}

export async function runSyncProfileUseCase({
  profileName,
  shouldBuild = true,
  dryRun = false,
  entities = null,
  resolveMissingProfile = null
} = {}) {
  let resolvedProfile = normalizeOptionalText(profileName) ?? await readDefaultProfile();
  if (shouldBuild) {
    if (!resolvedProfile) {
      if (typeof resolveMissingProfile !== "function") {
        throw new Error("An active profile is required. Set one with 'use <name>'.");
      }
      resolvedProfile = await resolveMissingProfile();
    }
    await buildProfile(resolvedProfile, { lockMode: "write", suggestNextStep: false });
  }

  const gateProfile = resolvedProfile ?? await readRuntimeBundleProfile();
  const applyProfile = resolvedProfile ?? gateProfile;
  if (dryRun) {
    return applyBindings(applyProfile, {
      dryRun: true,
      entities
    });
  }
  return cmdApply(applyProfile, { entities });
}

export async function runPostMutationSyncUseCase({
  profileName,
  noSync = false,
  build = false,
  apply = false,
  resolveMissingProfile = null
} = {}) {
  if (noSync === true) {
    if (apply === true) {
      await runSyncProfileUseCase({
        profileName,
        shouldBuild: true,
        resolveMissingProfile
      });
      return;
    }
    if (build === true) {
      await buildProfile(profileName, { lockMode: "write", suggestNextStep: false });
    }
    return;
  }

  await runSyncProfileUseCase({
    profileName,
    shouldBuild: true,
    resolveMissingProfile
  });
}
