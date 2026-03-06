import readline from "node:readline/promises";
import { readDefaultProfile } from "./config.js";
import { canPrompt, isPromptCancelledError, promptForSelect, promptForText } from "./prompt-adapter.js";
import { accent, brand, danger, formatPrompt, heading, muted, success, warning } from "./terminal-ui.js";

const ROOT_COMMANDS = [
  "init",
  "build",
  "apply",
  "doctor",
  "unlink",
  "list",
  "search",
  "use",
  "current",
  "ls",
  "new",
  "remove",
  "profile",
  "agents",
  "upstream",
  "workspace",
  "detect",
  "help"
];

const ROOT_SUBCOMMANDS = {
  list: ["skills", "mcps", "upstreams", "profiles", "everything", "upstream-content"],
  search: ["skills"],
  profile: [
    "show",
    "inspect",
    "refresh",
    "diff",
    "clone",
    "new-skill",
    "add-skill",
    "remove-skill",
    "add-mcp",
    "remove-mcp",
    "export",
    "import",
    "add-upstream",
    "remove-upstream"
  ],
  agents: ["inventory", "drift"],
  upstream: ["add", "remove"],
  workspace: ["export", "import", "diff", "sync"]
};

const ROOT_OPTIONS = {
  init: ["--seed", "--dry-run", "--profile"],
  build: ["--profile", "--lock"],
  apply: ["--profile", "--build", "--agents", "--dry-run"],
  doctor: ["--profile"],
  detect: ["--format", "--agents"],
  unlink: ["--agents", "--dry-run"],
  shell: ["--profile"]
};

const SUBCOMMAND_OPTIONS = {
  list: {
    skills: ["--profile", "--detail", "--agents", "--format"],
    mcps: ["--profile", "--format"],
    upstreams: ["--format"],
    agents: ["--agents", "--format"],
    profiles: ["--format"],
    everything: ["--detail", "--format"],
    "upstream-content": [
      "--upstream",
      "--source",
      "--provider",
      "--root",
      "--ref",
      "--profile",
      "--verbose",
      "--versbose",
      "--format"
    ]
  },
  search: {
    skills: [
      "--query",
      "--upstream",
      "--source",
      "--provider",
      "--root",
      "--ref",
      "--profile",
      "--scope",
      "--verbose",
      "--versbose",
      "--format"
    ]
  },
  profile: {
    show: ["--detail", "--agents", "--format"],
    inspect: ["--format"],
    refresh: ["--upstream", "--path", "--all", "--build", "--apply", "--dry-run", "--format"],
    diff: ["--format"],
    clone: [],
    "new-skill": ["--profile", "--path", "--frontmatter", "--include-scripts", "--include-references"],
    "add-skill": [
      "--upstream",
      "--upstream-id",
      "--source",
      "--provider",
      "--root",
      "--path",
      "--all",
      "--interactive",
      "--ref",
      "--pin",
      "--dest-prefix",
      "--build",
      "--apply"
    ],
    "remove-skill": [
      "--upstream",
      "--path",
      "--all",
      "--interactive",
      "--ref",
      "--dest-prefix",
      "--prune-upstream",
      "--build",
      "--apply",
      "--yes"
    ],
    "add-mcp": ["--command", "--url", "--args", "--arg", "--env"],
    "remove-mcp": [],
    export: ["--output"],
    import: ["--input", "--replace"],
    "add-upstream": ["--source", "--repo", "--provider", "--root", "--default-ref", "--type"],
    "remove-upstream": []
  },
  agents: {
    inventory: ["--agents", "--format"],
    drift: ["--profile", "--agents", "--dry-run", "--format"]
  },
  upstream: {
    add: ["--source", "--repo", "--provider", "--root", "--default-ref", "--type"],
    remove: []
  },
  workspace: {
    export: ["--output"],
    import: ["--input", "--replace"],
    diff: ["--input", "--format"],
    sync: ["--input", "--dry-run"]
  }
};

const SHELL_ALIASES = [":help", ":profile", ":clear", ":exit", "help", "clear", "exit", "quit"];
const SHELL_SHORTCUTS = ["list", "agents", "profile", "search", "workspace"];

const PROFILE_AWARE_COMMANDS = new Set(["build", "apply", "doctor"]);

function normalizeRootToken(token) {
  if (typeof token !== "string") {
    return token;
  }
  const trimmed = token.trim();
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function isShellShortcut(input) {
  const normalized = normalizeRootToken(input);
  return SHELL_SHORTCUTS.includes(normalized);
}

function tokenizeCommandLine(input) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (const character of String(input)) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new Error("Unterminated quote in command.");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function splitByWhitespace(input) {
  return String(input).trim().split(/\s+/).filter((token) => token.length > 0);
}

function uniqueSorted(items) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

function getCompletionMatches(pool, current) {
  if (!current) {
    return pool;
  }
  const matches = pool.filter((item) => item.startsWith(current));
  return matches.length > 0 ? matches : pool;
}

function createCompleter() {
  const rootCompletions = uniqueSorted([...ROOT_COMMANDS, ...SHELL_ALIASES, ...SHELL_SHORTCUTS]);

  return (line) => {
    const raw = String(line || "");
    const tokens = splitByWhitespace(raw);
    const endsWithWhitespace = /\s$/.test(raw);

    if (tokens.length === 0) {
      return [rootCompletions, raw];
    }

    if (tokens.length === 1 && !endsWithWhitespace) {
      const token = tokens[0];
      const normalizedToken = normalizeRootToken(token);
      const children = ROOT_SUBCOMMANDS[normalizedToken] ?? [];
      if (children.length > 0) {
        const prefix = token.startsWith("/") ? `/${normalizedToken}` : normalizedToken;
        const expanded = children.map((child) => `${prefix} ${child}`);
        return [expanded, raw];
      }
      const matches = rootCompletions.filter((item) => item.startsWith(token));
      return [matches.length > 0 ? matches : rootCompletions, raw];
    }

    const rootToken = tokens[0];
    const normalizedRoot = normalizeRootToken(rootToken);
    const children = ROOT_SUBCOMMANDS[normalizedRoot] ?? [];
    const rootOptions = ROOT_OPTIONS[normalizedRoot] ?? [];
    const current = endsWithWhitespace ? "" : tokens[tokens.length - 1];

    if (children.length === 0) {
      if (rootOptions.length === 0) {
        return [[], raw];
      }
      return [getCompletionMatches(rootOptions, current), raw];
    }

    const secondToken = tokens[1];
    const hasKnownSubcommand =
      typeof secondToken === "string" &&
      !secondToken.startsWith("-") &&
      children.includes(secondToken);

    if (!hasKnownSubcommand) {
      const pool = uniqueSorted([...children, ...rootOptions]);
      return [getCompletionMatches(pool, current), raw];
    }

    const subcommandOptions = SUBCOMMAND_OPTIONS[normalizedRoot]?.[secondToken] ?? [];
    if (tokens.length === 2 && !endsWithWhitespace && !current.startsWith("-")) {
      return [getCompletionMatches(children, current), raw];
    }
    if (subcommandOptions.length === 0) {
      return [[], raw];
    }
    return [getCompletionMatches(subcommandOptions, current), raw];
  };
}

function isReadlineClosedError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("readline was closed") || message.includes("interface is closed");
}

function handleShellAlias(rawLine, activeProfile) {
  const line = rawLine.trim();
  const lower = line.toLowerCase();

  if (lower === "exit" || lower === "quit" || lower === ":exit") {
    return { type: "exit", nextProfile: activeProfile };
  }
  if (lower === "help" || lower === "?" || lower === ":help") {
    return { type: "help", nextProfile: activeProfile };
  }
  if (lower === "clear" || lower === ":clear") {
    return { type: "clear", nextProfile: activeProfile };
  }
  if (lower === ":profile") {
    return { type: "show-profile", nextProfile: activeProfile };
  }
  if (lower.startsWith(":profile ")) {
    const value = line.slice(":profile ".length).trim();
    if (value === "" || value.toLowerCase() === "none") {
      return { type: "set-profile", nextProfile: null };
    }
    if (value.toLowerCase() === "default") {
      return { type: "set-profile-default", nextProfile: activeProfile };
    }
    return { type: "set-profile", nextProfile: value };
  }
  return { type: "none", nextProfile: activeProfile };
}

function resolveShortcutCommands(shortcut) {
  const normalizedShortcut = normalizeRootToken(shortcut);
  if (normalizedShortcut === "list") {
    return {
      message: "List options",
      commands: [
        { value: "list profiles", label: "profiles", hint: "show available profiles" },
        { value: "list skills", label: "skills", hint: "show effective profile skills" },
        { value: "list mcps", label: "mcps", hint: "show effective profile MCP servers" },
        { value: "list upstreams", label: "upstreams", hint: "show configured upstream repos" },
        { value: "list agents", label: "agents", hint: "show locally detected agents" },
        { value: "list everything", label: "everything", hint: "full profile inventory" },
        { value: "list upstream-content", label: "upstream-content", hint: "skills + MCP manifests in upstream refs" }
      ]
    };
  }
  if (normalizedShortcut === "agents") {
    return {
      message: "Agents options",
      commands: [
        { value: "agents inventory", label: "inventory", hint: "inspect detected agent resources" },
        { value: "agents drift --dry-run", label: "drift (dry-run)", hint: "check drift without changes" },
        { value: "agents drift", label: "drift", hint: "reconcile drift" }
      ]
    };
  }
  if (normalizedShortcut === "profile") {
    return {
      message: "Profile options",
      commands: [
        { value: "profile show", label: "show", hint: "show active profile skills + MCP servers" },
        { value: "profile inspect", label: "inspect", hint: "check imports, freshness, and capability warnings" },
        { value: "profile refresh", label: "refresh", hint: "refresh imported skill sources" },
        { value: "profile add-skill", label: "add-skill", hint: "add a skill import to profile" },
        { value: "profile remove-skill", label: "remove-skill", hint: "remove a skill import from profile" },
        { value: "profile new-skill demo-skill", label: "new-skill", hint: "scaffold a local skill directory" },
        { value: "profile add-upstream", label: "add-upstream", hint: "add an upstream repository" },
        { value: "profile remove-upstream", label: "remove-upstream", hint: "remove an upstream repository" },
        { value: "profile add-mcp", label: "add-mcp", hint: "add/update MCP server in profile" },
        { value: "profile remove-mcp", label: "remove-mcp", hint: "remove MCP server from profile" },
        { value: "profile export", label: "export", hint: "export profile config to JSON" },
        { value: "profile import", label: "import", hint: "import profile config JSON" },
        { value: "profile diff personal work", label: "diff", hint: "compare two profiles" },
        { value: "profile clone personal work", label: "clone", hint: "clone a profile pack" }
      ]
    };
  }
  if (normalizedShortcut === "search") {
    return {
      message: "Search options",
      commands: [
        { value: "search skills", label: "skills", hint: "fuzzy search skills (prompts for query)" },
        { value: "search skills --verbose", label: "skills verbose", hint: "include title-based matching" }
      ]
    };
  }
  if (normalizedShortcut === "workspace") {
    return {
      message: "Workspace options",
      commands: [
        { value: "workspace export", label: "export", hint: "write a full workspace manifest" },
        { value: "workspace diff", label: "diff", hint: "compare manifest vs live workspace" },
        { value: "workspace sync --dry-run", label: "sync (dry-run)", hint: "preview manifest reconciliation" },
        { value: "workspace sync", label: "sync", hint: "apply manifest reconciliation" }
      ]
    };
  }
  return null;
}

async function resolveShortcutSelection(shortcut, rl) {
  const normalizedShortcut = normalizeRootToken(shortcut);
  const shortcutConfig = resolveShortcutCommands(shortcut);
  if (!shortcutConfig) {
    return null;
  }
  if (!canPrompt()) {
    process.stderr.write(`${warning("Slash shortcuts require an interactive terminal prompt.")}\n`);
    return null;
  }

  rl.pause();
  try {
    const selectedCommand = await promptForSelect({
      message: shortcutConfig.message,
      options: shortcutConfig.commands
    });
    if (normalizedShortcut !== "search") {
      return selectedCommand;
    }

    const query = await promptForText({
      message: "Search query",
      placeholder: "mcp",
      validate: (inputValue) =>
        String(inputValue ?? "").trim().length > 0 ? undefined : "Search query is required."
    });
    const args = tokenizeCommandLine(selectedCommand);
    return [...args, "--query", query];
  } finally {
    rl.resume();
  }
}

function printShellHelp(activeProfile) {
  process.stdout.write(`${heading("Interactive shell commands")}\n`);
  process.stdout.write(`  ${accent("help")} / ${accent(":help")}         Show this help\n`);
  process.stdout.write(`  ${accent("exit")} / ${accent("quit")} / ${accent(":exit")}  Exit shell mode\n`);
  process.stdout.write(`  ${accent("clear")} / ${accent(":clear")}       Clear terminal output\n`);
  process.stdout.write(`  ${accent(":profile <name>")}     Set shell profile context\n`);
  process.stdout.write(`  ${accent(":profile default")}    Reset shell profile to current default profile\n`);
  process.stdout.write(`  ${accent(":profile none")}       Disable shell profile context\n`);
  process.stdout.write(`  ${accent("list agents profile search workspace")}  Open shortcut selection menus\n`);
  process.stdout.write(`  ${accent("init build apply doctor unlink")}  Core commands\n`);
  process.stdout.write("\n");
  process.stdout.write(
    `${muted("Tip: press TAB for command completion. Quoted arguments are supported.")}\n`
  );
  if (activeProfile) {
    process.stdout.write(`${muted(`Current shell profile context: ${activeProfile}`)}\n`);
  }
}

function injectProfileIfNeeded(tokens, activeProfile) {
  if (!activeProfile || tokens.includes("--profile")) {
    return tokens;
  }
  const normalizedRoot = normalizeRootToken(tokens[0]);
  if (!PROFILE_AWARE_COMMANDS.has(normalizedRoot)) {
    return tokens;
  }
  return [...tokens, "--profile", activeProfile];
}

async function executeWithReadlinePaused({ rl, executeCommand, commandArgs }) {
  rl.pause();
  try {
    return await executeCommand(commandArgs);
  } finally {
    rl.resume();
  }
}

export async function cmdShell({ profile, executeCommand }) {
  if (typeof executeCommand !== "function") {
    throw new Error("Interactive shell requires an executeCommand callback.");
  }

  let activeProfile = profile ?? await readDefaultProfile();
  const interactiveTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 500,
    terminal: interactiveTerminal,
    completer: createCompleter()
  });

  process.stdout.write(`${brand("skills-sync")} ${heading("interactive shell")}\n`);
  process.stdout.write(
    `${muted("Run CLI commands directly. Use help/:help for shell commands. Type exit to quit.")}\n`
  );
  if (activeProfile) {
    process.stdout.write(`${muted(`Profile context enabled: ${activeProfile}`)}\n`);
  } else {
    process.stdout.write(`${muted("Profile context disabled. Use :profile <name> to set one.")}\n`);
  }
  process.stdout.write(`${muted("Modes:")}\n`);
  process.stdout.write(`${muted("  setup   -> init | init --seed")}\n`);
  process.stdout.write(`${muted("  sync    -> build -> apply")}\n`);
  process.stdout.write(`${muted("Explore and Manage:")}\n`);
  process.stdout.write(`${muted("  list      -> profiles, skills, MCP servers, upstreams, and detected agents")}\n`);
  process.stdout.write(`${muted("  agents    -> inventory/drift to identify drift and sync status")}\n`);
  process.stdout.write(`${muted("  profile   -> inspect, refresh, scaffold, and manage skills/MCPs/upstreams")}\n`);
  process.stdout.write(`${muted("  search    -> choose search mode, then enter query")}\n`);
  process.stdout.write(`${muted("  workspace -> export, diff, and sync full environment manifests")}\n`);
  process.stdout.write("\n");

  try {
    while (true) {
      let line;
      try {
        line = await rl.question(formatPrompt({ profile: activeProfile }, process.stdout));
      } catch (error) {
        if (isReadlineClosedError(error)) {
          break;
        }
        throw error;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (isShellShortcut(trimmed)) {
        let shortcutCommand;
        try {
          shortcutCommand = await resolveShortcutSelection(trimmed, rl);
        } catch (error) {
          if (isPromptCancelledError(error)) {
            process.stderr.write(`${warning("Selection cancelled.")}\n`);
            continue;
          }
          throw error;
        }
        if (!shortcutCommand) {
          continue;
        }
        const args = Array.isArray(shortcutCommand) ? shortcutCommand : tokenizeCommandLine(shortcutCommand);
        const commandArgs = injectProfileIfNeeded(args, activeProfile);
        const exitCode = await executeWithReadlinePaused({
          rl,
          executeCommand,
          commandArgs
        });
        if (exitCode !== 0) {
          process.stderr.write(`${danger(`Command exited with code ${exitCode}.`)}\n`);
        }
        continue;
      }

      const shellAlias = handleShellAlias(trimmed, activeProfile);
      if (shellAlias.type === "exit") {
        break;
      }
      if (shellAlias.type === "help") {
        printShellHelp(activeProfile);
        continue;
      }
      if (shellAlias.type === "clear") {
        console.clear();
        continue;
      }
      if (shellAlias.type === "show-profile") {
        const current = activeProfile || "(none)";
        process.stdout.write(`${muted(`Shell profile context: ${current}`)}\n`);
        continue;
      }
      if (shellAlias.type === "set-profile-default") {
        activeProfile = await readDefaultProfile();
        process.stdout.write(
          `${muted(`Shell profile context: ${activeProfile || "(none)"}`)}\n`
        );
        continue;
      }
      if (shellAlias.type === "set-profile") {
        activeProfile = shellAlias.nextProfile;
        process.stdout.write(`${muted(`Shell profile context: ${activeProfile || "(none)"}`)}\n`);
        continue;
      }

      let args;
      try {
        args = tokenizeCommandLine(trimmed);
      } catch (error) {
        process.stderr.write(`${danger(`Input error: ${error.message}`)}\n`);
        continue;
      }

      if (args[0] === "shell") {
        process.stderr.write(`${warning("Already running inside shell mode.")}\n`);
        continue;
      }

      const commandArgs = injectProfileIfNeeded(args, activeProfile);
      const exitCode = await executeWithReadlinePaused({
        rl,
        executeCommand,
        commandArgs
      });
      if (exitCode !== 0) {
        process.stderr.write(`${danger(`Command exited with code ${exitCode}.`)}\n`);
      }
    }
  } finally {
    rl.close();
  }

  process.stdout.write(`${success("Leaving shell mode.")}\n`);
}
