import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { buildProfile } from "./lib/build.js";
import { cmdApply, cmdUnlink } from "./lib/bindings.js";
import { cmdAgentDrift, cmdAgentInventory } from "./lib/agents.js";
import { cmdDetect } from "./lib/detect.js";
import { cmdDoctor } from "./lib/doctor.js";
import { cmdInit } from "./lib/init.js";
import {
  cmdCurrentProfile,
  cmdListProfiles,
  cmdNewProfile,
  cmdRemoveProfile,
  readDefaultProfile,
  writeDefaultProfile
} from "./lib/config.js";
import { cmdListEverything, cmdShowProfileInventory } from "./lib/inventory.js";
import { cmdProfileExport, cmdProfileImport } from "./lib/profile-transfer.js";
import {
  cmdProfileAddMcp,
  cmdProfileAddSkill,
  cmdProfileRemoveMcp,
  cmdProfileRemoveSkill,
  cmdUpstreamAdd,
  cmdUpstreamRemove
} from "./lib/manage.js";
import { cmdListSkills, cmdListUpstreamContent, cmdListUpstreams, cmdSearchSkills } from "./lib/upstreams.js";

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
  "agent",
  "upstream",
  "detect",
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
  process.stderr.write("Unknown command. See: skills-sync help\n");
}

function preflightUnknownCommandCheck(argv) {
  if (argv.length === 0) {
    return;
  }

  const [root, child] = argv;
  const listChildren = new Set(["skills", "upstreams", "profiles", "everything", "upstream-content"]);
  const searchChildren = new Set(["skills"]);
  const profileChildren = new Set(["show", "add-skill", "remove-skill", "add-mcp", "remove-mcp", "export", "import"]);
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
  if (root === "agent" && child && !child.startsWith("-") && !agentChildren.has(child)) {
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

async function cmdBuild(profileName, lockModeRaw) {
  const lockMode = (lockModeRaw || "write").toLowerCase();
  if (!VALID_BUILD_LOCK_MODES.has(lockMode)) {
    throw new Error("Invalid --lock value. Use read, write, or refresh.");
  }
  const resolved = profileName ?? await readDefaultProfile();
  if (!resolved) {
    throw new Error("--profile is required (or set a default profile with 'skills-sync use <name>').");
  }
  await buildProfile(resolved, { lockMode });
}

async function cmdApplyWithOptionalBuild(profileName, shouldBuild, options = {}) {
  const normalizedProfile = typeof profileName === "string" && profileName.trim().length > 0 ? profileName.trim() : null;
  const resolvedProfile = normalizedProfile ?? await readDefaultProfile();
  if (shouldBuild) {
    if (!resolvedProfile) {
      throw new Error(
        "apply --build requires --profile <name> or a default profile."
      );
    }
    await buildProfile(resolvedProfile, { lockMode: "write" });
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
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
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
    .description("List discovered upstream skills (directories under skills/** containing SKILL.md).")
    .option("--upstream <id>", "upstream id (optional; defaults to all configured upstreams)")
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--verbose", "include skill titles (slower; reads SKILL.md contents)")
    .option("--versbose", "alias for --verbose")
    .option("--format <format>", "output format: text|json", "text")
    .action((options) => {
      const format = (options.format || "text").toLowerCase();
      if (format !== "text" && format !== "json") {
        throw new Error("Invalid --format value. Use text or json.");
      }
      return cmdListSkills({
        upstream: options.upstream,
        ref: options.ref,
        profile: options.profile,
        format,
        verbose: options.verbose === true || options.versbose === true
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
    .command("use <name>")
    .description("Set the default profile; auto-scaffolds an empty local profile if missing.")
    .action((name) => writeDefaultProfile(name));

  program
    .command("current")
    .description("Print the current default profile name.")
    .action(() => cmdCurrentProfile());

  program
    .command("ls")
    .description("List all available profiles, marking the current default with ->.")
    .action(() => cmdListProfiles());

  const profileCommand = program.command("profile").description("Inspect and modify profile-level skill/MCP configuration.");
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
    .command("add-skill <name>")
    .description("Add an upstream skill import to a profile.")
    .requiredOption("--upstream <id>", "upstream id")
    .requiredOption("--path <repoPath>", "upstream repository path, e.g. skills/my-skill")
    .option("--ref <ref>", "ref/branch/tag (defaults to upstream defaultRef)")
    .option("--dest-prefix <prefix>", "destination prefix in bundled skills tree")
    .action((name, options) =>
      cmdProfileAddSkill({
        profile: name,
        upstream: options.upstream,
        skillPath: options.path,
        ref: options.ref,
        destPrefix: options.destPrefix
      }));
  profileCommand
    .command("remove-skill <name>")
    .description("Remove skill import path(s) from a profile.")
    .requiredOption("--upstream <id>", "upstream id")
    .requiredOption("--path <repoPath>", "upstream repository path, e.g. skills/my-skill")
    .option("--ref <ref>", "optional ref filter")
    .option("--dest-prefix <prefix>", "optional destination prefix filter")
    .action((name, options) =>
      cmdProfileRemoveSkill({
        profile: name,
        upstream: options.upstream,
        skillPath: options.path,
        ref: options.ref,
        destPrefix: options.destPrefix
      }));
  profileCommand
    .command("add-mcp <name> <server>")
    .description("Add or update an MCP server in a profile.")
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
    .action((name, server, options) =>
      cmdProfileAddMcp({
        profile: name,
        name: server,
        command: options.command,
        url: options.url,
        args: resolveMcpArgsOption({ args: options.args, arg: options.arg }),
        env: options.env
      }));
  profileCommand
    .command("remove-mcp <name> <server>")
    .description("Remove an MCP server from a profile.")
    .action((name, server) =>
      cmdProfileRemoveMcp({
        profile: name,
        name: server
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
    .command("import <name>")
    .description("Import profile config JSON.")
    .requiredOption("--input <path>", "path to exported profile JSON")
    .option("--replace", "overwrite existing local profile files if present")
    .action((name, options) =>
      cmdProfileImport({
        profile: name,
        input: options.input,
        replace: options.replace === true
      }));

  const agentCommand = program.command("agent").description("Inspect detected agent installs and profile drift.");
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
    .action((options) => {
      const format = parseFormatOption(options.format);
      return cmdAgentDrift({
        profile: options.profile,
        dryRun: options.dryRun === true,
        format,
        agents: options.agents
      });
    });

  const upstreamCommand = program.command("upstream").description("Manage configured upstream repositories.");
  upstreamCommand
    .command("add <id>")
    .description("Add an upstream repository.")
    .requiredOption("--repo <url>", "git repository URL")
    .option("--default-ref <ref>", "default ref/branch/tag", "main")
    .option("--type <type>", "upstream type (currently only git)", "git")
    .action((id, options) =>
      cmdUpstreamAdd({
        id,
        repo: options.repo,
        defaultRef: options.defaultRef,
        type: options.type
      }));
  upstreamCommand
    .command("remove <id>")
    .description("Remove an upstream repository.")
    .action((id) => cmdUpstreamRemove({ id }));

  program
    .command("new <name>")
    .description("Scaffold a new profile and pack.")
    .action((name) => cmdNewProfile(name));

  program
    .command("remove <name>")
    .description("Delete a profile definition (pack is preserved).")
    .action((name) => cmdRemoveProfile(name));

  const searchCommand = program.command("search").description("Search available resources.");
  searchCommand
    .command("skills")
    .description("Search upstream skills by keyword (path by default; path+title with --verbose).")
    .option("--query <text>", "search term")
    .option("--upstream <id>", "upstream id (optional; defaults to all configured upstreams)")
    .option("--ref <ref>", "ref/branch/tag")
    .option("--profile <name>", "profile name to infer upstream/ref defaults")
    .option("--interactive", "interactive prompt mode")
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
        interactive: options.interactive === true,
        verbose: options.verbose === true || options.versbose === true
      });
    });

  program.command("help").description("Show help.").action(() => program.outputHelp());
  return program;
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    preflightUnknownCommandCheck(argv);
    const program = createProgram();
    await program.parseAsync(["node", "skills-sync", ...argv]);
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
    process.stderr.write(`[skills-sync] ERROR: ${redactPathDetails(error.message)}\n`);
    return 1;
  }
}
