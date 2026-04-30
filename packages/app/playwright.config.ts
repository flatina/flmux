import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: /\.playwright\.ts$/,
  // ptyd daemon is install-scoped — sequential only.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});
