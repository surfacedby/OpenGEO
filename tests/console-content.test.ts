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
import { parsePage } from "../server/audit.js";
import { jobInput, projectInput } from "../server/contracts.js";
import { exportProject } from "../server/export.js";
import { importProject } from "../server/import.js";
import { Scheduler } from "../server/scheduler.js";

test("managed drafts preserve approved quotes, survive interrupted collection, settle once and export scoped reviews", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-managed-content-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("console", { key: "synthetic-console-credential" });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", locale: "fr-FR" }));
  const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "site-audit");
  store.put("page", project.id, audit.id, parsePage("https://example.com/", 200, "<title>Shared reports</title><main><p>Create useful reports for your team.</p></main>"));
  store.updateJob(audit.id, { status: "completed" });
  const domainId = randomUUID(), quoteId = randomUUID(), remoteId = randomUUID();
  const requests: { path: string; body: any; identity?: string }[] = [];
  let finished = false, cancelling = false;
  const remote = () => ({ id: remoteId, status: finished ? cancelling ? "cancelled" : "completed" : "waiting_reconciliation",
    estimated_credits: 4, cancel_requested: cancelling,
    receipt: finished ? { status: cancelling ? "cancelled" : "completed", charged_credits: 2, refunded_credits: 2 } : null });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const path = request.url!;
    requests.push({ path, body: body ? JSON.parse(body) : undefined, identity: request.headers["idempotency-key"] as string | undefined });
    assert.equal(request.headers["x-api-key"], "synthetic-console-credential");
    let data: unknown;
    if (path === "/capabilities") data = { platforms: [], operations: ["content"], content_available: true, models: [{ id: "managed-model", operations: ["content"] }] };
    else if (path === "/domains") data = [{ id: domainId, domain: project.domain }];
    else if (path.includes("/estimates/")) {
      assert.equal(requests.at(-1)!.body.locale, "fr-FR");
      assert.equal(requests.at(-1)!.body.content_type, "blog_post");
      assert.deepEqual(requests.at(-1)!.body.source_urls, ["https://example.com/"]);
      data = { id: quoteId, domain_id: domainId, operation: "content", estimated_credits: 4, expires_at: new Date(Date.now() + 3600000).toISOString() };
    } else if (path === "/content/jobs") data = remote();
    else if (path.endsWith("/cancel")) { cancelling = true; data = remote(); }
    else if (path.endsWith("/results")) data = { job: remote(), brief: "Explain reports for small teams.", draft: { title: "Reports", markdown: "# Rapports\n\nCréez un rapport utile.", html: "<script>private-fixture</script>" },
      review: { requires_human_review: true, claim_scope: "numeric_and_absolute_statements", coverage_complete: false,
        issues: [{ claim: "Always complete", support: "unsupported", evidence_urls: ["https://example.com/"] }], privatePrompt: "private-fixture" },
      sources: [{ url: "https://example.com/", title: "Reports", supplier_id: "private-fixture" }], privateAccounting: "private-fixture" };
    else if (path === "/content/jobs/" + remoteId) data = remote();
    else { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const original = globalThis.fetch;
  globalThis.fetch = ((url, init) => {
    const address = new URL(String(url));
    assert.equal(address.origin, "https://api.surfacedby.com");
    return original(`http://127.0.0.1:${(server.address() as any).port}` + address.pathname.replace("/api/v1/console", ""), init);
  }) as typeof fetch;
  try {
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "console", topic: "How can I share reports?", maxCostUsd: 0.3 }), "managed-draft");
    await runner.tick();
    assert.equal(store.job(job.id).error, "budget");
    assert.equal(requests.filter(request => request.path === "/content/jobs").length, 0);
    runner.resume(job.id, false, 0.6); await runner.tick();
    assert.equal(store.job(job.id).error, "approval");
    assert.throws(() => runner.resume(job.id, false));
    assert.equal(requests.filter(request => request.path === "/content/jobs").length, 0);
    runner.resume(job.id, true); await runner.tick();
    assert.equal(store.job(job.id).error, "waiting");
    assert.equal(store.job(job.id).spentUsd, 0.4);
    assert.equal(store.job(job.id).costBasis, "includes_estimates");
    const submission = requests.find(request => request.path === "/content/jobs")!;
    assert.equal(submission.identity, job.id);
    assert.deepEqual(submission.body, { estimate_id: quoteId, request_key: job.id, approved_credits: 6 });
    finished = true; runner.resume(job.id, false); await runner.tick();
    assert.equal(store.job(job.id).status, "completed");
    assert.equal(store.job(job.id).spentUsd, 0.2);
    assert.equal(store.job(job.id).costBasis, "reported");
    assert.equal(requests.filter(request => request.path.includes("/estimates/")).length, 1);
    assert.equal(requests.filter(request => request.path === "/content/jobs").length, 1);
    const exported = exportProject(store, project.id);
    assert.equal(JSON.stringify(exported).includes("private-fixture"), false);
    const restored = importProject(store, exported).project;
    const draft = store.artifacts<any>(restored.id, "content")[0];
    assert.equal(draft.markdown, "# Rapports\n\nCréez un rapport utile.");
    assert.equal(draft.review.scope, "numeric_and_absolute_statements");
    assert.equal(draft.review.coverageComplete, false);
    assert.equal(draft.status, "needs_review");
    assert.equal(draft.requiresHumanReview, true);
    assert.equal(draft.sourceEvidence[0].url, "https://example.com/");
    assert.equal(draft.review.issues[0].evidenceIds[0], draft.sourceEvidence[0].id);
    const cancelled = store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "console", topic: "How can I share reports?", maxCostUsd: 0.6 }), "cancelled-managed-draft");
    finished = false; await runner.tick(); runner.resume(cancelled.id, true); await runner.tick(); await runner.cancel(cancelled.id);
    assert.equal(store.job(cancelled.id).error, "cancel_remote");
    assert.equal(store.job(cancelled.id).spentUsd, 0.4);
    finished = true; await runner.cancel(cancelled.id);
    assert.equal(store.job(cancelled.id).error, null);
    assert.equal(store.job(cancelled.id).spentUsd, 0.2);
    assert.equal(requests.filter(request => request.path === "/content/jobs").length, 2);
    cancelling = false;
    const scheduler = new Scheduler(store), scheduled = scheduler.add({ job: { projectId: project.id, kind: "content", provider: "console", topic: "How can I share reports?", maxCostUsd: 0.6 }, frequency: "daily", hour: 9, timezone: "UTC", monthlyBudgetUsd: 0.6 });
    scheduler.tick(new Date(scheduled.nextAt)); await runner.tick();
    const scheduledJob = store.jobs(project.id).find(item => item.kind === "content" && ![job.id, cancelled.id].includes(item.id))!;
    assert.equal(scheduledJob.status, "completed");
    assert.equal(requests.filter(request => request.path === "/content/jobs").length, 3);
    scheduler.tick(new Date(scheduler.list()[0].nextAt));
    assert.equal(scheduler.list()[0].lastError, "Monthly budget is insufficient for the next run.");
  } finally {
    globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
    server.closeAllConnections(); server.close(); await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
