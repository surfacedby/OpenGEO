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

const json = (data: unknown) => new Response(JSON.stringify({ data }), {
  headers: { "Content-Type": "application/json" },
});

test("Console check totals and public citations survive project edits, dashboard reads and restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-console-contract-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() });
  vault.set("console", { key: "synthetic-console-key" });
  const runtime = await createApp(store, vault, "synthetic-local-session");
  const original = globalThis.fetch;
  let submitted = 0, previewCount: unknown = 3, finalCount = 3;
  // Supplier HTTP fixtures exercise the production adapter, queue, projections and SQLite writes.
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/api/v1/console", "");
    if (path === "/capabilities") return json({ platforms: [{ key: "chatgpt", name: "ChatGPT", enabled: true }] });
    if (path === "/domains") return json([{ id: "fixture-domain", domain: "example.com" }]);
    if (path === "/domains/fixture-domain/brand") return json({ domain_id: "fixture-domain" });
    if (path === "/scans/preview") return json({ credits_required: 2, query_count: previewCount });
    if (path === "/scans") {
      submitted++;
      assert.equal(JSON.parse(init!.body as string).max_credits, 2);
      return json({ scan_id: "fixture-scan", credits_charged: 2 });
    }
    if (path === "/scans/fixture-scan") return json({ status: "completed", answers_total: finalCount,
      visibility_score: 75, completed_at: "2026-10-01T10:00:00Z" });
    if (path.endsWith("/analysis")) return json({ analysis_status: "available" });
    if (path.endsWith("/observations")) return json([
      { id: "remote-answer-1", prompt: "First question?", platform: "chatgpt", model: "fixture-model", status: "collected",
        surface: "consumer_interface",
        answer_text: "Example provides examples.", presence: "cited", citations: [null, "unusable annotation", { url_citation: "unusable nested annotation" },
          { url: "https://example.com/", title: null, supplier_secret: "synthetic-hidden-field" }, { url: "javascript:alert(1)" }, { url: "https://example.com/" }] },
      { id: "remote-answer-2", prompt: "Second question?", platform: "chatgpt", model: "fixture-model", status: "collected",
        answer_text: "Other examples.", presence: "missing", citations: [] },
      { id: "remote-answer-3", prompt: "Third question?", platform: "chatgpt", status: "missing_observation", answer_text: null },
    ]);
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
    assert.equal((await workspace(project.id)).metrics.requested, 3);
    assert.match(reportMarkdown(store, project.id), /Answers collected: 2 of 3/);
    const portable = exportProject(store, project.id);
    assert.equal(JSON.stringify(portable).includes("synthetic-hidden-field"), false);
    assert.deepEqual(portable.observations[0].citations, []);
    assert.equal(portable.observations[0].surface, "unknown");
    assert.equal(portable.observations[1].surface, "consumer_interface");
    assert.deepEqual(portable.observations[1].citations, [{ url: "https://example.com/" }]);
    const restored = importProject(store, portable).project;
    assert.equal((await workspace(restored.id)).metrics.requested, 3);
    assert.equal((await workspace(restored.id)).comparison.status, "incomplete");
    previewCount = null;
    const rejected = enqueue("console-no-scope-check");
    await runtime.runner.tick();
    assert.equal(store.job(rejected.id).error, "estimate");
    assert.equal(submitted, 1);
    previewCount = 3; finalCount = 1;
    const inconsistent = enqueue("console-inconsistent-scope-check");
    await runtime.runner.tick();
    assert.equal(store.job(inconsistent.id).error, "invalid_response");
    assert.equal(store.observations(project.id, inconsistent.id).length, 2);
    assert.equal(store.job(inconsistent.id).requestedAnswers, 3);
    assert.equal(submitted, 2);
  } finally {
    globalThis.fetch = original;
    await runtime.app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
