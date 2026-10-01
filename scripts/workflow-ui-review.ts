import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { start } from "../server/main.js";
import { projectInput } from "../server/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "opengeo-workflow-ui-"));
const runtime = await start({ directory, port: 0, protector: { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() } });
const original = globalThis.fetch;
let discoveryRequests = 0;
globalThis.fetch = (async url => {
  assert.equal(String(url), "https://api.surfacedby.com/api/v1/console/capabilities");
  discoveryRequests++;
  return new Response(JSON.stringify({ data: { platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }] } }), {
    status: discoveryRequests === 1 ? 503 : 200, headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;
const browser = await chromium.launch({ channel: "chrome", headless: true });
let release: (() => void) | undefined;
try {
  await runtime.runner.stop(); runtime.scheduler.stop();
  runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["What is an example domain?"] }));
  runtime.store.set("onboarding", { completed: true });
  runtime.runner.providers.vault.set("console", { key: "synthetic-console-key" });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + (runtime.app.server.address() as any).port);
  await navigate(page, "Visibility");
  await page.getByRole("button", { name: "Check visibility", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Measure AI visibility" });
  await dialog.getByRole("button", { name: "Retry availability check", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start workflow", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Retry availability check", exact: true }).click();
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).waitFor({ state: "visible" });
  await dialog.getByLabel("Approved run budget (USD)").fill("10001");
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).click();
  await dialog.getByText("Review the highlighted fields.", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Approved run budget (USD)").getAttribute("aria-invalid"), "true");
  assert.equal(runtime.store.jobs().length, 0);
  await dialog.getByRole("button", { name: /^Run budget:/ }).click();
  assert.equal(await dialog.getByLabel("Approved run budget (USD)").evaluate(element => element === document.activeElement), true);
  await dialog.getByLabel("Approved run budget (USD)").fill("0.20");
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).waitFor();
  // A browser transport failure happens before the backend creates any paid work.
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/jobs", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await held; await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).click();
  await dialog.getByRole("button", { name: "Starting...", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Close dialog", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1);
  release();
  await dialog.getByText("The workspace did not confirm this run. Check Recent activity or retry with the same inputs.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start workflow", exact: true }).isEnabled(), true);
  assert.equal(await dialog.getByLabel("Approved run budget (USD)").inputValue(), "0.20");
  assert.equal(runtime.store.jobs().length, 0);
  await page.unroute("**/api/jobs");
  // The backend accepts this request, but the browser never receives its reply.
  let acceptedKey = "";
  await page.route("**/api/jobs", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    acceptedKey = route.request().headers()["idempotency-key"];
    const response = await route.fetch(); assert.equal(response.ok(), true);
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).click();
  await dialog.locator(".inline-error").waitFor();
  assert.equal(runtime.store.jobs().length, 1);
  const acceptedId = runtime.store.jobs()[0].id;
  assert.ok(acceptedKey.length >= 8);
  assert.equal(await page.locator('main > [role="alert"]').count(), 0, "The task form owns its error message");
  await page.unroute("**/api/jobs");
  let retryKey = "";
  await page.route("**/api/jobs", async route => { retryKey = route.request().headers()["idempotency-key"]; await route.continue(); });
  await dialog.getByRole("button", { name: "Start workflow", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(runtime.store.jobs().length, 1);
  assert.equal(runtime.store.jobs()[0].id, acceptedId);
  assert.equal(retryKey, acceptedKey);
  assert.equal(runtime.store.jobs()[0].provider, "console");
  assert.equal(runtime.store.jobs()[0].maxCostUsd, 0.2);
  assert.equal(runtime.store.jobs()[0].status, "queued");
  await navigate(page, "Actions");
  const plan = page.getByRole("tab", { name: /Improvement plan/ });
  const content = page.getByRole("tab", { name: /Content drafts/ });
  await plan.focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await content.getAttribute("aria-selected"), "true");
  assert.equal(await content.evaluate(element => element === document.activeElement), true);
  await page.keyboard.press("Home");
  assert.equal(await plan.getAttribute("aria-selected"), "true");
  assert.equal(await plan.evaluate(element => element === document.activeElement), true);
  await navigate(page, "Settings");
  await page.getByRole("tab", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  await page.getByRole("button", { name: "Scheduled workflow", exact: true }).click();
  await page.getByRole("option", { name: "Visibility recheck", exact: true }).click();
  await page.getByLabel("Maximum per run (USD)", { exact: true }).fill("0.20");
  await page.getByLabel("Monthly maximum (USD)", { exact: true }).fill("10001");
  await page.getByRole("button", { name: "Save schedule", exact: true }).click();
  await page.getByText("Review the highlighted fields.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Monthly maximum (USD)", { exact: true }).getAttribute("aria-invalid"), "true");
  assert.equal(runtime.scheduler.list().length, 0);
  await page.getByRole("button", { name: /^Monthly budget:/ }).click();
  assert.equal(await page.getByLabel("Monthly maximum (USD)", { exact: true }).evaluate(element => element === document.activeElement), true);
  await page.getByLabel("Monthly maximum (USD)", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save schedule", exact: true }).click();
  await page.getByText("Schedule saved.", { exact: true }).waitFor();
  assert.equal(runtime.scheduler.list().length, 1);
  assert.equal(runtime.scheduler.list()[0].job.provider, "console");
  assert.equal(runtime.scheduler.list()[0].monthlyBudgetUsd, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(failures, []);
  console.log("Actual browser verified: linked validation, availability retry, pending-run close protection, retained inputs, one queued job after a lost reply, connected-provider schedules and keyboard action tabs. No paid provider requests.");
} finally {
  release?.(); globalThis.fetch = original; await browser.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true });
}
