import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { jobInput, projectInput } from "../server/contracts.js";
import { exportProject, reportMarkdown } from "../server/export.js";
import { importProject } from "../server/import.js";
import { analysisInProgress, completedAnalysisResult, completedMeasurement } from "../server/portable-results.js";

const json = (data: unknown) => new Response(JSON.stringify({ data }), {
  headers: { "Content-Type": "application/json" },
});

test('an unconfirmed full-check submission cannot be resubmitted or discarded by cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-full-check-unconfirmed-'));
  const store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('console', { key: 'synthetic-console-key' });
  const runtime = await createApp(store, vault, 'synthetic-local-session');
  const original = globalThis.fetch;
  const domain = { id: randomUUID(), domain: 'example.com' };
  const scanId = randomUUID();
  let receipt: { request_key: string; domain_id: string; scan_id: string; credits_charged: number } | undefined;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const request = new URL(String(url));
    const path = request.pathname.replace('/api/v1/console', '');
    requests.push(path);
    if (path === '/capabilities') return json({ platforms: [{ key: 'chatgpt', enabled: true }], pricing: { credit_usd: .25 } });
    if (path === '/domains') return json([domain]);
    if (path.endsWith('/brand')) return json({});
    if (path === '/scans/preview') return json({ credits_required: 2, query_count: 1 });
    if (path === '/scans') return json({ scan_id: scanId });
    if (path === '/scans/submission') {
      assert.equal(init?.method, 'GET');
      assert.equal(request.searchParams.get('request_key'), receipt?.request_key);
      return json(receipt);
    }
    throw new Error('Unexpected request ' + path);
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: domain.domain, brand: 'Example', prompts: ['Which examples are useful?'] }));
    const enqueue = (key: string) => store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .5 }), key);
    const newJob = enqueue('unconfirmed-charge');
    await runtime.runner.tick();
    assert.equal(store.job(newJob.id).error, 'cost_unknown');
    assert.equal(store.step(newJob.id, 'console-scan')?.state, 'started');
    assert.throws(() => runtime.runner.resume(newJob.id, true, 1), /submission is still unconfirmed/i);
    assert.equal(store.job(newJob.id).maxCostUsd, .5);
    assert.equal((await runtime.runner.cancel(newJob.id)).error, 'cancel_remote');

    const former = enqueue('old-approved-retry');
    store.setStep(former.id, 'console-scan', 'approved-retry');
    await runtime.runner.tick();
    assert.equal(store.job(former.id).status, 'paused');
    assert.equal(runtime.runner.resumePreview(former.id).uncertainRequests, 1);
    assert.equal((await runtime.runner.cancel(former.id)).error, 'cancel_remote');

    const malformed = enqueue('old-incomplete-receipt');
    store.setStep(malformed.id, 'console-scan', 'done', { scan_id: randomUUID() });
    assert.equal((await runtime.runner.cancel(malformed.id)).error, 'cancel_remote');
    assert.equal(store.step(malformed.id, 'console-scan')?.state, 'done');
    assert.throws(() => store.deleteProject(project.id, project.domain), /unfinished/);

    const previousBrand = store.createProject(projectInput.parse({ domain: 'example.org', brand: 'Previous' }));
    const previouslyStopped = store.enqueue(jobInput.parse({ projectId: previousBrand.id, kind: 'measure', provider: 'console', maxCostUsd: .5 }), 'old-local-cancellation');
    store.setStep(previouslyStopped.id, 'console-scan', 'approved-retry');
    store.updateJob(previouslyStopped.id, { status: 'cancelled', error: null });
    assert.throws(() => store.deleteProject(previousBrand.id, previousBrand.domain), /unfinished/);
    assert.equal((await runtime.runner.cancel(previouslyStopped.id)).error, 'cancel_remote');
    assert.deepEqual(requests, ['/capabilities', '/domains', `/domains/${domain.id}/brand`, '/scans/preview', '/scans']);

    receipt = { request_key: newJob.id, domain_id: randomUUID(), scan_id: scanId, credits_charged: 2 };
    await assert.rejects(() => runtime.runner.recoverConsoleSubmission(newJob.id), /submission is still unconfirmed/i);
    assert.equal(store.step(newJob.id, 'console-scan')?.state, 'started');
    receipt.domain_id = domain.id;
    const recovered = await runtime.runner.recoverConsoleSubmission(newJob.id);
    assert.equal(recovered.spentUsd, .5);
    assert.equal(recovered.error, 'cancel_remote');
    assert.equal(store.step(newJob.id, 'console-scan')?.state, 'done');
    assert.equal(requests.filter(path => path === '/scans').length, 1);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('full-check approval and refunds retain the advertised rate through price changes and cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-console-price-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('console', { key: 'synthetic-console-key' });
  const runtime = await createApp(store, vault, 'synthetic-local-session');
  const original = globalThis.fetch;
  let unit: unknown = 0.25, submitted = 0, cancelledRemote = 'other-scan';
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
    if (path.endsWith('/cancel')) return json({ id: cancelledRemote, status: 'cancelled', refunded_credits: 1, prior_status: 'running' });
    if (path === '/scans/fixture-scan') return json({ id: 'fixture-scan', domain_id: 'd373ba88-779f-41ce-926e-28a40103c97e', status: 'failed' });
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
    assert.equal(store.job(job.id).error, 'cancel_remote');
    assert.equal(store.job(job.id).spentUsd, .5);
    cancelledRemote = 'fixture-scan';
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

test('a full check that finishes before cancellation keeps its original charge and answers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-console-terminal-cancel-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('console', { key: 'synthetic-console-key' });
  const runtime = await createApp(store, vault, 'synthetic-local-session');
  const original = globalThis.fetch;
  const scanId = randomUUID(), domainId = randomUUID(), otherScan = randomUUID();
  let completedId = otherScan;
  let cancelledJobId: string;
  const routes: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const address = new URL(String(url));
    assert.equal(address.origin, 'https://api.surfacedby.com');
    const path = address.pathname.replace('/api/v1/console', '');
    routes.push((init?.method ?? 'GET') + ' ' + path);
    if (path === `/scans/${scanId}/cancel`) {
      assert.equal(store.job(cancelledJobId).error, 'cancel_remote');
      return Response.json({
        type: 'https://docs.surfacedby.com/v1/api/errors#validation_error', detail: 'This check already ended (completed).',
      }, { status: 409 });
    }
    if (path === `/scans/${scanId}`) return json({ id: completedId, domain_id: domainId, status: 'completed',
      answers_total: 2, completed_at: '2026-11-01T10:00:00Z' });
    if (path === `/scans/${scanId}/observations`) return json([{ id: randomUUID(), scan_id: scanId, status: 'collected',
      platform: 'chatgpt', prompt: 'How can I export a report?', answer_text: 'Export from the reports page.', citations: [] }]);
    throw new Error('Unexpected external request ' + path);
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['How can I export a report?'] }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .5 }), 'cancel-completed');
    cancelledJobId = job.id;
    store.updateJob(job.id, { status: 'paused', error: 'connection_interrupted' });
    store.setStep(job.id, 'console-scan', 'done', { scan_id: scanId, credits_charged: 2 });
    store.setStep(job.id, 'console-scan-credit-usd', 'done', .25);
    store.setStep(job.id, 'console-domain', 'done', { id: domainId, domain: project.domain });

    await runtime.runner.cancel(job.id);
    assert.equal(store.job(job.id).error, 'cancel_remote');
    assert.equal(store.observations(project.id, job.id).length, 0);
    completedId = scanId;
    const settled = await runtime.runner.cancel(job.id);
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.error, null);
    assert.equal(settled.spentUsd, .5);
    assert.equal(completedMeasurement(settled), true);
    assert.deepEqual((settled.result as { metrics: unknown }).metrics,
      { requested: 2, completed: 1, missing: 1, mentionRate: 0, citationRate: 0, citations: 0 });
    assert.equal(store.observations(project.id, job.id).length, 1);
    const workspace = await runtime.app.inject({ url: `/api/projects/${project.id}/workspace`,
      headers: { host: '127.0.0.1:4318', authorization: 'Bearer synthetic-local-session' } });
    assert.equal(workspace.statusCode, 200);
    const view = workspace.json();
    assert.equal(view.measurement.id, job.id);
    assert.deepEqual(view.metrics, (settled.result as { metrics: unknown }).metrics);
    assert.equal(view.observations.length, 1);
    assert.equal(view.findings.length, 0);
    assert.deepEqual(await runtime.runner.cancel(job.id), settled);
    assert.deepEqual(routes, [`POST /scans/${scanId}/cancel`, `GET /scans/${scanId}`, `POST /scans/${scanId}/cancel`,
      `GET /scans/${scanId}`, `GET /scans/${scanId}/observations`]);
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
  let analysis = async () => json({ scan_id: "fixture-scan", analysis_status: "available" });
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
    if (path === "/scans/fixture-scan") return json({ id: 'fixture-scan', domain_id: 'd373ba88-779f-41ce-926e-28a40103c97e', status: "completed", answers_total: finalCount,
      visibility_score: 75, completed_at: "2026-10-01T10:00:00+00:00" });
    if (path.endsWith("/analysis")) return analysis();
    if (path.endsWith("/observations")) {
      evidenceReads++;
      return json([
        { id: "remote-answer-1", scan_id: "fixture-scan", prompt: "First question?", platform: "chatgpt", model: "fixture-model", status: "collected",
          surface: "consumer_interface",
          web_search_used: true, search_queries: ["weekly reports", "weekly reports", "compare reporting tools"],
          answer_text: "Example provides examples.", presence: "cited", citations: [null, "unusable annotation", { url_citation: "unusable nested annotation" },
            { url: "https://example.com/", title: null, supplier_secret: "synthetic-hidden-field" }, { url: "javascript:alert(1)" }, { url: "https://example.com/" }] },
        { id: "remote-answer-2", scan_id: "fixture-scan", prompt: "Second question?", platform: "chatgpt", model: "fixture-model", status: "collected",
          answer_text: "Other examples.", presence: "missing", citations: [] },
        { id: "remote-answer-3", scan_id: "fixture-scan", prompt: "Third question?", platform: "chatgpt", status: "missing_observation", answer_text: null },
      ]);
    }
    if (path.endsWith("/insights/opportunities")) {
      assert.equal(new URL(String(url)).searchParams.get('published_recommendations'), 'true');
      return json([
      {
        id: "historical-gap", scan_id: "fixture-scan", title: "AI answers without citing you", description: "No page action is decided for this question yet.",
        priority: "medium", target_url: null, recommendation_eligible: false,
        evidence: [{ observation_id: "remote-answer-1" }], steps: [],
      },
      ...(hasRecommendation ? [{
        id: "remote-finding-1", scan_id: "fixture-scan", title: "Compare the available examples", description: "Show which examples fit each use case.",
        priority: "medium", target_url: "https://example.com/examples", recommendation_eligible: true,
        evidence: [{ observation_id: "remote-answer-1" }], steps: ["Explain who each example is for."],
      }] : []),
      ]);
    }
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
    assert.equal(check.findings[0].targetUrl, "https://example.com/examples");
    assert.deepEqual(check.findings[0].steps, ["Explain who each example is for."]);
    assert.match(reportMarkdown(store, project.id), /Answers collected: 2 of 3/);
    assert.doesNotMatch(reportMarkdown(store, project.id), /No page action is decided/);
    const portable = exportProject(store, project.id);
    assert.equal(JSON.stringify(portable).includes("synthetic-hidden-field"), false);
    assert.deepEqual(portable.observations[0].citations, []);
    assert.equal('surface' in portable.observations[0], false);
    assert.equal('model' in portable.observations[0], false);
    assert.equal('surface' in portable.observations[1], false);
    assert.deepEqual(portable.observations[1].citations, [{ url: "https://example.com/" }]);
    assert.equal(portable.observations[0].webSearchConfirmed, undefined);
    assert.equal(portable.observations[1].webSearchConfirmed, true);
    assert.deepEqual(portable.observations[1].searchQueries, ["weekly reports", "weekly reports", "compare reporting tools"]);
    const restored = importProject(store, portable).project;
    const restoredCheck = await workspace(restored.id);
    assert.deepEqual(restoredCheck.observations.find((row: { prompt: string }) => row.prompt === "First question?").searchQueries,
      ["weekly reports", "weekly reports", "compare reporting tools"]);
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
    const savedAnswers = store.observations(project.id, inconsistent.id);
    // A check paused on beta.10 could have saved both observations and findings before checking the total.
    const [earlierFinding] = store.artifacts(project.id, "finding", job.id) as Record<string, unknown>[];
    store.put("finding", project.id, inconsistent.id, { ...earlierFinding, id: randomUUID(), jobId: inconsistent.id,
      evidenceIds: [savedAnswers.find(answer => answer.prompt === "First question?")?.id] });
    store.setStep(inconsistent.id, "console-evidence", "done", { observations: 3 });
    finalCount = 3;
    runtime.runner.resume(inconsistent.id, false);
    await runtime.runner.tick();
    assert.deepEqual(completedAnalysisResult(store.job(inconsistent.id)), { findings: 1, measurementJobId: inconsistent.id });
    assert.deepEqual(store.observations(project.id, inconsistent.id), savedAnswers);
    assert.equal(evidenceReads, 2);
    assert.equal(submitted, 2);
    hasRecommendation = false;
    const reviewedWithoutChanges = enqueue("console-reviewed-no-recommendations");
    await runtime.runner.tick();
    assert.deepEqual(completedAnalysisResult(store.job(reviewedWithoutChanges.id)),
      { findings: 0, measurementJobId: reviewedWithoutChanges.id });
    assert.equal(submitted, 3);

    hasRecommendation = true;
    let arrived!: () => void, release!: () => void;
    const arrivedAtAnalysis = new Promise<void>(resolve => { arrived = resolve; });
    const holdAnalysis = new Promise<void>(resolve => { release = resolve; });
    analysis = async () => {
      arrived();
      await holdAnalysis;
      return json({ scan_id: "fixture-scan", analysis_status: "unavailable" });
    };
    const waiting = enqueue("console-answers-before-analysis");
    const tick = runtime.runner.tick();
    try {
      await Promise.race([arrivedAtAnalysis, tick]);
      const running = await workspace(project.id);
      assert.equal(running.measurement.id, waiting.id);
      assert.equal(running.measurement.status, "running");
      assert.equal(completedMeasurement(running.measurement), true);
      assert.equal(analysisInProgress(running.measurement), true);
      assert.deepEqual(running.metrics, { requested: 3, completed: 2, missing: 1, mentionRate: 50, citationRate: 50, citations: 1 });
      assert.equal(running.measurement.result.collectionCompletedAt, "2026-10-01T10:00:00.000Z");
      assert.equal(running.observations.length, 2);
      assert.throws(() => enqueue("console-cannot-submit-a-second-check"), /already in progress/);
    } finally {
      release();
      await tick;
    }
    assert.equal(store.job(waiting.id).status, "paused");
    assert.equal(runtime.runner.resumePreview(waiting.id).uncertainRequests, 0);
    const gathered = store.observations(project.id, waiting.id);
    const readsBeforeResume = evidenceReads;
    analysis = async () => json({ scan_id: "fixture-scan", analysis_status: "available" });
    runtime.runner.resume(waiting.id, false);
    await runtime.runner.tick();
    assert.equal(submitted, 4);
    assert.equal(evidenceReads, readsBeforeResume);
    assert.deepEqual(store.observations(project.id, waiting.id), gathered);
    const [recommendation] = store.artifacts<{ evidenceIds: string[] }>(project.id, "finding", waiting.id);
    assert.deepEqual(recommendation.evidenceIds, [gathered.find(answer => answer.prompt === "First question?")?.id]);

    analysis = async () => json({ scan_id: "fixture-scan", analysis_status: "unavailable" });
    const stopped = enqueue("console-stop-waiting-for-analysis");
    await runtime.runner.tick();
    await runtime.runner.cancel(stopped.id);
    assert.equal(store.job(stopped.id).status, "cancelled");
    assert.equal(store.job(stopped.id).error, null);
    assert.equal(store.job(stopped.id).spentUsd, 0.2);
    assert.equal(completedMeasurement(store.job(stopped.id)), true);
    assert.equal(store.observations(project.id, stopped.id).length, 2);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('a Console check rejects mixed scopes and duplicate answers without replacing its receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-console-evidence-scope-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('console', { key: 'synthetic-console-key' });
  const runtime = await createApp(store, vault, 'synthetic-local-session');
  const original = globalThis.fetch;
  const scanId = randomUUID(), other = randomUUID(), domainId = randomUUID();
  const answer = { id: randomUUID(), scan_id: scanId, status: 'collected', platform: 'chatgpt', prompt: 'What is an example?',
    answer_text: 'A locally scoped answer.', presence: 'named', citations: [] };
  const second = { ...answer, id: randomUUID(), prompt: 'Which other examples exist?' };
  const finding = { id: randomUUID(), scan_id: scanId, recommendation_eligible: true, title: 'Show an example', description: 'Explain how it works.',
    target_url: 'https://example.com/examples', evidence: [{ observation_id: answer.id }], steps: ['Add a concrete example.'] };
  let observations = [answer, { ...second, scan_id: other }], analysisScan = other, findings = [{ ...finding, scan_id: other }];
  let check = { id: other, domain_id: domainId, status: 'completed', answers_total: 70 };
  let submissions = 0, evidenceReads = 0;
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url)).pathname.replace('/api/v1/console', '');
    if (path === '/capabilities') return json({ platforms: [{ key: 'chatgpt', name: 'ChatGPT', enabled: true }], pricing: { credit_usd: .1 } });
    if (path === '/domains') return json([{ id: domainId, domain: 'example.com' }]);
    if (path.endsWith('/brand')) return json({});
    if (path === '/scans/preview') return json({ credits_required: 2, query_count: 2 });
    if (path === '/scans') { submissions++; return json({ scan_id: scanId, credits_charged: 2 }); }
    if (path === `/scans/${scanId}`) return json(check);
    if (path === `/scans/${scanId}/observations`) { evidenceReads++; return json(observations); }
    if (path === `/scans/${scanId}/analysis`) return json({ scan_id: analysisScan, analysis_status: 'available' });
    if (path.endsWith('/insights/diagnoses')) return json([]);
    if (path.endsWith('/insights/opportunities')) return json(findings);
    throw new Error('Unexpected external request ' + path);
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: [answer.prompt, second.prompt] }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .2 }), 'scope-guard');
    const resume = async () => { runtime.runner.resume(job.id, false); await runtime.runner.tick(); };
    const refuse = () => {
      assert.equal(store.job(job.id).status, 'paused');
      assert.equal(store.job(job.id).error, 'invalid_response');
      assert.equal(store.findings(project.id).length, 0);
      assert.equal(store.job(job.id).spentUsd, .2);
    };
    await runtime.runner.tick();
    refuse();
    assert.equal(evidenceReads, 0);
    assert.equal(store.job(job.id).requestedAnswers, 2);
    check = { ...check, id: scanId, domain_id: other, status: 'failed' };
    await resume();
    refuse();
    assert.equal(evidenceReads, 0);
    assert.equal(store.job(job.id).requestedAnswers, 2);
    check = { ...check, domain_id: domainId, status: 'completed', answers_total: 2 };
    await resume();
    refuse();
    assert.equal(store.observations(project.id, job.id).length, 0);
    observations = [answer, { ...second, id: answer.id }];
    await resume();
    refuse();
    assert.equal(store.observations(project.id, job.id).length, 0);
    observations = [answer, second];
    await resume();
    refuse();
    const saved = store.observations(project.id, job.id);
    assert.equal(saved.length, 2);
    assert.equal(completedMeasurement(store.job(job.id)), true);
    analysisScan = scanId;
    await resume();
    refuse();
    assert.deepEqual(store.observations(project.id, job.id), saved);
    findings = [finding];
    await resume();
    assert.deepEqual(completedAnalysisResult(store.job(job.id)), { findings: 1, measurementJobId: job.id });
    assert.deepEqual(store.findings(project.id)[0].evidenceIds, [saved.find(row => row.prompt === answer.prompt)?.id]);
    assert.deepEqual(store.observations(project.id, job.id), saved);
    assert.equal(submissions, 1);
    assert.equal(evidenceReads, 3);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
