import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { exportProject } from "../server/export.js";
import { projectInput, jobInput } from "../server/contracts.js";

test("first restore opens saved history without scheduling work or inheriting consent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-restore-"));
  const source = new Store(join(directory, "source")), destination = new Store(join(directory, "destination"));
  const previous = process.env.OPENGEO_SECRET_FILE;
  const secret = join(directory, "secret");
  writeFileSync(secret, Buffer.alloc(32, 7)); process.env.OPENGEO_SECRET_FILE = secret;
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  try {
    const project = source.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["Where can I find useful examples?"] }));
    const job = source.enqueue(jobInput.parse({ projectId: project.id, kind: "measure", provider: "chatgpt" }), "saved-check");
    source.updateJob(job.id, { status: "paused", error: "quota" });
    const body = exportProject(source, project.id);
    const runtime = await createApp(destination, new Vault(directory), "restore-session"); app = runtime.app;
    const headers = { host: "127.0.0.1:4318", authorization: "Bearer restore-session" };
    assert.equal((await app.inject({ url: "/api/onboarding", headers })).json().completed, false);
    destination.set("setupDraft", { step: 0, provider: "chatgpt", localOnly: false, questionRows: [] });
    assert.equal((await app.inject({ method: "POST", url: "/api/import", headers, payload: {} })).statusCode, 422);
    assert.equal(destination.projects().length, 0);
    assert.equal(destination.setting<any>("onboarding", null).completed, false);
    const empty = await app.inject({ method: "POST", url: "/api/backup/restore", headers, payload: { format: "opengeo-backup", version: 1, projects: [] } });
    assert.equal(empty.statusCode, 200); assert.deepEqual(empty.json(), []);
    assert.equal(destination.setting<any>("onboarding", null).completed, false);
    const restored = await app.inject({ method: "POST", url: "/api/import", headers, payload: body });
    assert.equal(restored.statusCode, 200);
    const saved = restored.json().project;
    assert.notEqual(saved.id, project.id);
    assert.deepEqual((await app.inject({ url: "/api/onboarding", headers })).json(), { completed: true, draft: null });
    assert.equal(destination.jobs().length, 1);
    assert.equal(destination.jobs()[0].status, "cancelled");
    await runtime.runner.tick();
    assert.equal(destination.jobs().length, 1);
    assert.equal(destination.jobs()[0].status, "cancelled");
    assert.equal(destination.setting("usageConsent", null), null);
    assert.equal(runtime.usage.status().enabled, false);
    assert.equal((destination.db.prepare("SELECT count(*) AS n FROM usage_outbox").get() as { n: number }).n, 0);
    assert.deepEqual((await app.inject({ url: "/api/providers", headers })).json().connected, { chatgpt: false, openrouter: false, dataforseo: false, console: false });
    const draft = { step: 1, provider: "chatgpt", localOnly: false, questionRows: [] };
    destination.set("setupDraft", draft);
    const replay = await app.inject({ method: "POST", url: "/api/backup/restore", headers, payload: { format: "opengeo-backup", version: 1, projects: [body] } });
    assert.equal(replay.statusCode, 200); assert.equal(replay.json()[0].replayed, true);
    assert.equal(replay.json()[0].project.id, saved.id); assert.equal(destination.projects().length, 1);
    assert.deepEqual(destination.setting("setupDraft", null), draft);
  } finally {
    await app?.close(); source.close(); destination.close();
    if (previous === undefined) delete process.env.OPENGEO_SECRET_FILE; else process.env.OPENGEO_SECRET_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
