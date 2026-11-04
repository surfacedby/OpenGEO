import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { chromium, type Page } from "playwright";
import { start } from "../server/main.js";
import { jobInput, projectInput, type Observation } from "../server/contracts.js";
import { navigate } from "./ui-navigation.js";

// Labelled synthetic review data on example domains. Providers are answered in process, so no request leaves this machine.
const directory = mkdtempSync(join(tmpdir(), "opengeo-ask-ui-"));
const output = join(process.env.LOCALAPPDATA ?? tmpdir(), "OpenGEO", "ask-ux-review");
mkdirSync(output, { recursive: true });
const original = globalThis.fetch;
let providerRequests = 0;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const address = new URL(String(url));
  if (address.hostname !== "api.surfacedby.com") return original(url, init);
  providerRequests++;
  const path = address.pathname.replace("/api/v1/console", "");
  const data = path === "/capabilities" ? { platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }, { key: "gemini", name: "Gemini", enabled: true }],
      operations: ["measurement"], content_available: false, models: [], selected_question_platforms: ["chatgpt", "gemini"] }
    : path === "/domains" ? [{ id: "00000000-0000-4000-8000-000000000001", domain: "example.com" }]
    : path.endsWith("/measurement/estimate") ? { id: randomUUID(), domain_id: "00000000-0000-4000-8000-000000000001", operation: "measurement", estimated_credits: 1, expires_at: new Date(Date.now() + 3600000).toISOString() }
    : null;
  if (!data) throw new Error("Unexpected review request " + path);
  return new Response(JSON.stringify({ data, meta: {} }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const runtime = await start({ directory, port: 0, protector: { encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() } });
const browser = await chromium.launch({ ...(process.env.OPENGEO_TEST_BROWSER ? { executablePath: process.env.OPENGEO_TEST_BROWSER } : { channel: "chrome" }), headless: true });
const failures: string[] = [];
const shots: string[] = [];
async function check(page: Page, name: string, width: number) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflows at ${width}px`);
  const file = join(output, `${name}-${width}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}
try {
  await runtime.runner.stop();
  runtime.scheduler.stop();
  const question = "Synthetic review: which example tools publish free reports?";
  const project = runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "UX test data", prompts: [question],
    topics: [{ id: randomUUID(), name: "Documentation examples", prompts: [], createdAt: "2026-10-01T10:00:00.000Z" }] }));
  runtime.store.set("onboarding", { completed: true });
  const auth = { authorization: "Bearer " + runtime.token };
  for (const provider of ["chatgpt", "console"] as const) {
    const body = provider === "chatgpt"
      ? { active: "review", profiles: [{ id: "review", access_token: "synthetic-access", expiresAt: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] }] }
      : { key: "synthetic-console-credential" };
    runtime.runner.providers.vault.set(provider, body);
  }
  const discover = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: "discover", provider: "chatgpt", auditJobId: randomUUID() }), randomUUID());
  runtime.store.updateJob(discover.id, { status: "completed", result: { questions: [
    { text: "Synthetic review: how do teams compare example dashboards?" }, { text: "Synthetic review: which example reports can be shared publicly?" },
    { text: "Synthetic review: what should an example status page include?" }] } });
  const check0 = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt", model: "synthetic-ui-model" }), randomUUID());
  runtime.store.put("observation", project.id, check0.id, { id: randomUUID(), projectId: project.id, jobId: check0.id, prompt: question, provider: "chatgpt",
    platform: "chat_gpt", model: "synthetic-ui-model", locale: "en-US", observedAt: "2026-10-30T10:00:00.000Z", answer: "Example tools publish reports.",
    citations: [{ url: "https://example.com/reports" }], surface: "api", mentioned: true, cited: true, costUsd: 0 } satisfies Observation);
  runtime.store.updateJob(check0.id, { status: "completed", requestedAnswers: 1, result: { metrics: { requested: 1, completed: 1, missing: 0, mentionRate: 100, citationRate: 100 }, collectionCompletedAt: "2026-10-30T10:00:00.000Z" } });

  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("http://127.0.0.1:" + (runtime.app.server.address() as any).port);
  await page.locator(".topbar").waitFor();

  // First visit: no asks yet, suggestions from the latest question suggestions.
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await navigate(page, "Ask history");
    await page.getByRole("heading", { name: "Ask a question the way a person would search it" }).waitFor();
    await check(page, "ask-empty", width);
  }

  // Settings drawer: the search moves into it; paid engines priced; then over the limit.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("searchbox").or(page.getByLabel("Ask every engine")).first().fill(question);
  await check(page, "ask-header", 1360);
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    if (!(await page.locator("#ask-settings").isVisible())) await page.locator(width > 900 ? ".ask-settings-button" : ".ask-mobile-trigger").first().click();
    const drawer = page.locator("#ask-settings");
    await drawer.waitFor();
    for (const name of ["ChatGPT app", "Gemini app"]) {
      const box = drawer.getByRole("checkbox", { name: new RegExp(name) });
      if (!(await box.isChecked())) await box.check();
    }
    await drawer.getByText("est. $0.10").first().waitFor();
    await check(page, "ask-drawer", width);
    await drawer.getByRole("textbox", { name: /Spending limit/ }).fill("0.10");
    await drawer.getByRole("alert").waitFor();
    assert.equal(await drawer.getByRole("button", { name: /^Ask 3 engines$/ }).isDisabled(), true);
    await check(page, "ask-over-limit", width);
    await drawer.getByRole("textbox", { name: /Spending limit/ }).fill("1.00");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
  }

  // Asking from the drawer navigates to the result; with the runner stopped every engine is collecting.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator(".ask-settings-button").click();
  await page.locator("#ask-settings").getByRole("button", { name: "Ask 3 engines" }).click();
  await page.getByRole("heading", { name: question }).waitFor();
  assert.equal(await page.locator(".ask-settings-button").innerText(), "1 engine");
  const askId = (await runtime.app.inject({ url: `/api/projects/${project.id}/asks`, headers: auth })).json().asks[0].askId;
  const jobs = runtime.store.jobs(project.id).filter((job) => job.askId === askId).reverse();
  assert.deepEqual(jobs.map((job) => job.maxCostUsd), [0, .5, .5]);
  // Settle them into the three outcomes a reader meets: answered, still collecting, and no answer.
  const answer = (job: (typeof jobs)[number], text: string, surface: "api" | "consumer_interface", cited: boolean) => {
    runtime.store.put("ask-answer", project.id, job.id, { id: randomUUID(), projectId: project.id, jobId: job.id, prompt: question, provider: job.provider!, platform: job.platform,
      model: surface === "api" ? "synthetic-ui-model" : "synthetic-app", locale: "en-US", observedAt: new Date().toISOString(), answer: text,
      citations: [{ url: cited ? "https://example.com/reports" : "https://example.org/reports", title: "Free example reports" }, { url: "https://example.net/compare", title: "Comparing example tools" }],
      surface, retrieval: surface === "api" ? "web_search" : undefined, webSearchConfirmed: surface === "api" ? true : undefined,
      searchQueries: surface === "api" ? ["free example report tools", "example tools publish reports"] : undefined, mentioned: cited, cited, costUsd: 0 } as Observation);
    runtime.store.updateJob(job.id, { status: "completed", progress: "Complete", spentUsd: surface === "api" ? 0 : .1 });
  };
  answer(jobs[0], "**Yes.** Several example tools publish free reports:\n\n| Need | Tool |\n|---|---|\n| Share a report | Example Reports |\n| Compare tools | Example Compare |\n\nMost of them need an account.", "api", false);
  runtime.store.updateJob(jobs[2].id, { status: "completed", progress: "Complete" });
  await page.waitForTimeout(3500);
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await page.getByText("No answer collected").first().waitFor();
    await check(page, "ask-result", width);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "Track this question" }).click();
  await page.getByRole("dialog", { name: "Track this question" }).waitFor();
  await check(page, "ask-track", 1360);
  await page.getByRole("dialog", { name: "Track this question" }).getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Ask history" }).first().click();
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await page.locator(".ask-history").waitFor();
    await check(page, "ask-history", width);
  }
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ output, screenshots: shots.length, providerRequests, externalRequests: 0, rendererErrors: failures.length }));
} finally {
  globalThis.fetch = original;
  await browser.close();
  await runtime.app.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Refusing cleanup outside the temporary test root");
  rmSync(directory, { recursive: true, force: true });
}
