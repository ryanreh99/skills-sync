import fs from "fs-extra";
import path from "node:path";
import { RUNTIME_INTERNAL_ROOT } from "../internal/core.js";
import { getStatePath } from "../internal/bindings.js";

export async function loadActiveStateDocument() {
  const statePath = await getStatePath();
  const exists = await fs.pathExists(statePath);
  if (!exists) {
    return {
      path: statePath,
      exists: false,
      state: null
    };
  }

  const state = await fs.readJson(statePath).catch(() => null);
  return {
    path: statePath,
    exists: true,
    state
  };
}

export function getRuntimeBundlePath(...segments) {
  return path.join(RUNTIME_INTERNAL_ROOT, ...segments);
}

export async function runtimePathExists(...segments) {
  return fs.pathExists(getRuntimeBundlePath(...segments));
}

export async function readRuntimeJson(...segments) {
  return fs.readJson(getRuntimeBundlePath(...segments));
}
