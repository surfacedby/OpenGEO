import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { jobInput, projectInput } from "../server/contracts.js";
import { Runner } from "../server/workflows.js";
import { Providers } from "../server/providers.js";
import { Connections } from "../server/oauth.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-setup-test-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() });
  const { app } = await createApp(store, vault, "synthetic-local-session");
  const headers = { host: "127.0.0.1:4318", authorization: "Bearer synthetic-local-session" };
  return { directory, store, vault, app, headers, async close() { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("setup survives lost responses; completion atomically creates one free local audit", async () => {
  const f = await fixture();
  try {
    const request = { project: { domain: "https://example.com/", brand: "Example" }, draft: { step: 3, provider: "chatgpt", localOnly: true } };
    assert.equal((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().completed, false);
    const first = await f.app.inject({ method: "POST", url: "/api/onboarding/website", headers: f.headers, payload: request });
    assert.equal(first.statusCode, 200);
    const repeated = await f.app.inject({ method: "POST", url: "/api/onboarding/website", headers: f.headers, payload: request });
    assert.equal(first.json().project.id, repeated.json().project.id);
    assert.equal(f.store.projects().length, 1);
    const draft = (await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().draft;
    assert.equal(draft.projectId, first.json().project.id);
    const invalid = await f.app.inject({ method: "POST", url: "/api/onboarding/start", headers: f.headers, payload: { ...draft, localOnly: false } });
    assert.equal(invalid.statusCode, 409);
    assert.equal(f.store.jobs().length, 0);
    const complete = await f.app.inject({ method: "POST", url: "/api/onboarding/start", headers: f.headers, payload: draft });
    assert.equal(complete.statusCode, 200);
    assert.equal(f.store.setting<any>("usageConsent", null).enabled, true);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/onboarding/start", headers: f.headers, payload: draft })).json().job.id, complete.json().job.id);
    assert.equal(f.store.jobs().length, 1);
    assert.equal(f.store.jobs()[0].provider, undefined);
    assert.equal(f.store.jobs()[0].maxCostUsd, 0);
    assert.deepEqual((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json(), { completed: true, draft: null });
  } finally { await f.close(); }
});

test("read-only provider verification preserves a working key on rejection and blocks active-account changes", async () => {
  const f = await fixture(), original = globalThis.fetch;
  let status = 401, requests = 0;
  globalThis.fetch = (async (url, init) => {
    requests++; assert.equal(String(url), "https://openrouter.ai/api/v1/key"); assert.equal(init?.method ?? "GET", "GET");
    return json(status === 200 ? { data: { label: "Synthetic test key" } } : { error: { message: "must-not-be-displayed" } }, status);
  }) as typeof fetch;
  try {
    f.vault.set("openrouter", { key: "synthetic-original-key" });
    const payload = { provider: "openrouter", key: "synthetic-new-key" };
    const denied = await f.app.inject({ method: "PUT", url: "/api/providers", headers: f.headers, payload });
    assert.equal(denied.statusCode, 409); assert.equal(f.vault.get("openrouter").key, "synthetic-original-key");
    assert.ok(!denied.body.includes("must-not-be-displayed")); assert.ok(!denied.body.includes(payload.key));
    status = 200;
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/providers", headers: f.headers, payload })).statusCode, 200);
    assert.equal(f.vault.get("openrouter").key, payload.key);
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "openrouter" }), "active-account-test");
    f.store.updateJob(job.id, { status: "running" });
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/providers", headers: f.headers, payload })).statusCode, 409);
    assert.equal(requests, 2);
    assert.ok(!(await f.app.inject({ url: "/api/providers", headers: f.headers })).body.includes(payload.key));
  } finally { globalThis.fetch = original; await f.close(); }
});

test("DataForSEO HTTP success without account authentication is not a connected credential", async () => {
  const f = await fixture(), original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => { assert.equal(String(url), "https://api.dataforseo.com/v3/appendix/user_data"); assert.equal(init?.method ?? "GET", "GET"); return json({ status_code: 20000, tasks: [{ status_code: 40102 }] }); }) as typeof fetch;
  try {
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/providers", headers: f.headers, payload: { provider: "dataforseo", login: "synthetic-user", password: "synthetic-password" } })).statusCode, 409);
    assert.equal(f.vault.status().dataforseo, false);
  } finally { globalThis.fetch = original; await f.close(); }
});

test("custom setup requires measurement and AI connections; completion preserves the displayed usage choice", async () => {
  const f = await fixture();
  try {
    f.vault.set("dataforseo", { login: "synthetic-user", password: "synthetic-password" });
    const request = { project: { domain: "example.com", brand: "Example" }, draft: { step: 3, provider: "dataforseo", localOnly: false } };
    const website = await f.app.inject({ method: "POST", url: "/api/onboarding/website", headers: f.headers, payload: request });
    const draft = website.json().draft;
    const blocked = await f.app.inject({ method: "POST", url: "/api/onboarding/start", headers: f.headers, payload: draft });
    assert.equal(blocked.statusCode, 409); assert.equal(f.store.jobs().length, 0);
    f.vault.set("openrouter", { key: "synthetic-openrouter-key" });
    await f.app.inject({ method: "PUT", url: "/api/settings/usage-sharing", headers: f.headers, payload: { enabled: false } });
    assert.equal((await f.app.inject({ method: "POST", url: "/api/onboarding/start", headers: f.headers, payload: draft })).statusCode, 200);
    assert.deepEqual(f.store.setting("usageConsent", null), { enabled: false });
    assert.equal(f.store.jobs().length, 1);
  } finally { await f.close(); }
});

test("resume requires review only for uncertain requests and changes budgets only with explicit approval", async () => {
  const f = await fixture(), connections = new Connections(f.store, f.vault), runner = new Runner(f.store, new Providers(f.vault, connections));
  try {
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "openrouter", maxCostUsd: 1 }), "resume-review-test");
    f.store.updateJob(job.id, { status: "paused", error: "budget", spentUsd: 0.5 });
    assert.equal(runner.resumePreview(job.id).uncertainRequests, 0);
    assert.throws(() => runner.resume(job.id, false, 0.4));
    assert.equal(f.store.job(job.id).maxCostUsd, 1);
    runner.resume(job.id, false, 2);
    assert.equal(f.store.job(job.id).maxCostUsd, 2);
    f.store.updateJob(job.id, { status: "paused", error: "interrupted" });
    f.store.setStep(job.id, "measure:0", "started");
    assert.equal(runner.resumePreview(job.id).uncertainRequests, 1);
    assert.throws(() => runner.resume(job.id, false));
    assert.equal(f.store.job(job.id).status, "paused");
    runner.resume(job.id, true);
    assert.equal(f.store.step(job.id, "measure:0")?.state, "approved-retry");
    assert.equal(f.store.job(job.id).spentUsd, 0.5);
  } finally { connections.close(); await f.close(); }
});

test("queued competitor discovery retains collected answers while an unstarted check preserves the prior scope", async () => {
  const f = await fixture(), connections = new Connections(f.store, f.vault), runner = new Runner(f.store, new Providers(f.vault, connections));
  try {
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["What can help our team?"] }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt", discoverCompetitors: true }), "saved-answers");
    const collectedAt = "2026-10-01T10:00:00Z";
    f.store.setStep(job.id, "project", "done", project);
    f.store.put("observation", project.id, job.id, { id: "saved-answer", projectId: project.id, jobId: job.id, prompt: project.prompts[0], provider: "chatgpt", platform: "chat_gpt", model: "fixture", locale: "en-US", observedAt: collectedAt, answer: "Example can help.", citations: [], surface: "api", mentioned: true, cited: false, costUsd: 0 });
    f.store.updateJob(job.id, { status: "paused", error: "quota", result: { comparisonKey: "a".repeat(64), collectionCompletedAt: collectedAt, metrics: { requested: 1, completed: 1, missing: 0, mentionRate: 100, citationRate: 0, citations: 0 } } });
    runner.resume(job.id, false);
    const workspace = async () => (await f.app.inject({ url: `/api/projects/${project.id}/workspace`, headers: f.headers })).json();
    const resumed = await workspace();
    assert.equal(resumed.measurement.id, job.id);
    assert.equal(resumed.measurement.status, "queued");
    assert.equal(resumed.metrics.completed, 1);
    assert.equal(resumed.metrics.mentionRate, 100);
    assert.deepEqual(resumed.observations.map((answer: any) => answer.id), ["saved-answer"]);
    f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "recheck", provider: "chatgpt" }), "unstarted-check");
    assert.equal((await workspace()).measurement.id, job.id);
  } finally { connections.close(); await f.close(); }
});
