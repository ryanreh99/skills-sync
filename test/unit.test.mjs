import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsExtra from "fs-extra";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildTargetsDocument, loadAgentIntegrations, normalizeAgentIntegrationEntry } from "../src/lib/agent-integrations.js";
import {
  getMcpMergeStrategy,
  loadAgentRegistry,
  supportsMcpAuth,
  supportsMcpCapability,
  supportsMcpConfigField,
  supportsMcpTransport,
  supportsToolFiltering
} from "../src/lib/agent-registry.js";
import { createEmptyImportLock } from "../src/lib/import-lock.js";
import { createSourceIdentity, normalizeSourceInput, inferUpstreamIdFromSourceDescriptor } from "../src/lib/source-normalization.js";
import { scanSkillDirectory } from "../src/lib/skill-capabilities.js";
import { summarizeSkillFeatureSupport } from "../src/lib/agent-registry.js";
import { movePathWithFallback } from "../src/lib/init.js";
import {
  assessAgentMcpSupport,
  buildAgentRuntimeMcpServers,
  buildToolJsonMcpServers,
  summarizeRequiredMcpSupport
} from "../src/lib/mcp-config.js";
import {
  advanceGuidedFlowSession,
  buildShellTranscriptLineMap,
  clearShellEntryState,
  createGuidedFlowSession,
  createInitialShellTuiState,
  createShellOutputRecord,
  createShellExplorerTree,
  createShellTuiViewModel,
  extractShellTranscriptSelectionText,
  findShellTranscriptMatches,
  flattenShellExplorerTree,
  getShellExplorerDefaultExpandedIds,
  getShellLayoutMode,
  getCompletionSuggestions,
  handleShellAlias,
  injectProfileIfNeeded,
  resolveShortcutCommands,
  setCommandInput,
  shouldHandoffShellCommand,
  tokenizeCommandLine
} from "../src/lib/shell.js";
import { fetchRefAndResolveCommit } from "../src/lib/git-runtime.js";
import {
  materializeProjectedSkillDirectory,
  projectSkillsForAgent,
  renderProjectedSkillMarkdown
} from "../src/lib/adapters/common.js";

function createAgentIntegrationFixture(overrides = {}) {
  const {
    config: configOverrides = null,
    skills: skillsOverrides = null,
    mcp: mcpOverrides = null,
    ...entryOverrides
  } = overrides;
  return {
    id: "fixture",
    name: "Fixture",
    config: {
      order: 99,
      adapter: "fixture",
      projectionVersion: 1,
      ...(configOverrides ?? {})
    },
    skills: {
      internalDir: ".fixture/skills",
      bindMode: "root",
      targets: {
        windows: {
          dir: "%USERPROFILE%\\\\.fixture\\\\skills"
        },
        macos: {
          dir: "$HOME/.fixture/skills"
        },
        linux: {
          dir: "$HOME/.fixture/skills"
        }
      },
      support: {
        nestedDiscovery: true,
        instructions: true,
        frontmatter: false,
        scripts: false,
        assets: false,
        references: false,
        helpers: false,
        ...((skillsOverrides?.support ?? null) ?? {})
      },
      ...Object.fromEntries(
        Object.entries(skillsOverrides ?? {}).filter(([key]) => key !== "support")
      )
    },
    mcp: {
      internalConfig: ".fixture/mcp.json",
      kind: "json-mcpServers",
      supportVersion: 1,
      hasNonMcpConfig: false,
      targets: {
        windows: {
          config: "%USERPROFILE%\\\\.fixture\\\\mcp.json"
        },
        macos: {
          config: "$HOME/.fixture/mcp.json"
        },
        linux: {
          config: "$HOME/.fixture/mcp.json"
        }
      },
      support: {
        ...((mcpOverrides?.support ?? null) ?? {})
      },
      ...Object.fromEntries(
        Object.entries(mcpOverrides ?? {}).filter(([key]) => key !== "support")
      )
    },
    ...entryOverrides
  };
}

function createLegacyAgentIntegrationFixture(overrides = {}) {
  const normalized = normalizeAgentIntegrationEntry(createAgentIntegrationFixture(overrides));
  return {
    id: normalized.id,
    name: normalized.name,
    order: normalized.order,
    adapter: normalized.adapter,
    internal: { ...normalized.internal },
    targets: Object.fromEntries(
      Object.entries(normalized.targets).map(([osName, target]) => [osName, {
        ...(target.skillsDir ? { skillsDir: target.skillsDir } : {}),
        mcpConfig: target.mcpConfig
      }])
    ),
    hasNonMcpConfig: normalized.hasNonMcpConfig,
    projectionVersion: normalized.projectionVersion,
    mcpSupportVersion: normalized.mcpSupportVersion,
    mcpKind: normalized.mcpKind,
    support: {
      skills: { ...normalized.support.skills },
      mcp: { ...normalized.support.mcp }
    },
    notes: [...normalized.notes]
  };
}

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

test("createSourceIdentity is stable for equivalent git descriptors", async () => {
  const shorthand = await normalizeSourceInput("openai/skills");
  const canonical = await normalizeSourceInput("https://github.com/openai/skills.git");
  assert.equal(createSourceIdentity(shorthand), createSourceIdentity(canonical));
  assert.equal(shorthand.sourceIdentity, canonical.sourceIdentity);
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

test("renderProjectedSkillMarkdown strips YAML frontmatter when unsupported", () => {
  const rendered = renderProjectedSkillMarkdown(
    [
      "---",
      "title: projection-demo",
      "summary: Projection test",
      "---",
      "",
      "# projection-demo",
      "",
      "Body text."
    ].join("\n"),
    {
      frontmatter: false
    }
  );

  assert.equal(rendered.startsWith("---"), false);
  assert.equal(rendered.includes("# projection-demo"), true);
  assert.equal(rendered.includes("Body text."), true);
});

test("materializeProjectedSkillDirectory removes unsupported optional skill entries", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-projected-skill-source-"));
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-projected-skill-target-"));
  const sourceSkillPath = path.join(skillRoot, "demo-skill");
  const targetSkillPath = path.join(targetRoot, "demo-skill");

  try {
    await fs.mkdir(path.join(sourceSkillPath, "scripts"), { recursive: true });
    await fs.mkdir(path.join(sourceSkillPath, "references"), { recursive: true });
    await fs.mkdir(path.join(sourceSkillPath, "assets"), { recursive: true });
    await fs.mkdir(path.join(sourceSkillPath, "helpers"), { recursive: true });
    await fs.writeFile(
      path.join(sourceSkillPath, "SKILL.md"),
      [
        "---",
        "title: demo-skill",
        "---",
        "",
        "# demo-skill",
        "",
        "Projected skill fixture."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(sourceSkillPath, "scripts", "run.txt"), "echo hi\n", "utf8");
    await fs.writeFile(path.join(sourceSkillPath, "references", "note.txt"), "ref\n", "utf8");
    await fs.writeFile(path.join(sourceSkillPath, "assets", "note.txt"), "asset\n", "utf8");
    await fs.writeFile(path.join(sourceSkillPath, "helpers", "note.txt"), "helper\n", "utf8");
    await fs.writeFile(path.join(sourceSkillPath, "README.txt"), "keep\n", "utf8");

    await materializeProjectedSkillDirectory(sourceSkillPath, targetSkillPath, {
      frontmatter: false,
      scripts: false,
      references: false,
      assets: false,
      helpers: false
    });

    const projectedMarkdown = await fs.readFile(path.join(targetSkillPath, "SKILL.md"), "utf8");
    assert.equal(projectedMarkdown.startsWith("---"), false);
    assert.equal(await fsExtra.pathExists(path.join(targetSkillPath, "scripts")), false);
    assert.equal(await fsExtra.pathExists(path.join(targetSkillPath, "references")), false);
    assert.equal(await fsExtra.pathExists(path.join(targetSkillPath, "assets")), false);
    assert.equal(await fsExtra.pathExists(path.join(targetSkillPath, "helpers")), false);
    assert.equal(await fsExtra.pathExists(path.join(targetSkillPath, "README.txt")), true);
  } finally {
    await fs.rm(skillRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test("projectSkillsForAgent creates flattened aliases and filtered skill trees when nested discovery is unsupported", async () => {
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-bundle-skills-"));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-runtime-skills-"));
  const sourceSkillPath = path.join(bundleRoot, "anthropic", "demo-skill");

  try {
    await fs.mkdir(path.join(sourceSkillPath, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(sourceSkillPath, "SKILL.md"),
      [
        "---",
        "title: demo-skill",
        "---",
        "",
        "# demo-skill",
        "",
        "Projection fixture."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(sourceSkillPath, "scripts", "run.txt"), "echo hi\n", "utf8");

    const projection = await projectSkillsForAgent(bundleRoot, path.join(runtimeRoot, "skills"), {
      id: "fixture",
      support: {
        skills: {
          nestedDiscovery: false,
          frontmatter: false,
          scripts: false,
          assets: true,
          references: true,
          helpers: false
        }
      }
    });

    assert.deepEqual(
      projection.projectionPlan.get("anthropic/demo-skill"),
      ["anthropic/demo-skill", "vendor__anthropic__demo-skill"]
    );
    assert.equal(await fsExtra.pathExists(path.join(runtimeRoot, "skills", "anthropic", "demo-skill", "scripts")), false);
    assert.equal(await fsExtra.pathExists(path.join(runtimeRoot, "skills", "vendor__anthropic__demo-skill")), true);
    const aliasMarkdown = await fs.readFile(
      path.join(runtimeRoot, "skills", "vendor__anthropic__demo-skill", "SKILL.md"),
      "utf8"
    );
    assert.equal(aliasMarkdown.startsWith("---"), false);
  } finally {
    await fs.rm(bundleRoot, { recursive: true, force: true });
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("summarizeSkillFeatureSupport only flags unsupported optional features as advisory mismatches", () => {
  const summary = summarizeSkillFeatureSupport(["instructions", "scripts", "references"], {
    support: {
      skills: {
        instructions: true,
        scripts: false,
        references: true
      }
    }
  });

  assert.deepEqual(summary.checks, [
    { feature: "scripts", supported: false },
    { feature: "references", supported: true }
  ]);
  assert.deepEqual(summary.unsupported, [
    { feature: "scripts", supported: false }
  ]);
});

test("createEmptyImportLock returns the current v3 lockfile shape", () => {
  const lock = createEmptyImportLock();
  assert.equal(lock.schemaVersion, 3);
  assert.deepEqual(lock.pins, []);
  assert.deepEqual(lock.imports, []);
});

test("loadImportLock initializes the canonical v3 lockfile when none exists", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-lock-migration-"));
  const workspaceRoot = path.join(tempHome, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const importLockUrl = pathToFileURL(path.join(process.cwd(), "src", "lib", "import-lock.js")).href;
  const script = `
    import { loadImportLock } from ${JSON.stringify(importLockUrl)};
    const state = await loadImportLock();
    console.log(JSON.stringify({
      path: state.path,
      exists: state.exists,
      changed: state.changed,
      keys: Object.keys(state).sort(),
      lock: state.lock
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
    assert.equal(result.status, 0, result.stderr || "Lock initialization subprocess should succeed.");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.path, path.join(workspaceRoot, "skills-sync.lock.json"));
    assert.equal(payload.exists, false);
    assert.equal(payload.changed, false);
    assert.deepEqual(payload.keys, ["changed", "exists", "lock", "path"]);
    assert.equal(payload.lock.schemaVersion, 3);
    assert.deepEqual(payload.lock.pins, []);
    assert.deepEqual(payload.lock.imports, []);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test("loadAgentRegistry exposes formal compatibility matrix metadata", async () => {
  const registry = await loadAgentRegistry();
  const cursor = registry.find((entry) => entry.id === "cursor");
  assert.equal(typeof cursor?.projectionVersion, "number");
  assert.equal(typeof cursor?.mcpSupportVersion, "number");
  assert.equal(typeof cursor?.support?.skills?.nestedDiscovery, "boolean");
  assert.equal(typeof cursor?.support?.mcp?.transports?.stdio, "boolean");
  assert.equal(typeof cursor?.support?.mcp?.config?.mergeStrategy, "string");
  assert.equal(typeof cursor?.mcpKind, "string");
  assert.equal(Array.isArray(cursor?.notes), true);
});

test("loadAgentIntegrations derives registry and targets from per-agent integration files", async () => {
  const integrations = await loadAgentIntegrations();
  const ids = integrations.map((entry) => entry.id);
  assert.deepEqual(ids, ["codex", "claude", "cursor", "copilot", "gemini"]);
  const claude = integrations.find((entry) => entry.id === "claude");

  const windowsTargets = buildTargetsDocument(integrations, "windows");
  assert.equal(typeof windowsTargets.codex?.mcpConfig, "string");
  assert.equal(typeof windowsTargets.cursor?.skillsDir, "string");
  assert.equal(typeof integrations[0]?.hasNonMcpConfig, "boolean");
  assert.equal(typeof windowsTargets.codex?.hasNonMcpConfig, "boolean");
  assert.equal(typeof integrations[0]?.internal?.skillsDir, "string");
  assert.equal(typeof integrations[0]?.adapter, "string");
  assert.equal(claude?.mcpKind, "claude-json-type");
  assert.equal(claude?.hasNonMcpConfig, true);
  assert.equal(windowsTargets.claude?.mcpConfig, "%USERPROFILE%\\\\.claude.json");
});

test("normalizeAgentIntegrationEntry defaults missing MCP support and version conservatively", () => {
  const normalized = normalizeAgentIntegrationEntry(createAgentIntegrationFixture({
    mcp: {
      supportVersion: undefined,
      support: undefined
    }
  }));

  assert.equal(normalized.mcpSupportVersion, 1);
  assert.equal(normalized.support.mcp.transports.stdio, false);
  assert.equal(normalized.support.mcp.auth.oauth, false);
  assert.equal(normalized.support.mcp.capabilities.tools, false);
  assert.equal(normalized.support.mcp.config.mergeStrategy, "replace");
});

test("normalizeAgentIntegrationEntry preserves authored mcp.hasNonMcpConfig and emits it into derived targets", () => {
  const normalized = normalizeAgentIntegrationEntry(createAgentIntegrationFixture({
    mcp: {
      hasNonMcpConfig: true
    }
  }));
  const windowsTargets = buildTargetsDocument([normalized], "windows");

  assert.equal(normalized.hasNonMcpConfig, true);
  assert.equal(windowsTargets.fixture.hasNonMcpConfig, true);
});

test("normalizeAgentIntegrationEntry migrates legacy nested hasNonMcpConfig values", () => {
  const fixture = createLegacyAgentIntegrationFixture();
  delete fixture.hasNonMcpConfig;
  fixture.targets.windows.hasNonMcpConfig = true;
  fixture.targets.macos.hasNonMcpConfig = true;
  fixture.targets.linux.hasNonMcpConfig = true;

  const normalized = normalizeAgentIntegrationEntry(fixture);

  assert.equal(normalized.hasNonMcpConfig, true);
  assert.equal("hasNonMcpConfig" in normalized.targets.windows, false);
});

test("normalizeAgentIntegrationEntry deep-merges partial MCP support overrides", () => {
  const normalized = normalizeAgentIntegrationEntry(createAgentIntegrationFixture({
    mcp: {
      support: {
        transports: {
          stdio: true
        },
        config: {
          url: true,
          mergeStrategy: "managed-block"
        }
      }
    }
  }));

  assert.equal(normalized.support.mcp.transports.stdio, true);
  assert.equal(normalized.support.mcp.transports.sse, false);
  assert.equal(normalized.support.mcp.config.url, true);
  assert.equal(normalized.support.mcp.config.command, false);
  assert.equal(normalized.support.mcp.config.mergeStrategy, "managed-block");
});

test("MCP support selectors read normalized agent matrices", async () => {
  const registry = await loadAgentRegistry();
  const byId = new Map(registry.map((entry) => [entry.id, entry]));

  assert.equal(supportsMcpTransport(byId.get("codex"), "stdio"), true);
  assert.equal(supportsMcpTransport(byId.get("codex"), "sse"), true);
  assert.equal(supportsMcpAuth(byId.get("gemini"), "providerAuth"), true);
  assert.equal(supportsMcpAuth(byId.get("copilot"), "oauth"), false);
  assert.equal(supportsMcpCapability(byId.get("claude"), "resources"), true);
  assert.equal(supportsMcpCapability(byId.get("cursor"), "resources"), false);
  assert.equal(supportsMcpConfigField(byId.get("cursor"), "envFile"), true);
  assert.equal(supportsMcpConfigField(byId.get("claude"), "enabledTools"), false);
  assert.equal(getMcpMergeStrategy(byId.get("codex")), "managed-block");
  assert.equal(getMcpMergeStrategy(byId.get("cursor")), "replace");
  assert.equal(supportsToolFiltering(byId.get("codex")), true);
  assert.equal(supportsToolFiltering(byId.get("claude")), false);
});

test("summarizeRequiredMcpSupport derives runtime MCP requirements from canonical servers and config kind", () => {
  const requirements = summarizeRequiredMcpSupport(
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: {
            ROOT: "$HOME"
          }
        },
        notion: {
          url: "https://mcp.notion.com/mcp"
        },
        events: {
          url: "https://example.com/sse",
          transport: "sse"
        }
      }
    },
    {
      configKind: "toml-managed-block"
    }
  );

  assert.equal(requirements.capabilities.tools, true);
  assert.equal(requirements.transports.stdio, true);
  assert.equal(requirements.transports.streamableHttp, true);
  assert.equal(requirements.transports.sse, true);
  assert.equal(requirements.config.command, true);
  assert.equal(requirements.config.args, true);
  assert.equal(requirements.config.env, true);
  assert.equal(requirements.config.url, true);
  assert.equal(requirements.config.managedBlock, true);
  assert.equal(requirements.config.mergeStrategy, "managed-block");
});

test("assessAgentMcpSupport reports unsupported requirement groups from the normalized support matrix", async () => {
  const registry = await loadAgentRegistry();
  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  const assessment = assessAgentMcpSupport(byId.get("copilot"), {
    requirements: {
      auth: {
        oauth: true
      },
      capabilities: {
        resources: true
      },
      advanced: {
        roots: true
      },
      config: {
        cwd: true,
        managedBlock: true,
        mergeStrategy: "managed-block"
      }
    }
  });

  assert.deepEqual(
    assessment.issues.map((issue) => issue.message),
    [
      "support.mcp.auth.oauth",
      "support.mcp.capabilities.resources",
      "support.mcp.advanced.roots",
      "support.mcp.config.cwd",
      "support.mcp.config.managedBlock",
      "support.mcp.config.mergeStrategy=managed-block"
    ]
  );
});

test("buildAgentRuntimeMcpServers rejects agent MCP projections that require unsupported transports", async () => {
  const unsupportedAgent = normalizeAgentIntegrationEntry(createAgentIntegrationFixture({
    mcp: {
      support: {
        transports: {
          stdio: true,
          streamableHttp: true,
          sse: false
        }
      }
    }
  }));

  assert.throws(
    () =>
      buildAgentRuntimeMcpServers(
        {
          mcpServers: {
            events: {
              url: "https://example.com/sse",
              transport: "sse"
            }
          }
        },
        unsupportedAgent
      ),
    /support\.mcp\.transports\.sse/
  );
});

test("buildToolJsonMcpServers renders Copilot-compatible stdio and remote server shapes", () => {
  const projected = buildToolJsonMcpServers(
    {
      mcpServers: {
        filesystem: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"]
        },
        notion: {
          url: "https://mcp.notion.com/mcp"
        },
        events: {
          url: "https://example.com/sse",
          transport: "sse"
        }
      }
    },
    "copilot"
  );

  assert.deepEqual(projected.filesystem, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    tools: ["*"]
  });
  assert.deepEqual(projected.notion, {
    type: "http",
    url: "https://mcp.notion.com/mcp",
    tools: ["*"]
  });
  assert.deepEqual(projected.events, {
    type: "sse",
    url: "https://example.com/sse",
    tools: ["*"]
  });
});

test("buildToolJsonMcpServers renders Gemini-compatible command/url server shapes", () => {
  const projected = buildToolJsonMcpServers(
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"]
        },
        notion: {
          url: "https://mcp.notion.com/mcp"
        }
      }
    },
    "gemini"
  );

  assert.deepEqual(projected.filesystem, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
  });
  assert.deepEqual(projected.notion, {
    url: "https://mcp.notion.com/mcp"
  });
});

test("buildToolJsonMcpServers renders Claude-compatible type-based server shapes", () => {
  const projected = buildToolJsonMcpServers(
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"]
        },
        notion: {
          url: "https://mcp.notion.com/mcp"
        },
        events: {
          url: "https://example.com/sse",
          transport: "sse"
        }
      }
    },
    "claude"
  );

  assert.deepEqual(projected.filesystem, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
  });
  assert.deepEqual(projected.notion, {
    type: "http",
    url: "https://mcp.notion.com/mcp"
  });
  assert.deepEqual(projected.events, {
    type: "sse",
    url: "https://example.com/sse"
  });
});

test("movePathWithFallback copies and removes source when rename is blocked", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-init-move-fallback-"));
  const sourcePath = path.join(tempRoot, "workspace");
  const targetPath = path.join(tempRoot, "workspace.backup");
  const markerPath = path.join(sourcePath, "profiles", "personal.json");

  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, '{"name":"personal"}\n', "utf8");

  const originalRename = fsExtra.rename;
  fsExtra.rename = async () => {
    const error = new Error("rename blocked");
    error.code = "EPERM";
    throw error;
  };

  try {
    const moved = await movePathWithFallback(sourcePath, targetPath);
    assert.equal(moved, true);
    assert.equal(await fs.stat(targetPath).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(sourcePath).then(() => true).catch(() => false), false);
    assert.equal(
      await fs.readFile(path.join(targetPath, "profiles", "personal.json"), "utf8"),
      '{"name":"personal"}\n'
    );
  } finally {
    fsExtra.rename = originalRename;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fetchRefAndResolveCommit falls back from missing main to master", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-sync-main-master-fallback-"));
  const originPath = path.join(tempRoot, "origin");
  const clonePath = path.join(tempRoot, "clone");

  const runGitChecked = (args, cwd) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "skills-sync-tests",
        GIT_AUTHOR_EMAIL: "skills-sync-tests@example.com",
        GIT_COMMITTER_NAME: "skills-sync-tests",
        GIT_COMMITTER_EMAIL: "skills-sync-tests@example.com"
      }
    });

    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} should succeed.\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`
    );
    return result.stdout.trim();
  };

  try {
    await fs.mkdir(originPath, { recursive: true });
    runGitChecked(["init"], originPath);
    runGitChecked(["branch", "-M", "master"], originPath);
    await fs.writeFile(path.join(originPath, "README.md"), "fixture\n", "utf8");
    runGitChecked(["add", "README.md"], originPath);
    runGitChecked(["commit", "-m", "init"], originPath);
    const expectedCommit = runGitChecked(["rev-parse", "--verify", "master^{commit}"], originPath);

    runGitChecked(["clone", "--filter=blob:none", "--no-checkout", originPath, clonePath], tempRoot);

    const resolved = await fetchRefAndResolveCommit(clonePath, "main", { repo: originPath });
    assert.equal(
      resolved.ref,
      "master",
      "Missing main should fall back to the repository default/master branch."
    );
    assert.equal(
      resolved.commit,
      expectedCommit,
      "Fallback resolution should return the master branch commit."
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("profile shell shortcuts route skill mutations through interactive selection", () => {
  const profileShortcut = resolveShortcutCommands("profile");
  assert.equal(Boolean(profileShortcut), true, "profile shortcut config should exist.");

  assert.equal(
    profileShortcut.commands.some((item) => item.value === "profile add-skill --interactive"),
    true,
    "profile add-skill shortcut should opt into interactive skill selection."
  );
  assert.equal(
    profileShortcut.commands.some((item) => item.value === "profile remove-skill "),
    true,
    "profile remove-skill shortcut should offer the prefilled removal flow."
  );
});

test("tokenizeCommandLine preserves quoted arguments for shell input", () => {
  const tokens = tokenizeCommandLine(`profile new-skill "demo skill" --path "skills/demo skill"`);
  assert.deepEqual(tokens, [
    "profile",
    "new-skill",
    "demo skill",
    "--path",
    "skills/demo skill"
  ]);
});

test("handleShellAlias updates shell profile context aliases", () => {
  const alias = handleShellAlias(":profile work", "personal");
  assert.deepEqual(alias, {
    type: "set-profile",
    nextProfile: "work"
  });

  const clearProfileAlias = handleShellAlias(":profile none", "personal");
  assert.deepEqual(clearProfileAlias, {
    type: "set-profile",
    nextProfile: null
  });
});

test("injectProfileIfNeeded only decorates profile-aware commands", () => {
  assert.deepEqual(
    injectProfileIfNeeded(["sync", "--dry-run"], "personal"),
    ["sync", "--dry-run", "--profile", "personal"]
  );
  assert.deepEqual(
    injectProfileIfNeeded(["list", "skills"], "personal"),
    ["list", "skills"]
  );
});

test("getCompletionSuggestions includes subcommand expansions and option completions", () => {
  assert.deepEqual(
    getCompletionSuggestions("profile").slice(0, 3),
    ["profile show", "profile inspect", "profile refresh"]
  );
  assert.deepEqual(getCompletionSuggestions("list skills --f"), ["--format"]);
});

test("shouldHandoffShellCommand isolates prompt-heavy shell flows", () => {
  assert.equal(shouldHandoffShellCommand(["profile", "add-skill", "--interactive"]), true);
  assert.equal(shouldHandoffShellCommand(["profile", "remove-skill", "--upstream", "demo"]), true);
  assert.equal(shouldHandoffShellCommand(["profile", "remove-skill", "--upstream", "demo", "--yes"]), false);
  assert.equal(shouldHandoffShellCommand(["sync", "--dry-run"]), false);
});

test("getShellLayoutMode selects wide, compact, and fallback breakpoints", () => {
  assert.equal(getShellLayoutMode(120, 40), "wide");
  assert.equal(getShellLayoutMode(90, 22), "compact");
  assert.equal(getShellLayoutMode(70, 17), "fallback");
});

test("flattenShellExplorerTree auto-expands ancestor paths for filtered matches", () => {
  const tree = createShellExplorerTree();
  const flattened = flattenShellExplorerTree(tree, {
    expandedIds: new Set(getShellExplorerDefaultExpandedIds(tree)),
    filter: "agents drift"
  });

  const rowIds = flattened.rows.map((row) => row.id);
  assert.equal(rowIds.includes("agents"), true);
  assert.equal(rowIds.includes("agents-drift"), true);
  assert.equal(rowIds.includes("explore-agents-drift"), true);
  assert.equal(rowIds.includes("explore-agents-drift-apply"), true);
  assert.equal(flattened.expandedIds.has("agents"), true);
  assert.equal(flattened.expandedIds.has("agents-drift"), true);
});

test("createShellExplorerTree exposes the interactive shell catalog", () => {
  const tree = createShellExplorerTree();
  const flattened = flattenShellExplorerTree(tree, {
    expandedIds: new Set([
      "setup",
      "profiles",
      "skills",
      "mcps",
      "upstreams",
      "agents",
      "setup-init",
      "setup-sync",
      "setup-health",
      "profiles-current",
      "profiles-manage",
      "profiles-inspect",
      "skills-list",
      "skills-search",
      "skills-manage",
      "skills-refresh",
      "mcps-list",
      "mcps-manage",
      "upstreams-list",
      "upstreams-manage",
      "agents-list",
      "agents-drift"
    ])
  });
  const commands = flattened.rows
    .filter((row) => row.kind === "action")
    .map((row) => row.command);

  assert.equal(commands.includes("detect"), true, "explorer should expose agent detection.");
  assert.equal(commands.includes("use "), true, "explorer should expose profile switching.");
  assert.equal(commands.includes("new "), true, "explorer should expose profile creation.");
  assert.equal(commands.includes("list mcps"), true, "explorer should expose MCP inventory.");
  assert.equal(commands.includes("list everything"), true, "explorer should expose combined inventory.");
  assert.equal(commands.includes("list upstreams"), true, "explorer should expose upstream inventory.");
  assert.equal(commands.includes("list upstream-content --upstream "), true, "explorer should expose upstream content browsing.");
  assert.equal(commands.includes("upstream add --source "), true, "explorer should expose upstream registration.");
  assert.equal(commands.includes("profile refresh"), true, "explorer should expose profile refresh.");
  assert.equal(commands.includes("profile add-mcp"), true, "explorer should expose MCP mutation.");
  assert.equal(commands.includes("profile add-skill --interactive"), true, "explorer should expose skill import.");
  assert.equal(commands.includes("profile diff "), true, "explorer should prefill profile comparison.");
  assert.equal(commands.includes("workspace sync"), false, "workspace commands should stay out of the interactive explorer.");
});

test("guided explorer actions expose flow metadata", () => {
  const tree = createShellExplorerTree();
  const flattened = flattenShellExplorerTree(tree, {
    expandedIds: new Set([
      "skills",
      "skills-manage",
      "mcps",
      "mcps-manage",
      "upstreams",
      "upstreams-manage"
    ])
  });

  const upstreamAdd = flattened.rows.find((row) => row.id === "profile-upstream-add");
  const skillAdd = flattened.rows.find((row) => row.id === "profile-skills-add");
  const mcpAdd = flattened.rows.find((row) => row.id === "profile-mcp-add");

  assert.equal(upstreamAdd?.mode, "guided");
  assert.equal(upstreamAdd?.flowId, "upstream-add");
  assert.equal(skillAdd?.mode, "guided");
  assert.equal(skillAdd?.flowId, "skill-add");
  assert.equal(mcpAdd?.mode, "guided");
  assert.equal(mcpAdd?.flowId, "mcp-add");
});

test("createShellTuiViewModel exposes explorer-first shell state", () => {
  const state = createInitialShellTuiState("personal");
  const viewModel = createShellTuiViewModel(state);

  assert.equal(viewModel.profileLabel, "personal");
  assert.equal(viewModel.activePane, "explorer");
  assert.equal(viewModel.layoutMode, "wide");
  assert.equal(viewModel.explorerRows[0]?.label, "Setup");
  assert.equal(viewModel.footerHints.some((hint) => hint.key === ":" && hint.label === "command"), true);
  assert.equal(viewModel.transcriptBlockCount, 1);
});

test("clearShellEntryState resets transient command-bar state", () => {
  const state = createInitialShellTuiState("personal");
  setCommandInput(state, "sync --dry-run");
  state.promptMode = "command";
  state.guided = { currentStep: { id: "source" } };
  state.historyDraft = "sync --dry-run";
  state.historyIndex = 0;

  clearShellEntryState(state);

  assert.equal(state.commandInput, "");
  assert.equal(state.cursorOffset, 0);
  assert.equal(state.promptMode, null);
  assert.equal(state.guided, null);
  assert.equal(state.historyDraft, "");
  assert.equal(state.historyIndex, null);
});

test("guided upstream add flow assembles canonical CLI args", async () => {
  const session = await createGuidedFlowSession({
    flowId: "upstream-add",
    context: {
      flowDefaults: {
        variant: "profile"
      }
    }
  });

  assert.equal(session.currentStep.id, "source");
  session.ui.textValue = "matlab/skills";
  await advanceGuidedFlowSession(session);
  assert.equal(session.currentStep.id, "upstreamAliasId");

  session.ui.textValue = "matlab_skills";
  await advanceGuidedFlowSession(session);
  assert.equal(session.currentStep.id, "advancedFlags");

  session.ui.textValue = "--default-ref main";
  await advanceGuidedFlowSession(session);
  assert.equal(session.currentStep.id, "review");
  assert.equal(session.currentStep.commandText.includes("profile add-upstream"), true);

  const result = await advanceGuidedFlowSession(session);
  assert.equal(result.type, "completed");
  assert.deepEqual(result.commandArgs, [
    "profile",
    "add-upstream",
    "matlab_skills",
    "--source",
    "matlab/skills",
    "--default-ref",
    "main"
  ]);
});

test("guided mcp add flow branches to the correct transport fields", async () => {
  const stdioSession = await createGuidedFlowSession({
    flowId: "mcp-add",
    activeProfile: "personal"
  });

  assert.equal(stdioSession.currentStep.id, "serverName");
  stdioSession.ui.textValue = "filesystem";
  await advanceGuidedFlowSession(stdioSession);
  assert.equal(stdioSession.currentStep.id, "transport");

  await advanceGuidedFlowSession(stdioSession);
  assert.equal(stdioSession.currentStep.id, "command");

  const httpSession = await createGuidedFlowSession({
    flowId: "mcp-add",
    activeProfile: "personal"
  });

  httpSession.ui.textValue = "remote";
  await advanceGuidedFlowSession(httpSession);
  httpSession.ui.selectedIndex = 1;
  await advanceGuidedFlowSession(httpSession);
  assert.equal(httpSession.currentStep.id, "url");
});

test("createShellOutputRecord returns normalized transcript blocks", () => {
  const output = createShellOutputRecord({
    title: "Command output",
    command: "help",
    text: "line 1\nline 2"
  });

  assert.equal(output.title, "Command output");
  assert.equal(output.command, "help");
  assert.equal(output.text, "line 1\nline 2");
  assert.equal(output.kind, "stdout");
});

test("buildShellTranscriptLineMap renders command blocks and shell messages", () => {
  const lineMap = buildShellTranscriptLineMap([
    createShellOutputRecord({
      command: "sync --dry-run",
      text: "preview line 1\npreview line 2"
    }),
    createShellOutputRecord({
      kind: "status",
      tone: "muted",
      text: "[shell] Shell profile context: personal"
    })
  ]);

  assert.deepEqual(
    lineMap.lines.map((line) => line.text),
    [
      "$ sync --dry-run",
      "preview line 1",
      "preview line 2",
      "",
      "[shell] Shell profile context: personal"
    ]
  );
});

test("findShellTranscriptMatches returns line and column matches", () => {
  const lineMap = buildShellTranscriptLineMap([
    createShellOutputRecord({
      command: "profile inspect",
      text: "Profile context: personal\nworkspace diff preview\nProfile import warnings"
    })
  ]);

  const matches = findShellTranscriptMatches(lineMap, "profile");

  assert.deepEqual(matches, [
    { line: 0, start: 2, end: 9 },
    { line: 1, start: 0, end: 7 },
    { line: 3, start: 0, end: 7 }
  ]);
});

test("extractShellTranscriptSelectionText returns multi-line selections", () => {
  const lineMap = buildShellTranscriptLineMap([
    createShellOutputRecord({
      command: "workspace diff",
      text: "alpha beta gamma\nsecond line"
    })
  ]);

  const selection = extractShellTranscriptSelectionText(
    lineMap,
    { line: 1, column: 6 },
    { line: 2, column: 6 }
  );

  assert.equal(selection, "beta gamma\nsecond");
});
