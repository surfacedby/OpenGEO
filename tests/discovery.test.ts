import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { Connections } from "../server/oauth.js";
import { Providers } from "../server/providers.js";
import { Runner } from "../server/workflows.js";
import { parsePage } from "../server/audit.js";
import { createApp } from "../server/app.js";
import { jobInput, projectInput } from "../server/contracts.js";
import { sitemapPages } from "../server/sitemap.js";
import { connectionPage } from "../server/connection-page.js";
import { consoleCapabilities } from "../server/console-capabilities.js";
import { completedMeasurement } from "../server/portable-results.js";
import { comparableHistory } from "../server/presentation.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-discovery-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("chatgpt", { active: "test-account", profiles: [{ id: "test-account", access_token: "synthetic-access", expiresAt: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] }] });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["What tools help teams answer customer questions?"] }));
  const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "discovery-audit");
  store.setStep(audit.id, "project", "done", project);
  const page = parsePage("https://example.com/", 200, '<html><title>Customer support workspace</title><body><h1>Support for small teams</h1><p>Our customer support workspace helps small teams organize questions, write replies and share support knowledge. Manage the support process in one place.</p></body></html>');
  store.put("page", project.id, audit.id, page); store.updateJob(audit.id, { status: "completed" });
  return { directory, store, vault, runner, project, page, audit, async close() { connections.close(); await runner.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
function stream(text: string, citations: unknown[] = []) {
  return new Response('data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "web_search_call", status: "completed" }, { content: [{ type: "output_text", text, annotations: citations }] }] } }) + '\n\n');
}

test("website suggestions use readable evidence, exclude brand-biased duplicates and never silently change tracked prompts", async () => {
  const f = fixture(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    assert.equal(String(url), "https://api.openai.com/v1/responses"); calls++;
    const request = JSON.parse(init!.body as string), evidence = JSON.parse(request.input[0].content);
    assert.equal(request.tools, undefined);
    if (evidence.pages && !evidence.candidates) {
      assert.equal(evidence.pages[0].id, f.page.id); assert.match(evidence.pages[0].text, /customer support/);
      return stream(JSON.stringify({ siteType: "business", audience: "Small support teams", offerings: [{ id: "support", label: "Shared support workspace", customerNeed: "Organize customer questions", evidence: [{ pageId: f.page.id, quote: "Our customer support workspace helps small teams organize questions" }] }], incidentalTopics: ["An employee's unrelated prior work"] }));
    }
    if (evidence.candidates) return stream(JSON.stringify({ questions: evidence.candidates.map((question: any) => ({ index: question.index, text: question.text })) }));
    assert.equal(evidence.pages, undefined, "Question drafting uses confirmed offerings rather than raw mixed page text");
    return stream(JSON.stringify({ questions: [
      { text: "Which tools help small teams manage customer questions?", offeringId: "support", intent: "discover" },
      { text: "Which tools help small teams manage customer questions?", offeringId: "support", intent: "choose" },
      { text: "Why should I use Example for customer support?", offeringId: "support", intent: "choose" },
    ] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt", auditJobId: f.audit.id }), "suggestions-test");
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "completed");
    const result = f.store.job(job.id).result as any;
    assert.equal(result.questions.length, 1); assert.equal(result.questions[0].sources[0].url, f.page.url);
    assert.deepEqual(f.store.project(f.project.id).prompts, f.project.prompts);
    f.store.updateJob(f.store.jobs(f.project.id).find(item => item.kind === 'audit')!.id, {status:'failed'});
    await f.runner.execute(f.store.job(job.id), f.project, new AbortController().signal);
    assert.equal(calls, 3, "Saved inventory, questions and review are not requested again after an interrupted response");
  } finally { globalThis.fetch = original; await f.close(); }
});

test("question discovery rejects unsupported inventory and exposes only independently reviewed customer wording", async () => {
  const f = fixture(), original = globalThis.fetch; let unsupported = true, calls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    calls++;
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    if (input.pages && !input.candidates) return stream(JSON.stringify({ siteType: "business", audience: "Small support teams", offerings: [{ id: "support", label: "Support workspace", customerNeed: "Keep customer questions organized", evidence: [{ pageId: f.page.id, quote: unsupported ? "This passage does not occur in the supplied page" : "Our customer support workspace helps small teams organize questions" }] }], incidentalTopics: [] }));
    if (input.inventory && !input.candidates) return stream(JSON.stringify({ questions: [{ text: "Which systems centralize customer inquiry routing and knowledge workflows?", offeringId: "support", intent: "choose" }] }));
    assert.equal(input.candidates.length, 1);
    return stream(JSON.stringify({ questions: [{ index: 0, text: "Our team keeps losing track of customer questions. What can help?" }] }));
  }) as typeof fetch;
  try {
    const invalid = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt", auditJobId: f.audit.id }), "unsupported-inventory");
    await f.runner.tick(); assert.equal(f.store.job(invalid.id).error, "evidence"); assert.equal(calls, 1);
    unsupported = false;
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt", auditJobId: f.audit.id }), "reviewed-inventory");
    await f.runner.tick(); assert.equal(f.store.job(job.id).status, "completed");
    assert.equal((f.store.job(job.id).result as any).questions[0].text, "Our team keeps losing track of customer questions. What can help?");
    assert.equal((f.store.job(job.id).result as any).questions[0].sources[0].url, f.page.url);
  } finally { globalThis.fetch = original; await f.close(); }
});

test("a response that breaks its contract pauses the run, and resuming requests it again instead of re-reading it", async () => {
  const f = fixture(), original = globalThis.fetch; let offeringCalls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    if (input.pages && !input.candidates) {
      offeringCalls++;
      if (offeringCalls === 1) return stream(JSON.stringify({ siteType: "business", offerings: "not a list" }));
      return stream(JSON.stringify({ siteType: "business", audience: "Small support teams", offerings: [{ id: "support", label: "Support workspace", customerNeed: "Keep customer questions organized", evidence: [{ pageId: f.page.id, quote: "Our customer support workspace helps small teams organize questions" }] }], incidentalTopics: [] }));
    }
    if (input.inventory && !input.candidates) return stream(JSON.stringify({ questions: [{ text: "Which tools help small teams keep customer questions organized?", offeringId: "support", intent: "discover" }] }));
    return stream(JSON.stringify({ questions: [{ index: 0, text: "Which tools help small teams keep customer questions organized?" }] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt", auditJobId: f.audit.id }), "broken-contract");
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "paused");
    assert.equal(f.store.job(job.id).error, "format");
    await f.runner.execute(f.store.job(job.id), f.project, new AbortController().signal);
    assert.equal(offeringCalls, 2, "the rejected response is requested again");
  } finally { globalThis.fetch = original; await f.close(); }
});

test("question suggestions read the audit they were queued behind and explain an unfinished one", async () => {
  const f = fixture(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    calls++; return new Response("", { status: 500 });
  }) as typeof fetch;
  try {
    assert.throws(() => jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt" }), "a suggestion run names its audit");
    f.store.updateJob(f.audit.id, { status: "failed" });
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "discover", provider: "chatgpt", auditJobId: f.audit.id }), "failed-audit");
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "paused");
    assert.equal(f.store.job(job.id).error, "evidence");
    assert.match(String(f.store.job(job.id).progress), /did not finish/);
    assert.equal(calls, 0, "no model request runs without the audit evidence");
  } finally { globalThis.fetch = original; await f.close(); }
});

test("first checks discover competitors only from answer mentions with matching citations, and preserve answers on quota", async () => {
  const f = fixture(), original = globalThis.fetch; let calls = 0, quota = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    calls++;
    const request = JSON.parse(init!.body as string);
    if (request.tools) return stream("Alternative is an option for customer support.", [{ type: "url_citation", url: "https://alternative.example/help", title: "Alternative" }]);
    if (quota) return new Response(JSON.stringify({ error: { code: "usage_limit" } }), { status: 429 });
    const input = JSON.parse(request.input[0].content);
    return stream(JSON.stringify({ competitors: [
      { name: "Alternative", domain: "alternative.example", observationIds: [input.answers[0].id] },
      { name: "Invented", domain: "unsupported.example", observationIds: [input.answers[0].id] },
      { name: "Alternative", domain: "reddit.com", observationIds: [input.answers[0].id] },
    ] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "measure", provider: "chatgpt", discoverCompetitors: true }), "competitors-test");
    quota = true; await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "paused"); assert.equal(f.store.job(job.id).error, "quota");
    assert.equal(f.store.observations(f.project.id, job.id).length, 1);
    assert.equal(completedMeasurement(f.store.job(job.id)), true);
    assert.equal(comparableHistory(f.store.jobs(), f.store.job(job.id)).history.length, 1);
    const findings = f.store.findings(f.project.id).filter(finding => finding.jobId === job.id).length;
    quota = false; f.runner.resume(job.id, false); await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "completed"); assert.equal(calls, 3);
    assert.equal(f.store.findings(f.project.id).filter(finding => finding.jobId === job.id).length, findings);
    assert.deepEqual((f.store.job(job.id).result as any).competitors.map((candidate: any) => candidate.domain), ["alternative.example"]);
    assert.deepEqual(f.store.project(f.project.id).competitors, [], "Candidates require user selection");
  } finally { globalThis.fetch = original; await f.close(); }
});

test("competitor analysis checkpoints bounded batches and does not replay saved answers or completed analysis", async () => {
  const f = fixture(), original = globalThis.fetch;
  const questions = Array.from({ length: 4 }, (_, index) => "Which support tools work for a team of " + (index + 1) + " people?");
  f.store.updateProject(f.project.id, { ...f.project, prompts: questions });
  let answers = 0, analysis = 0, quota = true;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    const request = JSON.parse(init!.body as string);
    if (request.tools) { answers++; return stream("Alternative supports small teams. " + "Evidence about customer support. ".repeat(350), [{ type: "url_citation", url: "https://alternative.example/help" }]); }
    const input = JSON.parse(request.input[0].content); analysis++;
    assert.ok(Buffer.byteLength(JSON.stringify(input.answers), "utf8") <= 18000);
    if (analysis === 2 && quota) return new Response(JSON.stringify({ error: { code: "usage_limit" } }), { status: 429 });
    return stream(JSON.stringify({ competitors: [{ name: "Alternative", domain: "alternative.example", observationIds: input.answers.map((answer: any) => answer.id) }] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "measure", provider: "chatgpt", discoverCompetitors: true }), "batched-competitors");
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "paused"); assert.equal(answers, 4);
    assert.equal(f.store.step(job.id, "competitors:0")?.state, "done");
    quota = false; f.runner.resume(job.id, false); await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "completed"); assert.equal(answers, 4); assert.equal(analysis, 5);
    assert.equal((f.store.job(job.id).result as any).competitors.length, 1);
  } finally { globalThis.fetch = original; await f.close(); }
});

test("competitor evidence permits a cited alternative regardless of website category", async () => {
  const f = fixture(), original = globalThis.fetch;
  const question = "Where can I host a discussion group for my customers?";
  f.store.updateProject(f.project.id, { ...f.project, prompts: [question] });
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    const request = JSON.parse(init!.body as string);
    if (request.tools) return stream("Reddit lets you host a customer discussion community.", [{ type: "url_citation", url: "https://www.reddit.com/", title: "Reddit" }]);
    const input = JSON.parse(request.input[0].content);
    assert.equal(input.answers[0].question, question);
    return stream(JSON.stringify({ competitors: [
      { name: "Reddit", domain: "reddit.com", observationIds: [input.answers[0].id] },
      { name: "Unmentioned", domain: "reddit.com", observationIds: [input.answers[0].id] },
    ] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "measure", provider: "chatgpt", discoverCompetitors: true }), "cited-alternative");
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, "completed");
    assert.deepEqual((f.store.job(job.id).result as any).competitors, [{ name: "Reddit", domain: "reddit.com", observationIds: [f.store.observations(f.project.id, job.id)[0].id] }]);
    assert.deepEqual(f.store.project(f.project.id).competitors, []);
  } finally { globalThis.fetch = original; await f.close(); }
});

test("competitor refresh owns its saved evidence, preserves measurements and never requests answers again", async () => {
  const f = fixture(), original = globalThis.fetch;
  let answerCalls = 0, reviews = 0, quota = true;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    const request = JSON.parse(init!.body as string);
    if (request.tools) { answerCalls++; return stream("Alternative can organize customer questions.", [{ type: "url_citation", url: "https://alternative.example/" }]); }
    reviews++;
    const input = JSON.parse(request.input[0].content);
    assert.equal(input.siteOverview.url, f.page.url, "the homepage travels once, as the site overview");
    assert.ok(input.siteOverview.text.includes("customer support workspace"));
    assert.ok(!input.website.sources.some((page: any) => page.url === f.page.url));
    assert.equal(input.businessNotes, "");
    if (quota) return new Response("{}", { status: 429 });
    return stream(JSON.stringify({ competitors: [{ name: "Alternative", domain: "alternative.example", observationIds: input.answers.map((answer: any) => answer.id) }] }));
  }) as typeof fetch;
  try {
    const measured = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: "measure", provider: "chatgpt" }), "saved-check");
    await f.runner.tick();
    const before = f.store.job(measured.id), answers = f.store.observations(f.project.id, measured.id);
    const reviewInput = jobInput.parse({ projectId: f.project.id, kind: "competitors", provider: "chatgpt", measurementJobId: measured.id });
    const review = f.store.enqueue(reviewInput, "competitor-refresh");
    assert.equal(f.store.enqueue(reviewInput, "competitor-refresh").id, review.id);
    assert.throws(() => f.store.enqueue(reviewInput, "duplicate-competitor-refresh"));
    await f.runner.tick();
    assert.equal(f.store.job(review.id).status, "paused");
    f.store.updateProject(f.project.id, { ...f.project, knowledge: "New notes after this run started" });
    quota = false; f.runner.resume(review.id, false); await f.runner.tick();
    assert.equal(f.store.job(review.id).status, "completed");
    assert.equal(answerCalls, 1); assert.equal(reviews, 2);
    assert.deepEqual(f.store.job(measured.id), before);
    assert.deepEqual(f.store.observations(f.project.id, measured.id), answers);
    assert.equal((f.store.job(review.id).result as any).measurementJobId, measured.id);
    assert.equal(comparableHistory(f.store.jobs(), f.store.job(measured.id)).history.length, 1);
    assert.deepEqual(f.store.project(f.project.id).competitors, []);
    const other = f.store.createProject(projectInput.parse({ domain: "other.example", brand: "Other" }));
    const foreign = f.store.enqueue(jobInput.parse({ ...reviewInput, projectId: other.id }), "foreign-review");
    await f.runner.tick();
    assert.equal(f.store.job(foreign.id).error, "evidence");
    assert.equal(reviews, 2);
  } finally { globalThis.fetch = original; await f.close(); }
});

test("setup records preserve row selections, deduplicate requests, snapshot inputs and refuse other-project task references", async () => {
  const f = fixture(), { app } = await createApp(f.store, f.vault, "synthetic-session");
  const headers = { host: "127.0.0.1:4318", authorization: "Bearer synthetic-session" };
  try {
    const row = { id: randomUUID(), text: "Which support tools suit small teams?", selected: false };
    const draft = { step: 2, provider: "chatgpt", localOnly: false, projectId: f.project.id, questionRows: [row] };
    assert.equal((await app.inject({ method: "PUT", url: "/api/onboarding/draft", headers, payload: draft })).statusCode, 200);
    const request = { method: "POST" as const, url: "/api/onboarding/questions", headers, payload: { projectId: f.project.id, provider: "chatgpt" } };
    const first = (await app.inject(request)).json(), again = (await app.inject(request)).json();
    assert.equal(first.id, again.id);
    assert.equal(first.auditJobId, f.audit.id, "Suggestions read the finished audit of this website");
    const refreshedRequest = { ...request, payload: { ...request.payload, requestId: randomUUID() } };
    assert.equal((await app.inject(refreshedRequest)).json().id, first.id, "Refresh coalesces an outstanding analysis instead of duplicating provider requests");
    assert.deepEqual(f.store.setting<any>("setupDraft", null).questionRows, [row]);
    f.store.updateProject(f.project.id, { ...f.project, brand: "Changed" });
    assert.equal(JSON.parse(f.store.step(first.id, "project")!.body!).brand, "Example");
    f.store.updateJob(first.id, { status: "completed", result: { questions: [] } });
    const renewed = (await app.inject(refreshedRequest)).json();
    assert.notEqual(renewed.id, first.id);
    assert.equal((await app.inject(refreshedRequest)).json().id, renewed.id, "An interrupted refresh response can retry its request identity safely");
    f.store.updateJob(renewed.id, { status: "completed", result: { questions: [] } }); f.store.updateJob(f.audit.id, { status: "failed" });
    const afterFailure = (await app.inject({ ...request, payload: { ...request.payload, requestId: randomUUID() } })).json();
    assert.notEqual(afterFailure.auditJobId, f.audit.id, "An audit that did not finish is replaced, not awaited");
    assert.equal(f.store.job(afterFailure.auditJobId).status, "queued");
    const other = f.store.createProject(projectInput.parse({ domain: "other.example", brand: "Other" }));
    assert.equal((await app.inject({ method: "PUT", url: "/api/onboarding/draft", headers, payload: { ...draft, projectId: other.id, discoveryJobId: first.id } })).statusCode, 409);
    const check = (await app.inject({ method: "POST", url: "/api/onboarding/check", headers, payload: { projectId: f.project.id } })).json();
    assert.equal(check.provider, "chatgpt"); assert.equal(check.maxCostUsd, 0); assert.equal(check.discoverCompetitors, true);
    assert.equal((await app.inject({ method: "POST", url: "/api/onboarding/check", headers, payload: { projectId: f.project.id } })).json().id, check.id);
    f.store.updateProject(f.project.id, { ...f.store.project(f.project.id), domain: "changed.example" });
    const changed = (await app.inject({ method: "POST", url: "/api/onboarding/check", headers, payload: { projectId: f.project.id } })).json();
    assert.notEqual(changed.id, check.id, "Revised website context cannot reuse another website's first check");
    assert.equal(JSON.parse(f.store.step(check.id, "project")!.body!).domain, "example.com");
  } finally { await app.close(); await f.close(); }
});

test("sitemap discovery follows same-site indexes, obeys robots, deduplicates and rejects private or unrelated URLs", async () => {
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    return { url, status: 200, contentType: "application/xml", text: url.endsWith("/sitemap.xml") ? '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap><sitemap><loc>http://127.0.0.1/private</loc></sitemap><sitemap><loc>https://other.example/map.xml</loc></sitemap></sitemapindex>' : '<urlset><url><loc>https://example.com/service</loc></url><url><loc>https://example.com/service</loc></url><url><loc>https://example.com/private</loc></url><url><loc>https://other.example/page</loc></url></urlset>' };
  };
  const pages = await sitemapPages(new URL("https://example.com/"), [], url => !url.endsWith("/private"), new AbortController().signal, 100, fetcher);
  assert.deepEqual(pages, ["https://example.com/service"]);
  assert.deepEqual(requests, ["https://example.com/sitemap.xml", "https://example.com/pages.xml"]);
  const html = connectionPage("connected", "chatgpt", "http://127.0.0.1:4318", "synthetic-nonce");
  assert.match(html, /Close sign-in window/); assert.match(html, /window.close/); assert.ok(!html.includes("code="));
});

test("Console connection metadata projects only public features and refuses malformed availability", () => {
  const data = consoleCapabilities({ platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true, supplierCredential: "synthetic-private-value" }], operations: ["full_check", "internal_debug"], content_available: true,
    models: [{ id: "managed-model", operations: ["research", "content", "internal_debug"], supplierCost: "synthetic-private-cost" }],
    privatePrompt: "synthetic-private-instruction", supplierCosts: [1, 2] });
  assert.deepEqual(data.platforms, [{ key: "chatgpt", name: "ChatGPT", enabled: true }]);
  assert.deepEqual(data.operations, ["full_check"]);
  assert.deepEqual(data.models, [{ id: "managed-model", operations: ["research", "content"] }]);
  assert.ok(!JSON.stringify(data).includes("synthetic-private"));
  assert.throws(() => consoleCapabilities({ platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: "yes" }] }));
});

test('website discovery separates substitutes from references and check evidence cannot cross projects', async () => {
  const f = fixture(), original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', context_window: 32768 }] });
    const request = JSON.parse(init!.body as string);
    if (request.tools) return stream('Alternative organizes customer questions. Read the documented support workflow.', [
      { type: 'url_citation', url: 'https://alternative.example/help', title: 'Alternative' },
      { type: 'url_citation', url: 'https://reference.example/guide', title: 'Workflow reference' },
    ]);
    const input = JSON.parse(request.input[0].content), ids = input.answers.map((answer:any) => answer.id);
    return stream(JSON.stringify({ competitors: [
      { name: 'Alternative', domain: 'alternative.example', role: 'competitor', reason: 'Recommended support workspace for the same customer need.', observationIds: ids },
      { name: 'Workflow reference', domain: 'reference.example', role: 'reference', reason: 'Cited workflow documentation, not a recommended substitute.', observationIds: ids },
      { name: 'Unmentioned substitute', domain: 'reference.example', role: 'competitor', reason: 'Unsupported substitute claim.', observationIds: ids },
    ] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', discoverCompetitors: true }), 'classified-sites');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    const result = f.store.job(job.id).result as any;
    assert.deepEqual(result.competitors.map((site:any) => site.domain), ['alternative.example']);
    assert.deepEqual(result.references.map((site:any) => site.domain), ['reference.example']);
    assert.deepEqual(f.store.project(f.project.id).competitors, []);
    const { app } = await createApp(f.store, f.vault, 'synthetic-session');
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer synthetic-session' };
    try {
      const response = await app.inject({ url: '/api/projects/' + f.project.id + '/checks/' + job.id + '/answers', headers });
      assert.deepEqual(response.json(), f.store.observations(f.project.id, job.id));
      const other = f.store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
      assert.equal((await app.inject({ url: '/api/projects/' + other.id + '/checks/' + job.id + '/answers', headers })).statusCode, 404);
      assert.equal((await app.inject({ url: '/api/projects/' + f.project.id + '/checks/' + job.id + '/answers', headers: { host: '127.0.0.1:4318' } })).statusCode, 401);
    } finally { await app.close(); }
  } finally { globalThis.fetch = original; await f.close(); }
});

test('a website with both roles retains the explanation of its competing offering', async () => {
  const f = fixture(), original = globalThis.fetch;
  const reason = 'Its support workspace is recommended for the same customer need.';
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', context_window: 32768 }] });
    const request = JSON.parse(init!.body as string);
    if (request.tools) return stream('Alternative organizes customer questions and publishes workflow guidance.', [
      { type: 'url_citation', url: 'https://alternative.example/help', title: 'Alternative' },
    ]);
    const input = JSON.parse(request.input[0].content), ids = input.answers.map((answer:any) => answer.id);
    return stream(JSON.stringify({ competitors: [
      { name: 'Alternative', domain: 'alternative.example', role: 'competitor', reason, observationIds: ids },
      { name: 'Alternative', domain: 'alternative.example', role: 'reference', reason: 'Its documentation supports the workflow explanation.', observationIds: ids },
    ] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', discoverCompetitors: true }), 'dual-role-explanation');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    const result = f.store.job(job.id).result as any;
    assert.equal(result.competitors.length, 1);
    assert.equal(result.competitors[0].role, 'both');
    assert.equal(result.competitors[0].reason, reason);
    assert.deepEqual(result.references, result.competitors);
    assert.deepEqual(result.competitors[0].observationIds, f.store.observations(f.project.id, job.id).map(answer => answer.id));
  } finally { globalThis.fetch = original; await f.close(); }
});
