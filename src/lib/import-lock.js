import { LOCKFILE_PATH, SCHEMAS, assertJsonFileMatchesSchema, writeJsonFile } from "./core.js";
import fs from "fs-extra";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeMaterializedAgents(values) {
  const entries = Array.isArray(values) ? values : [];
  return entries
    .map((entry) => ({
      id: normalizeOptionalText(entry?.id),
      mode: normalizeOptionalText(entry?.mode) ?? normalizeOptionalText(entry?.installMode) ?? "unknown",
      ...(normalizeOptionalText(entry?.appliedAt) ? { appliedAt: entry.appliedAt.trim() } : {})
    }))
    .filter((entry) => entry.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeProjectionAdapters(value) {
  const adapters = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const adapterId of Object.keys(adapters).sort((left, right) => left.localeCompare(right))) {
    const adapter = adapters[adapterId];
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
      continue;
    }
    normalized[adapterId] = {
      contractVersion: Number.isInteger(adapter.contractVersion) ? adapter.contractVersion : 1,
      ...(normalizeOptionalText(adapter.skillsMethod) ? { skillsMethod: adapter.skillsMethod.trim() } : {}),
      ...(normalizeOptionalText(adapter.mcpMethod) ? { mcpMethod: adapter.mcpMethod.trim() } : {})
    };
  }
  return normalized;
}

function normalizePinRecord(pin) {
  const sourceDescriptor =
    pin?.sourceDescriptor && typeof pin.sourceDescriptor === "object" && !Array.isArray(pin.sourceDescriptor)
      ? { ...pin.sourceDescriptor }
      : {};
  const resolvedRevision = normalizeOptionalText(pin?.resolvedRevision) || normalizeOptionalText(pin?.commit);
  if (!normalizeOptionalText(pin?.upstream) || !normalizeOptionalText(pin?.ref) || !resolvedRevision) {
    return null;
  }
  return {
    upstream: pin.upstream.trim(),
    ref: pin.ref.trim(),
    resolvedRevision,
    ...(normalizeOptionalText(pin?.sourceIdentity) ? { sourceIdentity: pin.sourceIdentity.trim() } : {}),
    sourceDescriptor,
    ...(normalizeOptionalText(pin?.updatedAt) ? { updatedAt: pin.updatedAt.trim() } : {})
  };
}

function normalizeImportRecord(record) {
  const source = record?.source && typeof record.source === "object" && !Array.isArray(record.source) ? record.source : {};
  const resolution =
    record?.resolution && typeof record.resolution === "object" && !Array.isArray(record.resolution) ? record.resolution : {};
  const digests =
    record?.digests && typeof record.digests === "object" && !Array.isArray(record.digests) ? record.digests : {};
  const projection =
    record?.projection && typeof record.projection === "object" && !Array.isArray(record.projection) ? record.projection : {};
  const refresh =
    record?.refresh && typeof record.refresh === "object" && !Array.isArray(record.refresh) ? record.refresh : {};
  const evalState = record?.eval && typeof record.eval === "object" && !Array.isArray(record.eval) ? record.eval : {};
  const capabilities = [...new Set((Array.isArray(record?.capabilities) ? record.capabilities : []).map((item) => String(item).trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  );

  const profile = normalizeOptionalText(record?.profile);
  const upstream = normalizeOptionalText(record?.upstream);
  const selectionPath = normalizeOptionalText(record?.selectionPath);
  const destRelative = normalizeOptionalText(record?.destRelative);
  if (!profile || !upstream || !selectionPath || !destRelative) {
    return null;
  }

  const provider = normalizeOptionalText(source.provider) || normalizeOptionalText(record?.provider);
  const originalInput = normalizeOptionalText(source.originalInput) || normalizeOptionalText(record?.originalInput);
  const sourceIdentity = normalizeOptionalText(source.identity) || normalizeOptionalText(record?.sourceIdentity);
  const descriptor = source.descriptor && typeof source.descriptor === "object" && !Array.isArray(source.descriptor)
    ? { ...source.descriptor }
    : {};
  const tracking = normalizeOptionalText(resolution.tracking) || normalizeOptionalText(record?.tracking) || "floating";
  const ref = normalizeOptionalText(resolution.ref) || normalizeOptionalText(record?.ref);
  const resolvedRevision = normalizeOptionalText(resolution.resolvedRevision) || normalizeOptionalText(record?.resolvedRevision);
  const latestRevision = normalizeOptionalText(resolution.latestRevision) || normalizeOptionalText(record?.latestRevision) || resolvedRevision;
  const contentHash = normalizeOptionalText(digests.contentSha256) || normalizeOptionalText(record?.contentHash);
  const installedAt = normalizeOptionalText(refresh.installedAt) || normalizeOptionalText(record?.installedAt);
  const refreshedAt = normalizeOptionalText(refresh.lastRefreshedAt) || normalizeOptionalText(record?.refreshedAt) || installedAt;
  const materializedAgents = normalizeMaterializedAgents(
    Array.isArray(record?.materializedAgents) ? record.materializedAgents : projection?.materializedAgents
  );
  const adapters = normalizeProjectionAdapters(projection.adapters);
  const lastOutcome = normalizeOptionalText(refresh.lastOutcome);

  if (!provider || !originalInput || !contentHash || !installedAt) {
    return null;
  }

  return {
    profile,
    upstream,
    selectionPath,
    destRelative,
    provider,
    originalInput,
    ...(ref ? { ref } : {}),
    tracking,
    ...(resolvedRevision ? { resolvedRevision } : {}),
    ...(latestRevision ? { latestRevision } : {}),
    contentHash,
    installedAt,
    ...(refreshedAt ? { refreshedAt } : {}),
    capabilities,
    materializedAgents,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    source: {
      provider,
      originalInput,
      ...(sourceIdentity ? { identity: sourceIdentity } : {}),
      descriptor
    },
    resolution: {
      tracking,
      ...(ref ? { ref } : {}),
      ...(resolvedRevision ? { resolvedRevision } : {}),
      ...(latestRevision ? { latestRevision } : {})
    },
    digests: {
      contentSha256: contentHash
    },
    projection: {
      adapters,
      materializedAgents
    },
    refresh: {
      installedAt,
      ...(refreshedAt ? { lastRefreshedAt: refreshedAt } : {}),
      ...(lastOutcome ? { lastOutcome } : {}),
      ...(typeof refresh.changed === "boolean" ? { changed: refresh.changed } : {})
    },
    eval: {
      status: normalizeOptionalText(evalState.status) || "pending",
      updatedAt: normalizeOptionalText(evalState.updatedAt)
    }
  };
}

function normalizeLockDocument(document) {
  const normalizedPins = (Array.isArray(document?.pins) ? document.pins : []).map(normalizePinRecord).filter(Boolean);
  const normalizedImports = (Array.isArray(document?.imports) ? document.imports : []).map(normalizeImportRecord).filter(Boolean);
  return {
    schemaVersion: 3,
    pins: normalizedPins,
    imports: normalizedImports
  };
}

export function createEmptyImportLock() {
  return normalizeLockDocument({
    schemaVersion: 3,
    pins: [],
    imports: []
  });
}

function stableKey(entry) {
  return [
    entry.profile,
    entry.upstream,
    entry.selectionPath,
    entry.destRelative
  ].join("::");
}

export function sortImportLock(lockDocument) {
  lockDocument.imports = (Array.isArray(lockDocument.imports) ? lockDocument.imports : []).sort((left, right) =>
    stableKey(left).localeCompare(stableKey(right))
  );
  lockDocument.pins = (Array.isArray(lockDocument.pins) ? lockDocument.pins : []).sort((left, right) =>
    `${left.upstream}::${left.ref}`.localeCompare(`${right.upstream}::${right.ref}`)
  );
}

export async function loadImportLock() {
  if (await fs.pathExists(LOCKFILE_PATH)) {
    const document = await assertJsonFileMatchesSchema(LOCKFILE_PATH, SCHEMAS.upstreamsLock);
    const normalized = normalizeLockDocument(document);
    sortImportLock(normalized);
    return {
      path: LOCKFILE_PATH,
      exists: true,
      changed: false,
      lock: normalized
    };
  }

  return {
    path: LOCKFILE_PATH,
    exists: false,
    changed: false,
    lock: createEmptyImportLock()
  };
}

export async function saveImportLock(lockState) {
  lockState.lock = normalizeLockDocument(lockState.lock);
  sortImportLock(lockState.lock);
  await writeJsonFile(lockState.path, lockState.lock);
  lockState.exists = true;
  lockState.changed = false;
}

export function findImportRecord(lockDocument, { profile, upstream, selectionPath, destRelative }) {
  return lockDocument.imports.find(
    (entry) =>
      entry.profile === profile &&
      entry.upstream === upstream &&
      entry.selectionPath === selectionPath &&
      entry.destRelative === destRelative
  ) ?? null;
}

export function upsertImportRecord(lockDocument, record) {
  const normalized = normalizeImportRecord(record);
  if (!normalized) {
    throw new Error("Cannot upsert an invalid import lock record.");
  }
  const existing = findImportRecord(lockDocument, normalized);
  if (existing) {
    Object.assign(existing, normalized);
    return existing;
  }
  lockDocument.imports.push(normalized);
  return lockDocument.imports[lockDocument.imports.length - 1];
}

export function removeImportRecords(lockDocument, predicate) {
  const before = lockDocument.imports.length;
  lockDocument.imports = lockDocument.imports.filter((entry) => !predicate(entry));
  return before - lockDocument.imports.length;
}

export function listProfileImportRecords(lockDocument, profile) {
  return lockDocument.imports
    .filter((entry) => entry.profile === profile)
    .sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
}
