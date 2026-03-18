const ROOT_COMMANDS = [
  "init",
  "sync",
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
  list: ["skills", "mcps", "upstreams", "profiles", "everything", "upstream-content", "agents"],
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
  sync: ["--profile", "--agents", "--dry-run"],
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
    refresh: ["--upstream", "--path", "--all", "--no-sync", "--dry-run", "--format"],
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
      "--no-sync"
    ],
    "remove-skill": [
      "--upstream",
      "--path",
      "--all",
      "--interactive",
      "--ref",
      "--dest-prefix",
      "--prune-upstream",
      "--no-sync",
      "--yes"
    ],
    "add-mcp": ["--command", "--url", "--transport", "--args", "--arg", "--env", "--no-sync"],
    "remove-mcp": ["--no-sync"],
    export: ["--output"],
    import: ["--input", "--replace", "--no-sync"],
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
const SHELL_SHORTCUTS = ["list", "skills", "mcps", "upstreams", "agents", "profiles", "profile", "search"];
const PROFILE_AWARE_COMMANDS = new Set(["sync", "build", "apply", "doctor"]);

const SHELL_SHORTCUT_TARGETS = {
  list: "skills-list",
  skills: "skills",
  mcps: "mcps",
  upstreams: "upstreams",
  agents: "agents",
  profiles: "profiles",
  profile: "profiles",
  search: "skills-search"
};

function explorerSection(id, label, children, options = {}) {
  return {
    id,
    label,
    kind: "section",
    defaultExpanded: options.defaultExpanded === true,
    matchText: options.matchText ?? "",
    children
  };
}

function explorerGroup(id, label, children, options = {}) {
  return {
    id,
    label,
    kind: "group",
    matchText: options.matchText ?? "",
    children
  };
}

function explorerAction(id, label, command, options = {}) {
  return {
    id,
    label,
    kind: "action",
    mode: options.mode ?? "execute",
    command,
    flowId: options.flowId ?? null,
    flowDefaults: options.flowDefaults ?? null,
    matchText: options.matchText ?? ""
  };
}

const SHELL_EXPLORER_TREE = [
  explorerSection("setup", "Setup", [
    explorerGroup("setup-init", "Init", [
      explorerAction("setup-init-default", "init", "init"),
      explorerAction("setup-init-seed", "init --seed", "init --seed"),
      explorerAction("setup-init-dry-run", "init --dry-run", "init --dry-run"),
      explorerAction("setup-init-profile", "init --profile <name>", "init --profile ", {
        mode: "prefill",
        matchText: "initialize workspace for a specific profile"
      })
    ]),
    explorerGroup("setup-sync", "Sync", [
      explorerAction("setup-sync-dry-run", "sync --dry-run", "sync --dry-run"),
      explorerAction("setup-sync-run", "sync", "sync"),
      explorerAction("setup-unlink-dry-run", "unlink --dry-run", "unlink --dry-run"),
      explorerAction("setup-unlink-run", "unlink", "unlink")
    ]),
    explorerGroup("setup-health", "Health", [
      explorerAction("setup-health-doctor", "doctor", "doctor"),
      explorerAction("setup-health-detect", "detect", "detect", {
        matchText: "detect installed agents"
      }),
      explorerAction("setup-health-help", "help", "help", {
        matchText: "shell help and cli overview"
      })
    ])
  ], { defaultExpanded: true }),
  explorerSection("profiles", "Profiles", [
    explorerGroup("profiles-current", "Current", [
      explorerAction("profiles-current-current", "current", "current", {
        matchText: "show active profile"
      }),
      explorerAction("profiles-current-list", "ls", "ls", {
        matchText: "list local profiles"
      }),
      explorerAction("profiles-current-use", "use <name>", "use ", {
        mode: "prefill",
        matchText: "switch active profile"
      }),
      explorerAction("profiles-current-list-profiles", "list profiles", "list profiles")
    ]),
    explorerGroup("profiles-manage", "Manage", [
      explorerAction("profiles-manage-new", "new <name>", "new ", {
        mode: "prefill",
        matchText: "create profile"
      }),
      explorerAction("profiles-manage-remove", "remove <name>", "remove ", {
        mode: "prefill",
        matchText: "delete profile"
      }),
      explorerAction("profiles-manage-clone", "profile clone <source> <target>", "profile clone ", {
        mode: "prefill",
        matchText: "clone profile definition"
      }),
      explorerAction("profiles-manage-diff", "profile diff <left> <right>", "profile diff ", {
        mode: "prefill",
        matchText: "compare two profiles"
      })
    ]),
    explorerGroup("profiles-inspect", "Inspect", [
      explorerAction("profile-summary-show", "profile show", "profile show"),
      explorerAction("profile-summary-inspect", "profile inspect", "profile inspect"),
      explorerAction("profile-data-export", "profile export", "profile export"),
      explorerAction("profile-data-import", "profile import <name>", "profile import ", {
        mode: "prefill",
        matchText: "import profile JSON"
      })
    ])
  ]),
  explorerSection("skills", "Skills", [
    explorerGroup("skills-list", "List", [
      explorerAction("explore-skills-list", "list skills", "list skills"),
      explorerAction("explore-skills-list-full", "list skills --detail full", "list skills --detail full", {
        matchText: "full skill inventory"
      }),
      explorerAction("explore-everything-list", "list everything", "list everything")
    ]),
    explorerGroup("skills-search", "Search", [
      explorerAction("explore-skills-search", "search skills --query <text>", "search skills --query ", {
        mode: "prefill"
      }),
      explorerAction(
        "explore-skills-search-verbose",
        "search skills --verbose --query <text>",
        "search skills --verbose --query ",
        {
          mode: "prefill",
          matchText: "verbose skill search"
        }
      )
    ]),
    explorerGroup("skills-manage", "Manage", [
      explorerAction(
        "profile-skills-add",
        "profile add-skill --interactive",
        "profile add-skill --interactive",
        {
          mode: "guided",
          flowId: "skill-add",
          matchText: "interactive skill import"
        }
      ),
      explorerAction(
        "profile-skills-add-upstream",
        "profile add-skill --upstream <id> --path <repoPath>",
        "profile add-skill --upstream ",
        {
          mode: "guided",
          flowId: "skill-add",
          flowDefaults: {
            sourceMode: "upstream"
          },
          matchText: "import skill from configured upstream"
        }
      ),
      explorerAction(
        "profile-skills-add-source",
        "profile add-skill --source <locator>",
        "profile add-skill --source ",
        {
          mode: "guided",
          flowId: "skill-add",
          flowDefaults: {
            sourceMode: "source"
          },
          matchText: "import skill from source"
        }
      ),
      explorerAction("profile-skills-remove", "profile remove-skill", "profile remove-skill ", {
        mode: "guided",
        flowId: "skill-remove",
        matchText: "remove imported skill"
      }),
      explorerAction("profile-skills-new", "profile new-skill <skillName>", "profile new-skill ", {
        mode: "prefill",
        matchText: "create a local skill"
      })
    ]),
    explorerGroup("skills-refresh", "Refresh", [
      explorerAction("profile-summary-refresh", "profile refresh", "profile refresh", {
        mode: "guided",
        flowId: "profile-refresh"
      }),
      explorerAction("profile-summary-refresh-dry-run", "profile refresh --dry-run", "profile refresh --dry-run", {
        mode: "guided",
        flowId: "profile-refresh",
        flowDefaults: {
          dryRun: true
        }
      }),
      explorerAction(
        "profile-summary-refresh-upstream",
        "profile refresh --upstream <id>",
        "profile refresh --upstream ",
        {
          mode: "guided",
          flowId: "profile-refresh",
          flowDefaults: {
            requireUpstream: true
          },
          matchText: "refresh one upstream"
        }
      )
    ])
  ]),
  explorerSection("mcps", "MCPs", [
    explorerGroup("mcps-list", "List", [
      explorerAction("explore-mcps-list", "list mcps", "list mcps")
    ]),
    explorerGroup("mcps-manage", "Manage", [
      explorerAction("profile-mcp-add", "profile add-mcp", "profile add-mcp", {
        mode: "guided",
        flowId: "mcp-add",
        matchText: "add or update MCP server"
      }),
      explorerAction("profile-mcp-remove", "profile remove-mcp <profile> <server>", "profile remove-mcp ", {
        mode: "guided",
        flowId: "mcp-remove",
        matchText: "remove MCP server"
      })
    ])
  ]),
  explorerSection("upstreams", "Upstreams", [
    explorerGroup("upstreams-list", "List", [
      explorerAction("explore-upstreams-list", "list upstreams", "list upstreams"),
      explorerAction(
        "explore-upstream-content",
        "list upstream-content --upstream <id>",
        "list upstream-content --upstream ",
        {
          mode: "guided",
          flowId: "upstream-content",
          matchText: "browse upstream content"
        }
      )
    ]),
    explorerGroup("upstreams-manage", "Manage", [
      explorerAction("explore-upstream-add", "upstream add --source <locator>", "upstream add --source ", {
        mode: "guided",
        flowId: "upstream-add",
        flowDefaults: {
          variant: "upstream"
        },
        matchText: "register upstream source"
      }),
      explorerAction("explore-upstream-remove", "upstream remove <id>", "upstream remove ", {
        mode: "guided",
        flowId: "upstream-remove",
        flowDefaults: {
          variant: "upstream"
        },
        matchText: "remove upstream source"
      }),
      explorerAction(
        "profile-upstream-add",
        "profile add-upstream --source <locator>",
        "profile add-upstream --source ",
        {
          mode: "guided",
          flowId: "upstream-add",
          flowDefaults: {
            variant: "profile"
          },
          matchText: "register upstream through profile workflow"
        }
      ),
      explorerAction("profile-upstream-remove", "profile remove-upstream <id>", "profile remove-upstream ", {
        mode: "guided",
        flowId: "upstream-remove",
        flowDefaults: {
          variant: "profile"
        },
        matchText: "remove profile upstream alias"
      })
    ])
  ]),
  explorerSection("agents", "Agents", [
    explorerGroup("agents-list", "List", [
      explorerAction("explore-agents-list", "list agents", "list agents"),
      explorerAction("explore-agents-detect", "detect", "detect", {
        matchText: "detect installed agents"
      }),
      explorerAction("explore-agents-inventory", "agents inventory", "agents inventory")
    ]),
    explorerGroup("agents-drift", "Drift", [
      explorerAction("explore-agents-drift", "agents drift --dry-run", "agents drift --dry-run"),
      explorerAction("explore-agents-drift-apply", "agents drift", "agents drift", {
        matchText: "reconcile agent drift"
      })
    ])
  ])
];

export {
  PROFILE_AWARE_COMMANDS,
  ROOT_COMMANDS,
  ROOT_OPTIONS,
  ROOT_SUBCOMMANDS,
  SHELL_ALIASES,
  SHELL_SHORTCUTS,
  SUBCOMMAND_OPTIONS
};

function cloneExplorerNode(node) {
  return {
    ...node,
    children: Array.isArray(node.children) ? node.children.map(cloneExplorerNode) : undefined
  };
}

function buildExplorerSearchText(node) {
  return [
    node.label,
    node.command,
    node.matchText,
    Array.isArray(node.children) ? node.children.map((child) => child.label).join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function flattenExplorerNode(node, context, depth, parentId, ancestorMatched) {
  const query = context.query;
  const selfMatches = query.length === 0 ? true : buildExplorerSearchText(node).includes(query);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const childResults = hasChildren
    ? node.children.map((child) => flattenExplorerNode(child, context, depth + 1, node.id, ancestorMatched || selfMatches))
    : [];
  const visibleChildResults = childResults.filter((result) => result.include);
  const hasVisibleDescendants = visibleChildResults.length > 0;
  const include = query.length === 0 ? true : selfMatches || hasVisibleDescendants || ancestorMatched;

  if (!include) {
    return { include: false, rows: [], expandedIds: new Set() };
  }

  const expandedIds = new Set();
  const expanded = hasChildren
    ? (query.length > 0 ? ancestorMatched || selfMatches || hasVisibleDescendants : context.expandedIds.has(node.id))
    : false;

  if (expanded) {
    expandedIds.add(node.id);
  }
  visibleChildResults.forEach((result) => {
    result.expandedIds.forEach((id) => expandedIds.add(id));
  });

  const row = {
    id: node.id,
    label: node.label,
    kind: node.kind,
    mode: node.mode ?? null,
    command: node.command ?? null,
    flowId: node.flowId ?? null,
    flowDefaults: node.flowDefaults ?? null,
    depth,
    hasChildren,
    expanded,
    isMatch: query.length > 0 && selfMatches,
    parentId
  };

  return {
    include: true,
    rows: [row, ...(expanded ? visibleChildResults.flatMap((result) => result.rows) : [])],
    expandedIds
  };
}

function flattenLeafActions(nodes, parentTitle) {
  const commands = [];
  nodes.forEach((node) => {
    if (Array.isArray(node.children) && node.children.length > 0) {
      commands.push(...flattenLeafActions(node.children, parentTitle));
      return;
    }
    commands.push({
      value: node.command,
      label: node.label.replace(/^.*?\s/, node.label.includes(" ") ? node.label.split(" ").slice(1).join(" ") : node.label),
      hint: parentTitle
    });
  });
  return commands;
}

export function normalizeRootToken(token) {
  if (typeof token !== "string") {
    return token;
  }
  const trimmed = token.trim();
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    return trimmed.slice(1);
  }
  return trimmed;
}

export function isShellShortcut(input) {
  return SHELL_SHORTCUTS.includes(normalizeRootToken(input));
}

export function tokenizeCommandLine(input) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (const character of String(input ?? "")) {
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

export function splitByWhitespace(input) {
  return String(input ?? "").trim().split(/\s+/).filter((token) => token.length > 0);
}

export function uniqueSorted(items) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

export function getCompletionMatches(pool, current) {
  if (!current) {
    return pool;
  }
  const matches = pool.filter((item) => item.startsWith(current));
  return matches.length > 0 ? matches : pool;
}

export function createCompleter() {
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
        return [children.map((child) => `${prefix} ${child}`), raw];
      }
      const matches = rootCompletions.filter((item) => item.startsWith(token));
      return [matches.length > 0 ? matches : rootCompletions, raw];
    }

    const normalizedRoot = normalizeRootToken(tokens[0]);
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
      return [getCompletionMatches(uniqueSorted([...children, ...rootOptions]), current), raw];
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

export function getCompletionSuggestions(line) {
  const [matches] = createCompleter()(line);
  return Array.isArray(matches) ? matches : [];
}

export function applyCompletionSuggestion(line, suggestion) {
  const raw = String(line ?? "");
  const normalizedSuggestion = String(suggestion ?? "");
  if (!normalizedSuggestion) {
    return raw;
  }

  if (raw.trim().length === 0 || /\s$/.test(raw)) {
    return `${raw}${normalizedSuggestion}`;
  }

  const lastWhitespaceIndex = Math.max(raw.lastIndexOf(" "), raw.lastIndexOf("\t"));
  if (lastWhitespaceIndex < 0) {
    return normalizedSuggestion;
  }
  return `${raw.slice(0, lastWhitespaceIndex + 1)}${normalizedSuggestion}`;
}

export function handleShellAlias(rawLine, activeProfile) {
  const line = String(rawLine ?? "").trim();
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

export function resolveShortcutCommands(shortcut) {
  const normalizedShortcut = normalizeRootToken(shortcut);
  const tree = createShellExplorerTree();

  if (normalizedShortcut === "list" || normalizedShortcut === "skills") {
    const section = tree.find((node) => node.id === "skills");
    return {
      message: "Skills options",
      commands: flattenLeafActions(section?.children ?? [], "skills")
    };
  }
  if (normalizedShortcut === "mcps") {
    const section = tree.find((node) => node.id === "mcps");
    return {
      message: "MCP options",
      commands: flattenLeafActions(section?.children ?? [], "mcps")
    };
  }
  if (normalizedShortcut === "upstreams") {
    const section = tree.find((node) => node.id === "upstreams");
    return {
      message: "Upstream options",
      commands: flattenLeafActions(section?.children ?? [], "upstreams")
    };
  }
  if (normalizedShortcut === "agents") {
    const section = tree.find((node) => node.id === "agents");
    return {
      message: "Agent options",
      commands: flattenLeafActions(section?.children ?? [], "agents")
    };
  }
  if (normalizedShortcut === "profile" || normalizedShortcut === "profiles") {
    const sections = [
      tree.find((node) => node.id === "profiles"),
      tree.find((node) => node.id === "skills"),
      tree.find((node) => node.id === "mcps"),
      tree.find((node) => node.id === "upstreams")
    ];
    return {
      message: "Profile options",
      commands: sections.flatMap((section) => flattenLeafActions(section?.children ?? [], section?.label ?? "profile"))
    };
  }
  if (normalizedShortcut === "search") {
    return {
      message: "Search options",
      commands: [
        { value: "search skills --query ", label: "skills", hint: "prefill a skills search" },
        { value: "search skills --verbose --query ", label: "skills verbose", hint: "prefill a verbose search" }
      ]
    };
  }
  return null;
}

export function createShellExplorerTree() {
  return SHELL_EXPLORER_TREE.map(cloneExplorerNode);
}

export function getShellExplorerDefaultExpandedIds(tree = createShellExplorerTree()) {
  const expandedIds = [];

  function visit(nodes) {
    nodes.forEach((node) => {
      if (node.defaultExpanded) {
        expandedIds.push(node.id);
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        visit(node.children);
      }
    });
  }

  visit(tree);
  return expandedIds;
}

export function flattenShellExplorerTree(tree = createShellExplorerTree(), options = {}) {
  const expandedIds = options.expandedIds instanceof Set
    ? options.expandedIds
    : new Set(Array.isArray(options.expandedIds) ? options.expandedIds : getShellExplorerDefaultExpandedIds(tree));
  const query = String(options.filter ?? "").trim().toLowerCase();

  const results = tree.map((node) => flattenExplorerNode(node, { expandedIds, query }, 0, null, false));
  return {
    rows: results.flatMap((result) => result.rows),
    expandedIds: new Set(results.flatMap((result) => [...result.expandedIds]))
  };
}

export function findShellExplorerShortcutTargetId(shortcut) {
  return SHELL_SHORTCUT_TARGETS[normalizeRootToken(shortcut)] ?? null;
}

export function createShellShortcutSections() {
  return createShellExplorerTree();
}

export function flattenShellShortcutSections(sections = createShellExplorerTree()) {
  return flattenShellExplorerTree(sections).rows;
}

export function createShellHelpLines(activeProfile) {
  const lines = [
    "Interactive shell commands",
    "  Explorer catalog      Browse the interactive skills, MCP, upstream, and agent workflows",
    "  help / :help         Show shell help in the Transcript",
    "  exit / quit / :exit  Exit shell mode",
    "  clear / :clear       Clear the Transcript",
    "  :profile <name>      Set shell profile context",
    "  :profile default     Reset shell profile to current default profile",
    "  :profile none        Disable shell profile context",
    "  skills mcps upstreams agents profiles search  Jump Explorer focus to common groups",
    "",
    "Explorer sections",
    "  Setup, Profiles, Skills, MCPs, Upstreams, Agents",
    "  Guided explorer actions open an in-shell stepper, while ':' stays available",
    "",
    "Shell UI keys",
    "  Tab                  Switch between Explorer and Transcript",
    "  Enter / Right        Expand Explorer branches or run selected actions",
    "  Left                 Collapse Explorer branch or move to parent",
    "  :                    Open the raw command prompt",
    "  /                    Filter the Explorer or search the Transcript",
    "  Space                Start or clear Transcript selection",
    "  y / Ctrl+Y           Copy the current selection or the full Transcript",
    "  Esc                  Close the prompt, clear selection, or exit",
    "  Ctrl+Q               Force exit shell mode",
    "",
    "Tip: use quoted arguments when paths contain spaces."
  ];
  if (activeProfile) {
    lines.push(`Current shell profile context: ${activeProfile}`);
  }
  return lines;
}

export function getShellPromptText(activeProfile) {
  return activeProfile ? `skills-sync(${activeProfile}) > ` : "skills-sync > ";
}

export function getShellFooterHints(context = {}) {
  const activePane = context.activePane ?? "explorer";
  const promptMode = context.promptMode ?? null;
  const guidedKind = context.guidedKind ?? null;
  const hasSelection = context.hasSelection === true;

  if (promptMode === "command") {
    return [
      { key: "Enter", label: "run" },
      { key: "Tab", label: "complete" },
      { key: "Up/Down", label: "history" },
      { key: "Esc", label: "close" }
    ];
  }

  if (promptMode === "filter") {
    return [
      { key: "Enter", label: "apply" },
      { key: "Esc", label: "close" }
    ];
  }

  if (promptMode === "guided") {
    if (guidedKind === "picker") {
      return [
        { key: "Up/Down", label: "choose" },
        { key: "Space", label: "toggle" },
        { key: "Enter", label: "next" },
        { key: "Esc", label: "back" }
      ];
    }
    if (guidedKind === "select" || guidedKind === "review") {
      return [
        { key: "Up/Down", label: "choose" },
        { key: "Enter", label: guidedKind === "review" ? "confirm" : "next" },
        { key: "Esc", label: "back" }
      ];
    }
    return [
      { key: "Enter", label: "next" },
      { key: "Esc", label: "back" },
      { key: "Ctrl+Q", label: "exit" }
    ];
  }

  if (activePane === "transcript") {
    return [
      { key: "Tab", label: "explorer" },
      { key: "Space", label: hasSelection ? "clear selection" : "select" },
      { key: "y", label: "copy" },
      { key: "/", label: "search" },
      { key: "Esc", label: "back" }
    ];
  }

  return [
    { key: "Enter", label: "expand / run" },
    { key: ":", label: "command" },
    { key: "/", label: "filter" },
    { key: "Tab", label: "transcript" },
    { key: "Esc", label: "exit" }
  ];
}

export function injectProfileIfNeeded(tokens, activeProfile) {
  if (!activeProfile || tokens.includes("--profile")) {
    return tokens;
  }
  const normalizedRoot = normalizeRootToken(tokens[0]);
  if (!PROFILE_AWARE_COMMANDS.has(normalizedRoot)) {
    return tokens;
  }
  return [...tokens, "--profile", activeProfile];
}
