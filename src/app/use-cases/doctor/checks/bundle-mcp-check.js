import fs from "fs-extra";
import path from "node:path";
import {
  CACHE_ROOT,
  SCHEMAS,
  assertJsonFileMatchesSchema
} from "../../../../infra/internal/core.js";
import { addDoctorError } from "../../../../domain/doctor/report.js";
import { getRuntimeBundlePath, runtimePathExists } from "../../../../infra/repositories/runtime-repository.js";

async function validateBundleMcp(bundleMcpPath, report) {
  try {
    const canonical = await fs.readJson(bundleMcpPath);
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      throw new Error("MCP bundle must be a JSON object.");
    }
    if (!canonical.mcpServers || typeof canonical.mcpServers !== "object" || Array.isArray(canonical.mcpServers)) {
      throw new Error("MCP bundle must contain object field 'mcpServers'.");
    }

    const projected = { servers: {} };
    for (const [name, server] of Object.entries(canonical.mcpServers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) {
        throw new Error(`mcpServers['${name}'] must be an object.`);
      }
      if (typeof server.url === "string" && server.url.trim().length > 0) {
        projected.servers[name] = { url: server.url.trim() };
        continue;
      }
      if (typeof server.command !== "string" || server.command.trim().length === 0) {
        throw new Error(`mcpServers['${name}'] must define either non-empty url or command.`);
      }

      const projectedServer = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : []
      };
      if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
        const env = {};
        for (const key of Object.keys(server.env).sort((left, right) => left.localeCompare(right))) {
          if (key.length === 0) {
            continue;
          }
          env[key] = String(server.env[key]);
        }
        if (Object.keys(env).length > 0) {
          projectedServer.env = env;
        }
      }
      projected.servers[name] = projectedServer;
    }

    // Validate the projected shape against the input MCP servers contract.
    const tempMcpShapePath = path.join(CACHE_ROOT, ".doctor-mcp-shape.json");
    await fs.ensureDir(path.dirname(tempMcpShapePath));
    await fs.writeFile(tempMcpShapePath, `${JSON.stringify(projected)}\n`, "utf8");
    await assertJsonFileMatchesSchema(tempMcpShapePath, SCHEMAS.mcpServers);
    await fs.remove(tempMcpShapePath).catch(() => {});
  } catch (error) {
    addDoctorError(report, `Invalid canonical MCP at ${bundleMcpPath}: ${error.message}`);
  }
}

export async function runBundleMcpCheck(report) {
  if (!(await runtimePathExists("common", "mcp.json"))) {
    return;
  }
  await validateBundleMcp(getRuntimeBundlePath("common", "mcp.json"), report);
}
