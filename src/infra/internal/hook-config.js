import fs from "fs-extra";
import { fileSha256, readJsonFile, sha256Text, stableJsonStringify, writeJsonFile } from "./core.js";

const CLAUDE_EVENT_ALIASES = Object.freeze({
  sessionstart: "SessionStart",
  sessionend: "SessionEnd",
  beforetool: "PreToolUse",
  aftertool: "PostToolUse",
  beforeagent: "UserPromptSubmit",
  afteragent: "Stop",
  notification: "Notification"
});

const GEMINI_EVENT_ALIASES = Object.freeze({
  sessionstart: "SessionStart",
  sessionend: "SessionEnd",
  beforetool: "BeforeTool",
  aftertool: "AfterTool",
  beforeagent: "BeforeAgent",
  afteragent: "AfterAgent",
  notification: "Notification"
});

const CLAUDE_EVENT_NAMES = new Set([
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact"
]);

const GEMINI_EVENT_NAMES = new Set([
  "SessionStart",
  "SessionEnd",
  "BeforeTool",
  "AfterTool",
  "BeforeAgent",
  "AfterAgent",
  "Notification"
]);

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneStructured(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

export function getEnabledHooksForAgent(hooksDocument) {
  return (Array.isArray(hooksDocument?.hooks) ? hooksDocument.hooks : [])
    .filter((hook) => hook?.enabled !== false)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function matcherFromConditions(conditions) {
  const normalized = (Array.isArray(conditions) ? conditions : [])
    .map((entry) => normalizeOptionalText(entry))
    .filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.length === 1 ? normalized[0] : normalized.join("|");
}

function mapHookEvent(agentId, event) {
  const normalized = normalizeOptionalText(event);
  if (!normalized) {
    return {
      ok: false,
      reason: "missing event"
    };
  }

  if (agentId === "claude") {
    if (CLAUDE_EVENT_NAMES.has(normalized)) {
      return { ok: true, actualEvent: normalized, lossy: false };
    }
    const mapped = CLAUDE_EVENT_ALIASES[normalized.toLowerCase()];
    if (!mapped) {
      return {
        ok: false,
        reason: `event '${normalized}' is not supported by Claude hooks`
      };
    }
    return {
      ok: true,
      actualEvent: mapped,
      lossy: mapped.toLowerCase() !== normalized.toLowerCase(),
      message:
        mapped.toLowerCase() !== normalized.toLowerCase()
          ? `Hook event '${normalized}' was translated to '${mapped}' for Claude.`
          : null
    };
  }

  if (agentId === "gemini") {
    if (GEMINI_EVENT_NAMES.has(normalized)) {
      return { ok: true, actualEvent: normalized, lossy: false };
    }
    const mapped = GEMINI_EVENT_ALIASES[normalized.toLowerCase()];
    if (!mapped) {
      return {
        ok: false,
        reason: `event '${normalized}' is not supported by Gemini hooks`
      };
    }
    return {
      ok: true,
      actualEvent: mapped,
      lossy: mapped.toLowerCase() !== normalized.toLowerCase(),
      message:
        mapped.toLowerCase() !== normalized.toLowerCase()
          ? `Hook event '${normalized}' was translated to '${mapped}' for Gemini.`
          : null
    };
  }

  return {
    ok: false,
    reason: `agent '${agentId}' does not support managed hooks`
  };
}

function normalizeCommandPayload(payload) {
  if (typeof payload === "string") {
    return {
      command: payload
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const command = normalizeOptionalText(payload.command);
  if (!command) {
    return null;
  }
  return {
    command,
    ...(payload.cwd && typeof payload.cwd === "string" ? { cwd: payload.cwd.trim() } : {}),
    ...(payload.env && typeof payload.env === "object" && !Array.isArray(payload.env)
      ? { env: cloneStructured(payload.env) }
      : {})
  };
}

function normalizePromptPayload(payload) {
  if (typeof payload === "string") {
    return {
      prompt: payload
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const prompt = normalizeOptionalText(payload.prompt);
  if (!prompt) {
    return null;
  }
  return {
    prompt,
    ...(normalizeOptionalText(payload.model) ? { model: payload.model.trim() } : {})
  };
}

function normalizeHttpPayload(payload) {
  if (typeof payload === "string") {
    return {
      url: payload
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const url = normalizeOptionalText(payload.url);
  if (!url) {
    return null;
  }
  return {
    url,
    ...(normalizeOptionalText(payload.method) ? { method: payload.method.trim().toUpperCase() } : {}),
    ...(payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)
      ? { headers: cloneStructured(payload.headers) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, "body") ? { body: cloneStructured(payload.body) } : {})
  };
}

function normalizeHookActionSpec(rawHook) {
  const type = normalizeOptionalText(rawHook?.type);
  if (!type) {
    return null;
  }
  if (type === "command") {
    const command = normalizeOptionalText(rawHook?.command);
    if (!command) {
      return null;
    }
    return {
      type: "command",
      command,
      ...(normalizeOptionalText(rawHook?.cwd) ? { cwd: rawHook.cwd.trim() } : {}),
      ...(rawHook?.env && typeof rawHook.env === "object" && !Array.isArray(rawHook.env)
        ? { env: cloneStructured(rawHook.env) }
        : {}),
      ...(normalizeOptionalText(rawHook?.name) ? { name: rawHook.name.trim() } : {}),
      ...(normalizeOptionalText(rawHook?.description) ? { description: rawHook.description.trim() } : {}),
      ...(Number.isInteger(rawHook?.timeout) && rawHook.timeout > 0 ? { timeout: rawHook.timeout } : {}),
      ...(rawHook?.async === true ? { async: true } : {})
    };
  }
  if (type === "prompt") {
    const prompt = normalizeOptionalText(rawHook?.prompt);
    if (!prompt) {
      return null;
    }
    return {
      type: "prompt",
      prompt,
      ...(normalizeOptionalText(rawHook?.model) ? { model: rawHook.model.trim() } : {}),
      ...(Number.isInteger(rawHook?.timeout) && rawHook.timeout > 0 ? { timeout: rawHook.timeout } : {})
    };
  }
  if (type === "http") {
    const url = normalizeOptionalText(rawHook?.url);
    if (!url) {
      return null;
    }
    return {
      type: "http",
      url,
      ...(normalizeOptionalText(rawHook?.method) ? { method: rawHook.method.trim().toUpperCase() } : {}),
      ...(rawHook?.headers && typeof rawHook.headers === "object" && !Array.isArray(rawHook.headers)
        ? { headers: cloneStructured(rawHook.headers) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(rawHook, "body") ? { body: cloneStructured(rawHook.body) } : {}),
      ...(Number.isInteger(rawHook?.timeout) && rawHook.timeout > 0 ? { timeout: rawHook.timeout } : {}),
      ...(rawHook?.async === true ? { async: true } : {})
    };
  }
  return null;
}

function normalizeHookGroup(event, group) {
  const matcher = normalizeOptionalText(group?.matcher);
  const hooks = (Array.isArray(group?.hooks) ? group.hooks : [])
    .map((hook) => normalizeHookActionSpec(hook))
    .filter(Boolean)
    .sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right)));
  if (hooks.length === 0) {
    return null;
  }
  const spec = {
    ...(matcher ? { matcher } : {}),
    hooks
  };
  return {
    key: `${event}::${matcher ?? ""}`,
    event,
    matcher,
    hooks,
    spec,
    signature: stableJsonStringify({
      event,
      ...spec
    })
  };
}

function buildGroupsDocument(groups) {
  const hooks = {};
  const sortedGroups = [...groups].sort((left, right) => left.key.localeCompare(right.key));
  for (const group of sortedGroups) {
    const current = hooks[group.event] ?? [];
    current.push({
      ...(group.matcher ? { matcher: group.matcher } : {}),
      hooks: group.hooks.map((hook) => cloneStructured(hook))
    });
    hooks[group.event] = current;
  }
  return { hooks };
}

function projectClaudeHookAction(hook, diagnostics) {
  if (hook.action?.type === "shell") {
    const payload = normalizeCommandPayload(hook.action.payload);
    if (!payload) {
      return {
        ok: false,
        reason: "shell hook payload must provide a command string"
      };
    }
    return {
      ok: true,
      action: {
        type: "command",
        command: payload.command,
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.env ? { env: payload.env } : {}),
        ...(hook.async === true ? { async: true } : {}),
        ...(Number.isInteger(hook.timeoutMs) && hook.timeoutMs > 0
          ? { timeout: Math.max(1, Math.ceil(hook.timeoutMs / 1000)) }
          : {})
      }
    };
  }

  if (hook.action?.type === "prompt") {
    const payload = normalizePromptPayload(hook.action.payload);
    if (!payload) {
      return {
        ok: false,
        reason: "prompt hook payload must provide prompt text"
      };
    }
    if (hook.async === true) {
      diagnostics.push({
        code: "lossy-hook-translation",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: `Hook '${hook.name}' drops async because Claude prompt hooks do not support it.`
      });
    }
    return {
      ok: true,
      action: {
        type: "prompt",
        prompt: payload.prompt,
        ...(payload.model ? { model: payload.model } : {}),
        ...(Number.isInteger(hook.timeoutMs) && hook.timeoutMs > 0
          ? { timeout: Math.max(1, Math.ceil(hook.timeoutMs / 1000)) }
          : {})
      }
    };
  }

  if (hook.action?.type === "http") {
    const payload = normalizeHttpPayload(hook.action.payload);
    if (!payload) {
      return {
        ok: false,
        reason: "http hook payload must provide a url"
      };
    }
    return {
      ok: true,
      action: {
        type: "http",
        url: payload.url,
        ...(payload.method ? { method: payload.method } : {}),
        ...(payload.headers ? { headers: payload.headers } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, "body") ? { body: payload.body } : {}),
        ...(hook.async === true ? { async: true } : {}),
        ...(Number.isInteger(hook.timeoutMs) && hook.timeoutMs > 0
          ? { timeout: Math.max(1, Math.ceil(hook.timeoutMs / 1000)) }
          : {})
      }
    };
  }

  return {
    ok: false,
    reason: `action type '${hook.action?.type ?? "unknown"}' is not supported by Claude hooks`
  };
}

function projectGeminiHookAction(hook, diagnostics) {
  if (hook.action?.type !== "shell") {
    return {
      ok: false,
      reason: `action type '${hook.action?.type ?? "unknown"}' is not supported by Gemini hooks`
    };
  }
  const payload = normalizeCommandPayload(hook.action.payload);
  if (!payload) {
    return {
      ok: false,
      reason: "shell hook payload must provide a command string"
    };
  }
  if (hook.async === true) {
    diagnostics.push({
      code: "lossy-hook-translation",
      severity: "warning",
      hookId: hook.id,
      hookName: hook.name,
      message: `Hook '${hook.name}' drops async because Gemini hooks run synchronously.`
    });
  }
  return {
    ok: true,
    action: {
      type: "command",
      command: payload.command,
      name: hook.name,
      ...(normalizeOptionalText(hook?.metadata?.description) ? { description: hook.metadata.description.trim() } : {}),
      ...(Number.isInteger(hook.timeoutMs) && hook.timeoutMs > 0 ? { timeout: hook.timeoutMs } : {})
    }
  };
}

export function buildHookProjection(hooksDocument, agent) {
  const agentId = String(agent?.id ?? "").trim();
  const hookKind = agent?.hookKind ?? "unsupported";
  const selectedHooks = getEnabledHooksForAgent(hooksDocument);
  const diagnostics = [];
  const skipped = [];
  const groupsByKey = new Map();

  for (const hook of selectedHooks) {
    if (hookKind === "unsupported") {
      skipped.push({
        id: hook.id,
        name: hook.name,
        reason: "agent does not support profile-managed hooks"
      });
      diagnostics.push({
        code: "unsupported-hook",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: `Agent '${agentId}' does not support managed hooks for '${hook.name}'.`
      });
      continue;
    }

    const mappedEvent = mapHookEvent(agentId, hook.event);
    if (!mappedEvent.ok) {
      skipped.push({
        id: hook.id,
        name: hook.name,
        reason: mappedEvent.reason
      });
      diagnostics.push({
        code: "unsupported-hook",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: `Hook '${hook.name}' was skipped for agent '${agentId}': ${mappedEvent.reason}.`
      });
      continue;
    }
    if (mappedEvent.lossy && mappedEvent.message) {
      diagnostics.push({
        code: "lossy-hook-translation",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: mappedEvent.message
      });
    }

    if (hook.retry) {
      diagnostics.push({
        code: "lossy-hook-translation",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: `Hook '${hook.name}' drops retry settings on agent '${agentId}'.`
      });
    }

    const actionProjection = agentId === "claude"
      ? projectClaudeHookAction(hook, diagnostics)
      : projectGeminiHookAction(hook, diagnostics);
    if (!actionProjection.ok) {
      skipped.push({
        id: hook.id,
        name: hook.name,
        reason: actionProjection.reason
      });
      diagnostics.push({
        code: "unsupported-hook",
        severity: "warning",
        hookId: hook.id,
        hookName: hook.name,
        message: `Hook '${hook.name}' was skipped for agent '${agentId}': ${actionProjection.reason}.`
      });
      continue;
    }

    const matcher = matcherFromConditions(hook.conditions);
    const key = `${mappedEvent.actualEvent}::${matcher ?? ""}`;
    const current = groupsByKey.get(key) ?? {
      key,
      event: mappedEvent.actualEvent,
      matcher,
      names: new Set(),
      hooks: []
    };
    current.names.add(hook.name);
    current.hooks.push(actionProjection.action);
    groupsByKey.set(key, current);
  }

  const items = Array.from(groupsByKey.values())
    .map((group) => {
      const hooks = group.hooks
        .map((entry) => normalizeHookActionSpec(entry))
        .filter(Boolean)
        .sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right)));
      const normalizedGroup = normalizeHookGroup(group.event, {
        matcher: group.matcher,
        hooks
      });
      return {
        ...normalizedGroup,
        names: [...group.names].sort((left, right) => left.localeCompare(right))
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    agentId,
    kind: hookKind,
    items,
    skipped,
    diagnostics: [...diagnostics].sort((left, right) => left.message.localeCompare(right.message)),
    projectedDocument: buildGroupsDocument(items)
  };
}

export async function projectHooksForAgent({ bundleHooksPath, runtimeHooksPath, agent }) {
  const hooksDocument = await readJsonFile(bundleHooksPath);
  const projection = buildHookProjection(hooksDocument, agent);
  await writeJsonFile(runtimeHooksPath, projection.projectedDocument);
  return {
    hooksMethod: projection.kind === "unsupported" ? "unsupported" : "generated",
    hookCount: projection.items.length,
    diagnostics: projection.diagnostics,
    skipped: projection.skipped,
    projection
  };
}

function parseHooksRoot(rootDocument) {
  const hooksRoot = rootDocument?.hooks;
  if (!hooksRoot || typeof hooksRoot !== "object" || Array.isArray(hooksRoot)) {
    return [];
  }
  const groups = [];
  for (const event of Object.keys(hooksRoot).sort((left, right) => left.localeCompare(right))) {
    const eventGroups = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
    for (const rawGroup of eventGroups) {
      const normalized = normalizeHookGroup(event, rawGroup);
      if (normalized) {
        groups.push(normalized);
      }
    }
  }
  return groups.sort((left, right) => left.key.localeCompare(right.key));
}

export async function readInstalledHooksForAgent({ configPath }) {
  const document = await readJsonFile(configPath);
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Expected JSON object root in ${configPath}.`);
  }
  return parseHooksRoot(document);
}

function buildHooksDocumentFromGroups(existingRoot, groups) {
  const nextRoot = existingRoot && typeof existingRoot === "object" && !Array.isArray(existingRoot)
    ? cloneStructured(existingRoot)
    : {};
  if (groups.length === 0) {
    delete nextRoot.hooks;
    return nextRoot;
  }
  nextRoot.hooks = buildGroupsDocument(groups).hooks;
  return nextRoot;
}

export async function applyManagedHookConfigForAgent({
  targetPath,
  projectedHooks,
  dryRun = false
}) {
  const currentRoot = (await fs.pathExists(targetPath)) ? await readJsonFile(targetPath) : {};
  if (!currentRoot || typeof currentRoot !== "object" || Array.isArray(currentRoot)) {
    throw new Error(`Expected JSON object root in ${targetPath}.`);
  }

  const existingGroups = parseHooksRoot(currentRoot);
  const projectedGroups = parseHooksRoot(projectedHooks);
  const mergedByKey = new Map(existingGroups.map((group) => [group.key, group]));
  const shadowedHooks = {};

  for (const group of projectedGroups) {
    const existing = mergedByKey.get(group.key);
    if (existing && existing.signature !== group.signature) {
      shadowedHooks[group.key] = existing.spec;
    }
    mergedByKey.set(group.key, group);
  }

  const nextGroups = Array.from(mergedByKey.values()).sort((left, right) => left.key.localeCompare(right.key));
  const nextRoot = buildHooksDocumentFromGroups(currentRoot, nextGroups);
  const currentSerialized = `${JSON.stringify(currentRoot, null, 2)}\n`;
  const nextSerialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const wouldWrite = currentSerialized !== nextSerialized;

  if (!dryRun && wouldWrite) {
    await writeJsonFile(targetPath, nextRoot);
  }

  return {
    wouldWrite,
    method: "generated",
    hash: sha256Text(nextSerialized),
    managedKeys: projectedGroups.map((group) => group.key),
    shadowedHooks
  };
}

export async function removeManagedHookConfig(binding, options = {}) {
  const { dryRun = false } = options;
  if (!(await fs.pathExists(binding.targetPath))) {
    return { removed: false };
  }

  const currentRoot = await readJsonFile(binding.targetPath);
  if (!currentRoot || typeof currentRoot !== "object" || Array.isArray(currentRoot)) {
    throw new Error(`Expected JSON object root in ${binding.targetPath}.`);
  }

  const currentGroups = parseHooksRoot(currentRoot);
  const remainingByKey = new Map(currentGroups.map((group) => [group.key, group]));
  for (const key of Array.isArray(binding.managedKeys) ? binding.managedKeys : []) {
    remainingByKey.delete(key);
  }

  const shadowedHooks = binding.shadowedHooks && typeof binding.shadowedHooks === "object" && !Array.isArray(binding.shadowedHooks)
    ? binding.shadowedHooks
    : {};
  for (const [key, spec] of Object.entries(shadowedHooks)) {
    const event = normalizeOptionalText(spec?.event) ?? key.split("::")[0];
    const normalized = normalizeHookGroup(event, spec);
    if (normalized) {
      remainingByKey.set(key, normalized);
    }
  }

  const nextGroups = Array.from(remainingByKey.values()).sort((left, right) => left.key.localeCompare(right.key));
  const nextRoot = buildHooksDocumentFromGroups(currentRoot, nextGroups);
  const currentSerialized = `${JSON.stringify(currentRoot, null, 2)}\n`;
  const nextSerialized = `${JSON.stringify(nextRoot, null, 2)}\n`;
  const removed = currentSerialized !== nextSerialized;

  if (!dryRun && removed) {
    await writeJsonFile(binding.targetPath, nextRoot);
  }

  return { removed };
}

export async function validateProjectedHookConfigForAgent({ projectionPath }) {
  try {
    const document = await readJsonFile(projectionPath);
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      return `Hook projection '${projectionPath}' must be a JSON object.`;
    }
    parseHooksRoot(document);
    return null;
  } catch (error) {
    return `Invalid projected hooks at '${projectionPath}': ${error.message}`;
  }
}

export async function validateManagedHookBindingTargetForAgent({
  targetPath,
  expectedManagedKeys
}) {
  try {
    const document = await readJsonFile(targetPath);
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      return `Managed hooks target '${targetPath}' must be a JSON object.`;
    }
    const groups = parseHooksRoot(document);
    const keys = new Set(groups.map((group) => group.key));
    const missing = (Array.isArray(expectedManagedKeys) ? expectedManagedKeys : []).filter((key) => !keys.has(key));
    if (missing.length > 0) {
      return `Managed hooks are missing from '${targetPath}': ${missing.join(", ")}.`;
    }
    return null;
  } catch (error) {
    return `Failed to validate managed hooks target '${targetPath}': ${error.message}`;
  }
}

export async function fileHashIfExists(targetPath) {
  if (!(await fs.pathExists(targetPath))) {
    return null;
  }
  return fileSha256(targetPath);
}
