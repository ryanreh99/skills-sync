import { logInfo } from "../../infra/internal/core.js";
import {
  accent,
  danger,
  muted,
  renderSection,
  renderSimpleList,
  renderTable,
  success,
  warning
} from "../../infra/internal/terminal-ui.js";

export function renderDetectJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderDetectText(result, stream = process.stdout) {
  const lines = [
    "",
    renderSection("Detected Agents", { stream }),
    renderTable(
      ["Agent", "Status", "Surface", "Skills", "MCP", "Parse Errors", "Non-MCP Config"],
      result.tools.map((row) => [
        accent(row.tool, stream),
        row.installed ? success("detected", stream) : warning("not detected", stream),
        row.managedSurface,
        row.hasSkills ? success("yes", stream) : muted("no", stream),
        row.hasMcp ? success("yes", stream) : muted("no", stream),
        row.parseErrors.length === 0 ? success("none", stream) : warning(String(row.parseErrors.length), stream),
        row.hasNonMcpConfig ? success("yes", stream) : muted("no", stream)
      ]),
      { stream }
    )
  ];

  const issues = result.tools.filter((row) => row.parseErrors.length > 0);
  if (issues.length > 0) {
    lines.push("");
    lines.push(renderSection("Parse Issues", { count: issues.length, stream }));
    for (const row of issues) {
      lines.push(accent(row.tool, stream));
      lines.push(
        renderSimpleList(
          row.parseErrors.map((issue) => `[${danger(issue.kind, stream)}] ${issue.message}`),
          { indent: "  " }
        )
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function presentDetectResult(result, { format = "text", stream = process.stdout } = {}) {
  if (format === "json") {
    stream.write(renderDetectJson(result));
    return;
  }

  logInfo(`Detected host OS: ${result.os}`);
  stream.write(renderDetectText(result, stream));
}
