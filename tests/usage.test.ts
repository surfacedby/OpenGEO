import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageSharing } from "../server/usage.js";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { projectInput, jobInput } from "../server/contracts.js";
import { exportProject } from "../server/export.js";

function fixture(send: typeof fetch = fetch) {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-usage-test-")), store = new Store(directory);
  let now = new Date("2026-10-01T10:00:00Z");
  const usage = new UsageSharing(store, send, () => now);
  return { directory, store, usage, day: (value: string) => { now = new Date(value); }, queued: () => store.db.prepare("SELECT body FROM usage_outbox ORDER BY rowid").all().map((row: any) => JSON.parse(row.body)), async close() { await usage.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const response = (accepted: string[]) => new Response(JSON.stringify({ accepted }), { headers: { "Content-Type": "application/json" } });

test("new setup preselects sharing without sending; existing choices and workspaces stay unchanged", async () => {
  let calls = 0;
  const f = fixture((async () => { calls++; return response([]); }) as typeof fetch);
  try {
    assert.deepEqual(f.usage.status(), { enabled: true });
    f.usage.record("workspace_opened", null, true); await f.usage.flush();
    assert.equal(calls, 0); assert.equal(f.queued().length, 0);
    f.usage.setEnabled(false);
    assert.deepEqual(f.usage.status(), { enabled: false });
    const reopened = new UsageSharing(f.store); assert.equal(reopened.status().enabled, false); await reopened.close();
    f.store.set("usageConsent", null);
    f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    f.store.set("usageSetupDefault", null);
    const existing = new UsageSharing(f.store);
    assert.equal(f.usage.status().enabled, false);
    f.store.set("onboarding", { completed: true });
    assert.equal(f.usage.status().enabled, false);
    await existing.close();
  } finally { await f.close(); }
});

test("unsaved sharing sends nothing, does not backfill and sends only closed non-content fields", async () => {
  let calls = 0, payload: any;
  const f = fixture((async (url, init) => { calls++; assert.equal(url, "https://api.surfacedby.com/api/v1/open-source/usage"); assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error"); payload = JSON.parse(String(init?.body)); return response(payload.events.map((event: any) => event.id)); }) as typeof fetch);
  try {
    f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Private brand", prompts: ["Private prompt"] }));
    f.usage.record("content_created", "chatgpt"); await f.usage.flush(); assert.equal(calls, 0); assert.equal(f.queued().length, 0);
    f.usage.setEnabled(true); f.usage.record("content_created", "chatgpt"); await f.usage.flush();
    assert.deepEqual(Object.keys(payload).sort(), ["appVersion", "channel", "events", "installation", "platform", "version"]);
    assert.deepEqual(payload.events.map((event: any) => event.name), ["usage_enabled", "workspace_opened", "content_created"]);
    for (const event of payload.events) assert.deepEqual(Object.keys(event).sort(), ["day", "id", "name", "provider"]);
    assert.doesNotMatch(JSON.stringify(payload), /example\.com|Private brand|Private prompt/);
    assert.equal(f.queued().length, 0);
  } finally { await f.close(); }
});

test("daily activity and limits persist across restarts; exported projects contain no usage state", async () => {
  const f = fixture();
  try {
    f.usage.setEnabled(true); const installation = f.store.setting<any>("usageConsent", null).installation;
    const reopened = new UsageSharing(f.store);
    reopened.record("workspace_opened", null, true); reopened.setEnabled(true);
    assert.equal(f.queued().length, 2); assert.equal(f.store.setting<any>("usageConsent", null).installation, installation);
    for (let n = 0; n < 100; n++) f.usage.record("audit_completed");
    assert.equal(f.queued().length, 40);
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    assert.doesNotMatch(JSON.stringify(exportProject(f.store, project.id)), /usageConsent|installation|usage_outbox/);
    await reopened.close();
  } finally { await f.close(); }
});

test("failed delivery retries identical IDs once and only deletes offered acknowledgements", async () => {
  const attempts: any[] = []; let available = false;
  const f = fixture((async (_url, init) => { const batch = JSON.parse(String(init?.body)); attempts.push(batch); if (!available) throw Error("Offline"); return response([batch.events[0].id, randomUUID()]); }) as typeof fetch);
  try {
    f.usage.setEnabled(true); await f.usage.flush(); available = true; await f.usage.flush();
    assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.queued().length, 1);
    assert.equal(f.queued()[0].id, attempts[0].events[1].id);
  } finally { await f.close(); }
});

test("withdrawal aborts delivery, clears identity and cannot acknowledge a later opt-in", async () => {
  let finish!: (response: Response) => void, signal: AbortSignal;
  const f = fixture((async (_url, init) => { signal = init!.signal!; return await new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch);
  try {
    f.usage.setEnabled(true); const first = f.store.setting<any>("usageConsent", null).installation, ids = f.queued().map(row => row.id);
    const pending = f.usage.flush(); f.usage.setEnabled(false);
    assert.equal(signal!.aborted, true); assert.deepEqual(f.store.setting("usageConsent", null), { enabled: false }); assert.equal(f.queued().length, 0);
    f.usage.setEnabled(true); assert.notEqual(f.store.setting<any>("usageConsent", null).installation, first);
    finish(response(ids)); await pending; assert.equal(f.queued().length, 2);
  } finally { await f.close(); }
});

test("expired queue records and corrupted records cannot interrupt local operations", async () => {
  const f = fixture((async () => { throw Error("Offline"); }) as typeof fetch);
  try {
    f.usage.setEnabled(true); f.day("2026-10-09T10:00:00Z"); f.usage.record("workspace_opened", null, true);
    assert.equal(f.queued().length, 1); assert.equal(f.queued()[0].day, "2026-10-09");
    f.store.db.prepare("UPDATE usage_outbox SET body='broken'").run(); await assert.doesNotReject(f.usage.flush());
    f.usage.setEnabled(false); assert.equal(f.queued().length, 0);
  } finally { await f.close(); }
});

test("protected preferences and completed transitions respect consent and skip historical work", async () => {
  const f = fixture(), vault = new Vault(f.directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(f.store, vault, "usage-fixture-session");
  const headers = { host: "127.0.0.1:4318", authorization: "Bearer usage-fixture-session" };
  try {
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/usage-sharing", payload: { enabled: true }, headers: { host: headers.host } })).statusCode, 401);
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/usage-sharing", payload: { enabled: true }, headers: { ...headers, origin: "https://example.com" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/usage-sharing", payload: { enabled: true, domain: "example.com" }, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/usage-sharing", payload: { enabled: true }, headers })).statusCode, 200);
    const project = f.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "chatgpt" }), "usage-content");
    f.store.updateJob(job.id, { status: "failed" }); f.store.updateJob(job.id, { status: "paused" });
    assert.equal(f.queued().filter(row => row.name === "content_created").length, 0);
    f.store.updateJob(job.id, { status: "completed" }); f.store.updateJob(job.id, { progress: "Done" });
    assert.equal(f.queued().filter(row => row.name === "content_created").length, 1);
    const history = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "usage-history");
    f.store.updateJob(history.id, { status: "completed", result: { imported: true } });
    assert.equal(f.queued().filter(row => row.name === "audit_completed").length, 0);
    f.store.put("finding", project.id, history.id, { id: "finding-usage", status: "open" });
    f.store.patchFinding(project.id, "finding-usage", "done"); f.store.patchFinding(project.id, "finding-usage", "done");
    assert.equal(f.queued().filter(row => row.name === "improvement_completed").length, 1);
    await app.inject({ method: "PUT", url: "/api/settings/usage-sharing", payload: { enabled: false }, headers });
    f.store.patchFinding(project.id, "finding-usage", "doing"); f.store.patchFinding(project.id, "finding-usage", "done");
    assert.equal(f.queued().length, 0);
  } finally { await app.close(); await f.close(); }
});
