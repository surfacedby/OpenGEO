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
import { jobInput, projectInput } from "../server/contracts.js";

for (const scenario of ["lost_ack", "changed_receipt", "foreign_question", "cancel", "cancel_receipt", "cancel_completed"] as const) {
  test("selected-question measurement preserves approval and evidence: " + scenario, async () => {
    const directory = mkdtempSync(join(tmpdir(), "opengeo-managed-measurement-")), store = new Store(directory);
    const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
    vault.set("console", { key: "synthetic-console-credential" });
    const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
    const prompts = ["How can I share reports with my team?", "Which tools let me export a report?"];
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts }));
    const domain = randomUUID(), quote = randomUUID(), remote = randomUUID();
    let purchases = 0, input: any, accepted: any, invalid = true, available = true;
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null, address = new URL(request.url!, "http://localhost"), path = address.pathname;
      let data: any, meta: any;
      if (path === "/capabilities") data = { platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }],
        operations: available ? ["measurement"] : [], content_available: false, models: [], selected_question_platforms: ["chatgpt"] };
      else if (path === "/domains") data = [{ id: domain, domain: project.domain }];
      else if (path.endsWith("/brand")) data = {};
      else if (path.endsWith("/measurement/estimate")) {
        input = body;
        assert.deepEqual(input.questions.map((row: any) => row.question), prompts);
        assert.equal(input.locale, "en-US"); assert.equal(input.country, "US");
        data = { id: quote, domain_id: domain, operation: "measurement", estimated_credits: 4,
          expires_at: new Date(Date.now() + 3600000).toISOString() };
      } else if (path === "/measurement/jobs") {
        purchases++;
        accepted = { id: remote, ...body, status: scenario.startsWith("cancel") ? "waiting_reconciliation" : "completed",
          estimated_credits: 4, cancel_requested: false, receipt: scenario.startsWith("cancel") ? null :
            { status: "completed", charged_credits: 2, refunded_credits: body.approved_credits - 2 } };
        if (scenario === "lost_ack") { request.socket.destroy(); return; }
        data = accepted;
      } else if (path === "/jobs") { data = [accepted]; meta = { has_more: false }; }
      else if (path.endsWith("/cancel")) {
        const status = scenario === "cancel_completed" ? "completed" : "cancelled", charge = status === "completed" ? 2 : 1;
        accepted = { ...accepted, status, cancel_requested: true,
          receipt: { status, charged_credits: charge, refunded_credits: accepted.approved_credits - charge } };
        data = accepted;
      } else if (path.endsWith("/results")) {
        const questions = ["cancel", "cancel_receipt"].includes(scenario) ? input.questions.slice(0, 1) : input.questions;
        const wrongCharge = scenario === "cancel_receipt" ? 2 : 1;
        data = { job: ["changed_receipt", "cancel_receipt"].includes(scenario) && invalid ? { ...accepted,
            receipt: { ...accepted.receipt, charged_credits: wrongCharge, refunded_credits: accepted.approved_credits - wrongCharge } } : accepted,
          profile: "selected_questions", requested_answers: 2, platform: input.platform, locale: input.locale,
          observations: questions.map((question: any, index: number) => ({ id: scenario === "foreign_question" && invalid ? randomUUID() : question.id,
            question: question.question, status: index === 1 ? "missing_observation" : "collected", platform: input.platform,
            locale: input.locale, country: input.country, surface: "consumer_interface", model: "measured-model",
            answer: index === 1 ? null : "Example helps teams share reports.",
            citations: index === 1 ? [] : [{ url: "https://example.com/reports", title: "Sharing reports" }],
            observed_at: "2026-10-08T08:00:00Z" })) };
      } else { assert.equal(path, "/jobs/" + remote); data = accepted; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data, ...(meta ? { meta } : {}) }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const original = globalThis.fetch;
    globalThis.fetch = ((url, init) => { const address = new URL(String(url)); return original("http://127.0.0.1:" +
      (server.address() as any).port + address.pathname.replace("/api/v1/console", "") + address.search, init); }) as typeof fetch;
    try {
      const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "console", maxCostUsd: 0.5 }), "selected");
      await runner.tick(); assert.equal(store.job(job.id).error, "approval"); assert.equal(purchases, 0);
      assert.equal(store.observations(project.id).length, 0);
      store.updateProject(project.id, { ...project, prompts: ["A later project edit must not change this check."] });
      runner.resume(job.id, true); await runner.tick();
      if (scenario.startsWith("cancel")) {
        assert.equal(store.job(job.id).error, "waiting");
        await runner.cancel(job.id);
        if (scenario === "cancel_receipt") {
          assert.equal(store.job(job.id).error, "cancel_remote"); assert.equal(store.observations(project.id).length, 0);
          invalid = false; await runner.cancel(job.id);
        }
        assert.equal(store.job(job.id).status, "cancelled"); assert.equal(store.job(job.id).error, null);
        assert.equal(store.job(job.id).spentUsd, scenario === "cancel_completed" ? 0.2 : 0.1);
        if (scenario === "cancel_completed") assert.equal((store.job(job.id).result as any).terminalStatus, "completed");
      } else {
        assert.equal(store.job(job.id).status, "paused");
        assert.equal(store.observations(project.id).length, 0);
        invalid = false; available = false;
        runner.resume(job.id, true); await runner.tick();
        assert.equal(store.job(job.id).status, "completed"); assert.equal(store.job(job.id).spentUsd, 0.2);
      }
      assert.equal(purchases, 1);
      const observations = store.observations(project.id);
      assert.equal(observations.length, 1); assert.equal(observations[0].prompt, prompts[0]);
      assert.equal(observations[0].observedAt, "2026-10-08T08:00:00Z");
      assert.equal(observations[0].surface, "consumer_interface"); assert.equal(observations[0].costUsd, null);
      assert.deepEqual((store.job(job.id).result as any).metrics,
        { requested: 2, completed: 1, missing: 1, mentionRate: 100, citationRate: 100, citations: 1 });
      assert.equal(store.findings(project.id).length, 0);
      await runner.tick(); assert.equal(purchases, 1);
    } finally {
      globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
      server.closeAllConnections(); server.close(); await once(server, "close"); rmSync(directory, { recursive: true, force: true });
    }
  });
}
