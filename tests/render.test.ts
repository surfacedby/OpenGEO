import test from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { renderedFetch } from "../server/render.js";
import { publicAgent } from "../server/network.js";

test("rendered crawling retains non-HTML response types without initiating a browser download", async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  mock.get("https://example.com").intercept({ path: "/menu" }).reply(302, "", { headers: { location: "https://www.example.com/menu.pdf" } });
  mock.get("https://www.example.com").intercept({ path: "/menu.pdf" }).reply(200, "%PDF-1.7", { headers: { "content-type": "application/pdf" } });
  const original = publicAgent.dispatch;
  publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const admitted: string[] = [];
    const result = await renderedFetch("https://example.com/menu", new AbortController().signal, url => { admitted.push(url); return true; });
    assert.equal(result.url, "https://www.example.com/menu.pdf");
    assert.equal(result.status, 200); assert.equal(result.contentType, "application/pdf");
    assert.deepEqual(admitted, ["https://example.com/menu", "https://www.example.com/menu.pdf"]);
    mock.assertNoPendingInterceptors();
  } finally { publicAgent.dispatch = original; await mock.close(); }
});
