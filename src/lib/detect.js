import { logInfo } from "./core.js";
import { collectAgentInventories } from "./agents.js";

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
    support: agent.support,
    canOverride: agent.canOverride,
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
  process.stdout.write("\n");
  for (const row of detailedRows) {
    process.stdout.write(`${row.tool}\n`);
    process.stdout.write(`  status      : ${row.installed ? "detected" : "not detected"}\n`);
    process.stdout.write(`  support     : ${row.support}\n`);
    process.stdout.write(`  skills found: ${row.hasSkills ? "yes" : "no"}\n`);
    process.stdout.write(`  mcp found   : ${row.hasMcp ? "yes" : "no"}\n`);
    if (row.parseErrors.length === 0) {
      process.stdout.write("  parse errors: none\n");
    } else {
      process.stdout.write(`  parse errors: ${row.parseErrors.length}\n`);
      for (const issue of row.parseErrors) {
        process.stdout.write(`    [${issue.kind}] ${issue.message}\n`);
      }
    }
    process.stdout.write(`  canOverride : ${row.canOverride}\n\n`);
  }
}
