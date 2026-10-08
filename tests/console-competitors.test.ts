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
import { jobInput, projectInput, type Observation } from "../server/contracts.js";

test("managed role review keeps saved answers, rejects unrelated evidence and resumes without another purchase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-managed-roles-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("console", { key: "synthetic-console-credential" });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", competitors: ["tracked.example"] }));
  const check = store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt" }), "check");
  const answer: Observation = { id: randomUUID(), projectId: project.id, jobId: check.id, prompt: "Which tools help teams share reports?",
    answer: "Example Reports provides reporting software. Reporting Reference publishes standards.",
    citations: [{ url: "https://example.net/reports", title: "Example Reports" }, { url: "https://example.org/standards", title: "Reporting Reference" }],
    provider: "chatgpt", platform: "chat_gpt", model: "fixture-model", locale: project.locale, surface: "api",
    observedAt: new Date().toISOString(), mentioned: false, cited: false, costUsd: 0 };
  store.put("observation", project.id, check.id, answer); store.updateJob(check.id, { status: "completed" });
  const domain = randomUUID(), quote = randomUUID(), remote = randomUUID();
  let approved = 0, purchases = 0, foreign = true;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, path = new URL(request.url!, "http://localhost").pathname;
    const saved = { id: remote, status: "completed", estimated_credits: 2, approved_credits: approved,
      cancel_requested: false, receipt: { charged_credits: 1, refunded_credits: approved - 1, status: "completed" } };
    let data;
    if (path === "/capabilities") data = { platforms: [], operations: ["competitors"], content_available: false, models: [] };
    else if (path === "/domains") data = [{ id: domain, domain: project.domain }];
    else if (path.endsWith("/competitors/estimate")) {
      assert.deepEqual(body.answers, [{ id: answer.id, question: answer.prompt, answer: answer.answer, observed_at: answer.observedAt, citations: answer.citations }]);
      data = { id: quote, domain_id: domain, operation: "competitors", estimated_credits: 2, expires_at: new Date(Date.now() + 3600000).toISOString() };
    } else if (path === "/competitors/jobs") {
      purchases++; approved = body.approved_credits;
      data = { ...saved, approved_credits: approved, receipt: { ...saved.receipt, refunded_credits: approved - 1 } };
    } else if (path.endsWith("/results")) data = { job: saved, review_complete: true, locale: project.locale,
      provenance: "client_supplied_answers", websites: [
        { name: "Example Reports", domain: "example.net", role: "competitor", reason: "A reporting tool for the same teams.", answer_ids: [foreign ? randomUUID() : answer.id] },
        { name: "Reporting Reference", domain: "example.org", role: "reference", reason: "Publishes reporting standards.", answer_ids: [answer.id] }] };
    else data = saved;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const original = globalThis.fetch;
  globalThis.fetch = ((url, init) => original("http://127.0.0.1:" + (server.address() as any).port + new URL(String(url)).pathname.replace("/api/v1/console", ""), init)) as typeof fetch;
  try {
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "competitors", provider: "console", measurementJobId: check.id, maxCostUsd: 0.5 }), "roles");
    await runner.tick(); assert.equal(store.job(job.id).error, "approval"); assert.equal(purchases, 0);
    runner.resume(job.id, true); await runner.tick();
    assert.equal(store.job(job.id).status, "paused"); assert.equal(store.job(job.id).error, "invalid_response");
    foreign = false; runner.resume(job.id, true); await runner.tick();
    assert.equal(store.job(job.id).status, "completed"); assert.equal(purchases, 1);
    const result = store.job(job.id).result as any;
    assert.equal(result.measurementJobId, check.id);
    assert.deepEqual(result.competitors.map((site: any) => site.domain), ["example.net"]);
    assert.deepEqual(result.references.map((site: any) => site.domain), ["example.org"]);
    assert.deepEqual(result.competitors[0].observationIds, [answer.id]);
    assert.deepEqual(store.project(project.id).competitors, ["tracked.example"]);
    assert.deepEqual(store.observations(project.id, check.id), [answer]);
    assert.equal(store.job(job.id).spentUsd, 0.1);
  } finally {
    globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
    server.closeAllConnections(); server.close(); await once(server, "close"); rmSync(directory, { recursive: true, force: true });
  }
});
