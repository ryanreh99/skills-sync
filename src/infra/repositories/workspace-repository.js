import path from "node:path";
import { SCHEMAS, assertJsonFileMatchesSchema } from "../internal/core.js";
import { resolvePack, resolveProfile } from "../internal/config.js";
import { loadEffectiveProfileState } from "../internal/profile-runtime.js";
import {
  collectSourcePlanning,
  loadLockfile,
  loadUpstreamsConfig,
  resolveReferences,
  validateAllLockPins
} from "../internal/upstreams.js";
import { loadAgentIntegrations } from "../internal/agent-integrations.js";

export async function loadDoctorDependencies() {
  await loadAgentIntegrations();
  const upstreams = await loadUpstreamsConfig();
  const lockState = await loadLockfile();
  if (lockState.exists) {
    await assertJsonFileMatchesSchema(lockState.path, SCHEMAS.upstreamsLock);
  }
  return {
    upstreams,
    lockState
  };
}

export async function loadProfileDoctorContext(profileName) {
  const { profilePath, profile } = await resolveProfile(profileName);
  const packRoot = await resolvePack(profile);
  const effectiveState = await loadEffectiveProfileState(profileName);
  await assertJsonFileMatchesSchema(profilePath, SCHEMAS.profile);
  await assertJsonFileMatchesSchema(path.join(packRoot, "pack.json"), SCHEMAS.packManifest);

  return {
    profilePath,
    profile,
    packRoot,
    effectiveState
  };
}

export function collectProfileSourcePlanning(effectiveState, upstreamById) {
  const sources = effectiveState.effectiveSources;
  return collectSourcePlanning(sources, upstreamById);
}

export async function resolveProfileReferences({ references, upstreamById, lockState }) {
  if (references.length === 0) {
    return new Map();
  }
  return resolveReferences({
    references,
    upstreamById,
    lockState,
    preferPinned: true,
    requirePinned: true,
    updatePins: false,
    allowLockUpdate: false
  });
}

export async function validateProfileLockPins(lockState, upstreamById, report) {
  await validateAllLockPins(lockState, upstreamById, report.errors);
}
