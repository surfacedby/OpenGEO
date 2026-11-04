import test from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { auditFindingPresentation, auditFindings, crawl, parsePage, type CrawlCheckpoint } from "../server/audit.js";
import { crawlFetch, publicAgent, type CrawlPermission } from "../server/network.js";
import { projectInput, type PageEvidence } from "../server/contracts.js";

test('an interrupted crawl resumes its saved frontier without repeating saved page reads', async () => {
  const requests: string[] = [], pages: PageEvidence[] = [];
  let checkpoint: CrawlCheckpoint | undefined;
  const stopped = new AbortController();
  const fetcher = async (url: string) => {
    requests.push(url);
    return { url, status: url.endsWith('.xml') ? 404 : 200, contentType: url.endsWith('/robots.txt') ? 'text/plain' : 'text/html', text: url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : '<h1>Example</h1><a href="/next">Next</a>' };
  };
  await assert.rejects(crawl('example.com', stopped.signal, () => assert.fail('durable commit owns page persistence'), () => {}, fetcher, 100, fetcher, {
    commit: (state, page) => { checkpoint = structuredClone(state); if (page) { pages.push(page); stopped.abort(); } },
  }), /abort/i);
  assert.equal(pages.length, 1);
  assert.deepEqual(checkpoint!.queue, ['https://example.com/next']);
  const coverage = await crawl('example.com', new AbortController().signal, () => assert.fail('durable commit owns page persistence'), () => {}, fetcher, 100, fetcher, {
    initial: checkpoint, commit: (state, page) => { checkpoint = structuredClone(state); if (page) pages.push(page); },
  });
  assert.equal(coverage.fetched, 2);
  assert.equal(coverage.truncated, false);
  assert.equal(requests.filter(url => url === 'https://example.com/').length, 1);
  assert.equal(new Set(pages.map(page => page.url)).size, 2);
  assert.deepEqual(checkpoint!.queue, []);
});

test('a storage failure stops a crawl rather than being recorded as a missing page', async () => {
  const fetcher = async (url: string) => ({ url, status: 200, contentType: url.endsWith('/robots.txt') ? 'text/plain' : 'text/html', text: '<h1>Example</h1>' });
  await assert.rejects(crawl('example.com', new AbortController().signal, () => {}, () => {}, fetcher, 100, fetcher, {
    commit: (_state, page) => { if (page) throw new Error('Disk unavailable'); },
  }), /Disk unavailable/);
});

test('updated website advice preserves saved finding identity and progress', () => {
  const project = { ...projectInput.parse({ domain: 'example.com', brand: 'Example' }), id: 'project', createdAt: '2026-10-01T00:00:00Z' };
  const page = parsePage('https://example.com/', 200, '<title>Example</title><p>A short introduction.</p>');
  const original = auditFindings(project, 'audit', [page]).find(item => item.kind === 'content')!;
  assert.ok(original);
  const saved = { ...original, title: 'Review page substance', status: 'done' as const };
  const display = auditFindingPresentation(project, saved, page);
  assert.equal(display.title, original.title);
  assert.equal(display.id, saved.id);
  assert.equal(display.status, 'done');
  assert.deepEqual(display.evidenceIds, saved.evidenceIds);
  assert.equal(saved.title, 'Review page substance');
});

test("an error response requires access review, not changes to its error-page content", () => {
  const project = { ...projectInput.parse({ domain: "example.com", brand: "Example" }), id: "project", createdAt: "2026-10-01T00:00:00Z" };
  const html = '<title>Not found</title><meta name="robots" content="noindex"><p>Missing</p>';
  for (const status of [404, 410, 503]) {
    const page = parsePage("https://example.com/missing", status, html);
    const findings = auditFindings(project, "audit", [page]);
    assert.equal(findings.length, 1); assert.equal(findings[0].kind, "http");
    assert.deepEqual(findings[0].evidenceIds, [page.id]); assert.equal(findings[0].targetUrl, page.url);
  }
  const valid = auditFindings(project, "audit", [parsePage("https://example.com/private", 200, html)]);
  assert.ok(valid.some(finding => finding.kind === "indexing"));
  assert.ok(valid.some(finding => finding.kind === "description"));
});

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
