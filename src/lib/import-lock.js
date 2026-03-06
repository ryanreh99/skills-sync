import { LEGACY_LOCKFILE_PATH, LOCKFILE_PATH, SCHEMAS, assertJsonFileMatchesSchema, writeJsonFile } from "./core.js";
import fs from "fs-extra";

export function createEmptyImportLock() {
  return {
    schemaVersion: 1,
    pins: [],
    imports: []
  };
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
  lockDocument.imports.sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
}

export async function loadImportLock() {
  if (await fs.pathExists(LOCKFILE_PATH)) {
    const document = await assertJsonFileMatchesSchema(LOCKFILE_PATH, SCHEMAS.upstreamsLock);
    if (!Array.isArray(document.imports)) {
      document.imports = [];
    }
    sortImportLock(document);
    return {
      path: LOCKFILE_PATH,
      exists: true,
      changed: false,
      lock: document,
      legacyPins: Array.isArray(document.pins) ? [...document.pins] : []
    };
  }

  if (await fs.pathExists(LEGACY_LOCKFILE_PATH)) {
    const legacy = await assertJsonFileMatchesSchema(LEGACY_LOCKFILE_PATH, SCHEMAS.upstreamsLock);
    return {
      path: LOCKFILE_PATH,
      exists: false,
      changed: false,
      lock: createEmptyImportLock(),
      legacyPins: Array.isArray(legacy.pins) ? [...legacy.pins] : []
    };
  }

  return {
    path: LOCKFILE_PATH,
    exists: false,
    changed: false,
    lock: createEmptyImportLock(),
    legacyPins: []
  };
}

export async function saveImportLock(lockState) {
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
  const existing = findImportRecord(lockDocument, record);
  if (existing) {
    Object.assign(existing, record);
    return existing;
  }
  lockDocument.imports.push({ ...record });
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
