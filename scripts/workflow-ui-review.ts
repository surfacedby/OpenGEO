import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  const project = runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["What is an example domain?"] }));
  runtime.store.set("onboarding", { completed: true });
  runtime.runner.providers.vault.set("console", { key: "synthetic-console-key" });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + (runtime.app.server.address() as any).port);
  await navigate(page, "Visibility");
  await page.getByRole("button", { name: "Check visibility", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Measure AI visibility" });
  await dialog.getByRole("button", { name: "Retry availability check", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start visibility check", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Retry availability check", exact: true }).click();
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).waitFor({ state: "visible" });
  await dialog.getByLabel("Approved run budget (USD)").fill("10001");
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).click();
  await dialog.getByText("Review the highlighted fields.", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Approved run budget (USD)").getAttribute("aria-invalid"), "true");
  assert.equal(runtime.store.jobs().length, 0);
  await dialog.getByRole("button", { name: /^Run budget:/ }).click();
  assert.equal(await dialog.getByLabel("Approved run budget (USD)").evaluate(element => element === document.activeElement), true);
  await dialog.getByLabel("Approved run budget (USD)").fill("0.20");
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).waitFor();
  // A browser transport failure happens before the backend creates any paid work.
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/jobs", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await held; await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).click();
  await dialog.getByRole("button", { name: "Starting...", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Close dialog", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1);
  release();
  await dialog.getByText("The workspace did not confirm this run. Check Recent activity or retry with the same inputs.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Start visibility check", exact: true }).isEnabled(), true);
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
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).click();
  await dialog.locator(".inline-error").waitFor();
  assert.equal(runtime.store.jobs().length, 1);
  const acceptedId = runtime.store.jobs()[0].id;
  assert.ok(acceptedKey.length >= 8);
  assert.equal(await page.locator('main > [role="alert"]').count(), 0, "The task form owns its error message");
  await page.unroute("**/api/jobs");
  let retryKey = "";
  await page.route("**/api/jobs", async route => { retryKey = route.request().headers()["idempotency-key"]; await route.continue(); });
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(runtime.store.jobs().length, 1);
  assert.equal(runtime.store.jobs()[0].id, acceptedId);
  assert.equal(retryKey, acceptedKey);
  assert.equal(runtime.store.jobs()[0].provider, "console");
  assert.equal(runtime.store.jobs()[0].maxCostUsd, 0.2);
  assert.equal(runtime.store.jobs()[0].status, "queued");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const content = page.getByRole("button", { name: "Content", exact: true });
  await content.focus(); await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Content", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  assert.equal(await content.getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("button", { name: "Actions", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const originals: string[] = [];
  for (const index of [0, 1, 2]) {
    const id = randomUUID(), derivedFrom = index === 2 ? originals[0] : undefined;
    const job = runtime.store.enqueue({ projectId: project.id, kind: derivedFrom ? 'revise' : 'content', provider: 'chatgpt', model: 'synthetic-ui-model', maxCostUsd: 0,
      ...(derivedFrom ? { contentId: derivedFrom, revisionInstructions: 'Clarify the opening.' } : { topic: 'Documentation examples' }) }, randomUUID());
    runtime.store.put('content', project.id, job.id, { id, topic: 'Documentation examples', markdown: '# Test draft\n\nSaved version ' + index, brief: 'A documentation example.', locale: 'en-US',
      createdAt: '2026-01-0' + (index + 1) + 'T12:00:00Z', ...(derivedFrom ? { derivedFrom } : {}) });
    runtime.store.updateJob(job.id, { status: 'completed', result: { id } });
    if (!derivedFrom) originals.push(id);
  }
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Your drafts 2', exact: true }).waitFor();
  assert.equal(await page.locator('.draft-card').count(), 2);
  assert.match(await page.locator('.draft-library').innerText(), /2 versions/);
  await page.getByRole('button', { name: 'Draft version', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search draft version', exact: true }).press('End');
  await page.keyboard.press('Enter');
  await page.getByText('Saved version 0', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Draft for Documentation examples', exact: true }).fill('# Preserved edits');
  await page.getByRole('button', { name: 'Draft version', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search draft version', exact: true }).press('Home');
  await page.keyboard.press('Enter');
  const saveChanges = page.getByRole('dialog', { name: 'Save your changes?', exact: true });
  await saveChanges.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Draft for Documentation examples', exact: true }).inputValue(), '# Preserved edits');
  await page.getByRole('button', { name: 'Draft version', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search draft version', exact: true }).press('Home');
  await page.keyboard.press('Enter');
  await saveChanges.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await page.getByText('Saved version 2', { exact: true }).waitFor();
  assert.equal(runtime.store.artifacts<any>(project.id, 'content').find(draft => draft.id === originals[0]).markdown, '# Preserved edits');
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: 780 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Content history at ' + width + 'px');
  }
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
  console.log("Actual browser verified: linked validation, availability retry, pending-run close protection, retained inputs, one queued job after a lost reply, connected-provider schedules and keyboard content navigation. No paid provider requests.");
} finally {
  release?.(); globalThis.fetch = original; await browser.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true });
}
