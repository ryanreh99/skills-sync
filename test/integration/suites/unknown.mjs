import assert from "node:assert/strict";
import { runCli } from "../helpers.mjs";

/**
 * Tests that unknown or removed commands are rejected with exit code 2.
 */
export async function run() {
  const removedOrInvalid = [
    ["update-upstreams", "--profile", "personal"],
    ["list-upstream-skills", "--upstream", "anthropic"],
    ["use-examples"],
    ["build", "--profile", "personal", "--no-lock-update"],
    ["frobnicate"],
    ["list", "packs"],
    ["search", "packs"]
  ];

  for (const args of removedOrInvalid) {
    const result = runCli(args, 2);
    assert.equal(
      (result.stderr || "").trim(),
      "Unknown command. See: help",
      `Expected rejection message for: ${args.join(" ")}`
    );
  }
}
