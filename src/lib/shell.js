import { readDefaultProfile } from "./config.js";
import { cmdShellTui, supportsShellTui } from "./shell-tui.js";

export const SHELL_TUI_REQUIREMENTS_MESSAGE =
  "Interactive shell requires a TTY terminal of at least 80x18. Use normal CLI commands in non-interactive mode.";

export {
  applyCompletionSuggestion,
  createCompleter,
  createShellExplorerTree,
  createShellHelpLines,
  createShellShortcutSections,
  findShellExplorerShortcutTargetId,
  flattenShellExplorerTree,
  flattenShellShortcutSections,
  getCompletionSuggestions,
  getShellExplorerDefaultExpandedIds,
  getShellFooterHints,
  getShellPromptText,
  handleShellAlias,
  injectProfileIfNeeded,
  isShellShortcut,
  normalizeRootToken,
  resolveShortcutCommands,
  tokenizeCommandLine
} from "./shell-shared.js";
export {
  buildShellTranscriptLineMap,
  clearShellEntryState,
  createInitialShellTuiState,
  createShellOutputRecord,
  createShellTranscriptBlock,
  createShellTuiViewModel,
  extractShellTranscriptSelectionText,
  findShellTranscriptMatches,
  getShellLayoutMode,
  setCommandInput,
  shouldHandoffShellCommand,
  supportsShellTui
} from "./shell-tui.js";
export {
  advanceGuidedFlowSession,
  createGuidedFlowSession,
  formatShellCommandArgs,
  refreshGuidedFlowStep,
  retreatGuidedFlowSession
} from "./shell-guided.js";

export async function cmdShell({ profile, executeCommand }) {
  if (typeof executeCommand !== "function") {
    throw new Error("Interactive shell requires an executeCommand callback.");
  }

  const activeProfile = profile ?? await readDefaultProfile();

  if (!supportsShellTui()) {
    throw new Error(SHELL_TUI_REQUIREMENTS_MESSAGE);
  }

  return cmdShellTui({
    profile: activeProfile,
    executeCommand
  });
}
