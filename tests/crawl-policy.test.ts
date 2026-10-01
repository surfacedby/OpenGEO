import test from "node:test";
import assert from "node:assert/strict";
import { robotsPolicy, loadRobots } from "../server/robots.js";
import { parsePage } from "../server/audit.js";
test("crawl discovery retains navigation while evidence omits navigation text", () => {
  const page = parsePage(
    "https://example.com/",
    200,
    '<html><body><nav><a href="/about">Navigation only</a></nav><main><h1>Example</h1><p>Useful information</p></main><footer><a href="/contact">Contact navigation</a></footer></body></html>',
  );
  assert.deepEqual(page.links, [
    "https://example.com/about",
    "https://example.com/contact",
  ]);
  assert.equal(page.text.includes("Navigation only"), false);
  assert.ok(page.text.includes("Useful information"));
});
test("crawl policy merges specific groups, honors longest match and handles encoded octets", () => {
  const allowed = robotsPolicy(
    "User-agent: *\nDisallow: /\nUser-agent: OpenGEO\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nUser-agent: opengeo\nDisallow: /encoded%2Fpart\nAllow: /equal\nDisallow: /equal",
  );
  assert.equal(allowed("https://example.com/"), true);
  assert.equal(allowed("https://example.com/private/a"), false);
  assert.equal(allowed("https://example.com/private/public/a"), true);
  assert.equal(allowed("https://example.com/a.pdf"), false);
  assert.equal(allowed("https://example.com/a.pdf?q=1"), true);
  assert.equal(allowed("https://example.com/encoded%2fpart"), false);
  assert.equal(allowed("https://example.com/encoded/part"), true);
  assert.equal(allowed("https://example.com/equal"), true);
  const unicode = robotsPolicy('User-agent: *\nDisallow: /\u{1F310}');
  assert.equal(unicode('https://example.com/%F0%9F%8C%90'), false);
});
test("unreachable robots stops the crawl, while a missing robots file permits it", async () => {
  const result = (status: number) => async (url: string) => ({
    url,
    status,
    contentType: "text/plain",
    text: "",
  });
  await assert.rejects(
    loadRobots(
      new URL("https://example.com"),
      new AbortController().signal,
      result(503),
    ),
  );
  assert.equal(
    (
      await loadRobots(
        new URL("https://example.com"),
        new AbortController().signal,
        result(404),
      )
    )("https://example.com/a"),
    true,
  );
});
