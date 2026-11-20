import fs from "fs-extra";
import path from "node:path";
import { SCHEMAS, assertJsonFileMatchesSchema } from "./core.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringList(values, transform = (value) => value) {
  const normalized = new Set();
  for (const rawValue of Array.isArray(values) ? values : []) {
    const text = normalizeOptionalText(rawValue);
    if (!text) {
      continue;
    }
    normalized.add(transform(text));
  }
  return Array.from(normalized).sort((left, right) => left.localeCompare(right));
}

function cloneStructuredObject(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeCommandArg(entry) {
  const raw = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { name: entry };
  const name = normalizeOptionalText(raw.name);
  if (!name) {
    return null;
  }
  return {
    name,
    ...(normalizeOptionalText(raw.description) ? { description: raw.description.trim() } : {}),
    ...(raw.required === true ? { required: true } : {}),
    ...(normalizeOptionalText(raw.placeholder) ? { placeholder: raw.placeholder.trim() } : {})
  };
}

export function normalizeCommandsDocument(document) {
  const commands = [];
  for (const entry of Array.isArray(document?.commands) ? document.commands : []) {
    const id = normalizeOptionalText(entry?.id) ?? normalizeOptionalText(entry?.name);
    const name = normalizeOptionalText(entry?.name) ?? id;
    const body = normalizeOptionalText(entry?.body) ?? normalizeOptionalText(entry?.prompt);
    if (!id || !name || !body) {
      continue;
    }
    const args = (Array.isArray(entry?.args) ? entry.args : []).map(normalizeCommandArg).filter(Boolean);
    const tags = normalizeStringList(entry?.tags);
    commands.push({
      id,
      name,
      ...(normalizeOptionalText(entry?.description) ? { description: entry.description.trim() } : {}),
      body,
      ...(args.length > 0 ? { args } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(entry?.enabled === false ? { enabled: false } : {}),
      ...(entry?.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
        ? { metadata: cloneStructuredObject(entry.metadata) }
        : {}),
      ...(entry?.provenance && typeof entry.provenance === "object" && !Array.isArray(entry.provenance)
        ? { provenance: cloneStructuredObject(entry.provenance) }
        : {})
    });
  }
  commands.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    commands
  };
}

function normalizeHookAction(action) {
  const raw = action && typeof action === "object" && !Array.isArray(action) ? action : {};
  const type = normalizeOptionalText(raw.type)?.toLowerCase();
  if (!type || !["shell", "prompt", "http", "other"].includes(type)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "payload")) {
    return null;
  }
  const payload = cloneStructuredObject(raw.payload);
  if (payload === null || payload === undefined || payload === "") {
    return null;
  }
  return {
    type,
    payload
  };
}

function normalizeRetry(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const count = Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : null;
  const backoffMs = Number.isInteger(raw.backoffMs) && raw.backoffMs >= 0 ? raw.backoffMs : null;
  if (count === null && backoffMs === null) {
    return null;
  }
  return {
    ...(count !== null ? { count } : {}),
    ...(backoffMs !== null ? { backoffMs } : {})
  };
}

export function normalizeHooksDocument(document) {
  const hooks = [];
  for (const entry of Array.isArray(document?.hooks) ? document.hooks : []) {
    const id = normalizeOptionalText(entry?.id) ?? normalizeOptionalText(entry?.name);
    const name = normalizeOptionalText(entry?.name) ?? id;
    const event = normalizeOptionalText(entry?.event);
    const action = normalizeHookAction(entry?.action);
    if (!id || !name || !event || !action) {
      continue;
    }
    const conditions = normalizeStringList(entry?.conditions);
    const retry = normalizeRetry(entry?.retry);
    hooks.push({
      id,
      name,
      event,
      action,
      ...(entry?.enabled === false ? { enabled: false } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
      ...(Number.isInteger(entry?.timeoutMs) && entry.timeoutMs > 0 ? { timeoutMs: entry.timeoutMs } : {}),
      ...(retry ? { retry } : {}),
      ...(entry?.async === true ? { async: true } : {}),
      ...(entry?.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
        ? { metadata: cloneStructuredObject(entry.metadata) }
        : {}),
      ...(entry?.provenance && typeof entry.provenance === "object" && !Array.isArray(entry.provenance)
        ? { provenance: cloneStructuredObject(entry.provenance) }
        : {})
    });
  }
  hooks.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    hooks
  };
}

function mergeEntityDocuments(documents, fieldName) {
  const merged = new Map();
  for (const document of documents) {
    for (const entry of document?.[fieldName] ?? []) {
      merged.set(entry.id, entry);
    }
  }
  return {
    schemaVersion: 1,
    [fieldName]: Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function mergeCommandsDocuments(documents) {
  return mergeEntityDocuments(documents, "commands");
}

export function mergeHooksDocuments(documents) {
  return mergeEntityDocuments(documents, "hooks");
}

async function loadEntityManifest(packRoot, relativePath, schemaPath, normalizer, emptyValue) {
  const targetPath = path.join(packRoot, relativePath);
  if (!(await fs.pathExists(targetPath))) {
    return {
      path: null,
      document: emptyValue
    };
  }
  const document = await assertJsonFileMatchesSchema(targetPath, schemaPath);
  return {
    path: targetPath,
    document: normalizer(document)
  };
}

export async function loadCommandsManifest(packRoot) {
  return loadEntityManifest(
    packRoot,
    path.join("commands", "commands.json"),
    SCHEMAS.commands,
    normalizeCommandsDocument,
    normalizeCommandsDocument({ commands: [] })
  );
}

export async function loadHooksManifest(packRoot) {
  return loadEntityManifest(
    packRoot,
    path.join("hooks", "hooks.json"),
    SCHEMAS.hooks,
    normalizeHooksDocument,
    normalizeHooksDocument({ hooks: [] })
  );
}
