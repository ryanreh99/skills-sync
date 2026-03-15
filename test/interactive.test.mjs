import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, Key, test } from "@microsoft/tui-test";
import {
  createShellExplorerTree,
  flattenShellExplorerTree,
  getShellExplorerDefaultExpandedIds
} from "../src/lib/shell-shared.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "index.js");
const interactiveHome = path.join(repoRoot, ".tmp-tui-test-home");
const interactiveFixtureRoot = path.join(interactiveHome, "fixtures", "demo-skills");
const CURSOR_GARBAGE_PATTERN = /\[\d+;\d+[A-Za-z]/;
const ARROW_DOWN = "\u001b[B";
const ARROW_UP = "\u001b[A";
const ARROW_RIGHT = "\u001b[C";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLS_SYNC_HOME: interactiveHome,
      TERM: "xterm-256color"
    }
  });

  assert.equal(
    result.status,
    0,
    `Command failed: node ${path.relative(repoRoot, cliPath)} ${args.join(" ")}\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`
  );
}

function terminalText(terminal) {
  return terminal.getViewableBuffer()
    .map((line) => line.join(""))
    .join("\n")
    .replace(/[ \t]+/g, " ");
}

async function waitForShell(terminal) {
  await expect(terminal.getByText("skills-sync", { full: true })).toBeVisible();
  await expect(terminal.getByText("Explorer (active)", { full: true })).toBeVisible();
  await expect(terminal.getByText("Active: Explorer")).toBeVisible();
}

function createExplorerState() {
  return {
    tree: createShellExplorerTree(),
    expandedIds: new Set(getShellExplorerDefaultExpandedIds()),
    selectedId: null
  };
}

function getExplorerRows(explorerState) {
  return flattenShellExplorerTree(explorerState.tree, {
    expandedIds: explorerState.expandedIds
  }).rows;
}

function ensureExplorerSelection(explorerState) {
  const rows = getExplorerRows(explorerState);
  if (!explorerState.selectedId) {
    explorerState.selectedId = rows[0]?.id ?? null;
  }
  return rows;
}

function findExplorerPath(nodes, targetId, trail = []) {
  for (const node of nodes) {
    const nextTrail = [...trail, node];
    if (node.id === targetId) {
      return nextTrail;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const match = findExplorerPath(node.children, targetId, nextTrail);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

async function pressExplorerKey(terminal, key) {
  terminal.write(key);
  await sleep(90);
}

async function moveExplorerSelectionTo(terminal, explorerState, targetId) {
  const targetPath = findExplorerPath(explorerState.tree, targetId);
  assert.ok(targetPath, `unknown explorer target '${targetId}'`);

  ensureExplorerSelection(explorerState);

  for (const ancestor of targetPath.slice(0, -1)) {
    let rows = ensureExplorerSelection(explorerState);
    let currentIndex = rows.findIndex((row) => row.id === explorerState.selectedId);
    let targetIndex = rows.findIndex((row) => row.id === ancestor.id);

    while (currentIndex !== targetIndex) {
      if (currentIndex < targetIndex) {
        await pressExplorerKey(terminal, ARROW_DOWN);
        currentIndex += 1;
      } else {
        await pressExplorerKey(terminal, ARROW_UP);
        currentIndex -= 1;
      }
    }

    explorerState.selectedId = ancestor.id;
    if (ancestor.kind !== "action" && !explorerState.expandedIds.has(ancestor.id)) {
      await pressExplorerKey(terminal, ARROW_RIGHT);
      explorerState.expandedIds.add(ancestor.id);
    }
  }

  const rows = ensureExplorerSelection(explorerState);
  let currentIndex = rows.findIndex((row) => row.id === explorerState.selectedId);
  const targetIndex = rows.findIndex((row) => row.id === targetId);
  assert.ok(targetIndex >= 0, `explorer target '${targetId}' should be visible`);

  while (currentIndex !== targetIndex) {
    if (currentIndex < targetIndex) {
      await pressExplorerKey(terminal, ARROW_DOWN);
      currentIndex += 1;
    } else {
      await pressExplorerKey(terminal, ARROW_UP);
      currentIndex -= 1;
    }
  }

  explorerState.selectedId = targetId;
}

async function openExplorerAction(terminal, explorerState, targetId) {
  await moveExplorerSelectionTo(terminal, explorerState, targetId);
  await sleep(120);
  terminal.keyPress(Key.Enter);
  await sleep(120);
}

await fs.rm(interactiveHome, { recursive: true, force: true });
await fs.mkdir(path.join(interactiveFixtureRoot, "alpha"), { recursive: true });
await fs.mkdir(path.join(interactiveFixtureRoot, "beta"), { recursive: true });
await fs.writeFile(
  path.join(interactiveFixtureRoot, "alpha", "SKILL.md"),
  "# alpha\n\nAlpha demo skill.\n",
  "utf8"
);
await fs.writeFile(
  path.join(interactiveFixtureRoot, "beta", "SKILL.md"),
  "# beta\n\nBeta demo skill.\n",
  "utf8"
);
runCli(["init", "--seed"]);
runCli(["use", "personal"]);
runCli(["upstream", "add", "demo_fixture", "--source", interactiveFixtureRoot, "--provider", "local-path"]);
runCli(["profile", "add-skill", "personal", "--upstream", "demo_fixture", "--path", "alpha", "--no-sync"]);

test.use({
  columns: 120,
  rows: 40,
  program: {
    file: process.execPath,
    args: [cliPath]
  },
  env: {
    ...process.env,
    SKILLS_SYNC_HOME: interactiveHome,
    TERM: "xterm-256color"
  }
});

test("launches the explorer-first full-screen shell", async ({ terminal }) => {
  await waitForShell(terminal);
  await expect(terminal.getByText("Explorer (active)", { full: true })).toBeVisible();

  const text = terminalText(terminal);
  assert.equal(text.includes("skills-sync(personal) >"), false, "command prompt should stay hidden until invoked.");
});

test("expands explorer sections and opens prefill actions on demand", async ({ terminal }) => {
  await waitForShell(terminal);
  const explorerState = createExplorerState();
  await openExplorerAction(terminal, explorerState, "explore-skills-search");

  await expect(terminal.getByText(/skills-sync\(personal\) >/g, { full: true })).toBeVisible();
  assert.equal(
    terminalText(terminal).includes("search skills --query"),
    true,
    "prefill actions should open the command prompt with the selected command."
  );
});

test("opens guided upstream add flows instead of the raw command prompt", async ({ terminal }) => {
  await waitForShell(terminal);
  const explorerState = createExplorerState();

  await openExplorerAction(terminal, explorerState, "profile-upstream-add");

  await expect(terminal.getByText("Source locator")).toBeVisible();
  await expect(terminal.getByText("GitHub shorthand, git URL, or local path.")).toBeVisible();
  assert.equal(
    terminalText(terminal).includes("skills-sync(personal) >"),
    false,
    "guided flows should not drop into the raw command prompt immediately."
  );
});

test("guided skill remove flow supports picker selection and confirmation", async ({ terminal }) => {
  await waitForShell(terminal);
  const explorerState = createExplorerState();

  await openExplorerAction(terminal, explorerState, "profile-skills-remove");
  await expect(terminal.getByText("Imported upstream")).toBeVisible();

  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("Removal mode")).toBeVisible();

  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("Imported skills")).toBeVisible();
  await expect(terminal.getByText("skills/frontend-design")).toBeVisible();

  terminal.keyPress(Key.Space);
  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("Advanced flags (optional)")).toBeVisible();

  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("Review skill removal")).toBeVisible();
  await expect(terminal.getByText("Run command")).toBeVisible();
});

test("runs raw commands from the hidden prompt and appends to the transcript", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.keyPress(":");
  await expect(terminal.getByText(/skills-sync\(personal\) >/g, { full: true })).toBeVisible();
  terminal.submit("current");

  await expect(terminal.getByText("$ current", { full: true })).toBeVisible();
  await expect(terminal.getByText("Active: Explorer")).toBeVisible();

  const text = terminalText(terminal);
  assert.equal(text.includes("skills-sync(personal) > current"), false, "command prompt should clear after submit.");
});

test("keeps inline transcript output free of cursor-control garbage", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.keyPress(":");
  await expect(terminal.getByText(/skills-sync\(personal\) >/g, { full: true })).toBeVisible();
  terminal.write("current");
  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("$ current", { full: true })).toBeVisible();

  const text = terminalText(terminal);
  assert.equal(CURSOR_GARBAGE_PATTERN.test(text), false, "transcript should not contain raw cursor-control fragments.");
});

test("tab switches cleanly between explorer and transcript", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.keyPress(Key.Tab);
  await expect(terminal.getByText("Transcript (active)", { full: true })).toBeVisible();
  await expect(terminal.getByText("Active: Transcript")).toBeVisible();

  terminal.keyPress(Key.Tab);
  await expect(terminal.getByText("Explorer (active)", { full: true })).toBeVisible();
  await expect(terminal.getByText("Active: Explorer")).toBeVisible();
});

test("keeps a persistent transcript and supports transcript search", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.keyPress(":");
  await expect(terminal.getByText(/skills-sync\(personal\) >/g, { full: true })).toBeVisible();
  terminal.submit("current");
  await expect(terminal.getByText("$ current", { full: true })).toBeVisible();

  terminal.keyPress("?");
  await expect(terminal.getByText("Interactive shell commands")).toBeVisible();

  const text = terminalText(terminal);
  assert.equal(text.includes("$ current"), true, "transcript should retain earlier command blocks.");

  terminal.keyPress(Key.Tab);
  await expect(terminal.getByText("Active: Transcript")).toBeVisible();
  terminal.keyPress("/");
  await expect(terminal.getByText("Filter")).toBeVisible();
  terminal.submit("profile");
  await expect(terminal.getByText("search profile", { full: false })).toBeVisible();
});

test("restores the shell after foreground prompt handoff", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.keyPress(":");
  await expect(terminal.getByText(/skills-sync\(personal\) >/g, { full: true })).toBeVisible();
  terminal.write("profile add-mcp");
  terminal.keyPress(Key.Enter);
  await expect(terminal.getByText("MCP server name", { full: true })).toBeVisible();

  terminal.keyCtrlC();
  await waitForShell(terminal);
});

test("escape backs out of guided flows without leaving stale prompt state", async ({ terminal }) => {
  await waitForShell(terminal);
  const explorerState = createExplorerState();

  await openExplorerAction(terminal, explorerState, "profile-upstream-add");
  await expect(terminal.getByText("Source locator")).toBeVisible();

  terminal.keyPress(Key.Escape);
  await expect(terminal.getByText("Explorer (active)", { full: true })).toBeVisible();
  await expect(terminal.getByText("Enter expand / run")).toBeVisible();
});

test("compact mode switches between explorer and transcript pages", async ({ terminal }) => {
  await waitForShell(terminal);

  terminal.resize(90, 22);
  await expect(terminal.getByText("Explorer (active)", { full: true })).toBeVisible();

  terminal.keyPress(Key.Tab);
  await expect(terminal.getByText("Transcript (active)", { full: true })).toBeVisible();
  await expect(terminal.getByText("Active: Transcript")).toBeVisible();
});

test.describe("small terminal rejection", () => {
  test.use({
    columns: 70,
    rows: 17
  });

  test("prints a clear error below the minimum TTY size", async ({ terminal }) => {
    await expect(terminal.getByText("requires a TTY terminal of at least 80x18")).toBeVisible();
    assert.equal(
      terminalText(terminal).includes("Explorer"),
      false,
      "undersized terminals should not render the full-screen explorer/transcript TUI."
    );
  });
});
