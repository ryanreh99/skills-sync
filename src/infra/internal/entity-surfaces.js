const ENTITY_SURFACES = ["skills", "mcp", "commands", "hooks"];

export const SURFACE_ENTITY_NAMES = Object.freeze(ENTITY_SURFACES);

export const DIRECTORY_SURFACES = Object.freeze(new Set(["skills", "commands"]));

export const CONFIG_SURFACES = Object.freeze(new Set(["mcp", "hooks"]));

export const BINDING_KIND_BY_SURFACE = Object.freeze({
  skills: "dir",
  commands: "command-dir",
  mcp: "config",
  hooks: "hook-config"
});

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function parseEntityFilterOption(rawEntities) {
  if (rawEntities === null || rawEntities === undefined) {
    return [];
  }
  if (Array.isArray(rawEntities)) {
    return uniqueSorted(
      rawEntities
        .flatMap((item) => parseEntityFilterOption(item))
        .filter((item) => SURFACE_ENTITY_NAMES.includes(item))
    );
  }

  const normalized = normalizeOptionalText(rawEntities);
  if (!normalized) {
    return [];
  }

  const selected = uniqueSorted(
    normalized
      .split(/[\s,]+/g)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const invalid = selected.filter((item) => !SURFACE_ENTITY_NAMES.includes(item));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --entities value. Supported entities: ${SURFACE_ENTITY_NAMES.join(", ")}. ` +
        `Received: ${invalid.join(", ")}.`
    );
  }
  return selected;
}

export function bindingSurfaceForKind(kind) {
  switch (kind) {
    case "dir":
      return "skills";
    case "command-dir":
      return "commands";
    case "config":
      return "mcp";
    case "hook-config":
      return "hooks";
    default:
      return null;
  }
}

export function bindingMatchesSelectedEntities(binding, selectedEntities) {
  if (!selectedEntities || selectedEntities.size === 0) {
    return true;
  }
  const surface = bindingSurfaceForKind(binding?.kind);
  return Boolean(surface) && selectedEntities.has(surface);
}

export function entitySelectionIncludes(selectedEntities, entityName) {
  return !selectedEntities || selectedEntities.size === 0 || selectedEntities.has(entityName);
}
