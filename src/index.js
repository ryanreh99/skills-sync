#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";

export { runCli };

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const currentFile = path.resolve(fileURLToPath(import.meta.url));
  const invokedFile = path.resolve(process.argv[1]);
  try {
    return fs.realpathSync(invokedFile) === fs.realpathSync(currentFile);
  } catch {
    return invokedFile === currentFile;
  }
}

if (isMainModule()) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}
