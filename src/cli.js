import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { buildProfile } from "./lib/build.js";
import { applyBindings, cmdApply, cmdUnlink } from "./lib/bindings.js";
import { cmdAgentDrift, cmdAgentInventory, cmdListAgents } from "./lib/agents.js";
import { RUNTIME_INTERNAL_ROOT } from "./lib/core.js";
import { cmdDetect } from "./lib/detect.js";
import { cmdDoctor } from "./lib/doctor.js";
import { cmdInit } from "./lib/init.js";
import {
  cmdCurrentProfile,
  cmdListProfiles,
  cmdNewProfile,
  cmdRemoveProfile,
  listAvailableProfiles,
  readDefaultProfile,
  writeDefaultProfile
} from "./lib/config.js";
import {
  canPrompt,
  isPromptCancelledError,
  parseCommaOrWhitespaceList,
  parseEnvEntries,
  promptForSelect,
  promptForText
} from "./lib/prompt-adapter.js";
import {
  buildProfileInventory,
  cmdListEverything,
  cmdListLocalSkills,
  cmdListMcps,
  cmdShowProfileInventory
} from "./lib/inventory.js";
import { cmdProfileExport, cmdProfileImport } from "./lib/profile-transfer.js";
import {
  cmdProfileClone,
  cmdProfileDiff,
  cmdProfileInspect,
  cmdProfileNewSkill,
  cmdProfileRefresh
} from "./lib/profile-extensions.js";
import {
  cmdProfileAddMcp,
  cmdProfileAddSkill,
  cmdProfileRemoveMcp,
  cmdProfileRemoveSkill,
  cmdUpstreamAdd,
  cmdUpstreamRemove
} from "./lib/manage.js";
import {
  cmdListUpstreamContent,
  cmdListUpstreams,
  cmdSearchSkills,
  createUpstreamFromSourceInput,
  loadUpstreamsConfig
} from "./lib/upstreams.js";
import { getProvider } from "./lib/providers/index.js";
import { cmdShell } from "./lib/shell.js";
import { danger, renderSection, renderTable, styleHelpOutput } from "./lib/terminal-ui.js";
import { cmdWorkspaceDiff, cmdWorkspaceExport, cmdWorkspaceImport, cmdWorkspaceSync } from "./lib/workspace-manifest.js";

const VALID_BUILD_LOCK_MODES = new Set(["read", "write", "refresh"]);
const KNOWN_ROOT_COMMANDS = new Set([
  "init",
  "sync",
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
  "detect",
  "shell",
  "workspace",
  "help"
]);

const UNKNOWN_COMMAND_CODE = "skills-sync.unknownCommand";
const COMMANDER_HELP_CODE = "commander.helpDisplayed";
const COMMANDER_HELP_CODE_ALT = "commander.help";
const COMMANDER_VERSION_CODE = "commander.version";

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

function readPackageVersion() {
  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(__filename), "..");
  const packageJsonPath = path.join(packageRoot, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fallback version keeps --version functional even in atypical environments.
  }
  return "0.0.0";
}

function createUnknownCommandError() {
  const error = new Error("Unknown command");
  error.code = UNKNOWN_COMMAND_CODE;
  return error;
}

function writeUnknownCommandError() {
  process.stderr.write("Unknown command. See: help\n");
}

function normalizeRootCommand(rawRoot) {
  if (typeof rawRoot !== "string") {
    return rawRoot;
  }

  const trimmed = rawRoot.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const candidates = [];
  const addCandidate = (value) => {
    const normalized = String(value ?? "").trim();
    if (normalized.length > 0) {
      candidates.push(normalized);
    }
  };

  addCandidate(trimmed);
  if (trimmed.startsWith("/") && trimmed.length > 1) {
    addCandidate(trimmed.slice(1));
  }
  if (/[\\/]/.test(trimmed)) {
    addCandidate(path.win32.basename(trimmed));
    addCandidate(path.posix.basename(trimmed));
  }

  for (const candidate of candidates) {
    if (candidate === "agent") {
      return "agents";
    }
    if (KNOWN_ROOT_COMMANDS.has(candidate)) {
      return candidate;
    }
  }

  return trimmed;
}

function normalizeCliArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return [];
  }
  const [rawRoot, ...rest] = argv;
  return [normalizeRootCommand(rawRoot), ...rest];
}

function preflightUnknownCommandCheck(argv) {
  if (argv.length === 0) {
    return;
  }

  const [root, child] = argv;
  const listChildren = new Set(["skills", "mcps", "upstreams", "profiles", "everything", "upstream-content", "agents"]);
  const searchChildren = new Set(["skills"]);
  const profileChildren = new Set([
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
  ]);
  const agentChildren = new Set(["inventory", "drift"]);
  const upstreamChildren = new Set(["add", "remove"]);
  const workspaceChildren = new Set(["export", "import", "diff", "sync"]);

  if (root.startsWith("-")) {
    return;
  }
  if (!KNOWN_ROOT_COMMANDS.has(root)) {
    throw createUnknownCommandError();
  }
  if (root === "list" && child && !child.startsWith("-") && !listChildren.has(child)) {
    throw createUnknownCommandError();
  }
  if (root === "search" && child && !child.startsWith("-") && !searchChildren.has(child)) {
    throw createUnknownCommandError();
  }
  if (root === "profile" && child && !child.startsWith("-") && !profileChildren.has(child)) {
    throw createUnknownCommandError();
  }
  if (root === "agents" && child && !child.startsWith("-") && !agentChildren.has(child)) {
    throw createUnknownCommandError();
  }
  if (root === "upstream" && child && !child.startsWith("-") && !upstreamChildren.has(child)) {
    throw createUnknownCommandError();
  }
  if (root === "workspace" && child && !child.startsWith("-") && !workspaceChildren.has(child)) {
    throw createUnknownCommandError();
  }
}

function parseFormatOption(rawFormat) {
  const format = (rawFormat || "text").toLowerCase();
  if (format !== "text" && format !== "json") {
    throw new Error("Invalid --format value. Use text or json.");
  }
  return format;
}

function parseDetailOption(rawDetail) {
  const detail = (rawDetail || "concise").toLowerCase();
  if (detail !== "concise" && detail !== "full") {
    throw new Error("Invalid --detail value. Use concise or full.");
  }
  return detail;
}

function collectOptionValues(value, previous) {
  if (Array.isArray(previous)) {
    return [...previous, value];
  }
  return [value];
}

function resolveMcpArgsOption({ args, arg }) {
  const variadicArgs = Array.isArray(args) ? args : [];
  const repeatedArgs = Array.isArray(arg) ? arg : [];
  if (variadicArgs.length > 0 && repeatedArgs.length > 0) {
    throw new Error("Use either --args or repeated --arg, not both.");
  }
  if (repeatedArgs.length > 0) {
    return repeatedArgs;
  }
  return variadicArgs;
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRequiredText(value, label) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

async function resolveRequiredTextOption({
  value,
  label,
  placeholder,
  missingMessage
}) {
  const normalized = normalizeOptionalText(value);
  if (normalized) {
    return normalized;
  }

  if (canPrompt()) {
    const prompted = await promptForText({
      message: label,
      placeholder,
      validate: (inputValue) =>
        normalizeOptionalText(inputValue) ? undefined : `${label} is required.`
    });
    return normalizeRequiredText(prompted, label);
  }

  throw new Error(missingMessage || `${label} is required.`);
}

async function resolveUpstreamIdOption({ value, missingMessage }) {
  const normalized = normalizeOptionalText(value);
  if (normalized) {
    return normalized;
  }

  if (!canPrompt()) {
    throw new Error(missingMessage || "--upstream <id> is required.");
  }

  let upstreams = [];
  try {
    const loaded = await loadUpstreamsConfig();
    upstreams = loaded.config.upstreams
      .map((item) => ({
        id: item.id,
        repo: item.repo
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    upstreams = [];
  }

  if (upstreams.length === 0) {
    throw new Error(
      "No upstreams configured. Add one with 'profile add-upstream --source <locator>' or 'upstream add --source <locator>'."
    );
  }

  const selectedId = await promptForSelect({
    message: "Upstream id",
    options: upstreams.map((item) => ({
      value: item.id,
      label: item.id,
      hint: item.repo
    }))
  });
  return normalizeRequiredText(selectedId, "Upstream id");
}

async function resolveSelectedSkillPaths({
  upstream,
  source,
  provider,
  root,
  ref,
  providedPaths,
  all,
  interactive
}) {
  const normalizedProvided = uniqueValues(providedPaths.map((item) => normalizeOptionalText(item)).filter(Boolean));
  if (normalizedProvided.length > 0 || all !== true && interactive !== true) {
    return normalizedProvided;
  }

  let upstreamDoc = null;
  if (source) {
    upstreamDoc = await createUpstreamFromSourceInput({
      source,
      provider,
      root,
      defaultRef: ref
    });
  } else {
    const loaded = await loadUpstreamsConfig();
    upstreamDoc = loaded.byId.get(upstream);
  }
  if (!upstreamDoc) {
    throw new Error("Could not resolve source for skill selection.");
  }

  const providerImpl = getProvider(upstreamDoc.provider);
  const discovery = await providerImpl.discover(upstreamDoc, {
    ref: ref || upstreamDoc.defaultRef || undefined
  });
  const skillPaths = discovery.skills.map((item) => item.path).sort((left, right) => left.localeCompare(right));
  if (skillPaths.length === 0) {
    throw new Error("No discoverable skills found in the selected source.");
  }
  if (all === true) {
    return skillPaths;
  }
  if (!interactive) {
    return [];
  }

  process.stdout.write(`${renderSection("Discovered Skills", { stream: process.stdout })}\n`);
  process.stdout.write(`${renderTable(["Path"], skillPaths.map((skillPath) => [skillPath]), { stream: process.stdout })}\n`);
  const rawSelection = await promptForText({
    message: "Skill path(s) (comma or space separated, or 'all')",
    placeholder: "frontend-design, spreadsheet",
    validate: (inputValue) => {
      const normalized = normalizeOptionalText(inputValue);
      return normalized ? undefined : "Select at least one skill path.";
    }
  });
  if (rawSelection.trim().toLowerCase() === "all") {
    return skillPaths;
  }
  return uniqueValues(parseCommaOrWhitespaceList(rawSelection).map((item) => normalizeRequiredText(item, "Skill path")));
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function groupImportedSelectionItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const existing = grouped.get(item.upstream) ?? [];
    existing.push(item.selectionPath);
    grouped.set(item.upstream, existing);
  }
  return Array.from(grouped.entries())
    .map(([upstream, skillPaths]) => ({
      upstream,
      skillPaths: sortStrings(uniqueValues(skillPaths))
    }))
    .sort((left, right) => left.upstream.localeCompare(right.upstream));
}

async function confirmProfileMutation({
  message,
  yes = false
}) {
  if (yes === true) {
    return;
  }
  if (!canPrompt()) {
    throw new Error(`${message} Re-run with --yes to confirm.`);
  }
  const selection = await promptForSelect({
    message,
    options: [
      { value: "yes", label: "continue", hint: "perform the requested change" },
      { value: "no", label: "cancel", hint: "abort without changes" }
    ]
  });
  if (selection !== "yes") {
    throw new Error("Operation cancelled.");
  }
}

async function resolveImportedRemovalGroups({
  profile,
  upstream,
  providedPaths,
  all = false,
  interactive = false
}) {
  const normalizedUpstream = normalizeOptionalText(upstream);
  const normalizedProvided = uniqueValues(
    providedPaths.map((item) => normalizeOptionalText(item)).filter(Boolean)
  );
  if (normalizedUpstream && normalizedProvided.length > 0 && all !== true && interactive !== true) {
    return [
      {
        upstream: normalizedUpstream,
        skillPaths: sortStrings(normalizedProvided)
      }
    ];
  }

  const inventory = await buildProfileInventory(profile, { detail: "full" });
  const importedItems = inventory.skills.items.filter(
    (item) => item.sourceType === "imported" && (!normalizedUpstream || item.upstream === normalizedUpstream)
  );
  if (importedItems.length === 0) {
    throw new Error(
      normalizedUpstream
        ? `No imported skills found for profile '${profile}' and upstream '${normalizedUpstream}'.`
        : `No imported skills found for profile '${profile}'.`
    );
  }

  if (all === true) {
    return groupImportedSelectionItems(importedItems);
  }

  let selectors = normalizedProvided;
  if (selectors.length === 0) {
    if (interactive !== true) {
      throw new Error("Provide --upstream with at least one --path, or use --interactive/--all.");
    }
    process.stdout.write(`${renderSection("Imported Skills", { stream: process.stdout })}\n`);
    process.stdout.write(
      `${renderTable(
        ["Selection", "Installed As"],
        importedItems.map((item) => [`${item.upstream}:${item.selectionPath}`, item.name]),
        { stream: process.stdout }
      )}\n`
    );
    const rawSelection = await promptForText({
      message: "Skill path selector(s)",
      placeholder: normalizedUpstream ? "skills/my-skill, prompts/review" : "my-upstream:skills/my-skill",
      validate: (inputValue) =>
        normalizeOptionalText(inputValue) ? undefined : "Select at least one imported skill."
    });
    if (rawSelection.trim().toLowerCase() === "all") {
      return groupImportedSelectionItems(importedItems);
    }
    selectors = uniqueValues(
      parseCommaOrWhitespaceList(rawSelection).map((item) => normalizeRequiredText(item, "Skill path selector"))
    );
  }

  const matchedItems = [];
  for (const selector of selectors) {
    let matches = [];
    if (selector.includes(":")) {
      const [selectorUpstream, ...rest] = selector.split(":");
      const selectorPath = rest.join(":");
      matches = importedItems.filter(
        (item) => item.upstream === selectorUpstream && (item.selectionPath === selectorPath || item.name === selectorPath)
      );
    } else {
      matches = importedItems.filter((item) => item.selectionPath === selector || item.name === selector);
      if (!normalizedUpstream && matches.length > 1) {
        const upstreams = sortStrings(matches.map((item) => item.upstream));
        throw new Error(
          `Ambiguous selector '${selector}'. Use '<upstream>:<path>'. Matches: ${upstreams.join(", ")}.`
        );
      }
    }

    if (matches.length === 0) {
      throw new Error(`No imported skill matched '${selector}'.`);
    }
    matchedItems.push(...matches);
  }

  return groupImportedSelectionItems(matchedItems);
}

async function resolveProfileForBuild(profileName) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (normalizedProfile) {
    return normalizedProfile;
  }

  const defaultProfile = await readDefaultProfile();
  if (defaultProfile) {
    return defaultProfile;
  }

  if (canPrompt()) {
    return resolveRequiredTextOption({
      value: null,
      label: "Profile name",
      placeholder: "personal",
      missingMessage: "--profile is required."
    });
  }

  throw new Error("Profile is required. Set a default profile with 'use <name>'.");
}

async function resolveProfileForAgentDrift(profileName) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (normalizedProfile) {
    return normalizedProfile;
  }

  const defaultProfile = await readDefaultProfile();
  if (defaultProfile) {
    return defaultProfile;
  }

  if (canPrompt()) {
    return resolveRequiredTextOption({
      value: null,
      label: "Profile name",
      placeholder: "personal",
      missingMessage: "--profile is required."
    });
  }

  return null;
}

async function resolveProfileForProfileMutation(profileName, usageHint) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (normalizedProfile) {
    return normalizedProfile;
  }

  const defaultProfile = await readDefaultProfile();
  if (defaultProfile) {
    return defaultProfile;
  }

  if (canPrompt()) {
    return resolveRequiredTextOption({
      value: null,
      label: "Profile name",
      placeholder: "personal",
      missingMessage: `Profile name is required. Usage: ${usageHint}.`
    });
  }

  throw new Error(`Profile name is required. Set one with 'use <name>' or pass it explicitly. Usage: ${usageHint}.`);
}

async function profileExists(profileName) {
  const normalizedProfile = normalizeOptionalText(profileName);
  if (!normalizedProfile) {
    return false;
  }
  const profiles = await listAvailableProfiles();
  return profiles.some((profile) => profile.name === normalizedProfile);
}

async function resolveMcpProfileAndServerArgs({
  profileArg,
  serverArg,
  commandName
}) {
  const normalizedProfileArg = normalizeOptionalText(profileArg);
  const normalizedServerArg = normalizeOptionalText(serverArg);
  const usageWithExplicitProfile = `${commandName} <name> <server>`;
  const usageWithOptionalProfile = `${commandName} [name] <server>`;

  if (normalizedServerArg) {
    return {
      profile: await resolveProfileForProfileMutation(normalizedProfileArg, usageWithOptionalProfile),
      server: normalizedServerArg
    };
  }

  if (normalizedProfileArg) {
    if (await profileExists(normalizedProfileArg)) {
      return {
        profile: normalizedProfileArg,
        server: await resolveRequiredTextOption({
          value: null,
          label: "MCP server name",
          placeholder: "my_server",
          missingMessage: `MCP server name is required. Usage: ${usageWithExplicitProfile}.`
        })
      };
    }

    return {
      profile: await resolveProfileForProfileMutation(null, usageWithOptionalProfile),
      server: normalizedProfileArg
    };
  }

  return {
    profile: await resolveProfileForProfileMutation(null, usageWithOptionalProfile),
    server: await resolveRequiredTextOption({
      value: null,
      label: "MCP server name",
      placeholder: "my_server",
      missingMessage: `MCP server name is required. Usage: ${usageWithOptionalProfile}.`
    })
  };
}

async function promptForMissingMcpTransportSettings({
  command,
  url,
  args,
  env
}) {
  const normalizedCommand = normalizeOptionalText(command);
  const normalizedUrl = normalizeOptionalText(url);
  if (normalizedCommand || normalizedUrl) {
    return {
      command: normalizedCommand,
      url: normalizedUrl,
      args,
      env
    };
  }

  if (!canPrompt()) {
    return {
      command: normalizedCommand,
      url: normalizedUrl,
      args,
      env
    };
  }

  const transport = await promptForSelect({
    message: "MCP transport",
    options: [
      {
        value: "stdio",
        label: "stdio command",
        hint: "command + optional args/env"
      },
      {
        value: "http",
        label: "http endpoint",
        hint: "URL only"
      }
    ]
  });

  if (transport === "http") {
    const promptedUrl = await promptForText({
      message: "MCP server URL",
      placeholder: "https://example.com/mcp",
      validate: (inputValue) =>
        normalizeOptionalText(inputValue) ? undefined : "MCP server URL is required."
    });
    return {
      command: null,
      url: normalizeRequiredText(promptedUrl, "MCP server URL"),
      args: [],
      env: []
    };
  }

  const promptedCommand = await promptForText({
    message: "MCP server command",
    placeholder: "node",
    validate: (inputValue) =>
      normalizeOptionalText(inputValue) ? undefined : "MCP server command is required."
  });
  const argsInput = await promptForText({
    message: "Command args (optional)",
    placeholder: "--flag value, --another"
  });
  const envInput = await promptForText({
    message: "Env entries KEY=VALUE (optional)",
    placeholder: "API_KEY=abc, MODE=dev"
  });

  return {
    command: normalizeRequiredText(promptedCommand, "MCP server command"),
    url: null,
    args: parseCommaOrWhitespaceList(argsInput),
    env: parseEnvEntries(envInput)
  };
}

async function cmdBuild(profileName, lockModeRaw) {
  const lockMode = (lockModeRaw || "write").toLowerCase();
  if (!VALID_BUILD_LOCK_MODES.has(lockMode)) {
    throw new Error("Invalid --lock value. Use read, write, or refresh.");
  }
  const resolvedProfile = await resolveProfileForBuild(profileName);
  await buildProfile(resolvedProfile, { lockMode });
}

async function readRuntimeBundleProfile() {
  const bundlePath = path.join(RUNTIME_INTERNAL_ROOT, "common", "bundle.json");
  if (!(await fs.pathExists(bundlePath))) {
    return null;
  }
  try {
    const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
    return normalizeOptionalText(bundle?.profile);
  } catch {
    return null;
  }
}

async function runSyncApplyFlow(profileName, { build = true, dryRun = false, agents = null } = {}) {
  let resolvedProfile = normalizeOptionalText(profileName) ?? await readDefaultProfile();
  if (build) {
    if (!resolvedProfile) {
      resolvedProfile = await resolveRequiredTextOption({
        value: null,
        label: "Profile name",
        placeholder: "personal",
        missingMessage: "An active profile is required. Set one with 'use <name>'."
      });
    }
    await buildProfile(resolvedProfile, { lockMode: "write", suggestNextStep: false });
  }

  const gateProfile = resolvedProfile ?? await readRuntimeBundleProfile();
  const applyProfile = resolvedProfile ?? gateProfile;
  if (dryRun) {
    return applyBindings(applyProfile, {
      dryRun: true,
      agents
    });
  }
  return cmdApply(applyProfile, { agents });
}

async function cmdSync(profileName, options = {}) {
  const resolvedProfile = await resolveProfileForBuild(profileName);
  return runSyncApplyFlow(resolvedProfile, {
    build: true,
    dryRun: options.dryRun === true,
    agents: options.agents
  });
}

async function cmdApplyWithOptionalBuild(profileName, shouldBuild, options = {}) {
  const normalizedProfile = normalizeOptionalText(profileName);
  await runSyncApplyFlow(normalizedProfile, {
    build: shouldBuild,
    dryRun: options.dryRun === true,
    agents: options.agents
  });
}

async function runPostMutationSync(profileName, options = {}) {
  const { noSync = false, build = false, apply = false } = options;
  if (noSync === true) {
    if (apply === true) {
      await runSyncApplyFlow(profileName, { build: true });
      return;
    }
    if (build === true) {
      await buildProfile(profileName, { lockMode: "write", suggestNextStep: false });
    }
    return;
  }
  await runSyncApplyFlow(profileName, { build: true });
}

function createProgram() {
  const program = new Command();
  program
    .name("skills-sync")
    .description("Profile-scoped skills + MCP sync for multiple AI agents.")
    .version(readPackageVersion())
    .exitOverride()
    .configureOutput({
      writeOut: (str) => process.stdout.write(styleHelpOutput(str, process.stdout)),
      writeErr: (str) => process.stderr.write(styleHelpOutput(str, process.stderr)),
      outputError: () => {}
    });
  program.addHelpText(
    "after",
    [
      "",
      "Typical workflow:",
      "  1. Edit or add skills/MCPs",
      "  2. Run:",
      "",
      "     skills-sync sync",
      "",
      "Preview changes without modifying agents:",
      "",
      "  skills-sync sync --dry-run",
      "",
      "Profile mutations sync automatically unless you pass --no-sync."
    ].join("\n")
  );

  program
    .command("init")
    .description("Initialize local workspace state (non-destructive). Use --seed to replace with seed content.")
    .option("--seed", "replace local workspace with bundled seed content")
    .option("--dry-run", "show planned init changes without mutating filesystem")
    .option("--profile <name>", "profile name to scaffold and set as default (default: personal)")
    .action((options) =>
      cmdInit({
        seed: options.seed === true,
        dryRun: options.dryRun === true,
        profile: options.profile
      }));

  program
    .command("sync")
    .description("Recommended: prepare runtime artifacts and sync them to agent targets.")
    .option("--profile <name>", "profile name (falls back to default profile)")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--dry-run", "prepare runtime artifacts and preview sync changes without modifying agents")
    .action((options) =>
      cmdSync(options.profile, {
        dryRun: options.dryRun === true,
        agents: options.agents
      }));

  program
    .command("build", { hidden: true })
    .description("Advanced: build deterministic runtime artifacts from a profile.")
    .option("--profile <name>", "profile name (falls back to default profile)")
    .option("--lock <mode>", "lock mode: read|write|refresh", "write")
    .action((options) => cmdBuild(options.profile, options.lock));

  program
    .command("apply", { hidden: true })
    .description("Advanced: bind prebuilt runtime artifacts to tool target paths.")
    .option("--profile <name>", "profile name (optional; defaults to runtime bundle profile)")
    .option("--build", "run build before applying")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--dry-run", "show planned changes without mutating filesystem")
    .action((options) =>
      cmdApplyWithOptionalBuild(options.profile, options.build === true, {
        dryRun: options.dryRun === true,
        agents: options.agents
      }));

  program
    .command("unlink")
    .description("Remove managed runtime bindings using the state file.")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--dry-run", "show what unlink would remove without mutating filesystem")
    .action((options) => cmdUnlink({ dryRun: options.dryRun === true, agents: options.agents }));

  program
    .command("doctor")
    .description("Validate manifests, state, upstream pins, and materialized runtime artifacts.")
    .option(
      "--profile <name>",
      "profile name for source/upstream validation (falls back to default profile)"
    )
    .action(async (options) => cmdDoctor(options.profile ?? await readDefaultProfile()));

  program
    .command("detect")
    .description("Detect agent support and installation status.")
    .option("--format <format>", "output format: text|json", "text")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .action((options) => {
      const format = (options.format || "text").toLowerCase();
      if (format !== "text" && format !== "json") {
        throw new Error("Invalid --format value. Use text or json.");
      }
      return cmdDetect({ format, agents: options.agents });
    });

  const listCommand = program.command("list").description("List available resources.");
  listCommand
    .command("skills")
    .description("List effective skills (local + imported) for the active/default profile.")
    .option("--profile <name>", "profile name (defaults to active/default profile)")
    .option("--detail <detail>", "detail level: concise|full", "concise")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      const detail = parseDetailOption(options.detail);
      return cmdListLocalSkills({
        profile: options.profile,
        format,
        detail,
        agents: options.agents
      });
    });
  listCommand
    .command("mcps")
    .description("List MCP servers for the active/default profile.")
    .option("--profile <name>", "profile name (defaults to active/default profile)")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListMcps({
        profile: options.profile,
        format
      });
    });
  listCommand
    .command("upstreams")
    .description("List configured upstream repositories.")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListUpstreams({ format });
    });
  listCommand
    .command("profiles")
    .description("List all profiles discovered in local workspace and seed.")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListProfiles({ format });
    });
  listCommand
    .command("everything")
    .description("List all profiles with their effective skills and MCP servers.")
    .option("--detail <detail>", "detail level: concise|full", "concise")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      const detail = parseDetailOption(options.detail);
      return cmdListEverything({ format, detail });
    });
  listCommand
    .command("agents")
    .description("List locally detected agents.")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListAgents({ format, agents: options.agents });
    });
  listCommand
    .command("upstream-content")
    .description("List skills and discoverable MCP server manifests available in upstream repository refs.")
    .option("--upstream <id>", "upstream id (optional; defaults to all configured upstreams)")
    .option("--source <locator>", "ad hoc source locator (GitHub shorthand/url, git url, or local path)")
    .option("--provider <provider>", "provider: auto|git|local-path", "auto")
    .option("--root <path>", "optional source root/subdirectory")
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--verbose", "include skill titles (slower; reads SKILL.md contents)")
    .option("--versbose", "alias for --verbose")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListUpstreamContent({
        upstream: options.upstream,
        source: options.source,
        provider: options.provider,
        root: options.root,
        ref: options.ref,
        profile: options.profile,
        format,
        verbose: options.verbose === true || options.versbose === true
      });
    });

  program
    .command("use [name]")
    .description("Set the default profile; auto-scaffolds an empty local profile if missing.")
    .action(async (name) => {
      const resolvedName = normalizeOptionalText(name) || "personal";
      return writeDefaultProfile(resolvedName);
    });

  program
    .command("current")
    .description("Print the current default profile name.")
    .action(() => cmdCurrentProfile());

  program
    .command("ls")
    .description("List all available profiles, marking the current default with ->.")
    .action(() => cmdListProfiles());

  async function runUpstreamAddAction(id, options) {
    const source = normalizeOptionalText(options.source) ?? normalizeOptionalText(options.repo);
    return cmdUpstreamAdd({
      id: normalizeOptionalText(id),
      repo: normalizeOptionalText(options.repo),
      source: await resolveRequiredTextOption({
        value: source,
        label: "Source locator",
        placeholder: "owner/repo or https://github.com/org/repo.git",
        missingMessage: "--source <locator> or --repo <url> is required."
      }),
      defaultRef: options.defaultRef,
      type: options.type,
      provider: options.provider,
      root: options.root
    });
  }

  async function runUpstreamRemoveAction(id) {
    return cmdUpstreamRemove({
      id: await resolveRequiredTextOption({
        value: id,
        label: "Upstream id",
        placeholder: "my-upstream",
        missingMessage: "Upstream id is required. Usage: upstream remove <id>."
      })
    });
  }

  const profileCommand = program.command("profile").description("Inspect and modify profile-level skill/MCP/upstream configuration.");
  profileCommand
    .command("inspect [name]")
    .description("Inspect imported skill provenance, freshness, and capability tolerance for a profile.")
    .option("--format <format>", "output format: text|json", "text")
    .action(async (name, options) =>
      cmdProfileInspect({
        profile: await resolveProfileForProfileMutation(name, "profile inspect [name]"),
        format: parseFormatOption(options.format)
      }));
  profileCommand
    .command("refresh [name]")
    .description("Refresh imported skills for a profile.")
    .option("--upstream <id>", "limit refresh to a single upstream")
    .option("--path <repoPath>", "imported skill selection path", collectOptionValues, [])
    .option("--all", "refresh all imported skills")
    .addOption(new Option("--build", "internal: with --no-sync, update runtime artifacts after refresh").hideHelp())
    .addOption(new Option("--apply", "internal: with --no-sync, update agent targets after refresh").hideHelp())
    .option("--no-sync", "skip the automatic sync after refresh")
    .option("--dry-run", "show refresh results without writing lock state")
    .option("--format <format>", "output format: text|json", "text")
    .action(async (name, options) => {
      const profile = await resolveProfileForProfileMutation(name, "profile refresh [name]");
      await cmdProfileRefresh({
        profile,
        upstream: normalizeOptionalText(options.upstream),
        skillPaths: Array.isArray(options.path) ? options.path : [],
        all: options.all === true,
        build: false,
        apply: false,
        dryRun: options.dryRun === true,
        format: parseFormatOption(options.format)
      });
      if (options.dryRun !== true) {
        await runPostMutationSync(profile, {
          noSync: options.sync === false,
          build: options.build === true,
          apply: options.apply === true
        });
      }
    });
  profileCommand
    .command("show [name]")
    .description("Show skills and MCP servers for a profile (defaults to current profile).")
    .option("--detail <detail>", "detail level: concise|full", "concise")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--format <format>", "output format: text|json", "text")
    .action((name, options) => {
      const format = parseFormatOption(options.format);
      const detail = parseDetailOption(options.detail);
      return cmdShowProfileInventory({
        profile: name,
        format,
        detail,
        agents: options.agents
      });
    });
  profileCommand
    .command("add-skill [name]")
    .description("Attach imported skills from an upstream or source to a profile.")
    .option("--upstream <id>", "upstream id")
    .option("--upstream-id <id>", "preferred upstream id when auto-registering from --source")
    .option("--source <locator>", "source locator (GitHub shorthand/url, git url, or local path)")
    .option("--provider <provider>", "provider: auto|git|local-path", "auto")
    .option("--root <path>", "optional source root/subdirectory")
    .option("--path <repoPath>", "upstream repository path, e.g. skills/my-skill", collectOptionValues, [])
    .option("--all", "attach all discoverable skills from the source")
    .option("--interactive", "discover source skills and prompt for selection")
    .option("--ref <ref>", "ref/branch/tag (defaults to upstream defaultRef)")
    .option("--pin", "track the import as pinned instead of floating")
    .option("--dest-prefix <prefix>", "destination prefix in bundled skills tree")
    .addOption(new Option("--build", "internal: with --no-sync, update runtime artifacts after attaching the skill").hideHelp())
    .addOption(new Option("--apply", "internal: with --no-sync, update agent targets after attaching the skill").hideHelp())
    .option("--no-sync", "skip the automatic sync after attaching the skill")
    .action(async (name, options) => {
      const profile = await resolveProfileForProfileMutation(name, "profile add-skill [name]");
      const upstream = normalizeOptionalText(options.upstream);
      const source = normalizeOptionalText(options.source);
      const resolvedUpstream = source
        ? upstream
        : await resolveUpstreamIdOption({
            value: upstream,
            missingMessage: "--upstream <id> or --source <locator> is required."
          });
      const skillPaths = await resolveSelectedSkillPaths({
        upstream: resolvedUpstream,
        source,
        provider: options.provider,
        root: options.root,
        ref: options.ref,
        providedPaths: Array.isArray(options.path) ? options.path : [],
        all: options.all === true,
        interactive: options.interactive === true
      });

      await cmdProfileAddSkill({
        profile,
        upstream: resolvedUpstream,
        source,
        provider: options.provider,
        root: options.root,
        upstreamId: options.upstreamId,
        skillPaths,
        all: options.all === true,
        ref: options.ref,
        pin: options.pin === true,
        destPrefix: options.destPrefix,
        build: false,
        apply: false
      });
      await runPostMutationSync(profile, {
        noSync: options.sync === false,
        build: options.build === true,
        apply: options.apply === true
      });
    });
  profileCommand
    .command("remove-skill [name]")
    .description("Remove imported skill attachments from a profile.")
    .option("--upstream <id>", "upstream id")
    .option("--path <repoPath>", "upstream repository path, e.g. skills/my-skill", collectOptionValues, [])
    .option("--all", "remove all imported skills for the selected upstream or profile")
    .option("--interactive", "prompt for imported skills to remove")
    .option("--ref <ref>", "optional ref filter")
    .option("--dest-prefix <prefix>", "optional destination prefix filter")
    .option("--prune-upstream", "remove an upstream registration if nothing else references it")
    .addOption(new Option("--build", "internal: with --no-sync, update runtime artifacts after removing the skill").hideHelp())
    .addOption(new Option("--apply", "internal: with --no-sync, update agent targets after removing the skill").hideHelp())
    .option("--no-sync", "skip the automatic sync after removing the skill")
    .option("--yes", "skip the confirmation prompt")
    .action(async (name, options) => {
      const profile = await resolveProfileForProfileMutation(name, "profile remove-skill [name]");
      const groups = await resolveImportedRemovalGroups({
        profile,
        upstream: options.upstream,
        providedPaths: Array.isArray(options.path) ? options.path : [],
        all: options.all === true,
        interactive: options.interactive === true
      });

      await confirmProfileMutation({
        message: `Remove ${groups.reduce((count, entry) => count + entry.skillPaths.length, 0)} imported skill entr${
          groups.reduce((count, entry) => count + entry.skillPaths.length, 0) === 1 ? "y" : "ies"
        } from profile '${profile}'?`,
        yes: options.yes === true
      });

      for (const group of groups) {
        await cmdProfileRemoveSkill({
          profile,
          upstream: group.upstream,
          skillPaths: group.skillPaths,
          ref: options.ref,
          destPrefix: options.destPrefix,
          pruneUpstream: options.pruneUpstream === true,
          build: false,
          apply: false
        });
      }

      await runPostMutationSync(profile, {
        noSync: options.sync === false,
        build: options.build === true,
        apply: options.apply === true
      });
    });
  profileCommand
    .command("new-skill <skillName>")
    .description("Scaffold a new skill directory for a profile without re-initializing the workspace.")
    .option("--profile <name>", "profile name (defaults to current profile)")
    .option("--path <path>", "optional explicit target directory")
    .option("--frontmatter", "include a frontmatter template in SKILL.md")
    .option("--include-scripts", "create a scripts/ placeholder directory")
    .option("--include-references", "create a references/ placeholder directory")
    .action(async (skillName, options) =>
      cmdProfileNewSkill({
        profile: await resolveProfileForProfileMutation(options.profile, "profile new-skill <skillName>"),
        name: skillName,
        skillPath: options.path,
        frontmatter: options.frontmatter === true,
        includeScripts: options.includeScripts === true,
        includeReferences: options.includeReferences === true
      }));
  profileCommand
    .command("add-mcp [name] [server]")
    .description("Add or update an MCP server in a profile (defaults to current profile when omitted).")
    .option("--command <command>", "server command executable (stdio transport)")
    .option("--url <url>", "server URL (HTTP transport)")
    .option("--args <values...>", "optional command args")
    .option(
      "--arg <value>",
      "single command arg (repeat to include values that start with '-')",
      collectOptionValues,
      []
    )
    .option("--env <entries...>", "optional env vars as KEY=VALUE entries")
    .option("--no-sync", "skip the automatic sync after adding or updating the MCP server")
    .action(async (name, server, options) => {
      const resolved = await resolveMcpProfileAndServerArgs({
        profileArg: name,
        serverArg: server,
        commandName: "profile add-mcp"
      });
      const resolvedArgs = resolveMcpArgsOption({ args: options.args, arg: options.arg });
      const resolvedTransport = await promptForMissingMcpTransportSettings({
        command: options.command,
        url: options.url,
        args: resolvedArgs,
        env: options.env
      });
      await cmdProfileAddMcp({
        profile: resolved.profile,
        name: resolved.server,
        command: resolvedTransport.command,
        url: resolvedTransport.url,
        args: resolvedTransport.args,
        env: resolvedTransport.env
      });
      await runPostMutationSync(resolved.profile, {
        noSync: options.sync === false
      });
    });
  profileCommand
    .command("remove-mcp [name] [server]")
    .description("Remove an MCP server from a profile (defaults to current profile when omitted).")
    .option("--no-sync", "skip the automatic sync after removing the MCP server")
    .action(async (name, server, options) => {
      const resolved = await resolveMcpProfileAndServerArgs({
        profileArg: name,
        serverArg: server,
        commandName: "profile remove-mcp"
      });
      await cmdProfileRemoveMcp({
        profile: resolved.profile,
        name: resolved.server
      });
      await runPostMutationSync(resolved.profile, {
        noSync: options.sync === false
      });
    });
  profileCommand
    .command("diff <left> <right>")
    .description("Compare the effective skills and MCP servers of two profiles.")
    .option("--format <format>", "output format: text|json", "text")
    .action((left, right, options) =>
      cmdProfileDiff({
        left,
        right,
        format: parseFormatOption(options.format)
      }));
  profileCommand
    .command("clone <source> <target>")
    .description("Clone a profile definition and its local pack into a new profile.")
    .action((source, target) =>
      cmdProfileClone({
        source,
        target
      }));
  profileCommand
    .command("export [name]")
    .description("Export a profile's config (pack manifest, sources, MCP, and local skills) to JSON.")
    .option("--output <path>", "optional output path (defaults to stdout)")
    .action((name, options) =>
      cmdProfileExport({
        profile: name,
        output: options.output
      }));
  profileCommand
    .command("import [name]")
    .description("Import profile config JSON.")
    .option("--input <path>", "path to exported profile JSON")
    .option("--replace", "overwrite existing local profile files if present")
    .option("--no-sync", "skip the automatic sync after importing the profile")
    .action(async (name, options) => {
      const profile = await resolveRequiredTextOption({
        value: name,
        label: "Profile name",
        placeholder: "imported-profile",
        missingMessage: "Profile name is required. Usage: profile import <name>."
      });
      await cmdProfileImport({
        profile,
        input: await resolveRequiredTextOption({
          value: options.input,
          label: "Import file path",
          placeholder: "profile-export.json",
          missingMessage: "--input <path> is required."
        }),
        replace: options.replace === true
      });
      await runPostMutationSync(profile, {
        noSync: options.sync === false
      });
    });
  profileCommand
    .command("add-upstream [id]")
    .description("Register an external source as an upstream (profile workflow alias).")
    .option("--source <locator>", "source locator (GitHub shorthand/url, git url, or local path)")
    .option("--repo <url>", "git repository URL")
    .option("--provider <provider>", "provider: auto|git|local-path", "auto")
    .option("--root <path>", "optional source root/subdirectory")
    .option("--default-ref <ref>", "default ref/branch/tag (auto-detected when omitted)")
    .option("--type <type>", "upstream type (currently only git)", "git")
    .action(runUpstreamAddAction);
  profileCommand
    .command("remove-upstream [id]")
    .description("Remove an upstream repository (profile workflow alias).")
    .action(runUpstreamRemoveAction);

  function registerAgentsSubcommands(agentCommand) {
    agentCommand
    .command("inventory")
    .description("Inspect installed skills and MCP servers per detected agent.")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdAgentInventory({
        format,
        agents: options.agents
      });
    });
    agentCommand
    .command("drift")
    .description("Check or reconcile drift between profile-expected config and detected agent installs.")
    .option("--profile <name>", "profile name (falls back to default profile)")
    .option("--agents <agents>", "optional comma-separated agent filter, e.g. codex,claude")
    .option("--dry-run", "report drift only without mutating files")
    .option("--format <format>", "output format: text|json", "text")
    .action(async (options) => {
      const format = parseFormatOption(options.format);
      const profile = await resolveProfileForAgentDrift(options.profile);
      return cmdAgentDrift({
        profile,
        dryRun: options.dryRun === true,
        format,
        agents: options.agents
      });
    });
  }

  const agentsCommand = program.command("agents").description("Inspect detected agent installs and profile drift.");
  registerAgentsSubcommands(agentsCommand);

  const upstreamCommand = program.command("upstream").description("Manage configured upstream repositories.");
  upstreamCommand
    .command("add [id]")
    .description("Add an upstream source (id auto-inferred from --source/--repo when omitted).")
    .option("--source <locator>", "source locator (GitHub shorthand/url, git url, or local path)")
    .option("--repo <url>", "git repository URL")
    .option("--provider <provider>", "provider: auto|git|local-path", "auto")
    .option("--root <path>", "optional source root/subdirectory")
    .option("--default-ref <ref>", "default ref/branch/tag (auto-detected when omitted)")
    .option("--type <type>", "upstream type (currently only git)", "git")
    .action(runUpstreamAddAction);
  upstreamCommand
    .command("remove [id]")
    .description("Remove an upstream repository.")
    .action(runUpstreamRemoveAction);

  program
    .command("new [name]")
    .description("Scaffold a new profile and pack.")
    .action(async (name) => cmdNewProfile(normalizeOptionalText(name) || "personal"));

  program
    .command("remove [name]")
    .description("Delete a profile definition (pack is preserved).")
    .action(async (name) =>
      cmdRemoveProfile(await resolveRequiredTextOption({
        value: name,
        label: "Profile name",
        placeholder: "my-profile",
        missingMessage: "Profile name is required. Usage: remove <name>."
      })));

  const searchCommand = program.command("search").description("Search available resources.");
  searchCommand
    .command("skills")
    .description("Search installed skills, discoverable upstream skills, or both.")
    .option("--query <text>", "search term")
    .option("--upstream <id>", "upstream id (optional; defaults to all configured upstreams)")
    .option("--source <locator>", "ad hoc source locator (GitHub shorthand/url, git url, or local path)")
    .option("--provider <provider>", "provider: auto|git|local-path", "auto")
    .option("--root <path>", "optional source root/subdirectory")
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--scope <scope>", "search scope: installed|discoverable|all", "discoverable")
    .option("--verbose", "include title metadata and title matching (slower)")
    .option("--versbose", "alias for --verbose")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdSearchSkills({
        upstream: options.upstream,
        source: options.source,
        provider: options.provider,
        root: options.root,
        ref: options.ref,
        profile: options.profile,
        query: options.query,
        scope: options.scope,
        format,
        verbose: options.verbose === true || options.versbose === true
      });
    });

  const workspaceCommand = program.command("workspace").description("Manage full workspace manifests.");
  workspaceCommand
    .command("export")
    .description("Export the current workspace state to a manifest file.")
    .option("--output <path>", "output path (defaults to workspace/skills-sync.manifest.json)")
    .action((options) =>
      cmdWorkspaceExport({
        output: options.output
      }));
  workspaceCommand
    .command("import")
    .description("Import workspace state from a manifest file.")
    .option("--input <path>", "manifest path (defaults to workspace/skills-sync.manifest.json)")
    .option("--replace", "replace existing local profiles when conflicts are found")
    .action((options) =>
      cmdWorkspaceImport({
        input: options.input,
        replace: options.replace === true
      }));
  workspaceCommand
    .command("diff")
    .description("Compare a manifest file to the current live workspace state.")
    .option("--input <path>", "manifest path (defaults to workspace/skills-sync.manifest.json)")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) =>
      cmdWorkspaceDiff({
        input: options.input,
        format: parseFormatOption(options.format)
      }));
  workspaceCommand
    .command("sync")
    .description("Reconcile the live workspace to a manifest file.")
    .option("--input <path>", "manifest path (defaults to workspace/skills-sync.manifest.json)")
    .option("--dry-run", "show drift without importing the manifest")
    .action((options) =>
      cmdWorkspaceSync({
        input: options.input,
        dryRun: options.dryRun === true
      }));

  program
    .command("shell")
    .description("Launch interactive shell mode with command completion and colorized prompts.")
    .option("--profile <name>", "optional shell profile context for sync/doctor commands")
    .action((options) =>
      cmdShell({
        profile: options.profile,
        executeCommand: (commandArgs) => runCli(commandArgs)
      }));

  program.command("help").description("Show help.").action(() => program.outputHelp());
  return program;
}

export async function runCli(argv = process.argv.slice(2)) {
  const normalizedArgv = normalizeCliArgv(argv);

  if (normalizedArgv.length === 0) {
    await cmdShell({
      executeCommand: (commandArgs) => runCli(commandArgs)
    });
    return 0;
  }

  try {
    preflightUnknownCommandCheck(normalizedArgv);
    const program = createProgram();
    await program.parseAsync(["node", "skills-sync", ...normalizedArgv]);
    return 0;
  } catch (error) {
    if (
      error?.code === COMMANDER_HELP_CODE ||
      error?.code === COMMANDER_HELP_CODE_ALT ||
      error?.message === "(outputHelp)" ||
      error?.code === COMMANDER_VERSION_CODE
    ) {
      return 0;
    }
    if (error?.code === UNKNOWN_COMMAND_CODE || error?.code === "commander.unknownOption" || error?.code === "commander.unknownCommand") {
      writeUnknownCommandError();
      return 2;
    }
    if (isPromptCancelledError(error)) {
      process.stderr.write("Prompt cancelled.\n");
      return 130;
    }
    process.stderr.write(`${danger("[skills-sync] ERROR:", process.stderr)} ${redactPathDetails(error.message)}\n`);
    return 1;
  }
}
