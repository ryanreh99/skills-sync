import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "../helpers.mjs";

/**
 * Tests for:
 * - profile show/add-skill/remove-skill/add-mcp/remove-mcp
 * - upstream add/remove
 * - list profiles/everything/upstream-content
 */
export async function run({ localOverridesPath }) {
  const runGit = (args, cwd) => {
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
      `git ${args.join(" ")} should succeed in tests.\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`
    );
  };

  const personalSourcesPath = path.join(localOverridesPath, "packs", "personal", "sources.json");
  const personalMcpPath = path.join(localOverridesPath, "packs", "personal", "mcp", "servers.json");
  const localUpstreamsPath = path.join(localOverridesPath, "upstreams.json");
  const lockPath = path.join(localOverridesPath, "skills-sync.lock.json");

  // --- list profiles in json mode ---
  const profilesJson = runCli(["list", "profiles", "--format", "json"]);
  const profilesPayload = JSON.parse(profilesJson.stdout.trim());
  assert.equal(Array.isArray(profilesPayload.profiles), true, "list profiles json should return profiles[]");
  assert.equal(
    profilesPayload.profiles.some((item) => item.name === "personal"),
    true,
    "list profiles should include personal"
  );

  // --- profile show ---
  const profileShow = runCli(["profile", "show", "personal", "--format", "json"]);
  const profilePayload = JSON.parse(profileShow.stdout.trim());
  assert.equal(profilePayload.profile.name, "personal", "profile show should target personal profile.");
  assert.equal(Array.isArray(profilePayload.skills.items), true, "profile show should include skills.items array.");
  assert.equal(
    profilePayload.skills.items.every((item) => typeof item.sourceType === "string"),
    true,
    "profile show should expose logical inventory entries."
  );
  assert.equal(Array.isArray(profilePayload.mcp.servers), true, "profile show should include mcp.servers array.");

  // --- profile add-skill ---
  runCli([
    "profile",
    "add-skill",
    "personal",
    "--upstream",
    "anthropic",
    "--path",
    "skills/test-skill-new",
    "--ref",
    "main",
    "--dest-prefix",
    "anthropic"
  ]);
  const sourcesAfterAdd = JSON.parse(await fs.readFile(personalSourcesPath, "utf8"));
  const hasAddedSkill = sourcesAfterAdd.imports.some(
    (entry) =>
      entry.upstream === "anthropic" &&
      Array.isArray(entry.paths) &&
      entry.paths.includes("skills/test-skill-new")
  );
  assert.equal(hasAddedSkill, true, "profile add-skill should write sources.json.");

  // --- profile add-skill without explicit profile uses current/default profile ---
  runCli([
    "profile",
    "add-skill",
    "--upstream",
    "anthropic",
    "--path",
    "skills/test-skill-default-profile"
  ]);
  const sourcesAfterDefaultProfileAdd = JSON.parse(await fs.readFile(personalSourcesPath, "utf8"));
  const hasDefaultProfileAddedSkill = sourcesAfterDefaultProfileAdd.imports.some(
    (entry) =>
      entry.upstream === "anthropic" &&
      Array.isArray(entry.paths) &&
      entry.paths.includes("skills/test-skill-default-profile")
  );
  assert.equal(
    hasDefaultProfileAddedSkill,
    true,
    "profile add-skill without profile name should target current/default profile."
  );

  // --- profile remove-skill ---
  runCli([
    "profile",
    "remove-skill",
    "personal",
    "--upstream",
    "anthropic",
    "--path",
    "skills/test-skill-new",
    "--ref",
    "main",
    "--dest-prefix",
    "anthropic",
    "--yes"
  ]);
  const sourcesAfterRemove = JSON.parse(await fs.readFile(personalSourcesPath, "utf8"));
  const stillHasSkill = sourcesAfterRemove.imports.some(
    (entry) => Array.isArray(entry.paths) && entry.paths.includes("skills/test-skill-new")
  );
  assert.equal(stillHasSkill, false, "profile remove-skill should remove imported path.");

  runCli([
    "profile",
    "remove-skill",
    "personal",
    "--upstream",
    "anthropic",
    "--path",
    "skills/test-skill-default-profile",
    "--yes"
  ]);

  // --- profile add-mcp ---
  runCli([
    "profile",
    "add-mcp",
    "personal",
    "unit_test_server",
    "--command",
    "node",
    "--args",
    "a",
    "b",
    "--env",
    "ALPHA=1",
    "BETA=two words"
  ]);
  const mcpAfterAdd = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(mcpAfterAdd.servers ?? {}, "unit_test_server"),
    true,
    "profile add-mcp should add server entry."
  );
  assert.equal(mcpAfterAdd.servers.unit_test_server.command, "node", "added mcp server command should match.");
  assert.equal(
    mcpAfterAdd.servers.unit_test_server.env?.ALPHA,
    "1",
    "added mcp env ALPHA should match."
  );
  assert.equal(
    mcpAfterAdd.servers.unit_test_server.env?.BETA,
    "two words",
    "added mcp env BETA should match."
  );

  // --- profile add-mcp without explicit profile uses current/default profile ---
  runCli([
    "profile",
    "add-mcp",
    "unit_test_default_profile_server",
    "--url",
    "https://example.com/default-profile-mcp"
  ]);
  const mcpAfterDefaultProfileAdd = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(mcpAfterDefaultProfileAdd.servers ?? {}, "unit_test_default_profile_server"),
    true,
    "profile add-mcp without profile name should target current/default profile."
  );

  // --- profile add-mcp (http/url) ---
  runCli([
    "profile",
    "add-mcp",
    "personal",
    "unit_test_http_server",
    "--url",
    "https://example.com/mcp"
  ]);
  const mcpAfterHttpAdd = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(mcpAfterHttpAdd.servers ?? {}, "unit_test_http_server"),
    true,
    "profile add-mcp with --url should add HTTP server entry."
  );
  assert.equal(
    mcpAfterHttpAdd.servers.unit_test_http_server.url,
    "https://example.com/mcp",
    "added http mcp server url should match."
  );

  // --- profile add-mcp (stdio with dashed args via repeated --arg) ---
  runCli([
    "profile",
    "add-mcp",
    "personal",
    "unit_test_dash_args_server",
    "--command",
    "npx",
    "--arg",
    "-y",
    "--arg",
    "example-mcp-server@latest",
    "--arg",
    "--transport",
    "--arg",
    "stdio"
  ]);
  const mcpAfterDashArgsAdd = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    mcpAfterDashArgsAdd.servers.unit_test_dash_args_server.command,
    "npx",
    "profile add-mcp with repeated --arg should preserve command."
  );
  assert.deepEqual(
    mcpAfterDashArgsAdd.servers.unit_test_dash_args_server.args,
    ["-y", "example-mcp-server@latest", "--transport", "stdio"],
    "profile add-mcp with repeated --arg should preserve dashed args."
  );

  // --- profile add-mcp validation ---
  const addMcpConflict = runCli(
    [
      "profile",
      "add-mcp",
      "personal",
      "unit_test_conflict_server",
      "--command",
      "node",
      "--url",
      "https://example.com/mcp"
    ],
    1
  );
  assert.equal(
    addMcpConflict.stderr.includes("Provide exactly one of --command or --url"),
    true,
    "profile add-mcp should reject combined --command and --url."
  );

  const addMcpArgsStyleConflict = runCli(
    [
      "profile",
      "add-mcp",
      "personal",
      "unit_test_args_style_conflict_server",
      "--command",
      "node",
      "--args",
      "a",
      "b",
      "--arg",
      "c"
    ],
    1
  );
  assert.equal(
    addMcpArgsStyleConflict.stderr.includes("Use either --args or repeated --arg"),
    true,
    "profile add-mcp should reject mixing --args and --arg."
  );

  // Keep one env-bearing server for downstream projection/apply assertions.
  runCli([
    "profile",
    "add-mcp",
    "personal",
    "unit_test_env_server",
    "--command",
    "node",
    "--args",
    "run",
    "--env",
    "MCP_TEST_HOME=$HOME"
  ]);

  // --- profile remove-mcp ---
  runCli(["profile", "remove-mcp", "personal", "unit_test_server"]);
  const mcpAfterRemove = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(mcpAfterRemove.servers ?? {}, "unit_test_server"),
    false,
    "profile remove-mcp should remove server entry."
  );

  // --- profile remove-mcp without explicit profile uses current/default profile ---
  runCli(["profile", "remove-mcp", "unit_test_default_profile_server"]);
  const mcpAfterDefaultProfileRemove = JSON.parse(await fs.readFile(personalMcpPath, "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(mcpAfterDefaultProfileRemove.servers ?? {}, "unit_test_default_profile_server"),
    false,
    "profile remove-mcp without profile name should target current/default profile."
  );

  // --- upstream add ---
  runCli([
    "upstream",
    "add",
    "unit-test-upstream",
    "--source",
    "example/example",
    "--default-ref",
    "main"
  ]);
  const localUpstreamsAfterAdd = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterAdd.upstreams.some((item) => item.id === "unit-test-upstream"),
    true,
    "upstream add should create/update local upstreams.json with new upstream."
  );
  assert.equal(
    localUpstreamsAfterAdd.upstreams.some(
      (item) => item.id === "unit-test-upstream" && item.provider === "git" && item.repo === "https://github.com/example/example.git"
    ),
    true,
    "upstream add should normalize GitHub shorthand into a canonical git source."
  );

  // --- profile add-upstream alias ---
  runCli([
    "profile",
    "add-upstream",
    "unit-test-upstream-alias",
    "--source",
    "https://github.com/example/alias",
    "--default-ref",
    "main"
  ]);
  const localUpstreamsAfterAliasAdd = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterAliasAdd.upstreams.some((item) => item.id === "unit-test-upstream-alias"),
    true,
    "profile add-upstream should create/update local upstreams.json with new upstream."
  );

  // --- upstream add auto-detects default ref when omitted ---
  const detectedRefRepoPath = path.join(localOverridesPath, "unit-test-detect-ref-repo");
  await fs.rm(detectedRefRepoPath, { recursive: true, force: true });
  await fs.mkdir(detectedRefRepoPath, { recursive: true });
  runGit(["init"], detectedRefRepoPath);
  runGit(["checkout", "-b", "trunk"], detectedRefRepoPath);
  await fs.writeFile(path.join(detectedRefRepoPath, "README.md"), "# test\n", "utf8");
  runGit(["add", "README.md"], detectedRefRepoPath);
  runGit(["commit", "-m", "init"], detectedRefRepoPath);

  runCli([
    "upstream",
    "add",
    "unit-test-detect-ref",
    "--source",
    detectedRefRepoPath,
    "--provider",
    "git"
  ]);
  const localUpstreamsAfterDetectedRef = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  const detectedRefEntry = localUpstreamsAfterDetectedRef.upstreams.find((item) => item.id === "unit-test-detect-ref");
  assert.equal(
    detectedRefEntry?.defaultRef,
    "trunk",
    "upstream add should auto-detect default ref from repository HEAD when omitted."
  );

  // --- list upstreams reflects add ---
  const upstreamsJsonAfterAdd = runCli(["list", "upstreams", "--format", "json"]);
  const upstreamsPayloadAfterAdd = JSON.parse(upstreamsJsonAfterAdd.stdout.trim());
  assert.equal(
    upstreamsPayloadAfterAdd.upstreams.some((item) => item.id === "unit-test-upstream"),
    true,
    "list upstreams should include newly added upstream."
  );

  // --- upstream add (auto-id inference + conflict suffix) ---
  runCli([
    "upstream",
    "add",
    "--source",
    "https://github.com/example/example.git",
    "--default-ref",
    "main"
  ]);
  runCli([
    "upstream",
    "add",
    "--source",
    "git@github.com:example/example.git",
    "--default-ref",
    "main"
  ]);
  const localUpstreamsAfterAutoAdd = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterAutoAdd.upstreams.some((item) => item.id === "example_example"),
    true,
    "upstream add without id should infer upstream id from github owner/repo."
  );
  assert.equal(
    localUpstreamsAfterAutoAdd.upstreams.filter((item) => item.id === "example_example").length,
    1,
    "Equivalent upstreams should reconcile idempotently instead of duplicating config entries."
  );

  // --- upstream remove ---
  runCli(["upstream", "remove", "unit-test-upstream"]);
  runCli(["profile", "remove-upstream", "unit-test-upstream-alias"]);
  runCli(["upstream", "remove", "unit-test-detect-ref"]);
  runCli(["upstream", "remove", "example_example"]);
  const localUpstreamsAfterRemove = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterRemove.upstreams.some((item) => item.id === "unit-test-upstream"),
    false,
    "upstream remove should delete the upstream from local config."
  );
  assert.equal(
    localUpstreamsAfterRemove.upstreams.some((item) => item.id === "unit-test-upstream-alias"),
    false,
    "profile remove-upstream should delete the upstream from local config."
  );

  // --- list everything ---
  const everythingJson = runCli(["list", "everything", "--format", "json"]);
  const everythingPayload = JSON.parse(everythingJson.stdout.trim());
  assert.equal(Array.isArray(everythingPayload.profiles), true, "list everything should return profiles[] in json.");
  assert.equal(
    everythingPayload.profiles.some((item) => item.profile === "personal"),
    true,
    "list everything should include personal."
  );
  const everythingText = runCli(["list", "everything"]).stdout;
  assert.equal(
    everythingText.includes("MCP_TEST_HOME=$HOME"),
    true,
    "list everything text should include MCP env values."
  );

  // --- profile inspect + local-path import/provider-backed discovery ---
  const inspectBefore = JSON.parse(runCli(["profile", "inspect", "personal", "--format", "json"]).stdout.trim());
  assert.equal(typeof inspectBefore.summary.imports, "number", "profile inspect should summarize imports.");
  assert.equal(Array.isArray(inspectBefore.imports), true, "profile inspect should list imported skills.");

  const localSourceRoot = path.join(localOverridesPath, "fixtures", "local-source");
  const localSkillRoot = path.join(localSourceRoot, "native-skill");
  await fs.mkdir(path.join(localSkillRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(localSkillRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(localSkillRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(localSkillRoot, "SKILL.md"),
    [
      "---",
      "title: native-skill",
      "summary: Local provider fixture",
      "---",
      "",
      "# native-skill",
      "",
      "Local provider fixture."
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(localSkillRoot, "scripts", "run.txt"), "run\n", "utf8");
  await fs.writeFile(path.join(localSkillRoot, "references", "guide.md"), "# guide\n", "utf8");
  await fs.writeFile(path.join(localSkillRoot, "assets", "note.txt"), "asset\n", "utf8");

  const localDiscovery = JSON.parse(
    runCli([
      "list",
      "upstream-content",
      "--source",
      localSourceRoot,
      "--provider",
      "local-path",
      "--format",
      "json"
    ]).stdout.trim()
  );
  assert.equal(Array.isArray(localDiscovery.skills), true, "list upstream-content should discover local-path skills.");
  assert.equal(
    localDiscovery.skills.some((item) => item.path === "native-skill"),
    true,
    "list upstream-content should discover the local fixture skill."
  );

  runCli([
    "profile",
    "add-skill",
    "personal",
    "--source",
    localSourceRoot,
    "--provider",
    "local-path",
    "--upstream-id",
    "local-fixtures",
    "--all",
    "--build"
  ]);
  runCli([
    "profile",
    "add-skill",
    "personal",
    "--source",
    localSourceRoot,
    "--provider",
    "local-path",
    "--upstream-id",
    "local-fixtures",
    "--all"
  ]);

  const upstreamsAfterLocalImport = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    upstreamsAfterLocalImport.upstreams.some((item) => item.id === "local-fixtures" && item.provider === "local-path"),
    true,
    "profile add-skill --source should register a local-path upstream."
  );

  const sourcesAfterLocalImport = JSON.parse(await fs.readFile(personalSourcesPath, "utf8"));
  const localImportEntries = sourcesAfterLocalImport.imports.filter((entry) => entry.upstream === "local-fixtures");
  assert.equal(localImportEntries.length, 1, "Repeated local imports should reconcile instead of duplicating sources entries.");
  assert.deepEqual(localImportEntries[0].paths, ["native-skill"], "Local-path import should store selected skill paths.");
  assert.equal(localImportEntries[0].tracking, "floating", "Local-path import should default to floating tracking.");

  const inventoryAfterLocalImport = JSON.parse(
    runCli(["list", "skills", "--profile", "personal", "--detail", "full", "--format", "json"]).stdout.trim()
  );
  const localImportedSkill = inventoryAfterLocalImport.skills.find((item) => item.upstream === "local-fixtures");
  assert.equal(Boolean(localImportedSkill), true, "list skills should include local-path imported skills.");
  assert.equal(localImportedSkill.provider, "local-path", "Imported local skill should retain provider metadata.");
  assert.equal(
    localImportedSkill.capabilities.includes("scripts") &&
      localImportedSkill.capabilities.includes("references") &&
      localImportedSkill.capabilities.includes("assets") &&
      localImportedSkill.capabilities.includes("frontmatter"),
    true,
    "Capability scanning should preserve optional skill capabilities."
  );

  const installedSearch = JSON.parse(
    runCli([
      "search",
      "skills",
      "--query",
      "native",
      "--profile",
      "personal",
      "--scope",
      "installed",
      "--format",
      "json"
    ]).stdout.trim()
  );
  assert.equal(
    installedSearch.some((item) => item.sourceScope === "installed" && item.upstream === "local-fixtures"),
    true,
    "Installed-scope search should surface imported local-path skills."
  );

  const refreshDryRun = JSON.parse(
    runCli([
      "profile",
      "refresh",
      "personal",
      "--upstream",
      "local-fixtures",
      "--dry-run",
      "--format",
      "json"
    ]).stdout.trim()
  );
  assert.equal(typeof refreshDryRun.summary.unchanged, "number", "profile refresh should summarize unchanged imports.");
  assert.equal(await fs.stat(lockPath).then(() => true).catch(() => false), true, "Build after import should write skills-sync.lock.json.");

  const inspectAfterLocalImport = JSON.parse(runCli(["profile", "inspect", "personal", "--format", "json"]).stdout.trim());
  assert.equal(
    inspectAfterLocalImport.imports.some((item) => item.upstream === "local-fixtures"),
    true,
    "profile inspect should include locally imported skills."
  );

  runCli([
    "profile",
    "remove-skill",
    "personal",
    "--upstream",
    "local-fixtures",
    "--all",
    "--prune-upstream",
    "--yes"
  ]);
  const upstreamsAfterLocalRemove = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    upstreamsAfterLocalRemove.upstreams.some((item) => item.id === "local-fixtures"),
    false,
    "Removing the last local-path import with --prune-upstream should deregister the upstream."
  );

  // --- profile export/import ---
  const exportPath = path.join(localOverridesPath, "exports", "personal-profile.json");
  runCli(["profile", "export", "personal", "--output", exportPath]);
  const exportedPayload = JSON.parse(await fs.readFile(exportPath, "utf8"));
  assert.equal(exportedPayload.profile?.name, "personal", "profile export should include profile name.");
  assert.equal(
    typeof exportedPayload.profile?.pack?.mcpServers === "object",
    true,
    "profile export should include mcpServers."
  );

  const importedProfileName = "imported-profile-from-export";
  runCli(["profile", "import", importedProfileName, "--input", exportPath]);
  const importedProfilePath = path.join(localOverridesPath, "profiles", `${importedProfileName}.json`);
  const importedPackMcpPath = path.join(localOverridesPath, "packs", importedProfileName, "mcp", "servers.json");
  const importedProfileDoc = JSON.parse(await fs.readFile(importedProfilePath, "utf8"));
  const importedMcpDoc = JSON.parse(await fs.readFile(importedPackMcpPath, "utf8"));
  assert.equal(importedProfileDoc.name, importedProfileName, "profile import should create profile JSON.");
  assert.equal(
    Object.prototype.hasOwnProperty.call(importedMcpDoc.servers ?? {}, "unit_test_env_server"),
    true,
    "profile import should restore exported mcp server entries."
  );

  // --- list upstream-content ---
  const upstreamContentJson = runCli([
    "list",
    "upstream-content",
    "--upstream",
    "anthropic",
    "--format",
    "json"
  ]);
  const upstreamContentPayload = JSON.parse(upstreamContentJson.stdout.trim());
  assert.equal(Array.isArray(upstreamContentPayload.skills), true, "upstream-content json should include skills[].");
  assert.equal(
    Array.isArray(upstreamContentPayload.mcpServers),
    true,
    "upstream-content json should include mcpServers[]."
  );

  // --- workspace export/diff/sync ---
  const manifestPath = path.join(localOverridesPath, "exports", "workspace-manifest.json");
  runCli(["workspace", "export", "--output", manifestPath]);
  assert.equal(
    await fs.stat(manifestPath).then(() => true).catch(() => false),
    true,
    "workspace export should write a manifest file."
  );
  const workspaceDiff = JSON.parse(runCli(["workspace", "diff", "--input", manifestPath, "--format", "json"]).stdout.trim());
  assert.deepEqual(workspaceDiff.profiles.onlyLeft, [], "workspace diff should be clean immediately after export.");
  assert.deepEqual(workspaceDiff.upstreams.onlyLeft, [], "workspace diff should report no upstream drift immediately after export.");
  runCli(["workspace", "sync", "--input", manifestPath, "--dry-run"]);
}
