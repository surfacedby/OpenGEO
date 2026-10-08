import test from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { crawl } from "../server/audit.js";
import { crawlFetch, publicAgent, type CrawlPermission } from "../server/network.js";
import type { PageEvidence } from "../server/contracts.js";

test("crawls www redirects and sitemap pages with each origin's own policy and no foreign subdomains", async () => {
  const requests: string[] = [], pages: PageEvidence[] = [];
  const fetcher = async (url: string, _signal?: AbortSignal, allowed?: CrawlPermission) => {
    if (allowed) assert.equal(await allowed(url), true);
    requests.push(url);
    if (url.endsWith("/robots.txt")) return { url, status: 200, contentType: "text/plain", text: url.startsWith("https://www.")
      ? "User-agent: *\nDisallow: /private\nSitemap: https://www.example.com/pages.xml"
      : "User-agent: *\nAllow: /\nSitemap: https://www.example.com/pages.xml" };
    if (url.endsWith(".xml")) return { url: "https://www.example.com/pages.xml", status: 200, contentType: "application/xml", text: '<urlset><url><loc>https://www.example.com/</loc></url><url><loc>https://www.example.com/rooms</loc></url><url><loc>https://www.example.com/private</loc></url><url><loc>https://docs.example.com/service</loc></url><url><loc>https://other.example/service</loc></url></urlset>' };
    const resolved = url === "https://example.com/" ? "https://www.example.com/" : url;
    if (allowed) assert.equal(await allowed(resolved), true);
    return { url: resolved, status: 200, contentType: "text/html", text: '<h1>Visitor services</h1><a href="https://www.example.com/">Home</a><a href="https://www.example.com/rooms">Rooms</a><a href="https://www.example.com/private">Private</a><a href="https://docs.example.com/service">Other subdomain</a>' };
  };
  const coverage = await crawl("example.com", new AbortController().signal, page => pages.push(page), () => {}, fetcher);
  assert.deepEqual(pages.map(page => page.url), ["https://www.example.com/", "https://www.example.com/rooms"]);
  assert.equal(coverage.fetched, 2);
  assert.equal(coverage.truncated, false);
  assert.deepEqual(coverage.excludedByRobots, ["https://www.example.com/private"]);
  assert.equal(requests.filter(url => url === "https://www.example.com/robots.txt").length, 1);
  assert.ok(!requests.some(url => url.includes("/private") || url.includes("docs.example.com") || url.includes("other.example")));
  assert.ok(!requests.includes("https://www.example.com/"), "the final homepage URL is not fetched again from its sitemap");
});

test("a redirect outside the permitted website is not admitted as first-party page evidence", async () => {
  const pages: PageEvidence[] = [];
  const fetcher = async (url: string) => ({ url: url.endsWith("/robots.txt") || url.endsWith(".xml") ? url : "https://other.example/", status: url.endsWith(".xml") ? 404 : 200, contentType: url.endsWith("/robots.txt") ? "text/plain" : "text/html", text: "<h1>Another website</h1>" });
  await assert.rejects(crawl("example.com", new AbortController().signal, page => pages.push(page), () => {}, fetcher), /permitted crawl scope/);
  assert.deepEqual(pages, []);
});

test("HTTP redirect targets pass crawl permission before the next network request", async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  mock.get("https://example.com").intercept({ path: "/" }).reply(302, "", { headers: { location: "https://www.example.com/private" } });
  let forbidden = 0;
  mock.get("https://www.example.com").intercept({ path: "/private" }).reply(() => { forbidden++; return { statusCode: 200, data: "<h1>Private</h1>" }; });
  const original = publicAgent.dispatch;
  publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    await assert.rejects(crawlFetch("https://example.com/", new AbortController().signal, url => !url.endsWith("/private")), /permitted crawl scope/);
    assert.equal(forbidden, 0);
  } finally { publicAgent.dispatch = original; await mock.close(); }
});
