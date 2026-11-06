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
const outputRoot = join(process.env.LOCALAPPDATA ?? tmpdir(), "OpenGEO");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(join(outputRoot, "ask-price-review-"));
const original = globalThis.fetch;
let providerRequests = 0;
let quoteLifetime = 3600000, quoteRequests = 0, geminiCredits = 1, externalRequests = 0;
let registeredWebsite = true;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const address = new URL(String(url));
  if (address.hostname !== "api.surfacedby.com") {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) return original(url, init);
    externalRequests++;
    throw new Error('Unexpected external request in isolated UI review');
  }
  providerRequests++;
  const path = address.pathname.replace("/api/v1/console", "");
  if (path.endsWith('/measurement/estimate')) quoteRequests++;
  const credits = init?.body && JSON.parse(String(init.body)).platform === 'gemini' ? geminiCredits : 1;
  const data = path === "/capabilities" ? { platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }, { key: "gemini", name: "Gemini", enabled: true }],
      operations: ["measurement"], content_available: false, models: [], selected_question_platforms: ["chatgpt", "gemini"],
      pricing: { credit_usd: .1, measurement: { estimates_free: true, estimate_validity_seconds: 900,
        credit_increment: 1, rounding: 'up_to_whole_credit_per_request', settlement: 'actual_usage_up_to_estimate',
        platforms: ['chatgpt', 'gemini'].map(platform => ({ platform, one_answer_credits: 1, one_answer_usd: '0.10' })) } } }
    : path === "/domains" ? (registeredWebsite ? [{ id: "00000000-0000-4000-8000-000000000001", domain: "example.com" }] : [])
    : path.endsWith("/measurement/estimate") ? { id: randomUUID(), domain_id: "00000000-0000-4000-8000-000000000001", operation: "measurement", estimated_credits: credits, estimated_usd: (credits / 10).toFixed(2), expires_at: new Date(Date.now() + quoteLifetime).toISOString() }
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

  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  await page.route('**/*', async route => {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname)) await route.continue();
    else { externalRequests++; await route.abort(); }
  });
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

  // Public prices are available without typing a question or requesting a quote.
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await page.locator(width > 900 ? '.ask-settings-button' : '.ask-mobile-trigger').first().click();
    const drawer = page.locator('#ask-settings');
    await drawer.getByText('Up to $0.10 per answer', { exact: true }).first().waitFor();
    assert.equal(await drawer.getByRole('textbox', { name: 'Question', exact: true }).inputValue(), '');
    assert.equal(quoteRequests, 0);
    await check(page, 'ask-price-menu', width);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
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
    for (const name of ["ChatGPT", "Gemini"]) {
      const box = drawer.locator('.ask-engine').filter({ has: page.getByText(name, { exact: true }) }).filter({ hasText: 'Your SurfacedBy connection' }).getByRole('checkbox');
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
  registeredWebsite = false;
  const beforeFirstAsk = quoteRequests;
  await modal.getByRole('textbox', { name: 'Question', exact: true }).fill(question + ' New website.');
  await modal.getByRole('status').filter({ hasText: 'after registering this website' }).waitFor();
  assert.equal(await modal.getByText('Up to $0.10 per answer', { exact: true }).count(), 2);
  assert.equal(quoteRequests, beforeFirstAsk);
  await modal.getByRole('textbox', { name: /Spending limit/ }).fill('0.19');
  assert.ok(await modal.getByRole('button', { name: 'Ask 3 engines', exact: true }).isDisabled());
  await modal.getByRole('button', { name: 'Raise limit to $0.20' }).click();
  assert.ok(await modal.getByRole('button', { name: 'Ask 3 engines', exact: true }).isEnabled());
  registeredWebsite = true;
  quoteLifetime = 1500;
  const pricingQuestion = question + ' Pricing review.';
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/asks/estimate') && response.request().postDataJSON()?.question === pricingQuestion),
    modal.getByRole('textbox', { name: 'Question', exact: true }).fill(pricingQuestion),
  ]);
  await modal.getByText('est. $0.10').first().waitFor();
  const beforeRefresh = quoteRequests;
  quoteLifetime = -1000;
  // The expired-price button can appear during the request debounce; observe the automatic response before judging refresh.
  await page.waitForResponse(response => response.url().endsWith('/asks/estimate') && response.request().postDataJSON()?.question === pricingQuestion);
  await modal.getByRole('button', { name: 'Refresh prices', exact: true }).waitFor();
  await modal.getByRole('status').filter({ hasText: "couldn't confirm a price" }).waitFor();
  assert.ok(await modal.getByRole('button', { name: 'Ask 3 engines', exact: true }).isDisabled());
  assert.ok(quoteRequests > beforeRefresh, 'Expired estimates refresh without editing the question');
  quoteLifetime = 3600000;
  await modal.getByRole('button', { name: 'Refresh prices', exact: true }).click();
  await modal.getByText('est. $0.10').first().waitFor();
  geminiCredits = 3;
  await modal.getByRole('textbox', { name: 'Question', exact: true }).fill(question + ' Different engine prices.');
  await modal.getByText('est. $0.30', { exact: true }).waitFor();
  await modal.getByRole('textbox', { name: /Spending limit/ }).fill('0.40');
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    assert.equal(await modal.getByRole('button', { name: 'Ask 3 engines', exact: true }).isEnabled(), true);
    assert.equal(await modal.getByRole('alert').count(), 0);
    await check(page, 'ask-unequal-prices', width);
    if (width === 390) {
      const submit = modal.getByRole('button', { name: 'Ask 3 engines', exact: true });
      await submit.scrollIntoViewIfNeeded();
      const bounds = await submit.boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 780, 'Mobile approval remains reachable');
      await check(page, 'ask-mobile-approval', width);
    }
  }
  geminiCredits = 1;
  await page.setViewportSize({ width: 1360, height: 900 });
  await modal.getByRole('textbox', { name: /Spending limit/ }).fill('1.00');
  await modal.getByRole('textbox', { name: 'Question', exact: true }).fill(question);
  await modal.getByText('est. $0.30', { exact: true }).waitFor({ state: 'hidden' });
  await modal.getByText('est. $0.10').nth(1).waitFor();
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
    runtime.store.updateJob(job.id, { status: "completed", progress: "Complete", spentUsd: surface === "api" ? 0 : .1, costBasis: 'reported' });
  };
  answer(jobs[0], "**Yes.** Several example tools publish free reports:\n\n| Need | Tool |\n|---|---|\n| Share a report | Example Reports |\n| Compare tools | Example Compare |\n\nMost of them need an account.", "api", false);
  runtime.store.updateJob(jobs[1].id, { spentUsd: .5, costBasis: 'includes_estimates' });
  runtime.store.updateJob(jobs[2].id, { status: "completed", progress: "Complete" });
  await page.waitForTimeout(3500);
  await page.getByText('$0.50 recorded, including reserved or estimated charges', { exact: false }).waitFor();
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
    await page.locator('.ask-history').getByText('$0.50 including estimates', { exact: false }).waitFor();
    await check(page, "ask-history", width);
  }
  answer(jobs[1], 'Example Reports publishes free reports with source links.', 'consumer_interface', true);
  await page.locator('.ask-history').getByText('$0.10 charged', { exact: false }).waitFor();

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

  // The approval screen displays the saved dollar limit without inventing a credit conversion.
  const pending = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content', provider: 'console',
    topic: 'Synthetic price approval', maxCostUsd: 0.75 }), randomUUID());
  runtime.store.updateJob(pending.id, { status: 'paused', error: 'approval', progress: 'Estimated maximum: $0.50. Approve to start.' });
  await navigate(page, 'Content');
  await page.getByRole('button', { name: 'Review price', exact: true }).click();
  const approval = page.locator('.resume-review');
  await approval.getByText('Your spending limit is $0.75.', { exact: false }).waitFor();
  for (const width of [1360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await approval.scrollIntoViewIfNeeded();
    await check(page, 'managed-price-approval', width);
  }
  await approval.getByRole('button', { name: 'Keep paused', exact: true }).click();
  assert.equal(runtime.store.job(pending.id).status, 'paused');
  assert.deepEqual(failures, []);
  assert.equal(externalRequests, 0);
  console.log(JSON.stringify({ output, screenshots: shots.length, providerRequests, externalRequests, rendererErrors: failures.length }));
} finally {
  globalThis.fetch = original;
  await browser.close();
  await runtime.app.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Refusing cleanup outside the temporary test root");
  rmSync(directory, { recursive: true, force: true });
}
