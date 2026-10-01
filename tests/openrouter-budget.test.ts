import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { Connections } from "../server/oauth.js";
import { Providers } from "../server/providers.js";
import { Runner } from "../server/workflows.js";
import { jobInput, projectInput } from "../server/contracts.js";

test("OpenRouter dispatch binds endpoint prices to the approved estimate and stops on missing cost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-routing-budget-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set("openrouter", { key: "synthetic-openrouter-key" });
  const connections = new Connections(store, vault), providers = new Providers(vault, connections);
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    requests.push(JSON.parse(init!.body as string));
    return new Response(JSON.stringify({ model: "fixture-model", choices: [{ finish_reason: "stop", message: { content: "Saved output." } }], usage: { cost: "not-a-cost" } }),
      { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "openrouter", maxCostUsd: 1 }), "routing-budget-check");
    const model = { id: "fixture-model", name: "Fixture", contextLength: 100000, maxOutputTokens: 2048, inputUsd: 0.000001, outputUsd: 0.000002 };
    const runner = new Runner(store, providers);
    await assert.rejects(runner.llmPass(job, model, "research", { topic: "Examples" }, new AbortController().signal), (error: any) => error.code === "cost_unknown");
    assert.deepEqual(requests[0].provider, { require_parameters: true, max_price: { prompt: 1, completion: 2, request: 0 } });
    assert.equal(requests[0].max_tokens, 2048);
    assert.equal(requests[0].model, model.id);
    assert.equal(store.job(job.id).costBasis, "includes_estimates");
    assert.ok(store.job(job.id).spentUsd > 0 && store.job(job.id).spentUsd < 1);
    assert.equal(store.step(job.id, "research")?.state, "done");
    assert.equal(await runner.llmPass(job, model, "research", { topic: "Examples" }, new AbortController().signal), "Saved output.");
    assert.equal(requests.length, 1);
    for (const prices of [undefined, { inputUsd: -1, outputUsd: 1 }, { inputUsd: Infinity, outputUsd: 1 }])
      await assert.rejects(providers.complete("openrouter", model.id, "Research", "Examples", new AbortController().signal, 2048, false, prices), (error: any) => error.code === "estimate");
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = original; connections.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("OpenRouter model choices exclude unknown, negative and per-request prices", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-catalog-prices-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const connections = new Connections(store, vault), original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [
    { id: "valid", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "free", pricing: { prompt: "0", completion: "0" } },
    { id: "unknown", pricing: { prompt: null, completion: null } },
    { id: "negative", pricing: { prompt: "-1", completion: "0" } },
    { id: "request-fee", pricing: { prompt: "0", completion: "0", request: "1" } },
  ].map(model => ({ ...model, name: model.id, architecture: { output_modalities: ["text"] }, supported_parameters: ["max_tokens"], context_length: 10000 })) }),
  { headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try { assert.deepEqual((await new Providers(vault, connections).models("openrouter")).map(model => model.id).sort(), ["free", "valid"]); }
  finally { globalThis.fetch = original; connections.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
