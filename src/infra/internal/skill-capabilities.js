import fs from "fs-extra";
import path from "node:path";
import { extractSkillSummary, extractSkillTitleFromMarkdown, parseSimpleFrontmatter } from "./core.js";

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function listTopLevelEntries(skillRoot) {
  const entries = await fs.readdir(skillRoot, { withFileTypes: true }).catch(() => []);
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function detectCapabilitiesFromEntries(entries) {
  const capabilities = ["instructions"];
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));

  if (names.has("scripts")) {
    capabilities.push("scripts");
  }
  if (names.has("references")) {
    capabilities.push("references");
  }
  if (names.has("assets")) {
    capabilities.push("assets");
  }
  if (names.has("helpers") || names.has("helper")) {
    capabilities.push("helpers");
  }

  return uniqueSorted(capabilities);
}

export async function scanSkillDirectory(skillRoot) {
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  const raw = await fs.readFile(skillMdPath, "utf8");
  const { frontmatter } = parseSimpleFrontmatter(raw);
  const entries = await listTopLevelEntries(skillRoot);
  const capabilities = detectCapabilitiesFromEntries(entries);
  if (Object.keys(frontmatter).length > 0) {
    capabilities.push("frontmatter");
  }

  return {
    title: extractSkillTitleFromMarkdown(raw, path.basename(skillRoot)),
    summary: await extractSkillSummary(skillMdPath),
    frontmatter,
    capabilities: uniqueSorted(capabilities),
    optionalEntries: entries
      .filter((entry) => entry.name !== "SKILL.md")
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file"
      }))
  };
}
