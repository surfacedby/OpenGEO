import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { start } from "../server/main.js";
import { jobInput, projectInput, type Observation } from "../server/contracts.js";

// DeepSeek in visibility checks, in a real browser: the brand view after a DeepSeek check, the check dialog's
// suggested budget, and the schedule form. Synthetic example.com data; DeepSeek is answered in process.
const directory = mkdtempSync(join(tmpdir(), "opengeo-deepseek-check-ui-"));
const output = join(process.env.LOCALAPPDATA ?? tmpdir(), "OpenGEO", "deepseek-check-review");
mkdirSync(output, { recursive: true });
const runtime = await start({ directory, port: 0, protector: { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() } });
const original = globalThis.fetch;
const deepseekRequests: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
  const address = new URL(String(url));
  assert.equal(address.hostname, "api.deepseek.com", "only DeepSeek may be called in this review");
  deepseekRequests.push(address.pathname);
  assert.equal(address.pathname, "/models");
  return new Response(JSON.stringify({ object: "list", data: ["deepseek-flash", "deepseek-v4-pro"].map(id => ({ id, object: "model", owned_by: "deepseek" })) }),
    { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const browser = await chromium.launch({ ...(process.env.OPENGEO_TEST_BROWSER ? { executablePath: process.env.OPENGEO_TEST_BROWSER } : { channel: "chrome" }), headless: true });
const shots: string[] = [];
async function check(page: Page, name: string, width: number) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflows at ${width}px`);
  const file = join(output, `${name}-${width}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}
try {
  await runtime.runner.stop(); runtime.scheduler.stop();
  const prompts = Array.from({ length: 82 }, (_, i) => `Synthetic review question ${i + 1}: which example tools publish reports?`);
  const project = runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example Brand", prompts }));
  runtime.store.set("onboarding", { completed: true });
  runtime.runner.providers.vault.set("deepseek", { provider: "deepseek", key: "synthetic-deepseek-review-key" });
  // An earlier ChatGPT check, then a newer DeepSeek check: the brand view shows the newer one.
  const seed = (provider: "chatgpt" | "deepseek", model: string, at: string, mentioned: number) => {
    const job = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider, model, maxCostUsd: provider === "chatgpt" ? 0 : 1 }), "seed-" + provider);
    prompts.forEach((prompt, i) => runtime.store.put("observation", project.id, job.id, { id: randomUUID(), projectId: project.id, jobId: job.id, prompt, provider,
      platform: provider === "chatgpt" ? "chat_gpt" : "deepseek", model, locale: "en-US", observedAt: at,
      answer: i < mentioned ? "Example Brand publishes reports at https://example.com/reports." : "Several example tools publish reports.",
      citations: i < mentioned ? [{ url: "https://example.com/reports" }] : [{ url: "https://example.org/compare" }], surface: "api", retrieval: "web_search",
      webSearchConfirmed: true, ...(provider === "deepseek" ? { searchQueries: ["example tools publish reports"] } : {}),
      mentioned: i < mentioned, cited: i < mentioned, costUsd: provider === "chatgpt" ? 0 : 0.005 } satisfies Observation));
    runtime.store.updateJob(job.id, { status: "completed", requestedAnswers: prompts.length, spentUsd: provider === "chatgpt" ? 0 : 0.41,
      result: { metrics: { requested: 82, completed: 82, missing: 0, mentionRate: mentioned / 82 * 100, citationRate: mentioned / 82 * 100 }, collectionCompletedAt: at } });
    return runtime.store.job(job.id);
  };
  seed("chatgpt", "synthetic-gpt", "2026-11-11T15:42:00.000Z", 7);
  await new Promise(resolve => setTimeout(resolve, 5));
  const deepseekCheck = seed("deepseek", "deepseek-flash", "2026-11-13T15:10:00.000Z", 12);
  assert.equal(deepseekCheck.platform, "deepseek");

  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + (runtime.app.server.address() as any).port);
  await page.locator(".topbar").waitFor();

  // The brand view after a DeepSeek check: its rates, labelled DeepSeek once.
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await navigate(page, "Overview");
    const scope = page.getByLabel("Current measurement scope").first();
    await scope.waitFor();
    assert.equal(await scope.getByText("DeepSeek", { exact: true }).count(), 1, "the scope bar names DeepSeek once");
    await check(page, "overview-deepseek", width);
  }

  // A DeepSeek-only connection unlocks a check, and the dialog suggests a budget that finishes 82 questions.
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await navigate(page, "Visibility");
    await page.getByRole("button", { name: "Check visibility", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Measure AI visibility" });
    await dialog.getByText("Suggested for 82 questions.", { exact: false }).waitFor();
    assert.equal(await dialog.getByLabel("Approved run budget (USD)").inputValue(), "1");
    assert.equal(await dialog.getByText("prepares recommendations", { exact: false }).count(), 0, "a DeepSeek check collects answers only");
    await dialog.getByText("Checks answers from DeepSeek", { exact: false }).waitFor();
    assert.equal(await dialog.getByText("OpenRouter", { exact: false }).count(), 0, "the DeepSeek dialog never names another provider's charges");
    await check(page, "check-dialog-deepseek", width);
    if (width !== 390) { await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); }
  }
  const dialog = page.getByRole("dialog", { name: "Measure AI visibility" });
  await dialog.getByRole("button", { name: "Start visibility check", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const started = runtime.store.jobs(project.id).find(job => job.kind === "measure" && job.status === "queued")!;
  assert.deepEqual([started.provider, started.platform, started.maxCostUsd, started.prepareRecommendations ?? false], ["deepseek", "deepseek", 1, false]);

  // The schedule form offers DeepSeek for a recheck.
  await page.setViewportSize({ width: 1360, height: 900 });
  await navigate(page, "Settings");
  await page.getByRole("tab", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "Add schedule", exact: true }).click();
  await page.getByRole("button", { name: "Scheduled workflow", exact: true }).click();
  await page.getByRole("option", { name: "Visibility recheck", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Schedule connection", exact: true }).innerText(), "DeepSeek");
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await check(page, "schedule-deepseek", width);
  }
  assert.deepEqual(failures, []);
  assert.ok(deepseekRequests.every(path => path === "/models"));
  console.log(JSON.stringify({ output, screenshots: shots.length, deepseekRequests: deepseekRequests.length, rendererErrors: failures.length }));
} finally {
  globalThis.fetch = original; await browser.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true });
}
