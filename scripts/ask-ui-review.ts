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
const deepseekRequests: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const address = new URL(String(url));
  if (address.hostname === "api.deepseek.com") {
    deepseekRequests.push(address.pathname);
    if (address.pathname !== "/user/balance") throw new Error("Unexpected DeepSeek review request " + address.pathname);
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "5.00", granted_balance: "0.00", topped_up_balance: "5.00" }] }), { headers: { "Content-Type": "application/json" } });
  }
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
  runtime.runner.providers.vault.set("deepseek", { provider: "deepseek", key: "synthetic-deepseek-review-key" });
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

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator('.ask-settings-button').click();
  const modal = page.getByRole('dialog', { name: 'Ask a question', exact: true });
  await modal.locator('button[type="submit"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true, 'Ask keeps keyboard focus inside the modal');
  await page.mouse.click(100, 300);
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.ask-settings-button').evaluate(element => element === document.activeElement), true, 'Closing Ask returns focus to its opener');

  // Asking from the drawer navigates to the result; with the runner stopped every engine is collecting.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator('.ask-bar button[type="submit"]').click();
  await modal.waitFor();
  assert.equal(runtime.store.jobs(project.id).filter(job => job.kind === 'ask').length, 0, 'Header submissions must show paid approval again after the drawer was dismissed');
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

  // Accept the request at the server but lose its response. Retrying the same form must not buy a second group.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('textbox', { name: 'Find an ask' }).fill('a question that is not saved');
  await page.getByRole('heading', { name: 'No matching questions' }).waitFor();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  assert.equal(await page.locator('.ask-history li').count(), 1);
  const beforeRetry = runtime.store.jobs(project.id).filter(job => job.kind === 'ask').length;
  const keys: string[] = [];
  const retryQuestion = 'Synthetic review: can an accepted ask be retried safely?';
  const routePattern = '**/api/projects/' + project.id + '/asks';
  await page.route(routePattern, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch();
    if (keys.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await page.getByRole('textbox', { name: 'Ask every engine', exact: true }).fill(retryQuestion);
  await page.locator('.ask-bar button[type="submit"]').click();
  await page.locator('#ask-settings').getByRole('alert').waitFor();
  assert.equal(runtime.store.jobs(project.id).filter(job => job.kind === 'ask').length, beforeRetry + 1);
  await page.locator('#ask-settings').getByRole('button', { name: 'Ask 1 engine', exact: true }).click();
  await page.getByRole('heading', { name: retryQuestion, exact: true }).waitFor();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'An uncertain retry keeps the original request key');
  assert.equal(runtime.store.jobs(project.id).filter(job => job.kind === 'ask').length, beforeRetry + 1);
  await page.unroute(routePattern);
  await navigate(page, 'Prompts');
  await page.locator('.activity-notice').filter({ hasText: retryQuestion }).waitFor();
  await page.locator('.activity-notice').filter({ hasText: retryQuestion }).getByRole('button', { name: 'View progress' }).click();
  await page.getByRole('heading', { name: retryQuestion, exact: true }).waitFor();

  // DeepSeek: a metered engine priced at the most one answer can cost, answered with its own searches.
  const deepseekQuestion = 'Synthetic review: which example tools cite their sources?';
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('textbox', { name: 'Ask every engine', exact: true }).fill(deepseekQuestion);
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    if (!(await page.locator('#ask-settings').isVisible())) await page.locator(width > 900 ? '.ask-settings-button' : '.ask-mobile-trigger').first().click();
    const drawer = page.locator('#ask-settings');
    await drawer.waitFor();
    const box = drawer.getByRole('checkbox', { name: /DeepSeek/ });
    if (!(await box.isChecked())) await box.check();
    await drawer.getByText(/^up to \$0\.\d+$/).first().waitFor();
    await drawer.getByText(/DeepSeek's price is the most one answer can cost/).waitFor();
    await check(page, 'ask-drawer-deepseek', width);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator('.ask-bar button[type="submit"]').click();
  await page.locator('#ask-settings').waitFor();
  const deepseekBox = page.locator('#ask-settings').getByRole('checkbox', { name: /DeepSeek/ });
  if (!(await deepseekBox.isChecked())) await deepseekBox.check();
  await page.locator('#ask-settings').getByRole('button', { name: 'Ask 2 engines', exact: true }).click();
  await page.getByRole('heading', { name: deepseekQuestion, exact: true }).waitFor();
  const deepseekJob = runtime.store.jobs(project.id).find(job => job.kind === 'ask' && job.provider === 'deepseek')!;
  assert.equal(deepseekJob.maxCostUsd, 1, 'The only paid engine receives the whole limit');
  const freeJob = runtime.store.jobs(project.id).find(job => job.askId === deepseekJob.askId && job.provider === 'chatgpt')!;
  runtime.store.put('ask-answer', project.id, deepseekJob.id, { id: randomUUID(), projectId: project.id, jobId: deepseekJob.id, prompt: deepseekQuestion, provider: 'deepseek', platform: 'deepseek',
    model: 'deepseek-flash', locale: 'en-US', observedAt: new Date().toISOString(),
    answer: 'Example Reports cites every source it uses. See [Example reports](https://example.com/reports) and [a comparison](https://example.net/compare).',
    citations: [{ url: 'https://example.com/reports', title: 'Example reports' }, { url: 'https://example.net/compare', title: 'a comparison' }],
    surface: 'api', retrieval: 'web_search', webSearchConfirmed: true, searchQueries: ['example tools that cite sources', 'example reports site:example.com'],
    mentioned: true, cited: true, costUsd: 0.0021 } as Observation);
  runtime.store.updateJob(deepseekJob.id, { status: 'completed', progress: 'Complete', spentUsd: 0.0021, costBasis: 'includes_estimates' });
  runtime.store.updateJob(freeJob.id, { status: 'completed', progress: 'Complete' });
  await page.waitForTimeout(3500);
  const deepseekColumn = page.locator('.ask-column').filter({ has: page.getByRole('heading', { name: 'DeepSeek', exact: true }) });
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await deepseekColumn.getByText('Answered, $0.0021 est.', { exact: true }).waitFor();
    await page.getByText('$0.0021 recorded against your $1.00 limit', { exact: false }).waitFor();
    await deepseekColumn.getByText(/Web search confirmed/).waitFor();
    await deepseekColumn.scrollIntoViewIfNeeded();
    await check(page, 'ask-result-deepseek', width);
  }
  assert.deepEqual(deepseekRequests, [], 'Pricing and asking in the review never call DeepSeek');

  // Settings: the DeepSeek card connects with a pasted key, checked against DeepSeek's balance endpoint only.
  await page.setViewportSize({ width: 1360, height: 900 });
  await navigate(page, 'Settings');
  const card = page.locator('.provider-card.deepseek');
  await card.getByRole('button', { name: 'Manage', exact: true }).click();
  await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await card.getByText('Not connected', { exact: true }).waitFor();
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await card.scrollIntoViewIfNeeded();
    await check(page, 'settings-deepseek', width);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  if (!(await card.getByLabel('API key', { exact: true }).isVisible())) await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await card.getByLabel('API key', { exact: true }).fill('synthetic-deepseek-pasted-key');
  await card.getByRole('button', { name: 'Verify & connect', exact: true }).click();
  await card.getByText('Connected', { exact: true }).waitFor();
  assert.deepEqual(deepseekRequests, ['/user/balance']);
  await card.scrollIntoViewIfNeeded();
  await check(page, 'settings-deepseek-connected', 1360);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ output, screenshots: shots.length, providerRequests, deepseekRequests: deepseekRequests.length, externalRequests: 0, rendererErrors: failures.length }));
} finally {
  globalThis.fetch = original;
  await browser.close();
  await runtime.app.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Refusing cleanup outside the temporary test root");
  rmSync(directory, { recursive: true, force: true });
}
