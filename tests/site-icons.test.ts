import test from "node:test";
import assert from "node:assert/strict";
import { SiteIcons, rasterIcon } from "../server/site-icons.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/storage.js";
import { Vault } from "../server/vault.js";
import { createApp } from "../server/app.js";
import { projectInput } from "../server/contracts.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfcUAAAAASUVORK5CYII=",
  "base64",
);
const response = (status: number, bytes: Buffer, location?: string) => ({
  status,
  headers: {
    get: (name: string) => (name === "location" ? (location ?? null) : null),
  },
  body: (async function* () {
    yield bytes;
  })(),
});

test("site icon routes require a session and refuse websites outside the selected project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-icon-scope-"));
  const store = new Store(directory),
    vault = new Vault(directory, {
      encrypt: (text) => Buffer.from(text),
      decrypt: (bytes) => bytes.toString(),
    });
  const { app } = await createApp(store, vault, "icon-route-fixture");
  try {
    const project = store.createProject(
      projectInput.parse({ domain: "example.com", brand: "Example" }),
    );
    store.createProject(
      projectInput.parse({ domain: "other.example", brand: "Other" }),
    );
    const url = `/api/projects/${project.id}/site-icon?domain=other.example`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url,
          headers: { authorization: "Bearer icon-route-fixture" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/projects/${project.id}/site-icon?domain=127.0.0.1`,
          headers: { authorization: "Bearer icon-route-fixture" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("site icons reject active content, oversized images and malformed icon directories", () => {
  assert.equal(rasterIcon(png)?.contentType, "image/png");
  assert.equal(
    rasterIcon(Buffer.from("<svg><script>alert(1)</script></svg>")),
    null,
  );
  assert.equal(rasterIcon(Buffer.alloc(131073)), null);
  const giant = Buffer.from(png);
  giant.writeUInt32BE(10000, 16);
  assert.equal(rasterIcon(giant), null);
  const ico = Buffer.alloc(26);
  ico.writeUInt32LE(65536);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt32LE(4, 14);
  ico.writeUInt32LE(22, 18);
  assert.equal(rasterIcon(ico)?.contentType, "image/vnd.microsoft.icon");
  ico.writeUInt32LE(100, 18);
  assert.equal(rasterIcon(ico), null);
});

test("site icon requests reject private networks, credential paths and tracking redirects, and cache failures", async () => {
  let requests = 0;
  const icons = new SiteIcons(async () => {
    requests++;
    return response(302, Buffer.alloc(0), "https://tracking.example/icon");
  });
  await assert.rejects(icons.get("127.0.0.1"));
  await assert.rejects(icons.get("private:secret@example.com"));
  await assert.rejects(icons.get("example.com/other-path"));
  assert.equal(requests, 0);
  assert.equal(await icons.get("example.com"), null);
  assert.equal(await icons.get("example.com"), null);
  assert.equal(requests, 1);
  let redirects = 0;
  const privateRedirect = new SiteIcons(async () => {
    redirects++;
    return response(302, Buffer.alloc(0), "http://10.0.0.1/icon");
  });
  assert.equal(await privateRedirect.get("example.com"), null);
  assert.equal(redirects, 1);
});

test("site icons coalesce duplicate requests and queue larger sets within the concurrency limit", async () => {
  let calls = 0,
    active = 0,
    maximum = 0;
  const icons = new SiteIcons(async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(200, png);
  });
  const results = await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => icons.get(`site${i}.example`)),
    icons.get("site0.example"),
  ]);
  assert.equal(calls, 12);
  assert.ok(maximum <= 8);
  assert.equal(results.length, 13);
  assert.ok(results.every((icon) => icon?.bytes.equals(png)));
  assert.equal((await icons.get("site0.example"))?.contentType, "image/png");
  assert.equal(calls, 12);
});

test('website-declared raster icons work without a root favicon and cannot reach unrelated hosts', async () => {
  const requests: string[] = [];
  const icons = new SiteIcons(async url => {
    requests.push(url.href);
    if(url.pathname === '/favicon.ico') return response(404, Buffer.alloc(0));
    if(url.pathname === '/') return response(200, Buffer.from('<link rel="icon" href="https://tracking.example/icon.png"><link rel="icon" href="http://127.0.0.1/private"><link rel="icon" href="/uploads/brand.png">'));
    return response(200, png);
  });
  assert.equal((await icons.get('example.com'))?.contentType,'image/png');
  assert.deepEqual(requests,['https://example.com/favicon.ico','https://example.com/','https://example.com/uploads/brand.png']);
  assert.ok((await icons.get('example.com'))?.bytes.equals(png));
  assert.equal(requests.length,3);
});

test('a missing or refused root icon still permits a website-declared raster icon', async () => {
  const requests: string[] = [];
  const icons = new SiteIcons(async url => {
    requests.push(url.pathname);
    if (url.pathname === '/favicon.ico') return response(403, Buffer.alloc(0));
    if (url.pathname === '/') return response(200, Buffer.from('<link rel="icon" href="/brand.svg"><link rel="apple-touch-icon" href="/brand.png">'));
    assert.equal(url.pathname, '/brand.png');
    return response(200, png);
  });
  assert.equal((await icons.get('example.com'))?.contentType, 'image/png');
  assert.deepEqual(requests, ['/favicon.ico', '/', '/brand.png']);
});

test('WebP icons require a bounded static canvas and complete chunk framing', () => {
  const bytes=Buffer.alloc(26);
  bytes.write('RIFF'); bytes.writeUInt32LE(18,4); bytes.write('WEBP',8); bytes.write('VP8L',12); bytes.writeUInt32LE(5,16); bytes[20]=47;
  bytes.writeUInt32LE(31|(31<<14),21);
  assert.equal(rasterIcon(bytes)?.contentType,'image/webp');
  const oversized=Buffer.from(bytes); oversized.writeUInt32LE(1023|(31<<14),21);
  assert.equal(rasterIcon(oversized),null);
  const truncated=Buffer.from(bytes); truncated.writeUInt32LE(40,16);
  assert.equal(rasterIcon(truncated),null);
  const trailing=Buffer.concat([bytes,Buffer.from('<script>')]);
  assert.equal(rasterIcon(trailing),null);
});
