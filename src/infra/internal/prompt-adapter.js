import { select, text, isCancel } from "@clack/prompts";

export const PROMPT_CANCELLED_CODE = "skills-sync.promptCancelled";

function canUseClackPrompts() {
  if (process.env.SKILLS_SYNC_DISABLE_PROMPTS === "1") {
    return false;
  }
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function canPrompt() {
  return canUseClackPrompts();
}

function createPromptCancelledError() {
  const error = new Error("Prompt cancelled.");
  error.code = PROMPT_CANCELLED_CODE;
  return error;
}

export function isPromptCancelledError(error) {
  return error?.code === PROMPT_CANCELLED_CODE;
}

function normalizeTextValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export async function promptForText({
  message,
  placeholder,
  defaultValue = "",
  validate
}) {
  if (!canPrompt()) {
    throw new Error("Prompts are unavailable in non-interactive mode.");
  }

  const value = await text({
    message,
    placeholder,
    defaultValue,
    validate
  });
  if (isCancel(value)) {
    throw createPromptCancelledError();
  }
  return normalizeTextValue(String(value));
}

export async function promptForSelect({ message, options }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("Select prompt requires one or more options.");
  }
  if (!canPrompt()) {
    throw new Error("Prompts are unavailable in non-interactive mode.");
  }

  const value = await select({
    message,
    options: options.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint
    }))
  });
  if (isCancel(value)) {
    throw createPromptCancelledError();
  }
  return value;
}

export function parseCommaOrWhitespaceList(rawValue) {
  const normalized = normalizeTextValue(String(rawValue ?? ""));
  if (normalized.length === 0) {
    return [];
  }

  if (normalized.includes(",")) {
    return normalized
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return normalized
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseEnvEntries(rawValue) {
  const entries = parseCommaOrWhitespaceList(rawValue);
  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error("MCP env values must be in KEY=VALUE format.");
    }
    const key = entry.slice(0, equalsIndex).trim();
    if (key.length === 0) {
      throw new Error("MCP env variable name cannot be empty.");
    }
  }
  return entries;
}
