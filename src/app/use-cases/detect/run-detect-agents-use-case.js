import { collectAgentInventories } from "../../../infra/internal/agents.js";
import { redactPathDetails } from "../../../shared/text.js";

function toPublicParseErrors(parseErrors) {
  return (Array.isArray(parseErrors) ? parseErrors : []).map((issue) => ({
    kind: issue.kind,
    message: redactPathDetails(issue.message)
  }));
}

export async function runDetectAgentsUseCase({ agents } = {}) {
  const inventory = await collectAgentInventories({ agents });
  const tools = inventory.agents.map((agent) => ({
    tool: agent.tool,
    managedSurface: agent.managedSurface,
    hasNonMcpConfig: agent.hasNonMcpConfig,
    hasSkills: agent.hasSkillsPath,
    hasMcp: agent.hasMcpPath,
    installed: agent.installed,
    parseErrors: toPublicParseErrors(agent.parseErrors)
  }));

  return {
    os: inventory.os,
    tools
  };
}
