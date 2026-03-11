import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";

async function addPathToHash(hash, targetPath, currentRelative = "") {
  const stats = await fs.stat(targetPath);
  if (stats.isDirectory()) {
    hash.update(`dir:${currentRelative}\n`);
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextPath = path.join(targetPath, entry.name);
      const nextRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;
      await addPathToHash(hash, nextPath, nextRelative);
    }
    return;
  }

  hash.update(`file:${currentRelative}\n`);
  hash.update(await fs.readFile(targetPath));
}

export async function hashPathContent(targetPath) {
  const hash = crypto.createHash("sha256");
  await addPathToHash(hash, targetPath);
  return hash.digest("hex");
}
