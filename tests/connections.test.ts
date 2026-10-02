import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { Connections } from "../server/oauth.js";
import { connectionPage } from "../server/connection-page.js";
import { Providers } from "../server/providers.js";
import { Runner } from "../server/workflows.js";
import { jobInput, projectInput, ProviderError } from "../server/contracts.js";
import { comparisonKey } from "../server/analysis.js";
import { exportProject } from "../server/export.js";
import { importProject } from "../server/import.js";
import { parsePage } from "../server/audit.js";
import { htmlDocument } from "../server/markdown.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-connection-test-")), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() });
  const profile = { id: "account-a", client_id: "synthetic-client", email: "reader@example.invalid", scopes: ["chatgpt.tokens.use.direct"], access_token: "synthetic-access", refresh_token: "synthetic-refresh", expiresAt: 0 };
  vault.set("chatgpt", { active: profile.id, profiles: [profile] });
  const connections = new Connections(store, vault), providers = new Providers(vault, connections);
  return { directory, store, vault, connections, providers, profile, close() { connections.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("refreshes serialize per account and sign-out revokes the rotated token without resurrecting access", async () => {
  const f = fixture(), original = globalThis.fetch;
  let release!: () => void, started!: () => void, refreshes = 0, revokedToken = "";
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/token")) { refreshes++; started(); await gate; return json({ access_token: "synthetic-rotated-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600 }); }
    if (String(url).includes("openid-configuration")) return json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/revoke" });
    revokedToken = new URLSearchParams(init?.body as URLSearchParams).get("token")!;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const first = f.connections.token(), second = f.connections.token();
    const rejected = Promise.allSettled([first, second]);
    await ready; const logout = f.connections.signOut(); release();
    assert.deepEqual(await logout, { revoked: true });
    assert.equal(refreshes, 1); assert.equal(revokedToken, "synthetic-rotated-refresh");
    assert.ok((await rejected).every((result) => result.status === "rejected"));
    assert.equal(f.vault.status().chatgpt, false);
    const saved = f.vault.get("chatgpt").profiles[0]; assert.equal(saved.client_id, f.profile.client_id); assert.equal(saved.refresh_token, undefined);
  } finally { globalThis.fetch = original; f.close(); }
});

test("temporary refresh failures preserve credentials; confirmed invalid grants require reconnecting the saved registration", async () => {
  const f = fixture(), original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => json({ error: "temporarily_unavailable" }, 503)) as typeof fetch;
    await assert.rejects(f.connections.token()); assert.equal(f.vault.get("chatgpt").profiles[0].refresh_token, f.profile.refresh_token);
    globalThis.fetch = (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch;
    await assert.rejects(f.connections.token(), (error: any) => error.code === "auth");
    assert.equal(f.vault.get("chatgpt").profiles[0].access_token, undefined); assert.equal(f.vault.get("chatgpt").profiles[0].client_id, f.profile.client_id);
  } finally { globalThis.fetch = original; f.close(); }
});

test("changing accounts during refresh cannot return another account's access token or overwrite the selection", async () => {
  const f = fixture(), original = globalThis.fetch; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => { await gate; return json({ access_token: "synthetic-a-new", refresh_token: "synthetic-a-refresh", expires_in: 3600 }); }) as typeof fetch;
  try {
    const saved = f.vault.get("chatgpt"); saved.profiles.push({ ...f.profile, id: "account-b", access_token: "synthetic-b", refresh_token: "synthetic-b-refresh", expiresAt: Date.now() + 3600000 }); f.vault.set("chatgpt", saved);
    const refresh = f.connections.token(), rejection = assert.rejects(refresh, (error: any) => error.code === "auth");
    f.connections.select("account-b"); release(); await rejection;
    assert.equal(f.vault.get("chatgpt").active, "account-b"); assert.equal(await f.connections.token(), "synthetic-b");
  } finally { globalThis.fetch = original; f.close(); }
});

test("callback state failures do not consume sign-in; reconnect uses the saved registration and host", async () => {
  const f = fixture();
  try {
    const first = await f.connections.start("chatgpt", f.profile.id), auth = new URL(first.url), host = auth.searchParams.get("ext_agent_host_id");
    assert.equal(auth.searchParams.get("client_id"), f.profile.client_id); assert.equal(auth.searchParams.has("agent_name_hint"), false);
    const callback = new URL(auth.searchParams.get("redirect_uri")!); callback.searchParams.set("state", "wrong-state"); callback.searchParams.set("code", "synthetic-code");
    const response = await fetch(callback); assert.equal(response.status, 400); assert.match(await response.text(), /Let's reconnect/); assert.equal(response.headers.get("cache-control"), "no-store");
    await assert.rejects(f.connections.finish(first.state, new URLSearchParams({ state: "wrong-state", code: "synthetic-code" })));
    callback.searchParams.set("state", first.state); callback.searchParams.set("error", "access_denied"); callback.searchParams.delete("code"); assert.equal((await fetch(callback)).status, 400);
    const next = new URL((await f.connections.start("chatgpt", f.profile.id)).url); assert.equal(next.searchParams.get("ext_agent_host_id"), host);
  } finally { f.close(); }
});

test("a signed-in identity without plan permission is not advertised as connected or ready", () => {
  const f = fixture();
  try {
    const saved = f.vault.get("chatgpt"); saved.profiles[0].scopes = ["openid"]; f.vault.set("chatgpt", saved);
    assert.equal(f.vault.status().chatgpt, false); assert.equal(f.connections.profiles().profiles[0].sharing, false);
    const html = connectionPage("identity", "chatgpt", "http://127.0.0.1:4318"); assert.match(html, /usage wasn't enabled/); assert.ok(!html.includes("You're ready"));
    assert.ok(!connectionPage("connected", "chatgpt", "https://evil.example").includes('href="https://evil.example'));
  } finally { f.close(); }
});

test("OAuth completion tracks the attempt through exchange and cannot change a provider during active work", async () => {
  const f = fixture(), original = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.vault.set("openrouter", { key: "synthetic-original-key" });
  globalThis.fetch = (async () => { await gate; return json({ key: "synthetic-new-key" }); }) as typeof fetch;
  try {
    const attempt = await f.connections.start("openrouter", undefined, true);
    assert.deepEqual(f.connections.status("openrouter", attempt.state), { status: "pending" });
    assert.deepEqual(f.connections.status("chatgpt", attempt.state), { status: "expired" });
    const finishing = f.connections.finish(attempt.state, new URLSearchParams({ code: "synthetic-code" }));
    assert.deepEqual(f.connections.status("openrouter", attempt.state), { status: "pending" });
    release(); await finishing;
    assert.deepEqual(f.connections.status("openrouter", attempt.state), { status: "connected" });
    assert.equal(f.vault.get("openrouter").key, "synthetic-new-key");

    const next = await f.connections.start("openrouter", undefined, true);
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "openrouter" }), "oauth-active-work");
    f.store.updateJob(job.id, { status: "running" });
    await assert.rejects(f.connections.start("openrouter", undefined, true), (error: any) => error.code === "busy");
    await assert.rejects(f.connections.finish(next.state, new URLSearchParams({ code: "synthetic-code" })), (error: any) => error.code === "busy");
    assert.deepEqual(f.connections.status("openrouter", next.state), { status: "failed" });
    assert.equal(f.vault.get("openrouter").key, "synthetic-new-key");
  } finally { globalThis.fetch = original; f.close(); }
});

test("a late OAuth exchange cannot replace a newer connection", async () => {
  const f = fixture(), original = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (_url, init) => {
    const code = JSON.parse(init?.body as string).code;
    if (code === "older-code") await gate;
    return json({ key: "synthetic-" + code });
  }) as typeof fetch;
  try {
    const older = await f.connections.start("openrouter", undefined, true);
    const finishing = f.connections.finish(older.state, new URLSearchParams({ code: "older-code" }));
    const rejected = assert.rejects(finishing, /newer connection attempt/);
    const newer = await f.connections.start("openrouter", undefined, true);
    await f.connections.finish(newer.state, new URLSearchParams({ code: "newer-code" }));
    release(); await rejected;
    assert.equal(f.vault.get("openrouter").key, "synthetic-newer-code");
    assert.deepEqual(f.connections.status("openrouter", newer.state), { status: "connected" });
  } finally { release(); globalThis.fetch = original; f.close(); }
});

test("ChatGPT search confirmation requires a completed tool output, not the requested tool or citations", async () => {
  const f = fixture(), original = globalThis.fetch;
  const saved = f.vault.get("chatgpt"); saved.profiles[0].expiresAt = Date.now() + 3600000; f.vault.set("chatgpt", saved);
  let toolStatus: string | undefined;
  let searchRequested = true;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.tool_choice, searchRequested ? "required" : undefined);
    assert.deepEqual(body.tools, searchRequested ? [{ type: "web_search" }] : undefined);
    return new Response('data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
    ...(toolStatus ? [{ type: "web_search_call", status: toolStatus }] : []),
    { type: "message", content: [{ type: "output_text", text: "A complete answer.", annotations: [{ type: "url_citation", url: "https://example.com/" }] }] },
  ] } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } }); }) as typeof fetch;
  try {
    for (const [status, confirmed] of [[undefined, false], ["in_progress", false], ["completed", true]] as const) {
      toolStatus = status;
      const result = await f.providers.complete("chatgpt", "fixture-model", "Answer independently.", "What is an example?", new AbortController().signal, 4096, true);
      assert.equal(result.webSearchConfirmed, confirmed);
      assert.equal(result.citations.length, 1);
    }
    searchRequested = false; toolStatus = undefined;
    await f.providers.complete("chatgpt", "fixture-model", "Analyze the supplied pages.", "Read these pages.", new AbortController().signal);
  } finally { globalThis.fetch = original; f.close(); }
});

test("ChatGPT streaming search evidence survives an empty terminal output and remains gated on completion", async () => {
  const f = fixture(), original = globalThis.fetch;
  const saved = f.vault.get("chatgpt"); saved.profiles[0].expiresAt = Date.now() + 3600000; f.vault.set("chatgpt", saved);
  let finish = true;
  const events = () => [
    { type: "response.output_item.done", output_index: 0, item: { type: "web_search_call", status: "completed" } },
    { type: "response.output_text.delta", delta: "An answer based on sources." },
    { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/", title: "Example", tracking_id: "synthetic-private-tracking" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", status: "completed", content: [{ type: "output_text", text: "An answer based on sources.", annotations: [{ type: "url_citation", url: "https://example.com/", title: "Example" }] }] } },
    ...(finish ? [{ type: "response.completed", response: { status: "completed", output: [] } }] : []),
  ];
  globalThis.fetch = (async () => {
    const bytes = new TextEncoder().encode(events().map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
    return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 13) controller.enqueue(bytes.slice(index, index + 13)); controller.close(); } }));
  }) as typeof fetch;
  try {
    const result = await f.providers.complete("chatgpt", "fixture-model", "Answer independently.", "Find examples.", new AbortController().signal, 4096, true);
    assert.equal(result.webSearchConfirmed, true);
    assert.equal(result.text, "An answer based on sources.");
    assert.deepEqual(result.citations, [{ url: "https://example.com/", title: "Example" }]);
    finish = false;
    await assert.rejects(f.providers.complete("chatgpt", "fixture-model", "Answer independently.", "Find examples.", new AbortController().signal, 4096, true), /did not confirm completion/);
  } finally { globalThis.fetch = original; f.close(); }
});

test("a confirmed ChatGPT response finishes without waiting for the transport to close", async () => {
  const f = fixture(), original = globalThis.fetch;
  const saved = f.vault.get("chatgpt"); saved.profiles[0].expiresAt = Date.now() + 3600000; f.vault.set("chatgpt", saved);
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ content: [{ type: "output_text", text: "The completed answer." }] }] } }) + '\n\n'));
    },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  try {
    const response = await f.providers.complete("chatgpt", "fixture-model", "Answer independently.", "Explain this topic.", AbortSignal.timeout(1000));
    assert.equal(response.text, "The completed answer.");
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; f.close(); }
});

test("ChatGPT API measurements preserve citations and progress when plan usage stops, without a paid fallback", async () => {
  const f = fixture(), original = globalThis.fetch; let requests = 0;
  const saved = f.vault.get("chatgpt"); saved.profiles[0].expiresAt = Date.now() + 3600000; f.vault.set("chatgpt", saved);
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const input = JSON.parse(init?.body as string); assert.equal(input.stream, true); assert.equal(input.store, false); assert.deepEqual(input.tools, [{ type: "web_search" }]); assert.ok(!input.instructions.includes("Example Brand"));
    if (++requests === 2) return json({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, 429);
    return new Response('data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Example Brand provides examples.", annotations: [{ type: "url_citation", url: "https://example.com/", title: "Example", tracking_id: "synthetic-private-tracking" }] }] }] } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const runner = new Runner(f.store, f.providers);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example Brand", prompts: ["Where can I find examples?", "Which examples are useful?"] }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt", model: "fixture-model" }), "api-measure");
    await runner.tick(); assert.equal(f.store.job(job.id).status, "paused"); assert.equal(f.store.job(job.id).error, "quota"); assert.equal(f.store.job(job.id).spentUsd, 0);
    const observations = f.store.observations(project.id, job.id); assert.equal(observations.length, 1); assert.deepEqual(observations[0].citations, [{ url: "https://example.com/", title: "Example" }]); assert.equal(observations[0].retrieval, "web_search");
    assert.equal(observations[0].webSearchConfirmed, false);
    const key = comparisonKey(project, f.store.job(job.id), observations); assert.notEqual(key, comparisonKey(project, f.store.job(job.id), [{ ...observations[0], retrieval: "model_only" }]));
    assert.notEqual(key, comparisonKey(project, f.store.job(job.id), [{ ...observations[0], webSearchConfirmed: true }]));
    const imported = importProject(f.store, exportProject(f.store, project.id)); assert.equal(f.store.observations(imported.project.id)[0].retrieval, "web_search");
    assert.equal(f.store.observations(imported.project.id)[0].webSearchConfirmed, false);
    assert.equal(requests, 2);
  } finally { await runner.stop(); globalThis.fetch = original; f.close(); }
});

test("content carries the requested language through every pass and portable export", async () => {
  const f = fixture(), original = globalThis.fetch;
  const saved = f.vault.get("chatgpt"); saved.profiles[0].expiresAt = Date.now() + 3600000; f.vault.set("chatgpt", saved);
  const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", locale: "fr-FR" }));
  const audit = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "language-audit");
  const page = parsePage("https://example.com/", 200, "<h1>Example</h1><p>Documentation examples.</p>");
  f.store.put("page", project.id, audit.id, page); f.store.updateJob(audit.id, { status: "completed" });
  const inputs: any[] = [];
  const outputs = [JSON.stringify({ facts: [{ claim: "Exemples de documentation.", evidenceIds: [page.id] }], unknowns: [] }), "## Sources\n" + page.id, "# Exemples\nUne explication.", JSON.stringify({ issues: [], requiresHumanReview: true }), "# Exemples\nUne explication claire.", JSON.stringify({ issues: [], requiresHumanReview: true })];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", context_window: 32768 }] });
    const request = JSON.parse(init?.body as string);
    const input = JSON.parse(request.input[0].content); inputs.push(input);
    return new Response('data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: outputs[inputs.length - 1] }] }] } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const runner = new Runner(f.store, f.providers);
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "chatgpt", model: "fixture-model" }), "language-content");
    await runner.tick();
    assert.equal(f.store.job(job.id).status, "completed");
    assert.equal(inputs.length, 6); assert.ok(inputs.every((input) => input.locale === "fr-FR"));
    assert.deepEqual(inputs[1].sourceReferences, [{ id: page.id, url: page.url, title: page.title }]);
    const imported = importProject(f.store, exportProject(f.store, project.id));
    const content = f.store.artifacts<any>(imported.project.id, "content")[0];
    assert.equal(content.locale, "fr-FR"); assert.ok(content.brief.includes(content.sourceEvidence[0].id)); assert.ok(!content.brief.includes(page.id));
    assert.match(htmlDocument(content.topic, content.markdown, content.locale), /lang="fr-FR" dir="ltr"/);
    assert.match(htmlDocument("Example", "Example", "ar-MA"), /lang="ar-MA" dir="rtl"/);
  } finally { await runner.stop(); globalThis.fetch = original; f.close(); }
});
