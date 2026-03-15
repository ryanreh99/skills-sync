import { defineConfig } from "@microsoft/tui-test";

export default defineConfig({
  expect: {
    timeout: 15000
  },
  reporter: "list",
  shellReadyTimeout: 15000,
  testMatch: "**/interactive.test.mjs",
  timeout: 60000,
  workers: 1
});
