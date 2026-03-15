import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pty from "node-pty";
import {
  createShellExplorerTree,
  flattenShellExplorerTree,
  getShellExplorerDefaultExpandedIds
} from "../src/lib/shell-shared.js";

const ESC = "\u001b";
const BEL = "\u0007";
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_ENTER = "\r";
const KEY_SPACE = " ";
const CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`,
  "g"
);

function parseArgs(argv) {
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    values.set(token, argv[index + 1]);
    index += 1;
  }

  const scenarioPath = values.get("--scenario");
  const outputPath = values.get("--output");

  if (!scenarioPath || !outputPath) {
    throw new Error("Usage: node scripts/record-demo-session.mjs --scenario <path> --output <path>");
  }

  return {
    scenarioPath: path.resolve(scenarioPath),
    outputPath: path.resolve(outputPath)
  };
}

function createRecordingConfig({ cols, rows }) {
  return {
    command: null,
    cwd: null,
    env: {
      recording: true
    },
    cols,
    rows,
    repeat: 0,
    quality: 100,
    frameDelay: "auto",
    maxIdleTime: 700,
    frameBox: {
      type: "floating",
      title: "skills-sync",
      style: {
        border: "0px black solid"
      }
    },
    watermark: {
      imagePath: null,
      style: {
        position: "absolute",
        right: "15px",
        bottom: "15px",
        width: "100px",
        opacity: 0.9
      }
    },
    cursorStyle: "bar",
    fontFamily: "Cascadia Code, Consolas, Monaco, monospace",
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    theme: {
      background: "#0f1521",
      foreground: "#d7deea",
      cursor: "#8bb6ff",
      black: "#0f1521",
      red: "#ef7c8e",
      green: "#7fca7d",
      yellow: "#e5b868",
      blue: "#6ea6ff",
      magenta: "#c792ea",
      cyan: "#7fdbca",
      white: "#d7deea",
      brightBlack: "#7f8aa0",
      brightRed: "#f29aa8",
      brightGreen: "#9cd999",
      brightYellow: "#ebc988",
      brightBlue: "#8bb6ff",
      brightMagenta: "#d9b8f7",
      brightCyan: "#a6e9df",
      brightWhite: "#f0f5fb"
    }
  };
}

function sanitizeTerminalText(text) {
  return String(text ?? "")
    .replace(CONTROL_SEQUENCE_PATTERN, "")
    .replaceAll("\u0000", "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function excerpt(text, maxLength = 1000) {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(-maxLength);
}

async function recordScenario(scenario) {
  const entryPoint = path.resolve(scenario.entryPoint);
  const cols = Number.isFinite(Number(scenario.cols)) ? Number(scenario.cols) : 88;
  const rows = Number.isFinite(Number(scenario.rows)) ? Number(scenario.rows) : 22;
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const promptText = String(scenario.promptText ?? "skills-sync(personal) > ");
  const readyMarker = String(scenario.readyMarker ?? "Explorer-first shell ready.");
  const quietAfterPromptMs = Number.isFinite(Number(scenario.quietAfterPromptMs))
    ? Number(scenario.quietAfterPromptMs)
    : 180;
  const quietAfterCommandMs = Number.isFinite(Number(scenario.quietAfterCommandMs))
    ? Number(scenario.quietAfterCommandMs)
    : 500;
  const navigationDelayMs = Number.isFinite(Number(scenario.navigationDelayMs))
    ? Number(scenario.navigationDelayMs)
    : 90;
  const expandDelayMs = Number.isFinite(Number(scenario.expandDelayMs))
    ? Number(scenario.expandDelayMs)
    : 140;
  const typingDelayMs = Number.isFinite(Number(scenario.typingDelayMs))
    ? Number(scenario.typingDelayMs)
    : 35;
  const timeoutMs = Number.isFinite(Number(scenario.timeoutMs))
    ? Number(scenario.timeoutMs)
    : 60000;
  const explorerTree = createShellExplorerTree();
  const explorerState = {
    expandedIds: new Set(getShellExplorerDefaultExpandedIds(explorerTree)),
    selectedId: null
  };
  let activePane = "explorer";

  const records = [];
  let sanitizedLog = "";
  let lastDataAt = Date.now();
  let lastRecordedDataAt = lastDataAt;
  let dataVersion = 0;
  let pendingRecord = null;
  let pendingFlush = null;

  function flushPendingRecord() {
    if (!pendingRecord) {
      return;
    }
    records.push({
      delay: Math.max(0, pendingRecord.startedAt - lastRecordedDataAt),
      content: pendingRecord.content
    });
    lastRecordedDataAt = pendingRecord.endedAt;
    pendingRecord = null;
    pendingFlush = null;
  }

  const shell = pty.spawn(process.execPath, [entryPoint], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: path.resolve(scenario.cwd ?? process.cwd()),
    env: {
      ...process.env,
      ...scenario.env,
      TERM: scenario.env?.TERM ?? "xterm-256color",
      COLORTERM: scenario.env?.COLORTERM ?? "truecolor"
    }
  });

  const exitPromise = new Promise((resolve) => {
    shell.onExit((result) => {
      flushPendingRecord();
      resolve(result);
    });
  });

  shell.onData((chunk) => {
    const now = Date.now();
    const text = String(chunk ?? "");
    dataVersion += 1;
    lastDataAt = now;
    sanitizedLog += sanitizeTerminalText(text);

    if (!pendingRecord) {
      pendingRecord = {
        startedAt: now,
        endedAt: now,
        content: text
      };
    } else {
      pendingRecord.endedAt = now;
      pendingRecord.content += text;
    }

    if (pendingFlush) {
      clearTimeout(pendingFlush);
    }
    pendingFlush = setTimeout(flushPendingRecord, 12);
  });

  async function waitForText(marker, startIndex, description) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const matchIndex = sanitizedLog.indexOf(marker, startIndex);
      if (matchIndex >= 0) {
        return matchIndex;
      }
      await sleep(50);
    }
    throw new Error(
      `Timed out waiting for ${description}.\nRecent terminal text:\n${excerpt(sanitizedLog)}`
    );
  }

  async function waitForOutputChange(previousVersion, description) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (dataVersion > previousVersion) {
        return;
      }
      await sleep(25);
    }
    throw new Error(
      `Timed out waiting for ${description}.\nRecent terminal text:\n${excerpt(sanitizedLog)}`
    );
  }

  async function waitForQuiet(minQuietMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (Date.now() - lastDataAt >= minQuietMs) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for terminal quiet.\nRecent terminal text:\n${excerpt(sanitizedLog)}`);
  }

  function getExplorerRows() {
    return flattenShellExplorerTree(explorerTree, { expandedIds: explorerState.expandedIds }).rows;
  }

  function ensureExplorerSelection() {
    const rows = getExplorerRows();
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

  async function pressKey(key, delayMs = navigationDelayMs) {
    shell.write(key);
    await sleep(delayMs);
  }

  async function typeText(text) {
    for (const character of String(text).split("")) {
      shell.write(character);
      await sleep(typingDelayMs);
    }
  }

  async function moveExplorerSelectionTo(targetId) {
    const targetPath = findExplorerPath(explorerTree, targetId);
    if (!targetPath) {
      throw new Error(`Unknown explorer target '${targetId}'.`);
    }

    ensureExplorerSelection();

    for (const ancestor of targetPath.slice(0, -1)) {
      let rows = ensureExplorerSelection();
      let currentIndex = rows.findIndex((row) => row.id === explorerState.selectedId);
      let targetIndex = rows.findIndex((row) => row.id === ancestor.id);

      while (currentIndex !== targetIndex) {
        if (currentIndex < targetIndex) {
          await pressKey(KEY_DOWN);
          currentIndex += 1;
        } else {
          await pressKey(KEY_UP);
          currentIndex -= 1;
        }
      }

      explorerState.selectedId = ancestor.id;
      if (ancestor.kind !== "action" && !explorerState.expandedIds.has(ancestor.id)) {
        await pressKey(KEY_RIGHT, expandDelayMs);
        explorerState.expandedIds.add(ancestor.id);
      }
    }

    const rows = ensureExplorerSelection();
    let currentIndex = rows.findIndex((row) => row.id === explorerState.selectedId);
    const targetIndex = rows.findIndex((row) => row.id === targetId);
    if (targetIndex < 0) {
      throw new Error(`Explorer target '${targetId}' is not visible after expansion.`);
    }

    while (currentIndex !== targetIndex) {
      if (currentIndex < targetIndex) {
        await pressKey(KEY_DOWN);
        currentIndex += 1;
      } else {
        await pressKey(KEY_UP);
        currentIndex -= 1;
      }
    }

    explorerState.selectedId = targetId;
    return getExplorerRows().find((row) => row.id === targetId) ?? null;
  }

  async function runRawCommand(command) {
    const promptIndex = sanitizedLog.length;
    const dataBeforePrompt = dataVersion;
    shell.write(":");
    await waitForOutputChange(dataBeforePrompt, "the command prompt to open");
    await waitForText(promptText, promptIndex, `prompt '${promptText}'`);
    await sleep(quietAfterPromptMs);

    await typeText(command);
    await sleep(120);

    const dataBeforeCommand = dataVersion;
    shell.write(KEY_ENTER);
    await waitForOutputChange(dataBeforeCommand, `command output for '${command}'`);
    activePane = "transcript";
  }

  async function runExplorerStep(step) {
    if (activePane !== "explorer") {
      const dataBeforeFocus = dataVersion;
      shell.write("\t");
      await waitForOutputChange(dataBeforeFocus, "Explorer focus");
      activePane = "explorer";
      await sleep(navigationDelayMs);
    }

    const targetId = String(step.targetId ?? "");
    const row = await moveExplorerSelectionTo(targetId);
    if (!row || row.kind !== "action") {
      throw new Error(`Explorer target '${targetId}' is not an executable action.`);
    }

    const interactionIndex = sanitizedLog.length;
    const dataBeforeAction = dataVersion;
    shell.write(KEY_ENTER);

    if (row.mode === "prefill") {
      await waitForOutputChange(dataBeforeAction, `prefill prompt for '${targetId}'`);
      await waitForText(promptText, interactionIndex, `prompt '${promptText}'`);
      await sleep(quietAfterPromptMs);
      if (typeof step.suffix === "string" && step.suffix.length > 0) {
        await typeText(step.suffix);
      }
      await sleep(120);
      const dataBeforeCommand = dataVersion;
      shell.write(KEY_ENTER);
      await waitForOutputChange(dataBeforeCommand, `command output for '${targetId}'`);
      activePane = "transcript";
      return;
    }

    await waitForOutputChange(dataBeforeAction, `command output for '${targetId}'`);
    activePane = "transcript";
  }

  async function runGuidedStep(step) {
    if (activePane !== "explorer") {
      const dataBeforeFocus = dataVersion;
      shell.write("\t");
      await waitForOutputChange(dataBeforeFocus, "Explorer focus");
      activePane = "explorer";
      await sleep(navigationDelayMs);
    }

    const targetId = String(step.targetId ?? "");
    const row = await moveExplorerSelectionTo(targetId);
    if (!row || row.kind !== "action") {
      throw new Error(`Explorer target '${targetId}' is not an executable action.`);
    }

    const openIndex = sanitizedLog.length;
    const dataBeforeOpen = dataVersion;
    shell.write(KEY_ENTER);
    await waitForOutputChange(dataBeforeOpen, `guided flow for '${targetId}'`);
    await sleep(quietAfterPromptMs);

    const inputs = Array.isArray(step.inputs) ? step.inputs : [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index] ?? {};
      const type = String(input.type ?? "submit");

      if (type === "text") {
        if (typeof input.value === "string" && input.value.length > 0) {
          await typeText(input.value);
          await sleep(120);
        }
      } else if (type === "select" || type === "picker" || type === "submit") {
        const moves = Number.isFinite(Number(input.moves)) ? Number(input.moves) : 0;
        const directionKey = moves >= 0 ? KEY_DOWN : KEY_UP;
        for (let moveIndex = 0; moveIndex < Math.abs(moves); moveIndex += 1) {
          await pressKey(directionKey);
        }

        if (type === "picker" && input.toggle !== false) {
          shell.write(KEY_SPACE);
          await sleep(navigationDelayMs);
        }
      } else {
        throw new Error(`Unsupported guided input type '${type}'.`);
      }

      const dataBeforeAdvance = dataVersion;
      shell.write(KEY_ENTER);
      await waitForOutputChange(dataBeforeAdvance, `guided step ${index + 1} for '${targetId}'`);
      await sleep(quietAfterPromptMs);
    }

    if (inputs.length === 0) {
      throw new Error(`Guided step '${targetId}' requires at least one guided input.`);
    }

    if (sanitizedLog.length <= openIndex) {
      throw new Error(`Guided flow '${targetId}' produced no terminal output.`);
    }

    activePane = "transcript";
  }

  try {
    await waitForText(readyMarker, 0, `shell ready marker '${readyMarker}'`);
    await waitForQuiet(quietAfterCommandMs);
    ensureExplorerSelection();

    for (const step of steps) {
      if (step?.kind === "run" && step.command) {
        await runRawCommand(step.command);
      } else if (step?.kind === "guided" && step.targetId) {
        await runGuidedStep(step);
      } else if (step?.kind === "explorer" && step.targetId) {
        await runExplorerStep(step);
      } else {
        continue;
      }
      const settleDelayMs = Number.isFinite(Number(step.pauseAfterMs)) && Number(step.pauseAfterMs) > 0
        ? Number(step.pauseAfterMs)
        : 3500;
      await sleep(settleDelayMs);
      await waitForQuiet(quietAfterCommandMs);
    }

    const exitPromptIndex = sanitizedLog.length;
    const dataBeforeExitPrompt = dataVersion;
    shell.write(":");
    await waitForOutputChange(dataBeforeExitPrompt, "the exit prompt to open");
    await waitForText(promptText, exitPromptIndex, `prompt '${promptText}' before exit`);
    await sleep(quietAfterPromptMs);

    for (const character of "exit") {
      shell.write(character);
      await sleep(typingDelayMs);
    }
    await sleep(120);

    const exitMarkerIndex = sanitizedLog.length;
    shell.write("\r");
    await waitForText("Leaving shell mode.", exitMarkerIndex, "shell shutdown");
    const result = await exitPromise;

    if (result.exitCode !== 0) {
      throw new Error(
        `Demo shell exited with code ${result.exitCode}.\nRecent terminal text:\n${excerpt(sanitizedLog)}`
      );
    }
  } finally {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      flushPendingRecord();
    }
  }

  return {
    config: createRecordingConfig({ cols, rows }),
    records
  };
}

async function main() {
  const { scenarioPath, outputPath } = parseArgs(process.argv.slice(2));
  const scenario = JSON.parse(await fs.readFile(scenarioPath, "utf8"));
  const recording = await recordScenario(scenario);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
