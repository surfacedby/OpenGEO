import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
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
// Browser cache references contain host package paths and are unnecessary at runtime.
const references = resolve(".browser-runtime/.links");
if (existsSync(references)) {
  const directory = lstatSync(references);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Browser references must stay in their local cache directory.");
  for (const name of readdirSync(references)) {
    const file = resolve(references, name), entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unexpected browser cache reference.");
    unlinkSync(file);
  }
}
