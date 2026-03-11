import { logInfo } from "./core.js";
import { collectAgentInventories } from "./agents.js";
import {
  accent,
  danger,
  muted,
  renderSection,
  renderSimpleList,
  renderTable,
  success,
  warning
} from "./terminal-ui.js";

function redactPathDetails(message) {
  return String(message ?? "")
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/~\/[^\s'"]+/g, "<path>")
    .replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "<path>")
    .replace(/\b[\w.-]+\.(json|toml|md)\b/g, "<file>");
}

function toPublicParseErrors(parseErrors) {
  return parseErrors.map((issue) => ({
    kind: issue.kind,
    message: redactPathDetails(issue.message)
  }));
}

export async function cmdDetect({ format = "text", agents } = {}) {
  const inventory = await collectAgentInventories({ agents });
  const detailedRows = inventory.agents.map((agent) => ({
    tool: agent.tool,
    managedSurface: agent.managedSurface,
    hasNonMcpConfig: agent.hasNonMcpConfig,
    hasSkills: agent.hasSkillsPath,
    hasMcp: agent.hasMcpPath,
    installed: agent.installed,
    parseErrors: toPublicParseErrors(agent.parseErrors)
  }));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({ os: inventory.os, tools: detailedRows }, null, 2)}\n`
    );
    return;
  }

  logInfo(`Detected host OS: ${inventory.os}`);
  const lines = [
    "",
    renderSection("Detected Agents", { stream: process.stdout }),
    renderTable(
      ["Agent", "Status", "Surface", "Skills", "MCP", "Parse Errors", "Non-MCP Config"],
      detailedRows.map((row) => [
        accent(row.tool, process.stdout),
        row.installed ? success("detected", process.stdout) : warning("not detected", process.stdout),
        row.managedSurface,
        row.hasSkills ? success("yes", process.stdout) : muted("no", process.stdout),
        row.hasMcp ? success("yes", process.stdout) : muted("no", process.stdout),
        row.parseErrors.length === 0 ? success("none", process.stdout) : warning(String(row.parseErrors.length), process.stdout),
        row.hasNonMcpConfig ? success("yes", process.stdout) : muted("no", process.stdout)
      ]),
      { stream: process.stdout }
    )
  ];

  const issues = detailedRows.filter((row) => row.parseErrors.length > 0);
  if (issues.length > 0) {
    lines.push("");
    lines.push(renderSection("Parse Issues", { count: issues.length, stream: process.stdout }));
    for (const row of issues) {
      lines.push(accent(row.tool, process.stdout));
      lines.push(
        renderSimpleList(
          row.parseErrors.map((issue) => `[${danger(issue.kind, process.stdout)}] ${issue.message}`),
          { indent: "  " }
        )
      );
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}
