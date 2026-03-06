import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { buildProfile } from "./lib/build.js";
import { cmdApply, cmdUnlink } from "./lib/bindings.js";
import { cmdAgentDrift, cmdAgentInventory, cmdListAgents } from "./lib/agents.js";
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
import { cmdListEverything, cmdListLocalSkills, cmdListMcps, cmdShowProfileInventory } from "./lib/inventory.js";
import { cmdProfileExport, cmdProfileImport } from "./lib/profile-transfer.js";
import {
  cmdProfileAddMcp,
  cmdProfileAddSkill,
  cmdProfileRemoveMcp,
  cmdProfileRemoveSkill,
  cmdUpstreamAdd,
  cmdUpstreamRemove
} from "./lib/manage.js";
import { cmdListUpstreamContent, cmdListUpstreams, cmdSearchSkills, loadUpstreamsConfig } from "./lib/upstreams.js";
import { cmdShell } from "./lib/shell.js";
import { danger, styleHelpOutput } from "./lib/terminal-ui.js";

const VALID_BUILD_LOCK_MODES = new Set(["read", "write", "refresh"]);
const KNOWN_ROOT_COMMANDS = new Set([
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
  "detect",
  "shell",
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
}

function parseFormatOption(rawFormat) {
  const format = (rawFormat || "text").toLowerCase();
  if (format !== "text" && format !== "json") {
    throw new Error("Invalid --format value. Use text or json.");
  }
  return format;
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
      "No upstreams configured. Add one with 'profile add-upstream --repo <url>' or 'upstream add --repo <url>'."
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

async function cmdApplyWithOptionalBuild(profileName, shouldBuild, options = {}) {
  const normalizedProfile = normalizeOptionalText(profileName);
  let resolvedProfile = normalizedProfile ?? await readDefaultProfile();
  if (shouldBuild) {
    if (!resolvedProfile) {
      resolvedProfile = await resolveRequiredTextOption({
        value: null,
        label: "Profile name",
        placeholder: "personal",
        missingMessage: "apply --build requires an active profile. Set one with 'use <name>'."
      });
    }
    await buildProfile(resolvedProfile, { lockMode: "write", suggestNextStep: false });
  }
  await cmdApply(resolvedProfile, { dryRun: options.dryRun === true });
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
    .command("build")
    .description("Build deterministic runtime artifacts from a profile.")
    .option("--profile <name>", "profile name (falls back to default profile)")
    .option("--lock <mode>", "lock mode: read|write|refresh", "write")
    .action((options) => cmdBuild(options.profile, options.lock));

  program
    .command("apply")
    .description("Bind prebuilt runtime artifacts to tool target paths.")
    .option("--profile <name>", "profile name (optional; defaults to runtime bundle profile)")
    .option("--build", "run build before applying")
    .option("--dry-run", "show planned changes without mutating filesystem")
    .action((options) => cmdApplyWithOptionalBuild(options.profile, options.build === true, { dryRun: options.dryRun === true }));

  program
    .command("unlink")
    .description("Remove bindings created by apply using state file.")
    .option("--dry-run", "show what unlink would remove without mutating filesystem")
    .action((options) => cmdUnlink({ dryRun: options.dryRun === true }));

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
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListLocalSkills({
        profile: options.profile,
        format
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
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListEverything({ format });
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
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--verbose", "include skill titles (slower; reads SKILL.md contents)")
    .option("--versbose", "alias for --verbose")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdListUpstreamContent({
        upstream: options.upstream,
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
    return cmdUpstreamAdd({
      id: normalizeOptionalText(id),
      repo: await resolveRequiredTextOption({
        value: options.repo,
        label: "Git repository URL",
        placeholder: "https://github.com/org/repo.git",
        missingMessage: "--repo <url> is required."
      }),
      defaultRef: options.defaultRef,
      type: options.type
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
    .command("show [name]")
    .description("Show skills and MCP servers for a profile (defaults to current profile).")
    .option("--format <format>", "output format: text|json", "text")
    .action((name, options) => {
      const format = parseFormatOption(options.format);
      return cmdShowProfileInventory({
        profile: name,
        format
      });
    });
  profileCommand
    .command("add-skill [name]")
    .description("Add an upstream skill import to a profile (defaults to current profile).")
    .option("--upstream <id>", "upstream id")
    .option("--path <repoPath>", "upstream repository path, e.g. skills/my-skill")
    .option("--ref <ref>", "ref/branch/tag (defaults to upstream defaultRef)")
    .option("--dest-prefix <prefix>", "destination prefix in bundled skills tree")
    .action(async (name, options) =>
      cmdProfileAddSkill({
        profile: await resolveProfileForProfileMutation(name, "profile add-skill <name>"),
        upstream: await resolveUpstreamIdOption({
          value: options.upstream,
          missingMessage: "--upstream <id> is required."
        }),
        skillPath: await resolveRequiredTextOption({
          value: options.path,
          label: "Skill path",
          placeholder: "skills/my-skill",
          missingMessage: "--path <repoPath> is required."
        }),
        ref: options.ref,
        destPrefix: options.destPrefix
      }));
  profileCommand
    .command("remove-skill [name]")
    .description("Remove skill import path(s) from a profile.")
    .option("--upstream <id>", "upstream id")
    .option("--path <repoPath>", "upstream repository path, e.g. skills/my-skill")
    .option("--ref <ref>", "optional ref filter")
    .option("--dest-prefix <prefix>", "optional destination prefix filter")
    .action(async (name, options) =>
      cmdProfileRemoveSkill({
        profile: await resolveRequiredTextOption({
          value: name,
          label: "Profile name",
          placeholder: "personal",
          missingMessage: "Profile name is required. Usage: profile remove-skill <name>."
        }),
        upstream: await resolveUpstreamIdOption({
          value: options.upstream,
          missingMessage: "--upstream <id> is required."
        }),
        skillPath: await resolveRequiredTextOption({
          value: options.path,
          label: "Skill path",
          placeholder: "skills/my-skill",
          missingMessage: "--path <repoPath> is required."
        }),
        ref: options.ref,
        destPrefix: options.destPrefix
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
      return cmdProfileAddMcp({
        profile: resolved.profile,
        name: resolved.server,
        command: resolvedTransport.command,
        url: resolvedTransport.url,
        args: resolvedTransport.args,
        env: resolvedTransport.env
      });
    });
  profileCommand
    .command("remove-mcp [name] [server]")
    .description("Remove an MCP server from a profile (defaults to current profile when omitted).")
    .action(async (name, server) => {
      const resolved = await resolveMcpProfileAndServerArgs({
        profileArg: name,
        serverArg: server,
        commandName: "profile remove-mcp"
      });
      return cmdProfileRemoveMcp({
        profile: resolved.profile,
        name: resolved.server
      });
    });
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
    .action(async (name, options) =>
      cmdProfileImport({
        profile: await resolveRequiredTextOption({
          value: name,
          label: "Profile name",
          placeholder: "imported-profile",
          missingMessage: "Profile name is required. Usage: profile import <name>."
        }),
        input: await resolveRequiredTextOption({
          value: options.input,
          label: "Import file path",
          placeholder: "profile-export.json",
          missingMessage: "--input <path> is required."
        }),
        replace: options.replace === true
      }));
  profileCommand
    .command("add-upstream [id]")
    .description("Add an upstream repository (profile workflow alias).")
    .option("--repo <url>", "git repository URL")
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
    .description("Add an upstream repository (id auto-inferred from --repo when omitted).")
    .option("--repo <url>", "git repository URL")
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
    .description("Search upstream skills by keyword (path by default; path+title with --verbose).")
    .option("--query <text>", "search term")
    .option("--upstream <id>", "upstream id (optional; defaults to all configured upstreams)")
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--verbose", "include title metadata and title matching (slower)")
    .option("--versbose", "alias for --verbose")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdSearchSkills({
        upstream: options.upstream,
        ref: options.ref,
        profile: options.profile,
        query: options.query,
        format,
        verbose: options.verbose === true || options.versbose === true
      });
    });

  program
    .command("shell")
    .description("Launch interactive shell mode with command completion and colorized prompts.")
    .option("--profile <name>", "optional shell profile context for build/apply/doctor commands")
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
