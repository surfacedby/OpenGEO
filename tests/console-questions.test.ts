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

test("managed questions require approval, recover uncertain submissions and retain only reviewed owned evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-managed-questions-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("console", { key: "synthetic-console-credential" });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: Array.from({ length: 121 }, (_, index) => "How can I share report number " + index + " with my team?") }));
  const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "audit");
  const page = parsePage("https://example.com/export", 200, "<title>Reports</title><main><p>Reporting software helps small teams share charts and tables with their colleagues. Each report can be exported for a presentation.</p></main>");
  store.put("page", project.id, audit.id, page);
  store.setStep(audit.id, "project", "done", project);
  store.updateJob(audit.id, { status: "completed" });
  const domain = randomUUID(), jobs = new Map<string, any>(), inputs = new Map<string, unknown>();
  let mode = "collect", available = true, purchases = 0, lookups = 0, capabilityReads = 0, cancellations = 0;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, address = new URL(request.url!, "http://localhost"), path = address.pathname;
    let data: unknown, meta: unknown;
    if (path === "/capabilities") {
      capabilityReads++;
      data = { platforms: [], operations: available ? ["questions"] : [], content_available: false, models: [{ id: "managed-model", operations: ["questions"] }] };
    } else if (path === "/domains") data = [{ id: domain, domain: project.domain }];
    else if (path.endsWith("/questions/estimate")) {
      inputs.set(request.headers["idempotency-key"] as string, body);
      data = { id: randomUUID(), domain_id: domain, operation: "questions", estimated_credits: 3, expires_at: new Date(Date.now() + 3600000).toISOString() };
    } else if (path === "/questions/jobs") {
      purchases++;
      jobs.set(body.request_key, { id: randomUUID(), ...body, operation: "questions", status: mode === "cancel" ? "queued" : "completed",
        estimated_credits: 3, cancel_requested: false, progress: "Questions reviewed",
        receipt: mode === "cancel" ? null : { charged_credits: 1, refunded_credits: body.approved_credits - 1, status: "completed" } });
      request.socket.destroy(); return;
    } else if (path === "/jobs") {
      lookups++;
      const saved = jobs.get(address.searchParams.get("request_key")!);
      data = [{ ...saved, ...(mode === "mismatch" ? { estimate_id: randomUUID() } : {}) }];
      meta = { has_more: false, next_cursor: null };
    } else {
      const saved = [...jobs.values()].find(job => path.includes("/" + job.id));
      assert.ok(saved, path);
      if (path.endsWith("/cancel")) {
        cancellations++; saved.status = "cancelled"; saved.cancel_requested = true;
        saved.receipt = { charged_credits: 1, refunded_credits: saved.approved_credits - 1, status: "cancelled" };
        data = saved;
      } else if (path.endsWith("/results")) data = {
        job: saved, review_complete: mode !== "incomplete", locale: project.locale, pages_read: 2,
        questions: ["How can I share a report with my team without sending a spreadsheet?", "HOW can I share a report with my team without sending a spreadsheet!", project.prompts[120]].map(text => ({ text,
          sources: [{ url: mode === "foreign" ? "https://other.example/report" : page.url, title: page.title, observed_at: new Date().toISOString() }] })),
        private_tracking: "not-part-of-public-result",
      };
      else data = saved;
    }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data, ...(meta ? { meta } : {}) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const original = globalThis.fetch;
  globalThis.fetch = ((url, init) => {
    const address = new URL(String(url));
    return original("http://127.0.0.1:" + (server.address() as any).port + address.pathname.replace("/api/v1/console", "") + address.search, init);
  }) as typeof fetch;
  try {
    for (const scenario of ["collect", "cancel", "mismatch", "incomplete", "foreign"]) {
      mode = scenario; available = true;
      const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "discover", provider: "console", auditJobId: audit.id, maxCostUsd: 0.5 }), scenario);
      const bought = purchases;
      await runner.tick();
      assert.equal(store.job(job.id).error, "approval");
      assert.equal(purchases, bought, "a quote never starts paid work");
      assert.deepEqual(inputs.get(job.id + ":estimate"), { source_urls: [page.url], existing_questions: project.prompts.slice(0, 100), count: 12, locale: project.locale });
      assert.equal(store.step(job.id, "console-questions-approval"), undefined);
      runner.resume(job.id, true); await runner.tick();
      assert.equal(store.job(job.id).status, "paused");
      assert.equal(purchases, bought + 1);
      assert.equal(store.step(job.id, "console-questions-job")?.state, "started");
      const quote = JSON.parse(store.step(job.id, "console-questions-estimate")!.body!);
      store.setStep(job.id, "console-questions-estimate", "done", { ...quote, expires_at: new Date(Date.now() - 1000).toISOString() });
      const reads = capabilityReads; available = false;
      if (scenario === "cancel") {
        await runner.cancel(job.id);
        assert.equal(store.job(job.id).status, "cancelled"); assert.equal(store.job(job.id).error, null);
      } else {
        runner.resume(job.id, true); await runner.tick();
        if (scenario !== "collect") {
          assert.equal(store.job(job.id).status, "paused");
          mode = "collect"; runner.resume(job.id, true); await runner.tick();
        }
        const completed = store.job(job.id);
        assert.equal(completed.status, "completed", completed.progress);
        const result = completed.result as any;
        assert.equal(result.questions.length, 1);
        assert.deepEqual(result.questions[0].pageIds, [page.id]);
        assert.equal(result.questions[0].sources[0].url, page.url);
        assert.ok(result.questions[0].sources[0].observed_at);
        assert.equal(JSON.stringify(result).includes("not-part-of-public-result"), false);
      }
      assert.equal(purchases, bought + 1);
      assert.equal(capabilityReads, reads, "disabling purchases cannot block an already-approved result");
      assert.equal(store.job(job.id).spentUsd, 0.1);
      assert.equal(store.job(job.id).costBasis, "reported");
      assert.deepEqual(store.project(project.id).prompts, project.prompts, "suggestions remain unselected until user review");
    }
    assert.equal(cancellations, 1); assert.equal(lookups, 6);
  } finally {
    globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
    server.closeAllConnections(); server.close(); await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
