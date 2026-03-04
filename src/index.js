#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

export { runCli };

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const invokedFile = path.resolve(process.argv[1]);
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(invokedFile)).href;
  } catch {
    return import.meta.url === pathToFileURL(invokedFile).href;
  }
}

if (isMainModule()) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}
