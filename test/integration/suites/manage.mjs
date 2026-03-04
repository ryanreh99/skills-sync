import assert from "node:assert/strict";
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
  const personalSourcesPath = path.join(localOverridesPath, "packs", "personal", "sources.json");
  const personalMcpPath = path.join(localOverridesPath, "packs", "personal", "mcp", "servers.json");
  const localUpstreamsPath = path.join(localOverridesPath, "upstreams.json");

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
  assert.equal(Array.isArray(profilePayload.skills.local), true, "profile show should include skills.local array.");
  assert.equal(Array.isArray(profilePayload.skills.imports), true, "profile show should include skills.imports array.");
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
    "anthropic"
  ]);
  const sourcesAfterRemove = JSON.parse(await fs.readFile(personalSourcesPath, "utf8"));
  const stillHasSkill = sourcesAfterRemove.imports.some(
    (entry) => Array.isArray(entry.paths) && entry.paths.includes("skills/test-skill-new")
  );
  assert.equal(stillHasSkill, false, "profile remove-skill should remove imported path.");

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

  // --- upstream add ---
  runCli([
    "upstream",
    "add",
    "unit-test-upstream",
    "--repo",
    "https://github.com/example/example.git",
    "--default-ref",
    "main"
  ]);
  const localUpstreamsAfterAdd = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterAdd.upstreams.some((item) => item.id === "unit-test-upstream"),
    true,
    "upstream add should create/update local upstreams.json with new upstream."
  );

  // --- list upstreams reflects add ---
  const upstreamsJsonAfterAdd = runCli(["list", "upstreams", "--format", "json"]);
  const upstreamsPayloadAfterAdd = JSON.parse(upstreamsJsonAfterAdd.stdout.trim());
  assert.equal(
    upstreamsPayloadAfterAdd.upstreams.some((item) => item.id === "unit-test-upstream"),
    true,
    "list upstreams should include newly added upstream."
  );

  // --- upstream remove ---
  runCli(["upstream", "remove", "unit-test-upstream"]);
  const localUpstreamsAfterRemove = JSON.parse(await fs.readFile(localUpstreamsPath, "utf8"));
  assert.equal(
    localUpstreamsAfterRemove.upstreams.some((item) => item.id === "unit-test-upstream"),
    false,
    "upstream remove should delete the upstream from local config."
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
}
