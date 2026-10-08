import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { Connections } from "../server/oauth.js";
import { Providers } from "../server/providers.js";
import { Runner } from "../server/workflows.js";
import { jobInput, projectInput, type Observation, type ManagedSourceEvidence } from "../server/contracts.js";
import { exportProject } from "../server/export.js";
import { importProject, previewImport } from "../server/import.js";
import { contentSources } from "../server/evidence-context.js";

test("managed recommendations validate evidence, keep work types and restore fresh excerpts without repurchasing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-managed-opportunities-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("console", { key: "synthetic-console-credential" });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
  const check = store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt" }), "check");
  const answer: Observation = { id: randomUUID(), projectId: project.id, jobId: check.id,
    prompt: "How can I share a report with my team?", answer: "Example Reports offers sharing tools.",
    citations: [{ url: "https://example.net/reports", title: "Example Reports" }], provider: "chatgpt", platform: "chat_gpt",
    model: "fixture-model", locale: project.locale, surface: "api", observedAt: "2026-01-01T08:00:00Z", mentioned: false, cited: false, costUsd: 0 };
  store.put("observation", project.id, check.id, answer); store.updateJob(check.id, { status: "completed" });
  const domain = randomUUID(), quote = randomUUID(), remote = randomUUID();
  let approved = 0, purchases = 0, foreign = true;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, path = new URL(request.url!, "http://localhost").pathname;
    const saved = { id: remote, status: "completed", estimated_credits: 4, approved_credits: approved,
      cancel_requested: false, receipt: { charged_credits: 1, refunded_credits: approved - 1, status: "completed" } };
    let data;
    if (path === "/capabilities") data = { platforms: [], operations: ["local_opportunities"], content_available: false, models: [] };
    else if (path === "/domains") data = [{ id: domain, domain: project.domain }];
    else if (path.endsWith("/opportunities/estimate")) {
      assert.equal(body.answers[0].observed_at, answer.observedAt); assert.equal(body.answers[0].answer, answer.answer);
      data = { id: quote, domain_id: domain, operation: "local_opportunities", estimated_credits: 4,
        expires_at: new Date(Date.now() + 3600000).toISOString() };
    } else if (path === "/opportunities/jobs") {
      purchases++; approved = body.approved_credits;
      data = { ...saved, approved_credits: approved, receipt: { ...saved.receipt, refunded_credits: approved - 1 } };
    } else if (path.endsWith("/results")) data = { job: saved, review_complete: true, locale: project.locale,
      provenance: "client_supplied_answers", pages_read: 1, uncertainties: [], sources: [{ url: "https://example.com/export",
        title: "Export a report", text: "The current page explains report sharing and export.", fetched_at: "2026-10-08T08:00:00Z" }],
      opportunities: ["page_update", "new_content"].map(type => ({ type, title: type === "page_update" ? "Explain the sharing options" : "Write a guide to sharing reports",
        description: "Help readers choose a sharing method using the saved answer and the current page.", benefit: "Readers can finish sharing their report.",
        page_title: "Report sharing", page_label: type === "page_update" ? "Product page" : "Guide", topic: "Sharing a report",
        target_url: type === "page_update" ? "https://example.com/export" : null, source_urls: ["https://example.com/export"],
        answer_ids: [foreign ? randomUUID() : answer.id], steps: ["Show a supported sharing example."] })) };
    else data = saved;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const original = globalThis.fetch;
  globalThis.fetch = ((url, init) => original("http://127.0.0.1:" + (server.address() as any).port + new URL(String(url)).pathname.replace("/api/v1/console", ""), init)) as typeof fetch;
  try {
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "diagnose", provider: "console", maxCostUsd: 0.5 }), "opportunities");
    await runner.tick(); assert.equal(store.job(job.id).error, "approval"); assert.equal(purchases, 0);
    runner.resume(job.id, true); await runner.tick();
    assert.equal(store.job(job.id).error, "invalid_response"); assert.equal(store.findings(project.id).length, 0);
    assert.equal(store.artifacts(project.id, "source").length, 0);
    foreign = false; runner.resume(job.id, true); await runner.tick();
    assert.equal(store.job(job.id).status, "completed"); assert.equal(purchases, 1); assert.equal(store.job(job.id).spentUsd, 0.1);
    const findings = store.findings(project.id), sources = store.artifacts<ManagedSourceEvidence>(project.id, "source");
    assert.deepEqual(new Set(findings.map(row => row.opportunity?.type)), new Set(["page_update", "new_content"]));
    assert.equal(sources.length, 1); assert.equal(store.pages(project.id).length, 0);
    assert.ok(findings.every(row => row.evidenceIds.includes(sources[0].id) && row.evidenceIds.includes(answer.id)));
    assert.equal(contentSources(sources, "Sharing a report", 10000, [findings[0].targetUrl]).sources[0].id, sources[0].id);
    const exported = exportProject(store, project.id), restored = importProject(store, exported).project;
    const restoredSources = store.artifacts<ManagedSourceEvidence>(restored.id, "source"), restoredFindings = store.findings(restored.id);
    assert.equal(restoredSources[0].fetchedAt, sources[0].fetchedAt); assert.notEqual(restoredSources[0].id, sources[0].id);
    assert.ok(restoredFindings.every(row => row.evidenceIds.includes(restoredSources[0].id)));
    assert.equal(store.job(restoredSources[0].jobId).kind, "diagnose"); assert.equal(store.pages(restored.id).length, 0);
    assert.throws(() => previewImport(store, { ...exported, sourceEvidence: [{ ...exported.sourceEvidence[0], jobId: "foreign-job" }] }));
    assert.deepEqual(store.observations(project.id, check.id), [answer]);
    await runner.tick(); assert.equal(store.findings(project.id).length, 2); assert.equal(purchases, 1);
  } finally {
    globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
    server.closeAllConnections(); server.close(); await once(server, "close"); rmSync(directory, { recursive: true, force: true });
  }
});
