import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { api } from "../src/api.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { projectInput } from "../server/contracts.js";

test("expired local sessions recover concurrent reads and create one approved schedule", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-session-recovery-"));
  const store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runtime = await createApp(store, vault);
  const originalFetch = globalThis.fetch;
  let cookie = "", bootstraps = 0, refused = 0;
  try {
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const address = runtime.app.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    // Supply only the browser's relative URL resolution and cookie transport.
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(new URL(String(input), origin), {
        ...options, headers: { ...options?.headers, cookie },
      });
      if (String(input) === "/api/session") bootstraps++;
      if (response.status === 401) refused++;
      const saved = response.headers.get("set-cookie");
      if (saved) cookie = saved.split(";")[0];
      return response;
    };
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const [projects, schedules] = await Promise.all([api("/projects"), api("/schedules")]);
    assert.equal(projects[0].id, project.id);
    assert.deepEqual(schedules, []);
    assert.equal(bootstraps, 1);
    assert.equal(refused, 2);
    cookie = "";
    const request = { job: { projectId: project.id, kind: "audit", maxCostUsd: 0 },
      frequency: "daily", hour: 9, timezone: "UTC", monthlyBudgetUsd: 0 };
    const first = await api("/schedules", request, "POST", "approved-session-recovery");
    const replay = await api("/schedules", request, "POST", "approved-session-recovery");
    assert.equal(first.id, replay.id);
    assert.equal(runtime.scheduler.list().length, 1);
    assert.equal(bootstraps, 2);
    assert.equal(refused, 3);
    assert.equal(store.jobs().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.app.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
