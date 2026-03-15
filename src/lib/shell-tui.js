import blessed from "neo-blessed";
import clipboard from "clipboardy";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDefaultProfile } from "./config.js";
import {
  advanceGuidedFlowSession,
  createGuidedFlowSession,
  retreatGuidedFlowSession
} from "./shell-guided.js";
import {
  applyCompletionSuggestion,
  createShellExplorerTree,
  createShellHelpLines,
  findShellExplorerShortcutTargetId,
  flattenShellExplorerTree,
  getCompletionSuggestions,
  getShellExplorerDefaultExpandedIds,
  getShellFooterHints,
  getShellPromptText,
  handleShellAlias,
  injectProfileIfNeeded,
  isShellShortcut,
  normalizeRootToken,
  tokenizeCommandLine
} from "./shell-shared.js";
import { stripAnsi } from "./terminal-ui.js";

const THEME = {
  background: "#0f1521",
  panel: "#151d2b",
  foreground: "#d7deea",
  muted: "#7f8aa0",
  accent: "#6ea6ff",
  border: "#334055",
  activeBorder: "#8bb6ff",
  selectionText: "#0f1521",
  success: "#7fca7d",
  warning: "#e5b868",
  danger: "#ef7c8e"
};

const MIN_TUI_COLUMNS = 80;
const MIN_TUI_ROWS = 18;
const WIDE_TUI_COLUMNS = 100;
const WIDE_TUI_ROWS = 24;
const EXPLORER_WIDTH = 32;
const TRANSCRIPT_LIMIT = 500;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`,
  "g"
);
const CLI_ENTRY_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

function sanitizeCapturedText(text) {
  return stripAnsi(String(text ?? ""))
    .replace(CONTROL_SEQUENCE_PATTERN, "")
    .replaceAll("\u0000", "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd();
}

function clampColumns(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getToneColor(tone) {
  switch (tone) {
    case "accent":
      return THEME.accent;
    case "success":
      return THEME.success;
    case "warning":
      return THEME.warning;
    case "danger":
      return THEME.danger;
    case "foreground":
      return THEME.foreground;
    case "muted":
    default:
      return THEME.muted;
  }
}

function withTags(text, ...tags) {
  return `${tags.map((tag) => `{${tag}}`).join("")}${blessed.escape(String(text ?? ""))}{/}`;
}

function toneTag(tone) {
  return `${getToneColor(tone)}-fg`;
}

function setStatus(state, text, tone = "muted", sticky = false) {
  state.status = {
    text: String(text ?? "").trim(),
    tone,
    sticky
  };
}

function clearTransientStatus(state) {
  if (state.busy || state.status.sticky) {
    return;
  }
  state.status = {
    text: "",
    tone: "muted",
    sticky: false
  };
}

export function getShellLayoutMode(columns, rows) {
  const normalizedColumns = clampColumns(Number(columns), WIDE_TUI_COLUMNS);
  const normalizedRows = clampColumns(Number(rows), WIDE_TUI_ROWS);

  if (normalizedColumns < MIN_TUI_COLUMNS || normalizedRows < MIN_TUI_ROWS) {
    return "fallback";
  }
  if (normalizedColumns < WIDE_TUI_COLUMNS || normalizedRows < WIDE_TUI_ROWS) {
    return "compact";
  }
  return "wide";
}

function getActiveShellLayoutMode(columns, rows) {
  return getShellLayoutMode(columns, rows) === "wide" ? "wide" : "compact";
}

export function supportsShellTui() {
  if (process.env.SKILLS_SYNC_SHELL_MODE === "fallback") {
    return false;
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return false;
  }
  if (String(process.env.TERM || "").toLowerCase() === "dumb") {
    return false;
  }
  return getShellLayoutMode(process.stdout.columns, process.stdout.rows) !== "fallback";
}

export function shouldHandoffShellCommand(tokens) {
  const normalizedTokens = Array.isArray(tokens) ? tokens.map((token) => String(token)) : [];
  if (normalizedTokens.length === 0) {
    return false;
  }
  if (normalizedTokens.includes("--interactive")) {
    return true;
  }

  const root = normalizeRootToken(normalizedTokens[0]);
  const subcommand = normalizedTokens[1];

  if (root === "profile" && subcommand === "remove-skill" && !normalizedTokens.includes("--yes")) {
    return true;
  }
  if (
    root === "profile" &&
    subcommand === "add-mcp" &&
    !normalizedTokens.includes("--command") &&
    !normalizedTokens.includes("--url")
  ) {
    return true;
  }
  return false;
}

export function createShellTranscriptBlock({
  kind = "stdout",
  title = "",
  command = null,
  text = "",
  tone = "foreground",
  exitCode = 0,
  startedAt = Date.now(),
  finishedAt = Date.now()
} = {}) {
  const normalizedText = sanitizeCapturedText(text) || "[shell] Command completed with no output.";

  return {
    kind,
    title: String(title ?? ""),
    command: command ? String(command) : null,
    text: normalizedText,
    tone,
    exitCode,
    startedAt,
    finishedAt
  };
}

export const createShellOutputRecord = createShellTranscriptBlock;

function renderTranscriptBlockLines(block) {
  const textLines = String(block.text ?? "")
    .split("\n")
    .map((line) => String(line));

  if (block.command) {
    return [`$ ${block.command}`, ...textLines];
  }
  return textLines;
}

export function buildShellTranscriptLineMap(blocks = []) {
  const lines = [];
  const blockRanges = [];

  blocks.forEach((block, blockIndex) => {
    const start = lines.length;
    const renderedLines = renderTranscriptBlockLines(block);
    renderedLines.forEach((text, blockLineIndex) => {
      lines.push({
        text,
        blockIndex,
        blockLineIndex,
        kind: block.kind,
        tone: block.tone
      });
    });
    const end = Math.max(start, lines.length - 1);
    blockRanges.push({
      blockIndex,
      start,
      end
    });
    if (blockIndex < blocks.length - 1) {
      lines.push({
        text: "",
        blockIndex,
        blockLineIndex: renderedLines.length,
        kind: "spacer",
        tone: "muted",
        spacer: true
      });
    }
  });

  return {
    lines,
    blockRanges
  };
}

export function findShellTranscriptMatches(lineMap, query) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const lines = Array.isArray(lineMap?.lines) ? lineMap.lines : Array.isArray(lineMap) ? lineMap : [];
  const matches = [];

  lines.forEach((line, lineIndex) => {
    const text = String(line?.text ?? "");
    const lower = text.toLowerCase();
    let startIndex = lower.indexOf(normalizedQuery);
    while (startIndex >= 0) {
      matches.push({
        line: lineIndex,
        start: startIndex,
        end: startIndex + normalizedQuery.length
      });
      startIndex = lower.indexOf(normalizedQuery, startIndex + Math.max(1, normalizedQuery.length));
    }
  });

  return matches;
}

function normalizeSelection(anchor, cursor) {
  if (!anchor || !cursor) {
    return null;
  }

  const anchorBeforeCursor =
    anchor.line < cursor.line ||
    (anchor.line === cursor.line && anchor.column <= cursor.column);
  const start = anchorBeforeCursor ? anchor : cursor;
  const end = anchorBeforeCursor ? cursor : anchor;

  if (start.line === end.line && start.column === end.column) {
    return null;
  }

  return {
    start,
    end
  };
}

export function extractShellTranscriptSelectionText(lineMap, anchor, cursor) {
  const normalized = normalizeSelection(anchor, cursor);
  if (!normalized) {
    return "";
  }

  const lines = Array.isArray(lineMap?.lines) ? lineMap.lines : Array.isArray(lineMap) ? lineMap : [];
  const fragments = [];

  for (let lineIndex = normalized.start.line; lineIndex <= normalized.end.line; lineIndex += 1) {
    const text = String(lines[lineIndex]?.text ?? "");
    const startColumn = lineIndex === normalized.start.line ? normalized.start.column : 0;
    const endColumn = lineIndex === normalized.end.line ? normalized.end.column : text.length;
    fragments.push(text.slice(startColumn, Math.max(startColumn, endColumn)));
  }

  return fragments.join("\n");
}

function getTranscriptBlockText(state, blockIndex) {
  const range = state.transcriptLineMap.blockRanges[blockIndex];
  if (!range) {
    return "";
  }
  return state.transcriptLineMap.lines
    .slice(range.start, range.end + 1)
    .map((line) => line.text)
    .join("\n");
}

function getFullTranscriptText(state) {
  return state.transcriptLineMap.lines.map((line) => line.text).join("\n");
}

function rebuildTranscriptState(state, options = {}) {
  state.transcriptLineMap = buildShellTranscriptLineMap(state.transcriptBlocks);
  state.transcriptLines = state.transcriptLineMap.lines;
  state.transcriptSearchMatches = findShellTranscriptMatches(state.transcriptLineMap, state.transcriptSearchQuery);
  if (state.transcriptSearchMatches.length === 0) {
    state.transcriptSearchIndex = -1;
  } else if (state.transcriptSearchIndex < 0 || state.transcriptSearchIndex >= state.transcriptSearchMatches.length) {
    state.transcriptSearchIndex = 0;
  }

  const maxLineIndex = Math.max(0, state.transcriptLines.length - 1);
  state.transcriptScrollTop = Math.max(0, Math.min(state.transcriptScrollTop, maxLineIndex));
  state.transcriptCursor.line = Math.max(0, Math.min(state.transcriptCursor.line, maxLineIndex));
  const currentLineLength = String(state.transcriptLines[state.transcriptCursor.line]?.text ?? "").length;
  state.transcriptCursor.column = Math.max(0, Math.min(state.transcriptCursor.column, currentLineLength));
  state.transcriptCursor.preferredColumn = state.transcriptCursor.column;

  if (state.transcriptSelectionAnchor) {
    state.transcriptSelectionAnchor = {
      line: Math.max(0, Math.min(state.transcriptSelectionAnchor.line, maxLineIndex)),
      column: Math.max(
        0,
        Math.min(
          state.transcriptSelectionAnchor.column,
          String(state.transcriptLines[state.transcriptSelectionAnchor.line]?.text ?? "").length
        )
      )
    };
  }

  if (options.follow === true) {
    state.transcriptCursor.line = maxLineIndex;
    state.transcriptCursor.column = 0;
    state.transcriptCursor.preferredColumn = 0;
    state.transcriptScrollTop = maxLineIndex;
  }
}

function appendTranscriptBlock(state, block, options = {}) {
  state.transcriptBlocks.push(block);
  if (state.transcriptBlocks.length > TRANSCRIPT_LIMIT) {
    state.transcriptBlocks = state.transcriptBlocks.slice(state.transcriptBlocks.length - TRANSCRIPT_LIMIT);
  }
  rebuildTranscriptState(state, options);
}

function createWelcomeBlock(profile) {
  return createShellTranscriptBlock({
    kind: "status",
    tone: "muted",
    text: profile
      ? `[shell] Explorer-first shell ready.\n[shell] Profile context: ${profile}`
      : "[shell] Explorer-first shell ready.\n[shell] Profile context: (none)"
  });
}

function createProfileBlock(profile) {
  return createShellTranscriptBlock({
    kind: "status",
    tone: "muted",
    text: `[shell] Shell profile context: ${profile || "(none)"}`
  });
}

function createHelpBlock(profile) {
  return createShellTranscriptBlock({
    kind: "help",
    title: "Shell help",
    tone: "foreground",
    text: createShellHelpLines(profile).join("\n")
  });
}

function getToneForResult(exitCode, text) {
  if (exitCode !== 0) {
    return "danger";
  }
  if (String(text ?? "").trim().length === 0) {
    return "muted";
  }
  return "foreground";
}

export function clearShellEntryState(state) {
  state.commandInput = "";
  state.cursorOffset = 0;
  state.promptMode = null;
  state.promptTarget = null;
  state.guided = null;
  state.historyDraft = "";
  state.historyIndex = null;
}

export function setCommandInput(state, value) {
  state.commandInput = String(value ?? "");
  state.cursorOffset = state.commandInput.length;
}

function setFilterInput(state, value) {
  state.filterInput = String(value ?? "");
  state.filterCursor = state.filterInput.length;
}

function setStatusForSearch(state) {
  if (!state.transcriptSearchQuery) {
    clearTransientStatus(state);
    return;
  }
  if (state.transcriptSearchMatches.length === 0) {
    setStatus(state, `No matches for '${state.transcriptSearchQuery}'.`, "warning");
    return;
  }
  const current = state.transcriptSearchIndex < 0 ? 1 : state.transcriptSearchIndex + 1;
  setStatus(state, `Match ${current}/${state.transcriptSearchMatches.length} for '${state.transcriptSearchQuery}'.`, "accent");
}

function getPromptValue(state) {
  if (state.promptMode === "command") {
    return state.commandInput;
  }
  if (state.promptMode === "guided" && state.guided?.currentStep?.kind === "text") {
    return String(state.guided.ui?.textValue ?? "");
  }
  return state.filterInput;
}

function getPromptCursor(state) {
  if (state.promptMode === "command") {
    return state.cursorOffset;
  }
  if (state.promptMode === "guided" && state.guided?.currentStep?.kind === "text") {
    return Math.max(0, Number(state.guided.ui?.textCursor ?? 0));
  }
  return state.filterCursor;
}

function setPromptState(state, value, cursorOffset) {
  if (state.promptMode === "command") {
    state.commandInput = String(value ?? "");
    state.cursorOffset = Math.max(0, Math.min(cursorOffset, state.commandInput.length));
    return;
  }
  if (state.promptMode === "guided" && state.guided?.currentStep?.kind === "text") {
    const textValue = String(value ?? "");
    state.guided.ui.textValue = textValue;
    state.guided.ui.textCursor = Math.max(0, Math.min(cursorOffset, textValue.length));
    return;
  }
  state.filterInput = String(value ?? "");
  state.filterCursor = Math.max(0, Math.min(cursorOffset, state.filterInput.length));
}

function getPromptLabel(state) {
  if (state.promptMode === "command") {
    return " Command ";
  }
  if (state.promptMode === "guided") {
    const step = state.guided?.currentStep;
    if (step?.position && step?.total) {
      return ` Guided ${step.position}/${step.total} `;
    }
    return " Guided ";
  }
  if (state.promptTarget === "transcript") {
    return " Search ";
  }
  return " Filter ";
}

function getPromptPrefix(state) {
  if (state.promptMode === "command") {
    return getShellPromptText(state.activeProfile);
  }
  if (state.promptMode === "guided") {
    return "> ";
  }
  return "/ ";
}

function createInitialExplorerState() {
  const explorerTree = createShellExplorerTree();
  const explorerExpandedIds = new Set(getShellExplorerDefaultExpandedIds(explorerTree));
  const flattened = flattenShellExplorerTree(explorerTree, { expandedIds: explorerExpandedIds });

  return {
    explorerTree,
    explorerExpandedIds,
    explorerVisibleExpandedIds: flattened.expandedIds,
    explorerRows: flattened.rows,
    explorerSelectedId: flattened.rows[0]?.id ?? null
  };
}

export function createInitialShellTuiState(profile) {
  const explorerState = createInitialExplorerState();
  const transcriptBlocks = [createWelcomeBlock(profile ?? null)];
  const transcriptLineMap = buildShellTranscriptLineMap(transcriptBlocks);

  return {
    activePane: "explorer",
    activeProfile: profile ?? null,
    busy: false,
    commandInput: "",
    compactPage: "explorer",
    cursorOffset: 0,
    explorerFilter: "",
    filterCursor: 0,
    filterInput: "",
    followTranscript: true,
    history: [],
    historyDraft: "",
    historyIndex: null,
    layoutMode: "wide",
    guided: null,
    promptMode: null,
    promptReturnPane: "explorer",
    promptTarget: null,
    previousPane: "explorer",
    status: { text: "", tone: "muted", sticky: false },
    transcriptBlocks,
    transcriptCursor: { line: Math.max(0, transcriptLineMap.lines.length - 1), column: 0, preferredColumn: 0 },
    transcriptLineMap,
    transcriptLines: transcriptLineMap.lines,
    transcriptScrollTop: 0,
    transcriptScrollLeft: 0,
    transcriptSelectionAnchor: null,
    transcriptSearchIndex: -1,
    transcriptSearchMatches: [],
    transcriptSearchQuery: "",
    ...explorerState
  };
}

function syncExplorerRows(state) {
  const flattened = flattenShellExplorerTree(state.explorerTree, {
    expandedIds: state.explorerExpandedIds,
    filter: state.explorerFilter
  });
  state.explorerRows = flattened.rows;
  state.explorerVisibleExpandedIds = flattened.expandedIds;
  if (!state.explorerRows.some((row) => row.id === state.explorerSelectedId)) {
    state.explorerSelectedId = state.explorerRows[0]?.id ?? null;
  }
}

function findExplorerPath(nodes, targetId, trail = []) {
  for (const node of nodes) {
    const nextTrail = [...trail, node];
    if (node.id === targetId) {
      return nextTrail;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const childPath = findExplorerPath(node.children, targetId, nextTrail);
      if (childPath) {
        return childPath;
      }
    }
  }
  return null;
}

function getSelectedExplorerRow(state) {
  return state.explorerRows.find((row) => row.id === state.explorerSelectedId) ?? null;
}

function moveExplorerSelection(state, delta) {
  if (state.explorerRows.length === 0) {
    return;
  }
  const currentIndex = Math.max(0, state.explorerRows.findIndex((row) => row.id === state.explorerSelectedId));
  const nextIndex = Math.max(0, Math.min(currentIndex + delta, state.explorerRows.length - 1));
  state.explorerSelectedId = state.explorerRows[nextIndex]?.id ?? state.explorerSelectedId;
}

function expandExplorerRow(state, row) {
  if (!row?.hasChildren) {
    return false;
  }
  if (!state.explorerExpandedIds.has(row.id)) {
    state.explorerExpandedIds.add(row.id);
    syncExplorerRows(state);
    return true;
  }
  return false;
}

function collapseExplorerRow(state, row) {
  if (!row) {
    return false;
  }
  if (row.hasChildren && state.explorerExpandedIds.has(row.id)) {
    state.explorerExpandedIds.delete(row.id);
    syncExplorerRows(state);
    return true;
  }
  if (row.parentId) {
    state.explorerSelectedId = row.parentId;
    return true;
  }
  return false;
}

function focusExplorerTarget(state, targetId) {
  if (!targetId) {
    return false;
  }
  const path = findExplorerPath(state.explorerTree, targetId);
  if (!path) {
    return false;
  }
  path
    .slice(0, -1)
    .filter((node) => Array.isArray(node.children) && node.children.length > 0)
    .forEach((node) => state.explorerExpandedIds.add(node.id));
  state.activePane = "explorer";
  state.compactPage = "explorer";
  state.explorerSelectedId = targetId;
  syncExplorerRows(state);
  clearTransientStatus(state);
  return true;
}

function rememberHistory(state, commandLine) {
  const normalized = String(commandLine ?? "").trim();
  if (!normalized) {
    return;
  }
  if (state.history[state.history.length - 1] !== normalized) {
    state.history.push(normalized);
    if (state.history.length > 200) {
      state.history.shift();
    }
  }
  state.historyDraft = "";
  state.historyIndex = null;
}

function moveHistory(state, direction) {
  if (state.history.length === 0) {
    return;
  }

  if (direction < 0) {
    if (state.historyIndex === null) {
      state.historyDraft = state.commandInput;
      state.historyIndex = state.history.length - 1;
    } else if (state.historyIndex > 0) {
      state.historyIndex -= 1;
    }
  } else if (direction > 0) {
    if (state.historyIndex === null) {
      return;
    }
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex += 1;
    } else {
      state.historyIndex = null;
      setCommandInput(state, state.historyDraft);
      return;
    }
  }

  if (state.historyIndex !== null) {
    setCommandInput(state, state.history[state.historyIndex]);
  }
}

function getTranscriptViewportHeight(screen, state) {
  const promptHeight = state.promptMode ? getPromptFrameHeight(state) : 0;
  const mainTop = 1;
  const mainBottom = 1 + promptHeight;
  const contentHeight = screen.height - mainTop - mainBottom - 2;
  return Math.max(1, contentHeight);
}

function getPromptFrameHeight(state) {
  if (!state.promptMode) {
    return 0;
  }
  if (state.promptMode !== "guided") {
    return 3;
  }

  switch (state.guided?.currentStep?.kind) {
    case "text":
      return 5;
    case "review":
      return 9;
    case "select":
    case "picker":
    default:
      return 8;
  }
}

function getTranscriptContentWidth(screen, state) {
  if (state.layoutMode === "wide") {
    return Math.max(1, screen.width - EXPLORER_WIDTH - 5);
  }
  return Math.max(1, screen.width - 4);
}

function ensureTranscriptCursorVisible(state, screen) {
  const viewportHeight = getTranscriptViewportHeight(screen, state);
  if (state.transcriptCursor.line < state.transcriptScrollTop) {
    state.transcriptScrollTop = state.transcriptCursor.line;
  }
  if (state.transcriptCursor.line >= state.transcriptScrollTop + viewportHeight) {
    state.transcriptScrollTop = Math.max(0, state.transcriptCursor.line - viewportHeight + 1);
  }

  const viewportWidth = Math.max(1, getTranscriptContentWidth(screen, state));
  if (state.transcriptCursor.column < state.transcriptScrollLeft) {
    state.transcriptScrollLeft = state.transcriptCursor.column;
  }
  if (state.transcriptCursor.column >= state.transcriptScrollLeft + viewportWidth) {
    state.transcriptScrollLeft = Math.max(0, state.transcriptCursor.column - viewportWidth + 1);
  }
}

function setTranscriptCursor(state, screen, line, column = state.transcriptCursor.column) {
  const maxLineIndex = Math.max(0, state.transcriptLines.length - 1);
  const nextLine = Math.max(0, Math.min(line, maxLineIndex));
  const lineLength = String(state.transcriptLines[nextLine]?.text ?? "").length;
  const nextColumn = Math.max(0, Math.min(column, lineLength));
  state.transcriptCursor.line = nextLine;
  state.transcriptCursor.column = nextColumn;
  state.transcriptCursor.preferredColumn = nextColumn;
  state.followTranscript = nextLine >= maxLineIndex;
  ensureTranscriptCursorVisible(state, screen);
}

function moveTranscriptCursor(state, screen, lineDelta, columnDelta = 0) {
  if (columnDelta !== 0) {
    const currentLineLength = String(state.transcriptLines[state.transcriptCursor.line]?.text ?? "").length;
    const nextColumn = Math.max(0, Math.min(state.transcriptCursor.column + columnDelta, currentLineLength));
    state.transcriptCursor.column = nextColumn;
    state.transcriptCursor.preferredColumn = nextColumn;
    ensureTranscriptCursorVisible(state, screen);
    return;
  }

  const nextLine = Math.max(0, Math.min(state.transcriptCursor.line + lineDelta, Math.max(0, state.transcriptLines.length - 1)));
  const nextLineLength = String(state.transcriptLines[nextLine]?.text ?? "").length;
  state.transcriptCursor.line = nextLine;
  state.transcriptCursor.column = Math.max(0, Math.min(state.transcriptCursor.preferredColumn, nextLineLength));
  state.followTranscript = nextLine >= Math.max(0, state.transcriptLines.length - 1);
  ensureTranscriptCursorVisible(state, screen);
}

function pageTranscript(state, screen, direction) {
  const amount = Math.max(1, getTranscriptViewportHeight(screen, state) - 1);
  moveTranscriptCursor(state, screen, direction * amount, 0);
}

function getTranscriptSelectionText(state) {
  return extractShellTranscriptSelectionText(state.transcriptLineMap, state.transcriptSelectionAnchor, state.transcriptCursor);
}

async function copyTextToClipboard(text) {
  await clipboard.write(String(text ?? ""));
}

async function copyTranscriptSelection(state, mode = "selection") {
  let text = "";
  if (mode === "all") {
    text = getFullTranscriptText(state);
  } else if (mode === "selection") {
    text = getTranscriptSelectionText(state);
    if (!text) {
      const currentBlockIndex = state.transcriptLines[state.transcriptCursor.line]?.blockIndex ?? 0;
      text = getTranscriptBlockText(state, currentBlockIndex);
    }
  }

  if (!text) {
    setStatus(state, "Nothing to copy yet.", "muted");
    return;
  }

  try {
    await copyTextToClipboard(text);
    setStatus(state, mode === "all" ? "Copied the full transcript." : "Copied transcript text.", "success");
  } catch (error) {
    setStatus(state, `Copy failed: ${error.message}. Use your terminal copy shortcut.`, "warning");
  }
}

function openCommandPrompt(state, initialValue = "") {
  state.previousPane = state.activePane;
  state.promptReturnPane = state.activePane;
  state.promptMode = "command";
  state.promptTarget = null;
  setCommandInput(state, initialValue);
  clearTransientStatus(state);
}

function openFilterPrompt(state, targetPane, initialValue = null) {
  state.previousPane = state.activePane;
  state.promptReturnPane = state.activePane;
  state.promptMode = "filter";
  state.promptTarget = targetPane;
  const value = initialValue ?? (targetPane === "transcript" ? state.transcriptSearchQuery : state.explorerFilter);
  setFilterInput(state, value);
  clearTransientStatus(state);
}

function closePrompt(state) {
  state.commandInput = "";
  state.cursorOffset = 0;
  state.promptMode = null;
  state.promptTarget = null;
  state.guided = null;
  state.filterInput = "";
  state.filterCursor = 0;
  state.historyDraft = "";
  state.historyIndex = null;
}

function applyExplorerFilter(state, value) {
  state.explorerFilter = String(value ?? "");
  syncExplorerRows(state);
  if (state.explorerRows.length === 0) {
    setStatus(state, `No Explorer matches for '${state.explorerFilter}'.`, "warning");
    return;
  }
  clearTransientStatus(state);
}

function applyTranscriptSearch(state, screen, query) {
  state.transcriptSearchQuery = String(query ?? "").trim();
  state.transcriptSearchMatches = findShellTranscriptMatches(state.transcriptLineMap, state.transcriptSearchQuery);
  state.transcriptSearchIndex = state.transcriptSearchMatches.length > 0 ? 0 : -1;
  if (state.transcriptSearchMatches.length > 0) {
    const match = state.transcriptSearchMatches[0];
    setTranscriptCursor(state, screen, match.line, match.start);
  }
  setStatusForSearch(state);
}

function moveTranscriptSearch(state, screen, direction) {
  if (state.transcriptSearchMatches.length === 0 || !state.transcriptSearchQuery) {
    setStatus(state, "No active transcript search.", "muted");
    return;
  }
  const total = state.transcriptSearchMatches.length;
  const current = state.transcriptSearchIndex < 0 ? 0 : state.transcriptSearchIndex;
  const next = (current + direction + total) % total;
  state.transcriptSearchIndex = next;
  const match = state.transcriptSearchMatches[next];
  setTranscriptCursor(state, screen, match.line, match.start);
  setStatusForSearch(state);
}

function clearTranscriptSearch(state) {
  state.transcriptSearchQuery = "";
  state.transcriptSearchMatches = [];
  state.transcriptSearchIndex = -1;
  clearTransientStatus(state);
}

function clearTranscriptSelection(state) {
  state.transcriptSelectionAnchor = null;
  clearTransientStatus(state);
}

function getSelectionRangeForLine(state, lineIndex) {
  const normalized = normalizeSelection(state.transcriptSelectionAnchor, state.transcriptCursor);
  if (!normalized) {
    return null;
  }
  if (lineIndex < normalized.start.line || lineIndex > normalized.end.line) {
    return null;
  }

  const lineLength = String(state.transcriptLines[lineIndex]?.text ?? "").length;
  const start = lineIndex === normalized.start.line ? normalized.start.column : 0;
  const end = lineIndex === normalized.end.line ? normalized.end.column : lineLength;
  if (start === end) {
    return null;
  }
  return {
    start,
    end
  };
}

function isLikelySectionHeading(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("$ ") || trimmed.startsWith("[shell]") || trimmed === "[stderr]") {
    return false;
  }
  if (/^[{["]/.test(trimmed) || /^[)\]}]/.test(trimmed)) {
    return false;
  }
  return /^[A-Z][A-Za-z0-9 /&:+-]*(?: \(\d+\))?$/.test(trimmed) && !String(text ?? "").startsWith(" ");
}

function isLikelyTableHeader(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) {
    return false;
  }
  return String(text ?? "").startsWith("  ") && /^[A-Z][A-Z0-9 /-]+$/.test(trimmed);
}

function getTranscriptLineTags(line, lineText, lineIndex, state) {
  if (lineIndex === state.transcriptCursor.line && state.activePane === "transcript" && state.promptMode === null) {
    return [`${THEME.accent}-fg`, "bold"];
  }
  if (line?.kind === "spacer") {
    return [`${THEME.muted}-fg`];
  }
  if (lineText.startsWith("$ ")) {
    return [`${THEME.accent}-fg`, "bold"];
  }
  if (lineText === "[stderr]") {
    return [`${THEME.danger}-fg`, "bold"];
  }
  if (lineText.startsWith("[shell]")) {
    return [toneTag(line?.tone ?? "muted")];
  }
  if (isLikelySectionHeading(lineText)) {
    return [`${THEME.accent}-fg`, "bold"];
  }
  if (isLikelyTableHeader(lineText)) {
    return [`${THEME.muted}-fg`, "bold"];
  }
  if (line?.kind === "stderr") {
    return [toneTag("danger")];
  }
  if (line?.kind === "warning") {
    return [toneTag("warning")];
  }
  return [toneTag(line?.tone ?? "foreground")];
}

function renderTranscriptLine(line, lineIndex, width, state) {
  const lineText = String(line?.text ?? "");
  const sliceStart = state.transcriptScrollLeft;
  const sliceEnd = Math.max(sliceStart, sliceStart + Math.max(1, width));
  const visibleText = lineText.slice(sliceStart, sliceEnd);
  const baseTags = getTranscriptLineTags(line, lineText, lineIndex, state);

  const selection = getSelectionRangeForLine(state, lineIndex);
  if (!selection) {
    return withTags(visibleText || " ", ...baseTags);
  }

  const before = visibleText.slice(0, Math.max(0, selection.start - sliceStart));
  const selected = visibleText.slice(
    Math.max(0, selection.start - sliceStart),
    Math.max(0, selection.end - sliceStart)
  );
  const after = visibleText.slice(Math.max(0, selection.end - sliceStart));

  return [
    withTags(before || "", ...baseTags),
    selected ? withTags(selected, `${THEME.accent}-bg`, `${THEME.selectionText}-fg`) : "",
    withTags(after || "", ...baseTags)
  ].join("") || withTags(" ", ...baseTags);
}

function getExplorerContentWidth(screen, state) {
  if (state.layoutMode === "wide") {
    return Math.max(1, EXPLORER_WIDTH - 4);
  }
  return Math.max(1, screen.width - 4);
}

function buildExplorerRowLabel(row, width) {
  const indent = "  ".repeat(row.depth);
  const prefix = row.hasChildren ? (row.expanded ? "v " : "> ") : "  ";
  const text = `${indent}${prefix}${row.label}`;
  return text.slice(0, Math.max(1, width));
}

function renderHeaderContent(state) {
  const parts = [
    withTags("skills-sync", `${THEME.accent}-fg`, "bold"),
    withTags(`profile ${state.activeProfile || "(none)"}`, `${THEME.muted}-fg`),
    withTags(state.busy ? "busy" : "ready", `${getToneColor(state.busy ? "warning" : "success")}-fg`),
    withTags(`Active: ${state.activePane === "explorer" ? "Explorer" : "Transcript"}`, `${THEME.foreground}-fg`, "bold")
  ];

  if (state.explorerFilter && state.activePane === "explorer") {
    parts.push(withTags(`filter ${state.explorerFilter}`, `${THEME.muted}-fg`));
  } else if (state.transcriptSearchQuery && state.activePane === "transcript") {
    parts.push(withTags(`search ${state.transcriptSearchQuery}`, `${THEME.muted}-fg`));
  }

  if (state.status.text) {
    parts.push(withTags(state.status.text, `${getToneColor(state.status.tone)}-fg`));
  }

  return parts.join(` ${withTags("|", `${THEME.border}-fg`)} `);
}

function renderFooterContent(state) {
  const hasSelection = normalizeSelection(state.transcriptSelectionAnchor, state.transcriptCursor) !== null;
  const hints = getShellFooterHints({
    activePane: state.activePane,
    promptMode: state.promptMode,
    guidedKind: state.guided?.currentStep?.kind ?? null,
    hasSelection
  });

  return hints
    .map((hint) => `${withTags(hint.key, `${THEME.accent}-fg`, "bold")} ${withTags(hint.label, `${THEME.muted}-fg`)}`)
    .join(` ${withTags("|", `${THEME.border}-fg`)} `);
}

function renderTranscriptContent(screen, state) {
  const width = getTranscriptContentWidth(screen, state);
  return state.transcriptLines.map((line, lineIndex) => renderTranscriptLine(line, lineIndex, width, state)).join("\n");
}

function renderPromptContent(state) {
  return withTags(getPromptPrefix(state), `${THEME.accent}-fg`, "bold");
}

function renderGuidedTitle(state) {
  const step = state.guided?.currentStep;
  if (!step) {
    return "";
  }
  return [
    withTags(step.title || "Guided step", `${THEME.foreground}-fg`, "bold"),
    step.position && step.total
      ? ` ${withTags(`(${step.position}/${step.total})`, `${THEME.muted}-fg`)}`
      : ""
  ].join("");
}

function renderGuidedMeta(state) {
  const description = String(state.guided?.currentStep?.description ?? "").trim();
  return description ? withTags(description, `${THEME.muted}-fg`) : "";
}

function renderGuidedPreview(state) {
  const lines = Array.isArray(state.guided?.currentStep?.previewLines)
    ? state.guided.currentStep.previewLines
    : [];
  return lines
    .slice(0, 3)
    .map((line, index) =>
      index === 0
        ? withTags(String(line ?? ""), `${THEME.accent}-fg`, "bold")
        : withTags(String(line ?? ""), `${THEME.foreground}-fg`)
    )
    .join("\n");
}

function renderGuidedListItems(state) {
  const step = state.guided?.currentStep;
  if (!step || !Array.isArray(step.options)) {
    return [];
  }

  if (step.kind === "picker") {
    const selectedValues = new Set(Array.isArray(state.guided?.ui?.selectedValues) ? state.guided.ui.selectedValues : []);
    return step.options.map((option) => {
      const prefix = selectedValues.has(option.value) ? "[x]" : "[ ]";
      const hint = option.hint ? ` ${withTags(`(${option.hint})`, `${THEME.muted}-fg`)}` : "";
      return `${withTags(prefix, `${THEME.accent}-fg`, "bold")} ${withTags(option.label, `${THEME.foreground}-fg`)}${hint}`;
    });
  }

  return step.options.map((option) => {
    const hint = option.hint ? ` ${withTags(`(${option.hint})`, `${THEME.muted}-fg`)}` : "";
    return `${withTags(option.label, `${THEME.foreground}-fg`)}${hint}`;
  });
}

function applyLayout(screen, widgets, state) {
  state.layoutMode = getActiveShellLayoutMode(screen.width, screen.height);
  if (state.layoutMode === "compact") {
    state.compactPage = state.activePane;
  }

  const promptVisible = state.promptMode !== null;
  const promptHeight = getPromptFrameHeight(state);
  const mainBottom = promptVisible ? promptHeight + 1 : 1;

  widgets.explorerFrame.hidden = state.layoutMode === "compact" && state.activePane !== "explorer";
  widgets.transcriptFrame.hidden = state.layoutMode === "compact" && state.activePane !== "transcript";

  if (state.layoutMode === "wide") {
    widgets.explorerFrame.position.top = 1;
    widgets.explorerFrame.position.left = 0;
    widgets.explorerFrame.position.width = EXPLORER_WIDTH;
    widgets.explorerFrame.position.bottom = mainBottom;

    widgets.transcriptFrame.position.top = 1;
    widgets.transcriptFrame.position.left = EXPLORER_WIDTH;
    widgets.transcriptFrame.position.right = 0;
    widgets.transcriptFrame.position.bottom = mainBottom;
  } else {
    widgets.explorerFrame.position.top = 1;
    widgets.explorerFrame.position.left = 0;
    widgets.explorerFrame.position.right = 0;
    widgets.explorerFrame.position.bottom = mainBottom;

    widgets.transcriptFrame.position.top = 1;
    widgets.transcriptFrame.position.left = 0;
    widgets.transcriptFrame.position.right = 0;
    widgets.transcriptFrame.position.bottom = mainBottom;
  }

  widgets.promptFrame.hidden = !promptVisible;
  widgets.promptFrame.position.bottom = 1;
  widgets.promptFrame.position.left = 0;
  widgets.promptFrame.position.width = "100%";
  widgets.promptFrame.position.height = promptHeight;
}

function syncTextboxFromState(textbox, state) {
  const value = getPromptValue(state);
  const cursorOffset = getPromptCursor(state);
  const coords = textbox.lpos || textbox._getCoords();
  const visibleWidth = coords
    ? Math.max(1, coords.xl - coords.xi - textbox.iwidth)
    : Math.max(1, (process.stdout.columns || WIDE_TUI_COLUMNS) - 20);
  const maxStart = Math.max(0, value.length - visibleWidth);
  const currentStart = Math.max(0, Math.min(textbox._visibleStart || 0, maxStart));
  const adjustedStart = cursorOffset < currentStart
    ? cursorOffset
    : cursorOffset > currentStart + visibleWidth - 1
      ? cursorOffset - visibleWidth + 1
      : currentStart;

  textbox._visibleStart = Math.max(0, Math.min(adjustedStart, maxStart));
  textbox.value = value;
  textbox._value = value;
  textbox.setContent(blessed.escape(value.slice(textbox._visibleStart, textbox._visibleStart + visibleWidth) || " "));
}

function renderScreen(screen, widgets, state) {
  applyLayout(screen, widgets, state);

  widgets.header.setContent(renderHeaderContent(state));
  widgets.footer.setContent(renderFooterContent(state));

  widgets.explorerFrame.setLabel(` Explorer ${state.activePane === "explorer" ? "(active)" : ""} `);
  widgets.explorerFrame.style.border.fg = state.activePane === "explorer" ? THEME.activeBorder : THEME.border;
  widgets.transcriptFrame.setLabel(` Transcript ${state.activePane === "transcript" ? "(active)" : ""} `);
  widgets.transcriptFrame.style.border.fg = state.activePane === "transcript" ? THEME.activeBorder : THEME.border;

  const explorerWidth = getExplorerContentWidth(screen, state);
  widgets.explorerList.setItems(state.explorerRows.map((row) => buildExplorerRowLabel(row, explorerWidth)));
  const selectedExplorerIndex = Math.max(0, state.explorerRows.findIndex((row) => row.id === state.explorerSelectedId));
  widgets.explorerList.select(selectedExplorerIndex);
  widgets.explorerList.scrollTo(selectedExplorerIndex);

  widgets.transcriptBody.setContent(renderTranscriptContent(screen, state));
  widgets.transcriptBody.scrollTo(state.transcriptScrollTop);

  widgets.promptFrame.setLabel(getPromptLabel(state));
  widgets.promptTitle.hidden = state.promptMode !== "guided";
  widgets.promptMeta.hidden = state.promptMode !== "guided";
  widgets.guidedPreview.hidden = true;
  widgets.guidedList.hidden = true;
  widgets.promptPrefix.hidden = false;
  widgets.promptInput.hidden = false;

  if (state.promptMode === "guided") {
    widgets.promptTitle.setContent(renderGuidedTitle(state));
    widgets.promptMeta.setContent(renderGuidedMeta(state));
    const guidedStep = state.guided?.currentStep;
    if (guidedStep?.kind === "text") {
      widgets.promptPrefix.setContent(renderPromptContent(state));
      const promptPrefix = getPromptPrefix(state);
      widgets.promptPrefix.position.top = 2;
      widgets.promptPrefix.width = promptPrefix.length;
      widgets.promptInput.position.top = 2;
      widgets.promptInput.position.left = promptPrefix.length;
      widgets.promptInput.position.right = 0;
      widgets.promptInput.position.height = 1;
      syncTextboxFromState(widgets.promptInput, state);
    } else {
      widgets.promptPrefix.hidden = true;
      widgets.promptInput.hidden = true;
      widgets.guidedList.hidden = false;
      widgets.guidedList.position.top = guidedStep?.kind === "review" ? 5 : 2;
      widgets.guidedList.position.bottom = 0;
      widgets.guidedList.setItems(renderGuidedListItems(state));
      widgets.guidedList.select(Math.max(0, Number(state.guided?.ui?.selectedIndex ?? 0)));
      widgets.guidedList.scrollTo(Math.max(0, Number(state.guided?.ui?.selectedIndex ?? 0)));
      if (guidedStep?.kind === "review") {
        widgets.guidedPreview.hidden = false;
        widgets.guidedPreview.position.top = 2;
        widgets.guidedPreview.position.height = 3;
        widgets.guidedPreview.setContent(renderGuidedPreview(state));
      } else {
        widgets.guidedPreview.setContent("");
      }
    }
  } else {
    widgets.promptTitle.setContent("");
    widgets.promptMeta.setContent("");
    widgets.promptPrefix.setContent(renderPromptContent(state));
    const promptPrefix = getPromptPrefix(state);
    widgets.promptPrefix.position.top = 0;
    widgets.promptPrefix.width = promptPrefix.length;
    widgets.promptInput.position.top = 0;
    widgets.promptInput.position.left = promptPrefix.length;
    widgets.promptInput.position.right = 0;
    widgets.promptInput.position.height = 1;
    syncTextboxFromState(widgets.promptInput, state);
  }

  screen.render();
}

function focusActiveWidget(widgets, state) {
  if (state.promptMode) {
    if (state.promptMode === "guided" && state.guided?.currentStep?.kind !== "text") {
      widgets.guidedList.focus();
      return;
    }
    widgets.promptInput.focus();
    if (!widgets.promptInput._reading) {
      widgets.promptInput.readInput();
    }
    return;
  }
  if (state.activePane === "explorer") {
    widgets.explorerList.focus();
    return;
  }
  widgets.transcriptBody.focus();
}

function createWidgets(screen) {
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    padding: { left: 1, right: 1 },
    style: {
      bg: THEME.background,
      fg: THEME.foreground
    }
  });

  const explorerFrame = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: EXPLORER_WIDTH,
    bottom: 1,
    border: "line",
    label: " Explorer ",
    style: {
      bg: THEME.panel,
      fg: THEME.foreground,
      border: { fg: THEME.border }
    }
  });

  const explorerList = blessed.list({
    parent: explorerFrame,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    mouse: true,
    keyable: true,
    style: {
      bg: THEME.panel,
      fg: THEME.foreground,
      selected: {
        bg: THEME.accent,
        fg: THEME.selectionText,
        bold: true
      }
    },
    scrollbar: {
      ch: " ",
      bg: THEME.border
    }
  });

  const transcriptFrame = blessed.box({
    parent: screen,
    top: 1,
    left: EXPLORER_WIDTH,
    right: 0,
    bottom: 1,
    border: "line",
    label: " Transcript ",
    padding: { left: 1, right: 1 },
    style: {
      bg: THEME.panel,
      fg: THEME.foreground,
      border: { fg: THEME.border }
    }
  });

  const transcriptBody = blessed.box({
    parent: transcriptFrame,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    tags: true,
    mouse: true,
    keyable: true,
    scrollable: true,
    alwaysScroll: true,
    wrap: false,
    style: {
      bg: THEME.panel,
      fg: THEME.foreground
    },
    scrollbar: {
      ch: " ",
      bg: THEME.border
    }
  });

  const promptFrame = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: "100%",
    height: 3,
    hidden: true,
    border: "line",
    label: " Command ",
    padding: { left: 1, right: 1 },
    style: {
      bg: THEME.background,
      fg: THEME.foreground,
      border: { fg: THEME.activeBorder }
    }
  });

  const promptPrefix = blessed.text({
    parent: promptFrame,
    top: 0,
    left: 0,
    height: 1,
    tags: true
  });

  const promptInput = blessed.textbox({
    parent: promptFrame,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    inputOnFocus: false,
    keys: true,
    mouse: true,
    keyable: true,
    style: {
      bg: THEME.background,
      fg: THEME.foreground
    }
  });

  const promptTitle = blessed.text({
    parent: promptFrame,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    hidden: true
  });

  const promptMeta = blessed.text({
    parent: promptFrame,
    top: 1,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    hidden: true
  });

  const guidedPreview = blessed.box({
    parent: promptFrame,
    top: 2,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    hidden: true,
    style: {
      bg: THEME.background,
      fg: THEME.foreground
    }
  });

  const guidedList = blessed.list({
    parent: promptFrame,
    top: 2,
    left: 0,
    right: 0,
    bottom: 0,
    tags: true,
    hidden: true,
    mouse: true,
    keyable: true,
    style: {
      bg: THEME.background,
      fg: THEME.foreground,
      selected: {
        bg: THEME.accent,
        fg: THEME.selectionText,
        bold: true
      }
    },
    scrollbar: {
      ch: " ",
      bg: THEME.border
    }
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    padding: { left: 1, right: 1 },
    style: {
      bg: THEME.background,
      fg: THEME.foreground
    }
  });

  return {
    explorerFrame,
    explorerList,
    footer,
    guidedList,
    guidedPreview,
    header,
    promptMeta,
    promptFrame,
    promptInput,
    promptPrefix,
    promptTitle,
    transcriptBody,
    transcriptFrame
  };
}

async function captureCommandExecution(commandArgs) {
  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(process.execPath, [CLI_ENTRY_PATH, ...commandArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKILLS_SYNC_DISABLE_PROMPTS: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdout: sanitizeCapturedText(stdoutChunks.join("")),
        stderr: sanitizeCapturedText(stderrChunks.join(""))
      });
    });
  });
}

function buildCommandResultBlock(rawCommand, result) {
  const parts = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    if (parts.length > 0) {
      parts.push("");
      parts.push("[stderr]");
    }
    parts.push(result.stderr);
  }
  if (parts.length === 0) {
    parts.push("[shell] Command completed with no output.");
  }

  const text = parts.join("\n");
  return createShellTranscriptBlock({
    kind: result.exitCode === 0 ? "stdout" : "stderr",
    title: result.exitCode === 0 ? "Command output" : "Command failed",
    command: rawCommand,
    text,
    tone: getToneForResult(result.exitCode, text),
    exitCode: result.exitCode
  });
}

async function runInlineCommandArgs(state, screen, commandArgs, rawCommand) {
  state.busy = true;
  setStatus(state, `Running ${rawCommand}...`, "warning", true);

  const result = await captureCommandExecution(commandArgs);
  state.busy = false;
  state.status.sticky = false;
  appendTranscriptBlock(state, buildCommandResultBlock(rawCommand, result), { follow: true });

  if (result.exitCode === 0) {
    setStatus(state, `Command completed: ${rawCommand}`, "success");
  } else {
    setStatus(state, `Command exited with code ${result.exitCode}.`, "danger");
  }

  if (state.layoutMode === "compact") {
    state.activePane = "transcript";
    state.compactPage = "transcript";
  }
  ensureTranscriptCursorVisible(state, screen);
}

function foregroundCommand(screen, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = screen.spawn(process.execPath, [CLI_ENTRY_PATH, ...commandArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env
      },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolve(typeof exitCode === "number" ? exitCode : 1);
    });
  });
}

function containsScreenPoint(widget, data) {
  if (!widget || !data) {
    return false;
  }

  const position = widget.lpos || widget._getCoords();
  if (!position) {
    return false;
  }

  return data.x >= position.xi && data.x < position.xl && data.y >= position.yi && data.y < position.yl;
}

function getTranscriptLineFromPointer(widget, data, state) {
  const position = widget.lpos || widget._getCoords();
  if (!position) {
    return state.transcriptCursor.line;
  }
  const lineOffset = Math.max(0, data.y - position.yi);
  return Math.max(0, Math.min(state.transcriptScrollTop + lineOffset, Math.max(0, state.transcriptLines.length - 1)));
}

function wirePromptTextbox(textbox, state, handlers) {
  textbox.on("focus", () => {
    if (!textbox._reading) {
      textbox.readInput();
    }
  });

  textbox._updateCursor = function(get) {
    if (this.screen.focused !== this || this._reading !== true) {
      return;
    }

    const lpos = get ? this.lpos : this._getCoords();
    if (!lpos) {
      return;
    }

    const value = getPromptValue(state);
    const cursorOffset = getPromptCursor(state);
    const visibleWidth = Math.max(1, lpos.xl - lpos.xi - this.iwidth);
    const maxStart = Math.max(0, value.length - visibleWidth);
    const currentStart = Math.max(0, Math.min(this._visibleStart || 0, maxStart));
    const nextStart = cursorOffset < currentStart
      ? cursorOffset
      : cursorOffset > currentStart + visibleWidth - 1
        ? cursorOffset - visibleWidth + 1
        : currentStart;
    this._visibleStart = Math.max(0, Math.min(nextStart, maxStart));

    const program = this.screen.program;
    const cursorX = lpos.xi + this.ileft + Math.max(0, cursorOffset - this._visibleStart);
    const cursorY = lpos.yi + this.itop;
    if (cursorY !== program.y || cursorX !== program.x) {
      program.cup(cursorY, cursorX);
    }
  };

  textbox._listener = async function(ch, key) {
    if (state.busy) {
      return;
    }

    if (key.ctrl && key.name === "q") {
      handlers.forceExit();
      return;
    }

    if (key.name === "enter") {
      await handlers.submit();
      return;
    }
    if (key.name === "escape") {
      await handlers.close();
      return;
    }
    if (state.promptMode === "command" && key.name === "tab") {
      handlers.complete();
      return;
    }
    if (state.promptMode === "command" && key.name === "up") {
      handlers.history(-1);
      return;
    }
    if (state.promptMode === "command" && key.name === "down") {
      handlers.history(1);
      return;
    }

    const before = getPromptValue(state);
    const currentCursor = getPromptCursor(state);
    let after = before;
    let nextCursor = currentCursor;
    let handled = false;

    switch (key.name) {
      case "left":
        nextCursor = Math.max(0, currentCursor - 1);
        handled = true;
        break;
      case "right":
        nextCursor = Math.min(before.length, currentCursor + 1);
        handled = true;
        break;
      case "home":
        nextCursor = 0;
        handled = true;
        break;
      case "end":
        nextCursor = before.length;
        handled = true;
        break;
      case "backspace":
        if (currentCursor > 0) {
          after = `${before.slice(0, currentCursor - 1)}${before.slice(currentCursor)}`;
          nextCursor = currentCursor - 1;
        }
        handled = true;
        break;
      case "delete":
        if (currentCursor < before.length) {
          after = `${before.slice(0, currentCursor)}${before.slice(currentCursor + 1)}`;
        }
        handled = true;
        break;
      default:
        break;
    }

    if (!handled && ch && ch.length === 1 && !key.ctrl && !key.meta) {
      after = `${before.slice(0, currentCursor)}${ch}${before.slice(currentCursor)}`;
      nextCursor = currentCursor + ch.length;
      handled = true;
    }

    if (!handled) {
      return;
    }

    setPromptState(state, after, nextCursor);
    handlers.change();
  };
}

export function createShellTuiViewModel(state) {
  return {
    activePane: state.activePane,
    busy: state.busy,
    commandInput: state.commandInput,
    explorerFilter: state.explorerFilter,
    explorerRows: state.explorerRows,
    footerHints: getShellFooterHints({
      activePane: state.activePane,
      promptMode: state.promptMode,
      guidedKind: state.guided?.currentStep?.kind ?? null,
      hasSelection: normalizeSelection(state.transcriptSelectionAnchor, state.transcriptCursor) !== null
    }),
    layoutMode: state.layoutMode,
    profileLabel: state.activeProfile || "(none)",
    promptMode: state.promptMode,
    promptTarget: state.promptTarget,
    guidedKind: state.guided?.currentStep?.kind ?? null,
    status: state.status,
    transcriptBlockCount: state.transcriptBlocks.length,
    transcriptLineCount: state.transcriptLines.length,
    transcriptSearchQuery: state.transcriptSearchQuery
  };
}

export async function cmdShellTui({ profile, executeCommand }) {
  if (typeof executeCommand !== "function") {
    throw new Error("Interactive shell requires an executeCommand callback.");
  }
  void executeCommand;

  const state = createInitialShellTuiState(profile);

  await new Promise((resolve, reject) => {
    const screen = blessed.screen({
      autoPadding: true,
      cursor: {
        artificial: false
      },
      dockBorders: true,
      fullUnicode: true,
      ignoreLocked: ["C-q"],
      input: process.stdin,
      output: process.stdout,
      smartCSR: false,
      fastCSR: false
    });

    screen.title = "skills-sync";
    const widgets = createWidgets(screen);

    const settle = () => {
      screen.destroy();
      resolve();
    };

    const rerender = () => {
      renderScreen(screen, widgets, state);
    };

    const focusPane = (pane) => {
      state.activePane = pane;
      state.compactPage = pane;
      clearTransientStatus(state);
      rerender();
      focusActiveWidget(widgets, state);
    };

    const closePromptAndRefocus = () => {
      closePrompt(state);
      rerender();
      focusActiveWidget(widgets, state);
    };

    const handleHelp = () => {
      appendTranscriptBlock(state, createHelpBlock(state.activeProfile), { follow: true });
      setStatus(state, "Help added to the transcript.", "muted");
      if (state.layoutMode === "compact") {
        state.activePane = "transcript";
        state.compactPage = "transcript";
      }
      rerender();
      focusActiveWidget(widgets, state);
    };

    const clearTranscript = () => {
      state.transcriptBlocks = [createWelcomeBlock(state.activeProfile)];
      clearTranscriptSearch(state);
      clearTranscriptSelection(state);
      rebuildTranscriptState(state, { follow: true });
      setStatus(state, "Transcript cleared.", "muted");
      rerender();
    };

    const handleInlineCommandArgs = async (commandArgs, commandText) => {
      await runInlineCommandArgs(state, screen, commandArgs, commandText);
      rerender();
      focusActiveWidget(widgets, state);
    };

    const handleHandoffCommand = async (commandArgs, commandText) => {
      state.busy = true;
      appendTranscriptBlock(
        state,
        createShellTranscriptBlock({
          kind: "warning",
          tone: "warning",
          command: commandText,
          text: "[shell] Swapping to the normal terminal for interactive input..."
        }),
        { follow: true }
      );
      setStatus(state, "Switching to terminal handoff mode...", "warning", true);
      rerender();
      screen.saveFocus();

      try {
        const exitCode = await foregroundCommand(screen, commandArgs);
        state.busy = false;
        state.status.sticky = false;
        screen.restoreFocus();

        appendTranscriptBlock(
          state,
          createShellTranscriptBlock({
            kind: exitCode === 0 ? "success" : "stderr",
            tone: exitCode === 0 ? "success" : "danger",
            command: commandText,
            text: exitCode === 0
              ? "[shell] Interactive command completed and the shell was restored."
              : `[shell] Interactive command exited with code ${exitCode}.`,
            exitCode
          }),
          { follow: true }
        );

        if (exitCode === 0) {
          setStatus(state, `Interactive command completed: ${commandText}`, "success");
        } else {
          setStatus(state, `Interactive command exited with code ${exitCode}.`, "danger");
        }

        if (state.layoutMode === "compact") {
          state.activePane = "transcript";
          state.compactPage = "transcript";
        }
        rerender();
        focusActiveWidget(widgets, state);
      } catch (error) {
        state.busy = false;
        state.status.sticky = false;
        screen.restoreFocus();
        appendTranscriptBlock(
          state,
          createShellTranscriptBlock({
            kind: "stderr",
            tone: "danger",
            command: commandText,
            text: `[shell] Interactive command failed: ${error.message}`,
            exitCode: 1
          }),
          { follow: true }
        );
        setStatus(state, `Interactive command failed: ${error.message}`, "danger");
        rerender();
        focusActiveWidget(widgets, state);
      }
    };

    const handleCommandExecution = async (commandArgs, commandText) => {
      if (shouldHandoffShellCommand(commandArgs)) {
        await handleHandoffCommand(commandArgs, commandText);
        return;
      }
      await handleInlineCommandArgs(commandArgs, commandText);
    };

    const openGuidedFlow = async (selected) => {
      if (!selected?.flowId) {
        return;
      }

      try {
        state.previousPane = state.activePane;
        state.promptReturnPane = state.activePane;
        state.promptMode = "guided";
        state.promptTarget = null;
        state.guided = await createGuidedFlowSession({
          flowId: selected.flowId,
          activeProfile: state.activeProfile,
          context: {
            variant: selected.flowDefaults?.variant,
            requireUpstream: selected.flowDefaults?.requireUpstream === true,
            flowDefaults: selected.flowDefaults ?? {}
          }
        });
        setStatus(state, `${selected.label} stepper ready.`, "accent");
      } catch (error) {
        closePrompt(state);
        setStatus(state, `Guided flow failed: ${error.message}`, "danger");
      }

      rerender();
      focusActiveWidget(widgets, state);
    };

    const retreatGuidedFlow = async () => {
      if (!state.guided) {
        closePromptAndRefocus();
        return;
      }
      try {
        const result = await retreatGuidedFlowSession(state.guided);
        if (result.type === "cancelled") {
          closePromptAndRefocus();
          return;
        }
        clearTransientStatus(state);
      } catch (error) {
        setStatus(state, `Guided flow failed: ${error.message}`, "danger");
      }
      rerender();
      focusActiveWidget(widgets, state);
    };

    const submitGuidedFlow = async () => {
      if (!state.guided) {
        closePromptAndRefocus();
        return;
      }

      try {
        const result = await advanceGuidedFlowSession(state.guided);
        if (result.type === "cancelled") {
          closePromptAndRefocus();
          return;
        }
        if (result.type === "completed") {
          rememberHistory(state, result.commandText);
          closePrompt(state);
          rerender();
          focusActiveWidget(widgets, state);
          await handleCommandExecution(result.commandArgs, result.commandText);
          return;
        }
        clearTransientStatus(state);
      } catch (error) {
        setStatus(state, `Guided flow error: ${error.message}`, "danger");
      }

      rerender();
      focusActiveWidget(widgets, state);
    };

    const handleSubmittedLine = async (rawInput) => {
      const trimmed = String(rawInput ?? "").trim();
      if (!trimmed) {
        return;
      }

      if (isShellShortcut(trimmed)) {
        const targetId = findShellExplorerShortcutTargetId(trimmed);
        if (focusExplorerTarget(state, targetId)) {
          setStatus(state, `Explorer focused: ${trimmed}`, "accent");
          rerender();
          focusActiveWidget(widgets, state);
        }
        return;
      }

      const alias = handleShellAlias(trimmed, state.activeProfile);
      if (alias.type === "exit") {
        settle();
        return;
      }
      if (alias.type === "help") {
        handleHelp();
        return;
      }
      if (alias.type === "clear") {
        clearTranscript();
        return;
      }
      if (alias.type === "show-profile") {
        appendTranscriptBlock(state, createProfileBlock(state.activeProfile), { follow: true });
        setStatus(state, `Shell profile context: ${state.activeProfile || "(none)"}`, "muted");
        if (state.layoutMode === "compact") {
          state.activePane = "transcript";
          state.compactPage = "transcript";
        }
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (alias.type === "set-profile-default") {
        state.activeProfile = await readDefaultProfile();
        appendTranscriptBlock(state, createProfileBlock(state.activeProfile), { follow: true });
        setStatus(state, `Shell profile context: ${state.activeProfile || "(none)"}`, "success");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (alias.type === "set-profile") {
        state.activeProfile = alias.nextProfile;
        appendTranscriptBlock(state, createProfileBlock(state.activeProfile), { follow: true });
        setStatus(state, `Shell profile context: ${state.activeProfile || "(none)"}`, "success");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }

      let args;
      try {
        args = tokenizeCommandLine(trimmed);
      } catch (error) {
        appendTranscriptBlock(
          state,
          createShellTranscriptBlock({
            kind: "stderr",
            tone: "danger",
            command: trimmed,
            text: `[shell] Input error: ${error.message}`,
            exitCode: 1
          }),
          { follow: true }
        );
        setStatus(state, `Input error: ${error.message}`, "danger");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }

      if (args[0] === "shell") {
        appendTranscriptBlock(
          state,
          createShellTranscriptBlock({
            kind: "warning",
            tone: "warning",
            command: trimmed,
            text: "[shell] Already running inside shell mode."
          }),
          { follow: true }
        );
        setStatus(state, "Already running inside shell mode.", "warning");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }

      const commandArgs = injectProfileIfNeeded(args, state.activeProfile);
      await handleCommandExecution(commandArgs, trimmed);
    };

    const submitPrompt = async () => {
      if (state.promptMode === "command") {
        const rawCommand = state.commandInput.trim();
        if (!rawCommand) {
          setStatus(state, "Enter a command before running.", "muted");
          rerender();
          return;
        }
        rememberHistory(state, rawCommand);
        closePrompt(state);
        setCommandInput(state, "");
        rerender();
        focusActiveWidget(widgets, state);
        await handleSubmittedLine(rawCommand);
        return;
      }
      if (state.promptMode === "guided") {
        await submitGuidedFlow();
        return;
      }

      closePromptAndRefocus();
    };

    wirePromptTextbox(widgets.promptInput, state, {
      change: () => {
        if (state.promptMode === "filter") {
          if (state.promptTarget === "transcript") {
            applyTranscriptSearch(state, screen, state.filterInput);
          } else {
            applyExplorerFilter(state, state.filterInput);
          }
        }
        rerender();
      },
      close: async () => {
        if (state.promptMode === "guided") {
          await retreatGuidedFlow();
          return;
        }
        closePromptAndRefocus();
      },
      complete: () => {
        const completions = getCompletionSuggestions(state.commandInput);
        if (state.commandInput.trim().length > 0 && completions.length > 0) {
          const applied = applyCompletionSuggestion(state.commandInput, completions[0]);
          if (applied !== state.commandInput) {
            setCommandInput(state, applied);
            setStatus(state, `Applied completion: ${completions[0]}`, "accent");
          }
        }
        rerender();
      },
      forceExit: settle,
      history: (direction) => {
        moveHistory(state, direction);
        rerender();
      },
      submit: submitPrompt
    });

    const moveGuidedSelection = (delta) => {
      const options = Array.isArray(state.guided?.currentStep?.options) ? state.guided.currentStep.options : [];
      if (options.length === 0) {
        return;
      }
      const nextIndex = Math.max(
        0,
        Math.min(Number(state.guided?.ui?.selectedIndex ?? 0) + delta, options.length - 1)
      );
      state.guided.ui.selectedIndex = nextIndex;
    };

    const toggleGuidedPickerValue = () => {
      if (state.guided?.currentStep?.kind !== "picker") {
        return;
      }
      const options = Array.isArray(state.guided.currentStep.options) ? state.guided.currentStep.options : [];
      const selectedIndex = Math.max(0, Math.min(Number(state.guided.ui?.selectedIndex ?? 0), options.length - 1));
      const option = options[selectedIndex];
      if (!option) {
        return;
      }
      const values = new Set(Array.isArray(state.guided.ui?.selectedValues) ? state.guided.ui.selectedValues : []);
      if (values.has(option.value)) {
        values.delete(option.value);
      } else {
        values.add(option.value);
      }
      state.guided.ui.selectedValues = [...values];
    };

    widgets.guidedList.on("focus", () => {
      if (state.promptMode !== "guided") {
        return;
      }
      rerender();
    });

    widgets.guidedList.on("keypress", async (ch, key) => {
      if (state.busy || state.promptMode !== "guided") {
        return;
      }
      if (key.ctrl && key.name === "q") {
        settle();
        return;
      }

      switch (key.name) {
        case "up":
          moveGuidedSelection(-1);
          rerender();
          return;
        case "down":
          moveGuidedSelection(1);
          rerender();
          return;
        case "home":
          state.guided.ui.selectedIndex = 0;
          rerender();
          return;
        case "end": {
          const options = Array.isArray(state.guided?.currentStep?.options) ? state.guided.currentStep.options : [];
          state.guided.ui.selectedIndex = Math.max(0, options.length - 1);
          rerender();
          return;
        }
        case "space":
          toggleGuidedPickerValue();
          rerender();
          return;
        case "enter":
          await submitGuidedFlow();
          return;
        case "escape":
          await retreatGuidedFlow();
          return;
        default:
          break;
      }
    });

    widgets.guidedList.on("click", () => {
      if (state.busy || state.promptMode !== "guided") {
        return;
      }
      state.guided.ui.selectedIndex = widgets.guidedList.selected;
      rerender();
      focusActiveWidget(widgets, state);
    });

    let lastExplorerClick = { id: null, at: 0 };

    widgets.explorerList.on("focus", () => {
      state.activePane = "explorer";
      clearTransientStatus(state);
      rerender();
    });

    widgets.explorerList.on("keypress", async (ch, key) => {
      if (state.busy || state.promptMode) {
        return;
      }
      if (key.ctrl && key.name === "q") {
        settle();
        return;
      }

      const selected = getSelectedExplorerRow(state);
      switch (key.name) {
        case "up":
          moveExplorerSelection(state, -1);
          rerender();
          return;
        case "down":
          moveExplorerSelection(state, 1);
          rerender();
          return;
        case "home":
          state.explorerSelectedId = state.explorerRows[0]?.id ?? state.explorerSelectedId;
          rerender();
          return;
        case "end":
          state.explorerSelectedId = state.explorerRows[state.explorerRows.length - 1]?.id ?? state.explorerSelectedId;
          rerender();
          return;
        case "right":
          expandExplorerRow(state, selected);
          rerender();
          return;
        case "left":
          collapseExplorerRow(state, selected);
          rerender();
          return;
        case "enter":
          if (selected?.hasChildren) {
            expandExplorerRow(state, selected);
            rerender();
            return;
          }
          if (selected?.command) {
            if (selected.mode === "guided") {
              await openGuidedFlow(selected);
              return;
            }
            if (selected.mode === "prefill") {
              openCommandPrompt(state, selected.command);
              setStatus(state, `Prefilled command: ${selected.command.trimEnd()}`, "accent");
              rerender();
              focusActiveWidget(widgets, state);
              return;
            }
            rememberHistory(state, selected.command);
            await handleSubmittedLine(selected.command);
          }
          return;
        default:
          break;
      }

      if (!key.ctrl && !key.meta && ch === ":") {
        openCommandPrompt(state);
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (!key.ctrl && !key.meta && ch === "/") {
        openFilterPrompt(state, "explorer");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (!key.ctrl && !key.meta && ch === "?") {
        handleHelp();
        return;
      }
      if (!key.ctrl && !key.meta && /[a-z0-9]/i.test(ch || "")) {
        openFilterPrompt(state, "explorer", ch);
        applyExplorerFilter(state, ch);
        rerender();
        focusActiveWidget(widgets, state);
      }
    });

    widgets.explorerList.on("click", () => {
      if (state.busy || state.promptMode) {
        return;
      }
      state.activePane = "explorer";
      const selectedIndex = widgets.explorerList.selected;
      const selectedRow = state.explorerRows[selectedIndex] ?? getSelectedExplorerRow(state);
      if (!selectedRow) {
        return;
      }
      state.explorerSelectedId = selectedRow.id;
      const now = Date.now();
      if (selectedRow.hasChildren && lastExplorerClick.id === selectedRow.id && now - lastExplorerClick.at < 350) {
        if (state.explorerExpandedIds.has(selectedRow.id)) {
          state.explorerExpandedIds.delete(selectedRow.id);
        } else {
          state.explorerExpandedIds.add(selectedRow.id);
        }
        syncExplorerRows(state);
      }
      lastExplorerClick = { id: selectedRow.id, at: now };
      rerender();
      focusActiveWidget(widgets, state);
    });

    widgets.transcriptBody.on("focus", () => {
      state.activePane = "transcript";
      clearTransientStatus(state);
      rerender();
    });

    widgets.transcriptBody.on("keypress", async (ch, key) => {
      if (state.busy || state.promptMode) {
        return;
      }
      if (key.ctrl && key.name === "q") {
        settle();
        return;
      }

      switch (key.name) {
        case "up":
          moveTranscriptCursor(state, screen, -1);
          rerender();
          return;
        case "down":
          moveTranscriptCursor(state, screen, 1);
          rerender();
          return;
        case "pageup":
          pageTranscript(state, screen, -1);
          rerender();
          return;
        case "pagedown":
          pageTranscript(state, screen, 1);
          rerender();
          return;
        case "left":
          moveTranscriptCursor(state, screen, 0, -1);
          rerender();
          return;
        case "right":
          moveTranscriptCursor(state, screen, 0, 1);
          rerender();
          return;
        case "home":
          setTranscriptCursor(state, screen, 0, 0);
          rerender();
          return;
        case "end":
          setTranscriptCursor(state, screen, Math.max(0, state.transcriptLines.length - 1), 0);
          rerender();
          return;
        case "space":
          if (normalizeSelection(state.transcriptSelectionAnchor, state.transcriptCursor)) {
            clearTranscriptSelection(state);
          } else if (state.transcriptSelectionAnchor) {
            clearTranscriptSelection(state);
          } else {
            state.transcriptSelectionAnchor = {
              line: state.transcriptCursor.line,
              column: state.transcriptCursor.column
            };
            setStatus(state, "Transcript selection started.", "accent");
          }
          rerender();
          return;
        default:
          break;
      }

      if (!key.ctrl && !key.meta && ch === ":") {
        openCommandPrompt(state);
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (!key.ctrl && !key.meta && ch === "/") {
        openFilterPrompt(state, "transcript");
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (!key.ctrl && !key.meta && ch === "g") {
        setTranscriptCursor(state, screen, 0, 0);
        rerender();
        return;
      }
      if (!key.ctrl && !key.meta && ch === "G") {
        setTranscriptCursor(state, screen, Math.max(0, state.transcriptLines.length - 1), 0);
        rerender();
        return;
      }
      if (!key.ctrl && !key.meta && ch === "n") {
        moveTranscriptSearch(state, screen, 1);
        rerender();
        return;
      }
      if (!key.ctrl && !key.meta && ch === "N") {
        moveTranscriptSearch(state, screen, -1);
        rerender();
        return;
      }
      if (!key.ctrl && !key.meta && ch === "y") {
        await copyTranscriptSelection(state, "selection");
        rerender();
        return;
      }
      if (key.ctrl && key.name === "y") {
        await copyTranscriptSelection(state, "all");
        rerender();
        return;
      }
      if (!key.ctrl && !key.meta && ch === "?") {
        handleHelp();
      }
    });

    widgets.transcriptBody.on("wheelup", () => {
      moveTranscriptCursor(state, screen, -3);
      rerender();
    });

    widgets.transcriptBody.on("wheeldown", () => {
      moveTranscriptCursor(state, screen, 3);
      rerender();
    });

    widgets.transcriptBody.on("click", (data) => {
      if (state.busy || state.promptMode) {
        return;
      }
      state.activePane = "transcript";
      const nextLine = getTranscriptLineFromPointer(widgets.transcriptBody, data, state);
      const lineText = String(state.transcriptLines[nextLine]?.text ?? "");
      const position = widgets.transcriptBody.lpos || widgets.transcriptBody._getCoords();
      const relativeX = position ? Math.max(0, data.x - position.xi) : 0;
      const column = Math.max(0, Math.min(state.transcriptScrollLeft + relativeX, lineText.length));
      setTranscriptCursor(state, screen, nextLine, column);
      rerender();
      focusActiveWidget(widgets, state);
    });

    screen.key(["C-c", "C-q"], settle);
    screen.key(["tab"], () => {
      if (state.busy || state.promptMode) {
        return;
      }
      focusPane(state.activePane === "explorer" ? "transcript" : "explorer");
    });
    screen.key(["escape"], () => {
      if (state.busy) {
        return;
      }
      if (state.promptMode) {
        if (state.promptMode === "guided") {
          void retreatGuidedFlow();
          return;
        }
        closePromptAndRefocus();
        return;
      }
      if (state.activePane === "transcript" && state.transcriptSelectionAnchor) {
        clearTranscriptSelection(state);
        rerender();
        return;
      }
      if (state.activePane === "explorer" && state.explorerFilter) {
        state.explorerFilter = "";
        syncExplorerRows(state);
        setStatus(state, "Explorer filter cleared.", "muted");
        rerender();
        return;
      }
      if (state.activePane === "transcript" && state.transcriptSearchQuery) {
        clearTranscriptSearch(state);
        rerender();
        return;
      }
      settle();
    });
    screen.on("resize", () => {
      rerender();
      focusActiveWidget(widgets, state);
    });
    screen.on("mousedown", (data) => {
      if (state.busy || state.promptMode) {
        return;
      }
      if (containsScreenPoint(widgets.explorerFrame, data)) {
        state.activePane = "explorer";
        rerender();
        focusActiveWidget(widgets, state);
        return;
      }
      if (containsScreenPoint(widgets.transcriptFrame, data)) {
        state.activePane = "transcript";
        rerender();
        focusActiveWidget(widgets, state);
      }
    });
    screen.on("error", reject);

    rerender();
    focusActiveWidget(widgets, state);
  });

  process.stdout.write("Leaving shell mode.\n");
}
