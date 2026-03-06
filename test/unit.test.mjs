import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeSourceInput, inferUpstreamIdFromSourceDescriptor } from "../src/lib/source-normalization.js";
import { scanSkillDirectory } from "../src/lib/skill-capabilities.js";
import { summarizeCapabilitySupport } from "../src/lib/agent-registry.js";

test("normalizeSourceInput handles GitHub shorthand", async () => {
  const descriptor = await normalizeSourceInput("openai/skills");
  assert.equal(descriptor.provider, "git");
  assert.equal(descriptor.repo, "https://github.com/openai/skills.git");
  assert.equal(descriptor.repoPath, "openai/skills");
  assert.equal(inferUpstreamIdFromSourceDescriptor(descriptor), "openai_skills");
});

test("normalizeSourceInput handles GitHub subdirectory URLs", async () => {
  const descriptor = await normalizeSourceInput(
    "https://github.com/openai/skills/tree/main/skills/.system/skill-creator"
  );
  assert.equal(descriptor.provider, "git");
  assert.equal(descriptor.repo, "https://github.com/openai/skills.git");
  assert.equal(descriptor.defaultRef, "main");
  assert.equal(descriptor.root, "skills/.system/skill-creator");
});

test("normalizeSourceInput handles GitLab tree URLs", async () => {
  const descriptor = await normalizeSourceInput(
    "https://gitlab.com/example/group/project/-/tree/main/skills/demo"
  );
  assert.equal(descriptor.provider, "git");
  assert.equal(descriptor.repo, "https://gitlab.com/example/group/project.git");
  assert.equal(descriptor.defaultRef, "main");
  assert.equal(descriptor.root, "skills/demo");
});

test("normalizeSourceInput handles local filesystem paths", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-local-source-"));
  try {
    const descriptor = await normalizeSourceInput(localRoot);
    assert.equal(descriptor.provider, "local-path");
    assert.equal(descriptor.path, localRoot);
    assert.equal(descriptor.displayName, path.basename(localRoot));
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("scanSkillDirectory records optional capabilities without dropping instructions", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-skill-scan-"));
  try {
    await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "assets"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "helpers"), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "title: capability-demo",
        "summary: Demonstrates optional capability scanning.",
        "---",
        "",
        "# capability-demo",
        "",
        "Capability scan fixture."
      ].join("\n"),
      "utf8"
    );

    const scan = await scanSkillDirectory(skillRoot);
    assert.equal(scan.title, "capability-demo");
    assert.equal(scan.summary.length > 0, true);
    assert.deepEqual(
      scan.capabilities,
      ["assets", "frontmatter", "helpers", "instructions", "references", "scripts"],
      "Optional capability metadata should be preserved alongside instructions."
    );
  } finally {
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("summarizeCapabilitySupport treats unsupported optional features as advisory mismatches", () => {
  const summary = summarizeCapabilitySupport(["instructions", "scripts", "references"], {
    capabilities: {
      instructions: "native",
      scripts: "ignored",
      references: "preserved"
    }
  });

  assert.deepEqual(summary.rows, [
    { capability: "scripts", support: "ignored" },
    { capability: "references", support: "preserved" }
  ]);
  assert.deepEqual(summary.mismatches, summary.rows);
});

test("loadImportLock migrates legacy pins into the new lockfile location without recreating legacy state", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-lock-migration-"));
  const workspaceRoot = path.join(tempHome, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "upstreams.lock.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        pins: [
          {
            upstream: "anthropic",
            ref: "main",
            commit: "abcdef1"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const importLockUrl = pathToFileURL(path.join(process.cwd(), "src", "lib", "import-lock.js")).href;
  const script = `
    import { loadImportLock } from ${JSON.stringify(importLockUrl)};
    const state = await loadImportLock();
    console.log(JSON.stringify({
      path: state.path,
      exists: state.exists,
      imports: state.lock.imports,
      legacyPins: state.legacyPins
    }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLS_SYNC_HOME: tempHome
    }
  });

  try {
    assert.equal(result.status, 0, result.stderr || "Lock migration subprocess should succeed.");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.path, path.join(workspaceRoot, "skills-sync.lock.json"));
    assert.equal(payload.exists, false);
    assert.deepEqual(payload.imports, []);
    assert.deepEqual(payload.legacyPins, [{ upstream: "anthropic", ref: "main", commit: "abcdef1" }]);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
