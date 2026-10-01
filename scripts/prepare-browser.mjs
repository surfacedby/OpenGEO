import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
// Each signing runner prepares its own OS and architecture browser bundle.
execFileSync(
  process.execPath,
  ["node_modules/playwright/cli.js", "install", "chromium"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: resolve(".browser-runtime"),
    },
  },
);
