import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";

test("separate local installations retain independent browser sessions on the same host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-sessions-"));
  const stores = [new Store(join(directory, "first")), new Store(join(directory, "second"))];
  const vaults = stores.map((_, index) => new Vault(join(directory, String(index)), {
    encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString(),
  }));
  const first = await createApp(stores[0], vaults[0], "synthetic-first-session", join(directory, "no-assets"));
  const second = await createApp(stores[1], vaults[1], "synthetic-second-session", join(directory, "no-assets"));
  try {
    const sessions = await Promise.all([first.app, second.app].map(app => app.inject({ url: "/api/session", headers: { host: "127.0.0.1" } })));
    const cookies = sessions.map(response => String(response.headers["set-cookie"]).split(";")[0]);
    assert.notEqual(cookies[0].split("=")[0], cookies[1].split("=")[0]);
    for (const response of sessions) assert.match(String(response.headers["set-cookie"]), /HttpOnly; SameSite=Strict; Path=\//);
    for (const app of [first.app, second.app]) {
      const response = await app.inject({ url: "/api/projects", headers: { host: "127.0.0.1", cookie: cookies.join("; ") } });
      assert.equal(response.statusCode, 200);
    }
    assert.equal((await first.app.inject({ url: "/api/projects", headers: { host: "127.0.0.1", cookie: cookies[1] } })).statusCode, 401);
    assert.equal((await second.app.inject({ url: "/api/projects", headers: { host: "127.0.0.1", cookie: cookies[0] } })).statusCode, 401);
    const repeated = await first.app.inject({ url: "/api/session", headers: { host: "127.0.0.1" } });
    assert.equal(String(repeated.headers["set-cookie"]).split(";")[0], cookies[0]);
  } finally {
    await first.app.close(); await second.app.close();
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
