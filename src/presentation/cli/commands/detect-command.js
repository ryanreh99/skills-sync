import { runDetectAgentsUseCase } from "../../../app/use-cases/detect/run-detect-agents-use-case.js";
import { presentDetectResult } from "../../presenters/detect-presenter.js";

export async function cmdDetect({ format = "text", agents } = {}) {
  const result = await runDetectAgentsUseCase({ agents });
  presentDetectResult(result, { format });
}
