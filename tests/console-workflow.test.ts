import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { jobInput, projectInput } from "../server/contracts.js";
import { exportProject, reportMarkdown } from "../server/export.js";
import { importProject } from "../server/import.js";
import { completedAnalysisResult } from "../server/portable-results.js";

const json = (data: unknown) => new Response(JSON.stringify({ data }), {
  headers: { "Content-Type": "application/json" },
});

test('full-check approval and refunds retain the advertised rate through price changes and cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-console-price-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('console', { key: 'synthetic-console-key' });
  const runtime = await createApp(store, vault, 'synthetic-local-session');
  const original = globalThis.fetch;
  let unit: unknown = 0.25, submitted = 0;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v1/console', '');
    if (path === '/capabilities') return json({ platforms: [{ key: 'chatgpt', name: 'ChatGPT', enabled: true }], pricing: { credit_usd: unit } });
    if (path === '/domains') return json([{ id: 'd373ba88-779f-41ce-926e-28a40103c97e', domain: 'example.com' }]);
    if (path.endsWith('/brand')) return json({});
    if (path === '/scans/preview') return json({ credits_required: 2, query_count: 1 });
    if (path === '/scans') {
      submitted++;
      assert.equal(JSON.parse(String(init?.body)).max_credits, 2);
      return json({ scan_id: 'fixture-scan', credits_charged: 2 });
    }
    if (path.endsWith('/cancel')) return json({ refunded_credits: 1, prior_status: 'running' });
    if (path === '/scans/fixture-scan') return json({ status: 'failed' });
    throw new Error('Unexpected external request: ' + path);
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['Which examples are useful?'] }));
    const enqueue = (key: string) => store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .74 }), key);
    const job = enqueue('quoted-price');
    await runtime.runner.tick();
    assert.equal(store.job(job.id).error, 'provider');
    assert.equal(store.job(job.id).spentUsd, .5);
    unit = 0.75;
    await runtime.runner.cancel(job.id);
    assert.equal(store.job(job.id).spentUsd, .25);
    await runtime.runner.cancel(job.id);
    assert.equal(store.job(job.id).spentUsd, .25);
    assert.equal(submitted, 1);
    for (const invalid of [undefined, -1, 0, '0.25', 0.0000001]) {
      unit = invalid;
      const refused = enqueue('invalid-price-' + String(invalid));
      await runtime.runner.tick();
      assert.equal(store.job(refused.id).error, 'estimate');
      assert.equal(store.job(refused.id).spentUsd, 0);
      await runtime.runner.cancel(refused.id);
    }
    assert.equal(submitted, 1);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Console check totals and public citations survive project edits, dashboard reads and restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-console-contract-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() });
  vault.set("console", { key: "synthetic-console-key" });
  const runtime = await createApp(store, vault, "synthetic-local-session");
  const original = globalThis.fetch;
  let submitted = 0, evidenceReads = 0, previewCount: unknown = 3, finalCount = 3, hasRecommendation = true;
  // Supplier HTTP fixtures exercise the production adapter, queue, projections and SQLite writes.
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/api/v1/console", "");
    if (path === "/capabilities") return json({ platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }], pricing: { credit_usd: 0.1 },
      operations: ['measurement', 'full_check'], selected_question_platforms: ['chatgpt'] });
    if (path === "/domains") return json([{ id: "d373ba88-779f-41ce-926e-28a40103c97e", domain: "example.com" }]);
    if (path === "/domains/d373ba88-779f-41ce-926e-28a40103c97e/brand") return json({ domain_id: "d373ba88-779f-41ce-926e-28a40103c97e" });
    if (path === "/scans/preview") return json({ credits_required: 2, query_count: previewCount });
    if (path === "/scans") {
      submitted++;
      assert.equal(JSON.parse(init!.body as string).max_credits, 2);
      return json({ scan_id: "fixture-scan", credits_charged: 2 });
    }
    if (path === "/scans/fixture-scan") return json({ status: "completed", answers_total: finalCount,
      visibility_score: 75, completed_at: "2026-10-01T10:00:00Z" });
    if (path.endsWith("/analysis")) return json({ analysis_status: "available" });
    if (path.endsWith("/observations")) {
      evidenceReads++;
      return json([
        { id: "remote-answer-1", prompt: "First question?", platform: "chatgpt", model: "fixture-model", status: "collected",
          surface: "consumer_interface",
          answer_text: "Example provides examples.", presence: "cited", citations: [null, "unusable annotation", { url_citation: "unusable nested annotation" },
            { url: "https://example.com/", title: null, supplier_secret: "synthetic-hidden-field" }, { url: "javascript:alert(1)" }, { url: "https://example.com/" }] },
        { id: "remote-answer-2", prompt: "Second question?", platform: "chatgpt", model: "fixture-model", status: "collected",
          answer_text: "Other examples.", presence: "missing", citations: [] },
        { id: "remote-answer-3", prompt: "Third question?", platform: "chatgpt", status: "missing_observation", answer_text: null },
      ]);
    }
    if (path.endsWith("/insights/opportunities") && hasRecommendation) return json([{
      id: "remote-finding-1", title: "Compare the available examples", description: "Show which examples fit each use case.",
      priority: "medium", target_url: "https://example.com/", evidence: [{ observation_id: "remote-answer-1" }],
      steps: ["Explain who each example is for."],
    }]);
    if (path.includes("/insights/")) return json([]);
    throw new Error("Unexpected external request: " + path);
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["One supplied question?"] }));
    const enqueue = (key: string) => store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "console", maxCostUsd: 0.2 }), key);
    const job = enqueue("console-scope-check");
    await runtime.runner.tick();
    assert.equal(store.job(job.id).status, "completed");
    assert.deepEqual((store.job(job.id).result as any).metrics, { requested: 3, completed: 2, missing: 1, mentionRate: 50, citationRate: 50, citations: 1 });
    assert.equal(store.job(job.id).spentUsd, 0.2);
    store.updateProject(project.id, projectInput.parse({ domain: project.domain, brand: project.brand,
      prompts: ["Changed question?", "Another question?", "Fourth?", "Fifth?"] }));
    const workspace = async (id: string) => (await runtime.app.inject({ url: "/api/projects/" + id + "/workspace",
      headers: { host: "127.0.0.1:4318", authorization: "Bearer synthetic-local-session" } })).json();
    const check = await workspace(project.id);
    assert.equal(check.metrics.requested, 3);
    assert.deepEqual(completedAnalysisResult(check.jobs.find((row: { id: string }) => row.id === job.id)),
      { findings: 1, measurementJobId: job.id });
    const answerId = check.observations.find((answer: { prompt: string }) => answer.prompt === "First question?").id;
    assert.deepEqual(check.findings.map((finding: { evidenceIds: string[] }) => finding.evidenceIds), [[answerId]]);
    assert.match(reportMarkdown(store, project.id), /Answers collected: 2 of 3/);
    const portable = exportProject(store, project.id);
    assert.equal(JSON.stringify(portable).includes("synthetic-hidden-field"), false);
    assert.deepEqual(portable.observations[0].citations, []);
    assert.equal('surface' in portable.observations[0], false);
    assert.equal('model' in portable.observations[0], false);
    assert.equal('surface' in portable.observations[1], false);
    assert.deepEqual(portable.observations[1].citations, [{ url: "https://example.com/" }]);
    const restored = importProject(store, portable).project;
    const restoredCheck = await workspace(restored.id);
    assert.equal(restoredCheck.metrics.requested, 3);
    assert.equal(restoredCheck.comparison.status, "incomplete");
    const restoredAnalysis = completedAnalysisResult(restoredCheck.measurement);
    assert.deepEqual(restoredAnalysis, { findings: 1, measurementJobId: restoredCheck.measurement.id });
    previewCount = null;
    const rejected = enqueue("console-no-scope-check");
    await runtime.runner.tick();
    assert.equal(store.job(rejected.id).error, "estimate");
    assert.equal(submitted, 1);
    await runtime.runner.cancel(rejected.id);
    assert.equal(store.job(rejected.id).status, "cancelled");
    previewCount = 3; finalCount = 1;
    const inconsistent = enqueue("console-inconsistent-scope-check");
    await runtime.runner.tick();
    assert.equal(store.job(inconsistent.id).error, "invalid_response");
    assert.equal(store.observations(project.id, inconsistent.id).length, 2);
    assert.equal(store.job(inconsistent.id).requestedAnswers, 3);
    assert.equal(submitted, 2);
    assert.equal(completedAnalysisResult(store.job(inconsistent.id)), null);
    // A check paused on beta.10 may already have saved the evidence without a finding count.
    store.setStep(inconsistent.id, "console-evidence", "done", { observations: 3 });
    const savedIds = store.observations(project.id, inconsistent.id).map(answer => answer.id);
    finalCount = 3;
    runtime.runner.resume(inconsistent.id, false);
    await runtime.runner.tick();
    assert.deepEqual(completedAnalysisResult(store.job(inconsistent.id)), { findings: 1, measurementJobId: inconsistent.id });
    assert.deepEqual(store.observations(project.id, inconsistent.id).map(answer => answer.id), savedIds);
    assert.equal(evidenceReads, 2);
    assert.equal(submitted, 2);
    hasRecommendation = false;
    const reviewedWithoutChanges = enqueue("console-reviewed-no-recommendations");
    await runtime.runner.tick();
    assert.deepEqual(completedAnalysisResult(store.job(reviewedWithoutChanges.id)),
      { findings: 0, measurementJobId: reviewedWithoutChanges.id });
    assert.equal(submitted, 3);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
