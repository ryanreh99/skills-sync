import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const srcRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");

async function copyDirectorySorted(sourceDir, targetDir, isTopLevel = false) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (isTopLevel && entry.isDirectory() && entry.name === "scripts") {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectorySorted(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

await fs.rm(distRoot, { recursive: true, force: true });
await copyDirectorySorted(srcRoot, distRoot, true);

const executablePath = path.join(distRoot, "index.js");
await fs.chmod(executablePath, 0o755).catch(() => {});
