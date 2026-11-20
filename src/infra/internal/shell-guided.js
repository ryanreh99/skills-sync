import { listAvailableProfiles, readDefaultProfile } from "./config.js";
import { buildProfileInventory } from "./inventory.js";
import { parseCommaOrWhitespaceList, parseEnvEntries } from "./prompt-adapter.js";
import { getProvider } from "./providers/index.js";
import { tokenizeCommandLine } from "./shell-shared.js";
import { createUpstreamFromSourceInput, loadUpstreamsConfig } from "./upstreams.js";

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

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((option) => option && typeof option === "object")
    .map((option) => ({
      value: String(option.value ?? ""),
      label: String(option.label ?? option.value ?? ""),
      hint: typeof option.hint === "string" ? option.hint : ""
    }))
    .filter((option) => option.value.length > 0);
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function quoteShellArg(rawValue) {
  const value = String(rawValue ?? "");
  if (value.length === 0) {
    return "\"\"";
  }
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function formatShellCommandArgs(args) {
  return (Array.isArray(args) ? args : []).map((value) => quoteShellArg(value)).join(" ");
}

function appendFlagTokens(target, rawFlags) {
  const normalized = normalizeOptionalText(rawFlags);
  if (!normalized) {
    return;
  }
  target.push(...tokenizeCommandLine(normalized));
}

async function readShellProfile(activeProfile) {
  return normalizeOptionalText(activeProfile) || normalizeOptionalText(await readDefaultProfile());
}

async function useCached(session, key, loader) {
  if (session.cache.has(key)) {
    return session.cache.get(key);
  }
  const value = await loader();
  session.cache.set(key, value);
  return value;
}

async function loadProfileOptions() {
  const profiles = await listAvailableProfiles();
  return profiles.map((profile) => ({
    value: profile.name,
    label: profile.name,
    hint: profile.source
  }));
}

async function loadConfiguredUpstreamOptions() {
  const loaded = await loadUpstreamsConfig();
  return loaded.config.upstreams.map((upstream) => ({
    value: upstream.id,
    label: upstream.id,
    hint: upstream.provider === "local-path" ? upstream.path : upstream.repo
  }));
}

async function getProfileInventoryCached(session) {
  const profile = normalizeOptionalText(session.values.profile);
  if (!profile) {
    throw new Error("Profile name is required.");
  }
  return await useCached(session, `inventory:${profile}`, async () =>
    await buildProfileInventory(profile, { detail: "full" }));
}

async function loadImportedUpstreamOptions(session) {
  const inventory = await getProfileInventoryCached(session);
  const counts = new Map();
  for (const item of inventory.skills.items) {
    if (item.sourceType !== "imported" || !item.upstream) {
      continue;
    }
    counts.set(item.upstream, (counts.get(item.upstream) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([upstreamId, count]) => ({
      value: upstreamId,
      label: upstreamId,
      hint: `${count} imported skill${count === 1 ? "" : "s"}`
    }));
}

async function loadImportedSkillOptions(session) {
  const inventory = await getProfileInventoryCached(session);
  const upstreamId = normalizeOptionalText(session.values.upstreamId);
  return inventory.skills.items
    .filter((item) => item.sourceType === "imported" && (!upstreamId || item.upstream === upstreamId))
    .sort((left, right) => left.selectionPath.localeCompare(right.selectionPath))
    .map((item) => ({
      value: item.selectionPath,
      label: item.selectionPath,
      hint: upstreamId ? item.name : `${item.upstream || "local"} | ${item.name}`
    }));
}

async function loadMcpOptions(session) {
  const inventory = await getProfileInventoryCached(session);
  return inventory.mcp.servers.map((server) => ({
    value: server.name,
    label: server.name,
    hint: typeof server.url === "string" && server.url.length > 0 ? server.url : server.command
  }));
}

async function loadDiscoverableSkillOptions(session) {
  const ref = normalizeOptionalText(session.values.ref);
  const sourceMode = session.values.sourceMode === "source" ? "source" : "upstream";
  const cacheKey = sourceMode === "source"
    ? `discover:source:${session.values.source || ""}:${ref || ""}`
    : `discover:upstream:${session.values.upstreamId || ""}:${ref || ""}`;

  return await useCached(session, cacheKey, async () => {
    let upstream;
    if (sourceMode === "source") {
      upstream = await createUpstreamFromSourceInput({
        source: normalizeRequiredText(session.values.source, "Source locator"),
        provider: "auto",
        root: null,
        defaultRef: ref
      });
    } else {
      const loaded = await loadUpstreamsConfig();
      upstream = loaded.byId.get(normalizeRequiredText(session.values.upstreamId, "Upstream id"));
      if (!upstream) {
        throw new Error(`Unknown upstream '${session.values.upstreamId}'.`);
      }
    }

    const provider = getProvider(upstream.provider);
    const discovery = await provider.discover(upstream, {
      ...(ref ? { ref } : {})
    });

    return discovery.skills.map((skill) => ({
      value: skill.path,
      label: skill.path,
      hint: normalizeOptionalText(skill.title) || normalizeOptionalText(skill.summary) || ""
    }));
  });
}

function getDefinition(flowId) {
  const definition = FLOW_DEFINITIONS[flowId];
  if (!definition) {
    throw new Error(`Unknown guided flow '${flowId}'.`);
  }
  return definition;
}

function getVisibleSteps(session) {
  return session.definition.steps.filter((step) => (typeof step.isVisible === "function" ? step.isVisible(session) : true));
}

function findStepConfig(session, stepId = session.currentStepId) {
  return session.definition.steps.find((step) => step.id === stepId) ?? null;
}

function getStepIndexById(session, stepId = session.currentStepId) {
  return session.definition.steps.findIndex((step) => step.id === stepId);
}

function getNextVisibleStepId(session, currentStepId) {
  const currentIndex = getStepIndexById(session, currentStepId);
  for (let index = currentIndex + 1; index < session.definition.steps.length; index += 1) {
    const step = session.definition.steps[index];
    if (!step.isVisible || step.isVisible(session)) {
      return step.id;
    }
  }
  return null;
}

function getPreviousVisibleStepId(session, currentStepId) {
  const currentIndex = getStepIndexById(session, currentStepId);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const step = session.definition.steps[index];
    if (!step.isVisible || step.isVisible(session)) {
      return step.id;
    }
  }
  return null;
}

function pickOptionIndex(options, selectedValue) {
  const normalized = normalizeOptionalText(selectedValue);
  if (!normalized) {
    return 0;
  }
  const index = options.findIndex((option) => option.value === normalized);
  return index < 0 ? 0 : index;
}

function createPromptDescription(stepTitle, stepDescription) {
  const title = typeof stepTitle === "function" ? stepTitle() : stepTitle;
  const description = typeof stepDescription === "function" ? stepDescription() : stepDescription;
  return {
    title: String(title ?? ""),
    description: String(description ?? "")
  };
}

function textStep({
  id,
  title,
  description,
  placeholder = "",
  optional = false,
  isVisible,
  getValue = () => "",
  requiredMessage = null,
  validate = null,
  commit,
  submitLabel = "Next"
}) {
  return {
    id,
    isVisible,
    async resolve(session) {
      const prompt = createPromptDescription(
        () => (typeof title === "function" ? title(session) : title),
        () => (typeof description === "function" ? description(session) : description)
      );
      return {
        id,
        kind: "text",
        title: prompt.title,
        description: prompt.description,
        placeholder: typeof placeholder === "function" ? placeholder(session) : placeholder,
        optional,
        value: String(getValue(session) ?? ""),
        submitLabel
      };
    },
    async commit(session, payload, descriptor) {
      const value = String(payload?.text ?? "").trim();
      if (!optional && value.length === 0) {
        throw new Error(requiredMessage || `${descriptor.title} is required.`);
      }
      if (typeof validate === "function") {
        validate(value, session, descriptor);
      }
      await commit(session, value, descriptor);
      return { action: "next" };
    }
  };
}

function selectStep({
  id,
  title,
  description,
  isVisible,
  loadOptions,
  getSelectedValue = () => null,
  commit,
  fallbackText = null,
  submitLabel = "Next"
}) {
  return {
    id,
    isVisible,
    async resolve(session) {
      const prompt = createPromptDescription(
        () => (typeof title === "function" ? title(session) : title),
        () => (typeof description === "function" ? description(session) : description)
      );
      try {
        const options = normalizeOptions(await loadOptions(session));
        if (options.length > 0) {
          return {
            id,
            kind: "select",
            title: prompt.title,
            description: prompt.description,
            options,
            selectedValue: getSelectedValue(session),
            submitLabel
          };
        }
      } catch (error) {
        if (!fallbackText) {
          throw error;
        }
      }

      if (!fallbackText) {
        throw new Error(`No options available for ${prompt.title.toLowerCase()}.`);
      }

      return {
        id,
        kind: "text",
        title: typeof fallbackText.title === "function" ? fallbackText.title(session) : (fallbackText.title || prompt.title),
        description: typeof fallbackText.description === "function"
          ? fallbackText.description(session)
          : (fallbackText.description || prompt.description),
        placeholder: typeof fallbackText.placeholder === "function"
          ? fallbackText.placeholder(session)
          : (fallbackText.placeholder || ""),
        optional: false,
        value: typeof fallbackText.getValue === "function" ? String(fallbackText.getValue(session) ?? "") : "",
        submitLabel
      };
    },
    async commit(session, payload, descriptor) {
      if (descriptor.kind === "text") {
        const value = normalizeRequiredText(payload?.text, descriptor.title);
        if (typeof fallbackText?.validate === "function") {
          fallbackText.validate(value, session, descriptor);
        }
        await fallbackText.commit(session, value, descriptor);
        return { action: "next" };
      }

      const options = Array.isArray(descriptor.options) ? descriptor.options : [];
      const selected = options[Math.max(0, Math.min(Number(payload?.index ?? 0), options.length - 1))];
      if (!selected) {
        throw new Error(`Choose an option for ${descriptor.title.toLowerCase()}.`);
      }
      await commit(session, selected.value, selected, descriptor);
      return { action: "next" };
    }
  };
}

function pickerStep({
  id,
  title,
  description,
  isVisible,
  loadOptions,
  getSelectedValues = () => [],
  commit,
  fallbackText = null,
  submitLabel = "Next"
}) {
  return {
    id,
    isVisible,
    async resolve(session) {
      const prompt = createPromptDescription(
        () => (typeof title === "function" ? title(session) : title),
        () => (typeof description === "function" ? description(session) : description)
      );
      try {
        const options = normalizeOptions(await loadOptions(session));
        if (options.length > 0) {
          return {
            id,
            kind: "picker",
            title: prompt.title,
            description: prompt.description,
            options,
            selectedValues: uniqueValues(getSelectedValues(session)),
            submitLabel
          };
        }
      } catch (error) {
        if (!fallbackText) {
          throw error;
        }
      }

      if (!fallbackText) {
        throw new Error(`No options available for ${prompt.title.toLowerCase()}.`);
      }

      return {
        id,
        kind: "text",
        title: typeof fallbackText.title === "function" ? fallbackText.title(session) : (fallbackText.title || prompt.title),
        description: typeof fallbackText.description === "function"
          ? fallbackText.description(session)
          : (fallbackText.description || prompt.description),
        placeholder: typeof fallbackText.placeholder === "function"
          ? fallbackText.placeholder(session)
          : (fallbackText.placeholder || ""),
        optional: false,
        value: typeof fallbackText.getValue === "function" ? String(fallbackText.getValue(session) ?? "") : "",
        submitLabel
      };
    },
    async commit(session, payload, descriptor) {
      if (descriptor.kind === "text") {
        const value = normalizeRequiredText(payload?.text, descriptor.title);
        await fallbackText.commit(session, value, descriptor);
        return { action: "next" };
      }

      const selectedValues = uniqueValues(payload?.values);
      if (selectedValues.length === 0) {
        throw new Error(`Choose one or more items for ${descriptor.title.toLowerCase()}.`);
      }
      await commit(session, selectedValues, descriptor);
      return { action: "next" };
    }
  };
}

function reviewStep({ id, title, description, buildCommand, isVisible }) {
  return {
    id,
    isVisible,
    async resolve(session) {
      const prompt = createPromptDescription(
        () => (typeof title === "function" ? title(session) : title),
        () => (typeof description === "function" ? description(session) : description)
      );
      const command = await buildCommand(session);
      const commandText = formatShellCommandArgs(command.args);
      return {
        id,
        kind: "review",
        title: prompt.title,
        description: prompt.description,
        previewLines: Array.isArray(command.previewLines) && command.previewLines.length > 0
          ? command.previewLines
          : [commandText],
        options: [
          { value: "confirm", label: "Run command", hint: commandText },
          { value: "back", label: "Back", hint: "return to the previous step" },
          { value: "cancel", label: "Cancel", hint: "close the guided flow" }
        ],
        selectedValue: "confirm",
        commandArgs: command.args,
        commandText
      };
    },
    async commit(session, payload, descriptor) {
      const value = String(payload?.value ?? "confirm");
      if (value === "back") {
        return { action: "back" };
      }
      if (value === "cancel") {
        return { action: "cancel" };
      }
      return {
        action: "complete",
        commandArgs: descriptor.commandArgs,
        commandText: descriptor.commandText
      };
    }
  };
}

function buildProfilePrefix(session, commandName) {
  const args = ["profile", commandName];
  const profile = normalizeOptionalText(session.values.profile);
  if (profile) {
    args.push(profile);
  }
  return args;
}

function buildUpstreamAddArgs(session) {
  const args = [
    session.context.variant === "profile" ? "profile" : "upstream",
    session.context.variant === "profile" ? "add-upstream" : "add"
  ];
  const id = normalizeOptionalText(session.values.upstreamAliasId);
  if (id) {
    args.push(id);
  }
  args.push("--source", normalizeRequiredText(session.values.source, "Source locator"));
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildUpstreamRemoveArgs(session) {
  return [
    session.context.variant === "profile" ? "profile" : "upstream",
    session.context.variant === "profile" ? "remove-upstream" : "remove",
    normalizeRequiredText(session.values.upstreamId, "Upstream id")
  ];
}

function buildUpstreamContentArgs(session) {
  const args = ["list", "upstream-content", "--upstream", normalizeRequiredText(session.values.upstreamId, "Upstream id")];
  const ref = normalizeOptionalText(session.values.ref);
  if (ref) {
    args.push("--ref", ref);
  }
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildSkillAddArgs(session) {
  const args = buildProfilePrefix(session, "add-skill");
  if (session.values.sourceMode === "source") {
    args.push("--source", normalizeRequiredText(session.values.source, "Source locator"));
  } else {
    args.push("--upstream", normalizeRequiredText(session.values.upstreamId, "Upstream id"));
  }
  const ref = normalizeOptionalText(session.values.ref);
  if (ref) {
    args.push("--ref", ref);
  }
  if (session.values.selectionMode === "all") {
    args.push("--all");
  } else {
    for (const skillPath of uniqueValues(session.values.skillPaths)) {
      args.push("--path", skillPath);
    }
  }
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildSkillRemoveArgs(session) {
  const args = buildProfilePrefix(session, "remove-skill");
  args.push("--upstream", normalizeRequiredText(session.values.upstreamId, "Upstream id"));
  if (session.values.removalMode === "all") {
    args.push("--all");
  } else {
    for (const skillPath of uniqueValues(session.values.skillPaths)) {
      args.push("--path", skillPath);
    }
  }
  args.push("--yes");
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildRefreshArgs(session) {
  const args = buildProfilePrefix(session, "refresh");
  const upstreamId = normalizeOptionalText(session.values.upstreamId);
  if (upstreamId) {
    args.push("--upstream", upstreamId);
  }
  for (const skillPath of uniqueValues(session.values.skillPaths)) {
    args.push("--path", skillPath);
  }
  if (session.values.dryRun === true) {
    args.push("--dry-run");
  }
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildAddMcpArgs(session) {
  const args = buildProfilePrefix(session, "add-mcp");
  args.push(normalizeRequiredText(session.values.serverName, "MCP server name"));
  if (session.values.transport === "http" || session.values.transport === "sse") {
    args.push("--url", normalizeRequiredText(session.values.url, "MCP server URL"));
    if (session.values.transport === "sse") {
      args.push("--transport", "sse");
    }
  } else {
    args.push("--command", normalizeRequiredText(session.values.command, "MCP server command"));
    for (const arg of uniqueValues(session.values.commandArgs)) {
      args.push("--arg", arg);
    }
    const envEntries = Array.isArray(session.values.envEntries) ? session.values.envEntries : [];
    if (envEntries.length > 0) {
      args.push("--env", ...envEntries);
    }
  }
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

function buildRemoveMcpArgs(session) {
  const args = buildProfilePrefix(session, "remove-mcp");
  args.push(normalizeRequiredText(session.values.serverName, "MCP server name"));
  appendFlagTokens(args, session.values.advancedFlags);
  return args;
}

const PROFILE_STEP = selectStep({
  id: "profile",
  title: "Profile",
  description: "Choose the profile for this action.",
  isVisible: (session) => session.needsProfile === true,
  loadOptions: async () => await loadProfileOptions(),
  getSelectedValue: (session) => session.values.profile,
  commit: async (session, value) => {
    session.values.profile = value;
    session.needsProfile = false;
  },
  fallbackText: {
    description: "Enter the profile name manually.",
    placeholder: "personal",
    getValue: (session) => session.values.profile || "",
    commit: async (session, value) => {
      session.values.profile = value;
      session.needsProfile = false;
    }
  }
});

function createAdvancedFlagsStep({
  description,
  placeholder = "--no-sync",
  isVisible
} = {}) {
  return textStep({
    id: "advancedFlags",
    title: "Advanced flags (optional)",
    description: description || "Add uncommon flags exactly as you would type them in the CLI.",
    placeholder,
    optional: true,
    isVisible,
    getValue: (session) => session.values.advancedFlags || "",
    validate: (value) => {
      if (value) {
        tokenizeCommandLine(value);
      }
    },
    commit: async (session, value) => {
      session.values.advancedFlags = value;
    }
  });
}

const FLOW_DEFINITIONS = {
  "upstream-add": {
    steps: [
      textStep({
        id: "source",
        title: "Source locator",
        description: "GitHub shorthand, git URL, or local path.",
        placeholder: "owner/repo or https://github.com/org/repo.git",
        getValue: (session) => session.values.source || "",
        commit: async (session, value) => {
          session.values.source = value;
        }
      }),
      textStep({
        id: "upstreamAliasId",
        title: "Upstream id (optional)",
        description: "Leave blank to auto-infer the upstream id.",
        placeholder: "team_skills",
        optional: true,
        getValue: (session) => session.values.upstreamAliasId || "",
        commit: async (session, value) => {
          session.values.upstreamAliasId = normalizeOptionalText(value);
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --provider local-path --root skills --default-ref main",
        placeholder: "--provider auto --default-ref main"
      }),
      reviewStep({
        id: "review",
        title: "Review upstream add",
        description: "Confirm the upstream registration command.",
        buildCommand: async (session) => ({
          args: buildUpstreamAddArgs(session)
        })
      })
    ]
  },
  "upstream-remove": {
    steps: [
      selectStep({
        id: "upstreamId",
        title: "Upstream id",
        description: "Choose the upstream to remove.",
        loadOptions: async () => await loadConfiguredUpstreamOptions(),
        getSelectedValue: (session) => session.values.upstreamId,
        commit: async (session, value) => {
          session.values.upstreamId = value;
        },
        fallbackText: {
          description: "Enter the upstream id manually.",
          placeholder: "team_skills",
          getValue: (session) => session.values.upstreamId || "",
          commit: async (session, value) => {
            session.values.upstreamId = value;
          }
        }
      }),
      reviewStep({
        id: "review",
        title: "Review upstream removal",
        description: "Confirm the upstream removal command.",
        buildCommand: async (session) => ({
          args: buildUpstreamRemoveArgs(session)
        })
      })
    ]
  },
  "upstream-content": {
    steps: [
      selectStep({
        id: "upstreamId",
        title: "Upstream id",
        description: "Choose the upstream to inspect.",
        loadOptions: async () => await loadConfiguredUpstreamOptions(),
        getSelectedValue: (session) => session.values.upstreamId,
        commit: async (session, value) => {
          session.values.upstreamId = value;
        },
        fallbackText: {
          description: "Enter the upstream id manually.",
          placeholder: "team_skills",
          getValue: (session) => session.values.upstreamId || "",
          commit: async (session, value) => {
            session.values.upstreamId = value;
          }
        }
      }),
      textStep({
        id: "ref",
        title: "Ref (optional)",
        description: "Leave blank to use the upstream default ref.",
        placeholder: "main",
        optional: true,
        getValue: (session) => session.values.ref || "",
        commit: async (session, value) => {
          session.values.ref = normalizeOptionalText(value);
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --verbose --format json",
        placeholder: "--verbose"
      }),
      reviewStep({
        id: "review",
        title: "Review upstream content",
        description: "Confirm the upstream content listing command.",
        buildCommand: async (session) => ({
          args: buildUpstreamContentArgs(session)
        })
      })
    ]
  },
  "skill-add": {
    usesProfile: true,
    steps: [
      PROFILE_STEP,
      selectStep({
        id: "sourceMode",
        title: "Source type",
        description: "Choose where the skills should come from.",
        isVisible: (session) => session.context.sourceModeLocked !== true,
        loadOptions: async () => [
          { value: "upstream", label: "Configured upstream", hint: "use an upstream you already registered" },
          { value: "source", label: "Ad hoc source", hint: "use a GitHub URL, repo URL, or local path" }
        ],
        getSelectedValue: (session) => session.values.sourceMode || "upstream",
        commit: async (session, value) => {
          session.values.sourceMode = value === "source" ? "source" : "upstream";
          if (session.values.sourceMode === "source") {
            session.values.upstreamId = null;
          } else {
            session.values.source = null;
          }
        }
      }),
      selectStep({
        id: "upstreamId",
        title: "Upstream id",
        description: "Choose the configured upstream to browse.",
        isVisible: (session) => session.values.sourceMode !== "source",
        loadOptions: async () => await loadConfiguredUpstreamOptions(),
        getSelectedValue: (session) => session.values.upstreamId,
        commit: async (session, value) => {
          session.values.upstreamId = value;
        },
        fallbackText: {
          description: "Enter the upstream id manually.",
          placeholder: "team_skills",
          getValue: (session) => session.values.upstreamId || "",
          commit: async (session, value) => {
            session.values.upstreamId = value;
          }
        }
      }),
      textStep({
        id: "source",
        title: "Source locator",
        description: "GitHub shorthand, git URL, or local path.",
        isVisible: (session) => session.values.sourceMode === "source",
        placeholder: "owner/repo or https://github.com/org/repo.git",
        getValue: (session) => session.values.source || "",
        commit: async (session, value) => {
          session.values.source = value;
        }
      }),
      textStep({
        id: "ref",
        title: "Ref (optional)",
        description: "Branch, tag, or commit for discovery and import.",
        placeholder: "main",
        optional: true,
        getValue: (session) => session.values.ref || "",
        commit: async (session, value) => {
          session.values.ref = normalizeOptionalText(value);
        }
      }),
      selectStep({
        id: "selectionMode",
        title: "Selection mode",
        description: "Choose specific skills or import everything discoverable.",
        loadOptions: async () => [
          { value: "paths", label: "Choose skills", hint: "pick one or more skill paths" },
          { value: "all", label: "Import all", hint: "use --all" }
        ],
        getSelectedValue: (session) => session.values.selectionMode || "paths",
        commit: async (session, value) => {
          session.values.selectionMode = value === "all" ? "all" : "paths";
        }
      }),
      pickerStep({
        id: "skillPaths",
        title: "Skill paths",
        description: "Choose one or more skills to import.",
        isVisible: (session) => session.values.selectionMode !== "all",
        loadOptions: async (session) => await loadDiscoverableSkillOptions(session),
        getSelectedValues: (session) => session.values.skillPaths || [],
        commit: async (session, values) => {
          session.values.skillPaths = values;
        },
        fallbackText: {
          description: "Enter one or more repo paths separated by commas or spaces.",
          placeholder: "skills/demo skills/another",
          getValue: (session) => Array.isArray(session.values.skillPaths) ? session.values.skillPaths.join(" ") : "",
          commit: async (session, value) => {
            session.values.skillPaths = uniqueValues(parseCommaOrWhitespaceList(value));
          }
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --pin --dest-prefix vendor --upstream-id org_demo --no-sync",
        placeholder: "--pin --dest-prefix imported"
      }),
      reviewStep({
        id: "review",
        title: "Review skill import",
        description: "Confirm the skill import command.",
        buildCommand: async (session) => ({
          args: buildSkillAddArgs(session)
        })
      })
    ]
  },
  "skill-remove": {
    usesProfile: true,
    steps: [
      PROFILE_STEP,
      selectStep({
        id: "upstreamId",
        title: "Imported upstream",
        description: "Choose the upstream to remove imported skills from.",
        loadOptions: async (session) => await loadImportedUpstreamOptions(session),
        getSelectedValue: (session) => session.values.upstreamId,
        commit: async (session, value) => {
          session.values.upstreamId = value;
        },
        fallbackText: {
          description: "Enter the upstream id manually.",
          placeholder: "team_skills",
          getValue: (session) => session.values.upstreamId || "",
          commit: async (session, value) => {
            session.values.upstreamId = value;
          }
        }
      }),
      selectStep({
        id: "removalMode",
        title: "Removal mode",
        description: "Remove specific skills or everything from this upstream.",
        loadOptions: async () => [
          { value: "paths", label: "Choose skills", hint: "pick one or more imported skills" },
          { value: "all", label: "Remove all", hint: "use --all for this upstream" }
        ],
        getSelectedValue: (session) => session.values.removalMode || "paths",
        commit: async (session, value) => {
          session.values.removalMode = value === "all" ? "all" : "paths";
        }
      }),
      pickerStep({
        id: "skillPaths",
        title: "Imported skills",
        description: "Choose one or more imported skills to remove.",
        isVisible: (session) => session.values.removalMode !== "all",
        loadOptions: async (session) => await loadImportedSkillOptions(session),
        getSelectedValues: (session) => session.values.skillPaths || [],
        commit: async (session, values) => {
          session.values.skillPaths = values;
        },
        fallbackText: {
          description: "Enter one or more imported skill paths separated by commas or spaces.",
          placeholder: "skills/demo skills/another",
          getValue: (session) => Array.isArray(session.values.skillPaths) ? session.values.skillPaths.join(" ") : "",
          commit: async (session, value) => {
            session.values.skillPaths = uniqueValues(parseCommaOrWhitespaceList(value));
          }
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --ref main --dest-prefix vendor --prune-upstream --no-sync",
        placeholder: "--prune-upstream"
      }),
      reviewStep({
        id: "review",
        title: "Review skill removal",
        description: "Confirm the imported skill removal command.",
        buildCommand: async (session) => ({
          args: buildSkillRemoveArgs(session)
        })
      })
    ]
  },
  "profile-refresh": {
    usesProfile: true,
    steps: [
      PROFILE_STEP,
      selectStep({
        id: "refreshScope",
        title: "Refresh scope",
        description: "Choose which imported skills to refresh.",
        loadOptions: async (session) => {
          const upstreamOptions = await loadImportedUpstreamOptions(session);
          if (session.context.requireUpstream === true) {
            return upstreamOptions;
          }
          return [
            { value: "__all__", label: "All imports", hint: "refresh every imported skill in the profile" },
            ...upstreamOptions
          ];
        },
        getSelectedValue: (session) => session.values.upstreamId || (session.context.requireUpstream === true ? null : "__all__"),
        commit: async (session, value) => {
          session.values.upstreamId = value === "__all__" ? null : value;
        },
        fallbackText: {
          description: "Enter the upstream id manually.",
          placeholder: "team_skills",
          getValue: (session) => session.values.upstreamId || "",
          commit: async (session, value) => {
            session.values.upstreamId = value;
          }
        }
      }),
      selectStep({
        id: "refreshPathMode",
        title: "Refresh target",
        description: "Refresh every matching import or just selected skill paths.",
        loadOptions: async () => [
          { value: "all", label: "All matching imports", hint: "refresh every imported skill in scope" },
          { value: "paths", label: "Choose skill paths", hint: "limit refresh to selected imports" }
        ],
        getSelectedValue: (session) => session.values.refreshPathMode || "all",
        commit: async (session, value) => {
          session.values.refreshPathMode = value === "paths" ? "paths" : "all";
        }
      }),
      pickerStep({
        id: "skillPaths",
        title: "Imported skill paths",
        description: "Choose one or more imported skill paths to refresh.",
        isVisible: (session) => session.values.refreshPathMode === "paths",
        loadOptions: async (session) => await loadImportedSkillOptions(session),
        getSelectedValues: (session) => session.values.skillPaths || [],
        commit: async (session, values) => {
          session.values.skillPaths = values;
        },
        fallbackText: {
          description: "Enter one or more imported skill paths separated by commas or spaces.",
          placeholder: "skills/demo skills/another",
          getValue: (session) => Array.isArray(session.values.skillPaths) ? session.values.skillPaths.join(" ") : "",
          commit: async (session, value) => {
            session.values.skillPaths = uniqueValues(parseCommaOrWhitespaceList(value));
          }
        }
      }),
      selectStep({
        id: "dryRun",
        title: "Execution mode",
        description: "Choose whether to apply the refresh or preview it.",
        isVisible: (session) => session.context.dryRunLocked !== true,
        loadOptions: async () => [
          { value: "run", label: "Apply refresh", hint: "update lock state and imported content" },
          { value: "dry-run", label: "Dry run", hint: "preview refresh results only" }
        ],
        getSelectedValue: (session) => session.values.dryRun === true ? "dry-run" : "run",
        commit: async (session, value) => {
          session.values.dryRun = value === "dry-run";
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --no-sync --format json",
        placeholder: "--no-sync"
      }),
      reviewStep({
        id: "review",
        title: "Review refresh",
        description: "Confirm the profile refresh command.",
        buildCommand: async (session) => ({
          args: buildRefreshArgs(session)
        })
      })
    ]
  },
  "mcp-add": {
    usesProfile: true,
    steps: [
      PROFILE_STEP,
      textStep({
        id: "serverName",
        title: "MCP server name",
        description: "Name of the server entry to add or update.",
        placeholder: "filesystem",
        getValue: (session) => session.values.serverName || "",
        commit: async (session, value) => {
          session.values.serverName = value;
        }
      }),
      selectStep({
        id: "transport",
        title: "Transport",
        description: "Choose the MCP transport type.",
        loadOptions: async () => [
          { value: "stdio", label: "stdio", hint: "local command-based MCP server" },
          { value: "http", label: "http", hint: "remote HTTP MCP server" },
          { value: "sse", label: "sse", hint: "legacy remote SSE MCP server" }
        ],
        getSelectedValue: (session) => session.values.transport || "stdio",
        commit: async (session, value) => {
          session.values.transport = value === "http" || value === "sse" ? value : "stdio";
        }
      }),
      textStep({
        id: "command",
        title: "Server command",
        description: "Executable to launch for stdio MCP servers.",
        isVisible: (session) => session.values.transport !== "http" && session.values.transport !== "sse",
        placeholder: "npx",
        getValue: (session) => session.values.command || "",
        commit: async (session, value) => {
          session.values.command = value;
        }
      }),
      textStep({
        id: "url",
        title: "Server URL",
        description: "Base URL for the remote MCP server.",
        isVisible: (session) => session.values.transport === "http" || session.values.transport === "sse",
        placeholder: "https://example.com/mcp",
        getValue: (session) => session.values.url || "",
        commit: async (session, value) => {
          session.values.url = value;
        }
      }),
      textStep({
        id: "commandArgs",
        title: "Command args (optional)",
        description: "Enter args separated by spaces or commas.",
        isVisible: (session) => session.values.transport !== "http" && session.values.transport !== "sse",
        placeholder: "-y @modelcontextprotocol/server-filesystem",
        optional: true,
        getValue: (session) => Array.isArray(session.values.commandArgs) ? session.values.commandArgs.join(" ") : "",
        commit: async (session, value) => {
          session.values.commandArgs = parseCommaOrWhitespaceList(value);
        }
      }),
      textStep({
        id: "envEntries",
        title: "Env entries (optional)",
        description: "Enter KEY=VALUE pairs separated by spaces or commas.",
        isVisible: (session) => session.values.transport !== "http" && session.values.transport !== "sse",
        placeholder: "ROOT=$HOME",
        optional: true,
        getValue: (session) => Array.isArray(session.values.envEntries) ? session.values.envEntries.join(" ") : "",
        validate: (value) => {
          parseEnvEntries(value);
        },
        commit: async (session, value) => {
          session.values.envEntries = parseEnvEntries(value);
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --no-sync",
        placeholder: "--no-sync"
      }),
      reviewStep({
        id: "review",
        title: "Review MCP add",
        description: "Confirm the MCP add/update command.",
        buildCommand: async (session) => ({
          args: buildAddMcpArgs(session)
        })
      })
    ]
  },
  "mcp-remove": {
    usesProfile: true,
    steps: [
      PROFILE_STEP,
      selectStep({
        id: "serverName",
        title: "MCP server",
        description: "Choose the MCP server to remove.",
        loadOptions: async (session) => await loadMcpOptions(session),
        getSelectedValue: (session) => session.values.serverName,
        commit: async (session, value) => {
          session.values.serverName = value;
        },
        fallbackText: {
          description: "Enter the MCP server name manually.",
          placeholder: "filesystem",
          getValue: (session) => session.values.serverName || "",
          commit: async (session, value) => {
            session.values.serverName = value;
          }
        }
      }),
      createAdvancedFlagsStep({
        description: "Examples: --no-sync",
        placeholder: "--no-sync"
      }),
      reviewStep({
        id: "review",
        title: "Review MCP removal",
        description: "Confirm the MCP removal command.",
        buildCommand: async (session) => ({
          args: buildRemoveMcpArgs(session)
        })
      })
    ]
  }
};

function buildCommitPayload(session) {
  const descriptor = session.currentStep;
  if (!descriptor) {
    throw new Error("No active guided step.");
  }

  if (descriptor.kind === "text") {
    return { text: String(session.ui?.textValue ?? "") };
  }
  if (descriptor.kind === "picker") {
    return { values: uniqueValues(session.ui?.selectedValues) };
  }
  if (descriptor.kind === "select") {
    return { index: Number(session.ui?.selectedIndex ?? 0) };
  }
  if (descriptor.kind === "review") {
    const options = Array.isArray(descriptor.options) ? descriptor.options : [];
    const selectedIndex = Math.max(0, Math.min(Number(session.ui?.selectedIndex ?? 0), options.length - 1));
    return { value: options[selectedIndex]?.value ?? "confirm" };
  }

  return {};
}

export async function refreshGuidedFlowStep(session) {
  if (!session || !session.definition) {
    throw new Error("Guided flow session is required.");
  }

  const visibleSteps = getVisibleSteps(session);
  if (visibleSteps.length === 0) {
    throw new Error(`Guided flow '${session.flowId}' has no visible steps.`);
  }

  if (!session.currentStepId || !visibleSteps.some((step) => step.id === session.currentStepId)) {
    session.currentStepId = visibleSteps[0].id;
  }

  const stepConfig = findStepConfig(session, session.currentStepId);
  if (!stepConfig) {
    throw new Error(`Unknown guided step '${session.currentStepId}'.`);
  }

  const descriptor = await stepConfig.resolve(session);
  descriptor.position = visibleSteps.findIndex((step) => step.id === descriptor.id) + 1;
  descriptor.total = visibleSteps.length;
  session.currentStep = descriptor;

  if (descriptor.kind === "text") {
    const value = String(descriptor.value ?? "");
    session.ui = {
      kind: "text",
      textValue: value,
      textCursor: value.length
    };
  } else if (descriptor.kind === "picker") {
    const selectedValues = uniqueValues(descriptor.selectedValues);
    const initialIndex = descriptor.options.findIndex((option) => selectedValues.includes(option.value));
    session.ui = {
      kind: "picker",
      selectedIndex: initialIndex >= 0 ? initialIndex : 0,
      selectedValues
    };
  } else if (descriptor.kind === "select") {
    session.ui = {
      kind: "select",
      selectedIndex: pickOptionIndex(descriptor.options, descriptor.selectedValue)
    };
  } else if (descriptor.kind === "review") {
    session.ui = {
      kind: "review",
      selectedIndex: pickOptionIndex(descriptor.options, descriptor.selectedValue)
    };
  } else {
    session.ui = { kind: descriptor.kind };
  }

  return descriptor;
}

export async function createGuidedFlowSession({
  flowId,
  activeProfile = null,
  context = {},
  initialValues = {}
} = {}) {
  const definition = getDefinition(flowId);
  const defaults = context && typeof context === "object" ? { ...context } : {};
  const flowDefaults = defaults.flowDefaults && typeof defaults.flowDefaults === "object"
    ? { ...defaults.flowDefaults }
    : {};
  const {
    variant = defaults.variant,
    requireUpstream = defaults.requireUpstream,
    ...valueDefaults
  } = flowDefaults;
  const values = {
    ...valueDefaults,
    ...initialValues
  };
  const session = {
    cache: new Map(),
    context: {
      variant: variant === "profile" ? "profile" : "upstream",
      sourceModeLocked: typeof values.sourceMode === "string",
      dryRunLocked: values.dryRun === true,
      requireUpstream: requireUpstream === true
    },
    currentStep: null,
    currentStepId: null,
    definition,
    flowId,
    needsProfile: definition.usesProfile === true,
    ui: null,
    values
  };

  if (definition.usesProfile === true) {
    const profile = await readShellProfile(activeProfile);
    if (profile) {
      session.values.profile = normalizeOptionalText(session.values.profile) || profile;
      session.needsProfile = false;
    }
  }

  await refreshGuidedFlowStep(session);
  return session;
}

export async function advanceGuidedFlowSession(session, payload = null) {
  if (!session?.currentStepId || !session.currentStep) {
    throw new Error("Guided flow session is not ready.");
  }

  const stepConfig = findStepConfig(session, session.currentStepId);
  if (!stepConfig) {
    throw new Error(`Unknown guided step '${session.currentStepId}'.`);
  }

  const result = await stepConfig.commit(session, payload || buildCommitPayload(session), session.currentStep);
  const action = result?.action || "next";

  if (action === "cancel") {
    return { type: "cancelled" };
  }
  if (action === "back") {
    return await retreatGuidedFlowSession(session);
  }
  if (action === "stay") {
    await refreshGuidedFlowStep(session);
    return { type: "step", descriptor: session.currentStep };
  }
  if (action === "complete") {
    return {
      type: "completed",
      commandArgs: Array.isArray(result.commandArgs) ? result.commandArgs : [],
      commandText: String(result.commandText ?? formatShellCommandArgs(result.commandArgs ?? []))
    };
  }

  const nextStepId = result?.nextStepId || getNextVisibleStepId(session, session.currentStepId);
  if (!nextStepId) {
    throw new Error(`Guided flow '${session.flowId}' has no next step after '${session.currentStepId}'.`);
  }
  session.currentStepId = nextStepId;
  await refreshGuidedFlowStep(session);
  return { type: "step", descriptor: session.currentStep };
}

export async function retreatGuidedFlowSession(session) {
  if (!session?.currentStepId) {
    return { type: "cancelled" };
  }

  const previousStepId = getPreviousVisibleStepId(session, session.currentStepId);
  if (!previousStepId) {
    return { type: "cancelled" };
  }

  session.currentStepId = previousStepId;
  await refreshGuidedFlowStep(session);
  return { type: "step", descriptor: session.currentStep };
}
