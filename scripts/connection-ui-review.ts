import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { start } from "../server/main.js";
import { projectInput } from "../server/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "opengeo-connection-ui-"));
const runtime = await start({ directory, port: 0, protector: { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() } });
const original = globalThis.fetch;
let requests = 0, release!: () => void;
const validation = new Promise<void>(resolve => { release = resolve; });
globalThis.fetch = (async url => {
  assert.equal(String(url), "https://api.surfacedby.com/api/v1/console/capabilities");
  requests++;
  if (requests === 1) await validation;
  return new Response(JSON.stringify({ data: { platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }] } }), {
    status: requests === 2 ? 503 : 200, headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await runtime.runner.stop(); runtime.scheduler.stop();
  runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
  runtime.store.set("onboarding", { completed: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + (runtime.app.server.address() as any).port);
  await navigate(page, "Settings");
  const card = page.locator(".provider-card.console");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByRole("button", { name: "I have a key", exact: true }).click();
  await card.getByLabel("API key", { exact: true }).fill("x");
  await card.getByRole("button", { name: "Verify & connect", exact: true }).click();
  await page.getByText("Review the highlighted fields.", { exact: true }).waitFor();
  assert.equal(await card.getByLabel("API key", { exact: true }).getAttribute("aria-invalid"), "true");
  assert.equal(requests, 0);
  await page.getByRole("button", { name: /^API key:/ }).click();
  assert.equal(await card.getByLabel("API key", { exact: true }).evaluate(element => element === document.activeElement), true);
  await card.getByLabel("API key", { exact: true }).fill("synthetic-console-key");
  await card.getByRole("button", { name: "Verify & connect", exact: true }).click();
  await page.getByRole("button", { name: "Verifying connection...", exact: true }).waitFor();
  assert.equal(await page.locator(".provider-card.chatgpt").getByRole("button", { name: "Continue with ChatGPT", exact: true }).isDisabled(), true);
  assert.equal(requests, 1);
  release();
  await card.getByText("Platform availability could not be checked.", { exact: true }).waitFor();
  assert.equal(await card.getByText("Loading supported platforms", { exact: true }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Retry platform check", exact: true }).count(), 1);
  await card.getByRole("button", { name: "Retry platform check", exact: true }).click();
  await card.locator(".platform-list").getByText("ChatGPT", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Retry platform check", exact: true }).count(), 0);
  assert.equal(requests, 3);
  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await card.getByRole("button", { name: "4 more", exact: true }).waitFor();
  assert.equal(await card.locator(".platform-list").getByText("Gemini", { exact: true }).count(), 1);
  assert.equal(await card.getByText("Platform availability could not be checked.", { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(failures, []);
  console.log("Actual browser verified: connection mutation guard, capability failure, explicit retry, refreshed supported platforms, disconnect cleanup and mobile layout. No paid requests.");
} finally { release(); globalThis.fetch = original; await browser.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true }); }
