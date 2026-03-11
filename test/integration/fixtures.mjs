import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Builds a targets override pointing all tool paths into runtimePath,
 * and writes it to workspace/manifests/targets.override.json.
 */
export async function writeTargetsOverride(localOverridesPath, runtimePath) {
  const overridePath = path.join(localOverridesPath, "manifests", "targets.override.json");
  const override = {
    codex: {
      skillsDir: path.join(runtimePath, ".codex", "skills", "vendor_imports"),
      mcpConfig: path.join(runtimePath, ".codex", "config.toml"),
      hasNonMcpConfig: true
    },
    claude: {
      skillsDir: path.join(runtimePath, ".claude", "skills"),
      mcpConfig: path.join(runtimePath, ".claude.json"),
      hasNonMcpConfig: false
    },
    cursor: {
      skillsDir: path.join(runtimePath, ".cursor", "skills"),
      mcpConfig: path.join(runtimePath, ".cursor", "mcp.json"),
      hasNonMcpConfig: false
    },
    copilot: {
      skillsDir: path.join(runtimePath, ".copilot", "skills"),
      mcpConfig: path.join(runtimePath, ".copilot", "mcp-config.json"),
      hasNonMcpConfig: false
    },
    gemini: {
      skillsDir: path.join(runtimePath, ".gemini", "skills"),
      mcpConfig: path.join(runtimePath, ".gemini", "settings.json"),
      hasNonMcpConfig: true
    }
  };
  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  await fs.writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`, "utf8");
}

/**
 * Creates pre-existing user-side configs in runtimePath, simulating a real
 * user environment with unmanaged keys that should survive apply/unlink.
 */
export async function seedUserConfigs(runtimePath) {
  const codexVendorImportsPath = path.join(runtimePath, ".codex", "skills", "vendor_imports");
  const codexUnmanagedDirPath = path.join(codexVendorImportsPath, "manual-skills");
  const codexUnmanagedMarkerPath = path.join(codexVendorImportsPath, "README.local.txt");

  await fs.mkdir(path.join(runtimePath, ".codex"), { recursive: true });
  await fs.mkdir(codexVendorImportsPath, { recursive: true });
  await fs.mkdir(path.join(runtimePath, ".cursor"), { recursive: true });
  await fs.mkdir(path.join(runtimePath, ".copilot"), { recursive: true });
  await fs.mkdir(path.join(runtimePath, ".gemini"), { recursive: true });
  await fs.mkdir(codexUnmanagedDirPath, { recursive: true });
  await fs.writeFile(codexUnmanagedMarkerPath, "keep me\n", "utf8");

  await fs.writeFile(
    path.join(runtimePath, ".codex", "config.toml"),
    [
      'model = "gpt-5-codex"',
      "",
      '[mcp_servers."keep_me"]',
      'transport = "stdio"',
      'command = "echo"',
      'args = ["keep"]',
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(runtimePath, ".claude.json"),
    `${JSON.stringify(
      {
        mcpServers: { keep_me: { transport: "stdio", command: "echo", args: ["keep"] } },
        settings: { verbose: true }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(runtimePath, ".cursor", "mcp.json"),
    `${JSON.stringify(
      { mcpServers: { keep_me: { transport: "stdio", command: "echo", args: ["keep"] } } },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(runtimePath, ".copilot", "mcp-config.json"),
    `${JSON.stringify(
      {
        mcpServers: { keep_me: { transport: "stdio", command: "echo", args: ["keep"] } },
        editor: { chat: { autoSuggest: true } }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(runtimePath, ".gemini", "settings.json"),
    `${JSON.stringify(
      {
        mcpServers: { keep_me: { transport: "stdio", command: "echo", args: ["keep"] } },
        ui: { theme: "dark" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

/**
 * Asserts that the JSON string contains managed MCP keys blended with the
 * pre-existing unmanaged keep_me key.
 */
export function assertManagedJsonMerged(content, label) {
  const doc = JSON.parse(content);
  assert.equal(typeof doc.mcpServers, "object", `${label}: mcpServers should be an object.`);
  assert.equal("keep_me" in doc.mcpServers, true, `${label}: expected unmanaged key keep_me.`);
  const managed = Object.keys(doc.mcpServers).filter((key) => key !== "keep_me");
  assert.equal(managed.length > 0, true, `${label}: expected managed keys.`);
}

/**
 * Asserts that managed MCP keys have been removed but unmanaged ones remain.
 */
export function assertManagedJsonRemoved(content, label) {
  const doc = JSON.parse(content);
  const managed = Object.keys(doc.mcpServers ?? {}).filter((key) => key !== "keep_me");
  assert.equal(managed.length, 0, `${label}: managed keys should be removed by unlink.`);
  assert.equal("keep_me" in (doc.mcpServers ?? {}), true, `${label}: unmanaged key should remain.`);
}
