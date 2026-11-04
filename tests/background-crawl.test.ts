import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { Connections } from '../server/oauth.js';
import { Providers } from '../server/providers.js';
import { Runner } from '../server/workflows.js';
import { crawlRetryAt, publicAgent } from '../server/network.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { currentFindings } from '../server/presentation.js';
import { parsePage } from '../server/audit.js';

test('an eligible yielded crawl stays behind work already waiting across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-crawl-fairness-'));
  let store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  let runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  const visited: string[] = [];
  for (const domain of ['first.example', 'second.example']) {
    const pool = mock.get('https://' + domain);
    pool.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /').persist();
    pool.intercept({ path: '/sitemap.xml' }).reply(404, '').persist();
    for (const [path, next] of [['/', '/two'], ['/two', '/three'], ['/three', '']]) {
      pool.intercept({ path }).reply(() => { visited.push(domain + path); return { statusCode: 200, data: '<h1>Documentation</h1>' + (next ? '<a href="' + next + '">Next</a>' : ''), responseOptions: { headers: { 'content-type': 'text/html' } } }; });
    }
  }
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const firstProject = store.createProject(projectInput.parse({ domain: 'first.example', brand: 'First' }));
    const secondProject = store.createProject(projectInput.parse({ domain: 'second.example', brand: 'Second' }));
    const first = store.enqueue(jobInput.parse({ projectId: firstProject.id, kind: 'audit', background: true, maxPages: 10 }), 'first');
    const second = store.enqueue(jobInput.parse({ projectId: secondProject.id, kind: 'audit', background: true, maxPages: 10 }), 'second');
    await runner.tick();
    assert.deepEqual(visited, ['first.example/', 'first.example/two']);
    const eligibleAt = Date.parse(store.job(first.id).availableAt!) + 1;
    await runner.stop(); store.close();
    store = new Store(directory);
    runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
    t.mock.method(Date, 'now', () => eligibleAt);
    await runner.tick();
    assert.deepEqual(visited, ['first.example/', 'first.example/two', 'second.example/', 'second.example/two']);
    assert.equal(store.job(first.id).status, 'queued');
    assert.equal(store.job(second.id).status, 'queued');
    await runner.tick();
    assert.equal(store.job(first.id).status, 'completed');
    assert.equal(visited.at(-1), 'first.example/three');
  } finally { t.mock.restoreAll(); publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('saved crawl backfill reads only unaudited pages and keeps prior findings intact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-crawl-backfill-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  mock.get('https://example.com').intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /');
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true, maxPages: 10 }), 'backfill');
    const oldPage = parsePage('https://example.com/', 200, '<h1>Saved homepage</h1>');
    const reviewed = parsePage('https://example.com/reviewed', 200, '<h1>Reviewed page</h1>');
    store.put('page', project.id, job.id, oldPage);
    store.put('page', project.id, job.id, reviewed);
    store.setStep(job.id, 'audit-page:' + reviewed.id, 'done');
    const priorFinding = { id: 'prior-finding', projectId: project.id, jobId: job.id, kind: 'title', title: 'Prior saved advice', description: 'Keep the reviewed explanation.', targetUrl: reviewed.url, evidenceIds: [reviewed.id], priority: 'medium', confidence: 'known', status: 'doing', steps: ['Keep the agreed action.'] };
    store.put('finding', project.id, job.id, priorFinding);
    store.setStep(job.id, 'crawl-frontier', 'done', { base: 'https://example.com/', maxPages: 10, queue: [], seen: [oldPage.url, reviewed.url], visited: [oldPage.url, reviewed.url], fetched: 2, errors: [], excluded: [], skippedNonHtml: [] });
    assert.deepEqual(store.unauditedPageIds(project.id, job.id), [oldPage.id]);
    await runner.tick();
    assert.equal(store.job(job.id).status, 'completed');
    assert.deepEqual(store.unauditedPageIds(project.id, job.id), []);
    assert.deepEqual(store.findings(project.id).find(finding => finding.id === priorFinding.id), priorFinding);
    assert.ok(store.findings(project.id).some(finding => finding.evidenceIds.includes(oldPage.id)));
    assert.equal((store.job(job.id).result as { pages: number }).pages, 2);
    assert.equal((store.job(job.id).result as { findings: number }).findings, store.findings(project.id).length);
    mock.assertNoPendingInterceptors();
  } finally { publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('crawl retry dates honor seconds and HTTP dates without accepting malformed values', () => {
  const now = Date.UTC(2026, 10, 4);
  assert.equal(crawlRetryAt('120', now), now + 120000);
  assert.equal(crawlRetryAt(new Date(now + 300000).toUTCString(), now), now + 300000);
  assert.equal(crawlRetryAt('not a date', now), undefined);
  assert.equal(crawlRetryAt('9999999999999999999999999999', now), undefined);
  assert.equal(crawlRetryAt(null, now), undefined);
});

test('busy pages preserve the frontier, defer requests and resume without saving error HTML', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-crawl-backoff-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  const pool = mock.get('https://example.com');
  pool.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /').persist();
  pool.intercept({ path: '/sitemap.xml' }).reply(404, '').persist();
  pool.intercept({ path: '/' }).reply(200, '<h1>Home</h1><a href="/two">Two</a>', { headers: { 'content-type': 'text/html' } });
  pool.intercept({ path: '/two' }).reply(429, '<h1>Too many requests</h1>', { headers: { 'content-type': 'text/html', 'retry-after': '120' } });
  pool.intercept({ path: '/two' }).reply(200, '<h1>Second page</h1>', { headers: { 'content-type': 'text/html' } });
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true, maxPages: 10 }), 'busy-page');
    const started = Date.now();
    await runner.tick();
    assert.equal(store.job(job.id).status, 'queued');
    assert.ok(Date.parse(store.job(job.id).availableAt!) >= started + 120000);
    assert.equal(store.pages(project.id, job.id).length, 1);
    const frontier = JSON.parse(store.step(job.id, 'crawl-frontier')!.body!);
    assert.deepEqual(frontier.queue, ['https://example.com/two']);
    assert.deepEqual(frontier.seen, ['https://example.com/']);
    const reopened = new Store(directory);
    try {
      assert.equal(reopened.job(job.id).status, 'queued');
      assert.equal(reopened.job(job.id).availableAt, store.job(job.id).availableAt);
      assert.deepEqual(JSON.parse(reopened.step(job.id, 'crawl-frontier')!.body!), frontier);
    } finally { reopened.close(); }
    await runner.tick();
    assert.equal(JSON.parse(store.step(job.id, 'crawl-backoff')!.body!).attempts, 1);
    const eligibleAt = Date.parse(store.job(job.id).availableAt!) + 1;
    t.mock.method(Date, 'now', () => eligibleAt);
    await runner.tick();
    assert.equal(store.job(job.id).status, 'completed');
    assert.equal(store.job(job.id).error, null);
    assert.deepEqual(store.pages(project.id, job.id).map(page => page.status), [200, 200]);
    assert.equal(store.pages(project.id, job.id).some(page => page.text.includes('Too many')), false);
    mock.assertNoPendingInterceptors();
  } finally { publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a new check respects a cancelled crawl cooldown after restart without blocking another website', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-shared-cooldown-'));
  let store = new Store(directory);
  const vault = new Vault(directory, { encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() });
  let runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  const pool = mock.get('https://example.com');
  pool.intercept({ path: '/robots.txt' }).reply(429, 'Busy', { headers: { 'retry-after': '120' } });
  for (const domain of ['https://example.com', 'https://other.example']) {
    const site = mock.get(domain);
    site.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /');
    site.intercept({ path: '/sitemap.xml' }).reply(404, '');
    site.intercept({ path: '/' }).reply(200, '<h1>Website</h1>', { headers: { 'content-type': 'text/html' } });
  }
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    const first = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true }), 'first');
    await runner.tick();
    const eligibleAt = Date.parse(store.job(first.id).availableAt!) + 1;
    store.updateJob(first.id, { status: 'cancelled' });
    await runner.stop(); store.close();
    store = new Store(directory);
    runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
    const second = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'second');
    await runner.tick();
    assert.equal(store.job(second.id).status, 'paused');
    assert.equal(store.step(second.id, 'crawl-backoff'), undefined, 'a deferred check has not made a network retry');
    assert.equal(store.pages(project.id, second.id).length, 0);
    const independent = store.enqueue(jobInput.parse({ projectId: other.id, kind: 'audit' }), 'independent');
    await runner.tick();
    assert.equal(store.job(independent.id).status, 'completed');
    t.mock.method(Date, 'now', () => eligibleAt);
    runner.resume(second.id, false);
    await runner.tick();
    assert.equal(store.job(second.id).status, 'completed');
    assert.equal(store.pages(project.id, second.id).length, 1);
    mock.assertNoPendingInterceptors();
  } finally { t.mock.restoreAll(); publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('busy sitemap stops discovery and exhausts only three automatic retries', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-sitemap-backoff-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  const pool = mock.get('https://example.com');
  pool.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /').persist();
  pool.intercept({ path: '/sitemap.xml' }).reply(503, 'Busy').persist();
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true }), 'busy-sitemap');
    for (let attempt = 1; attempt <= 4; attempt++) {
      await runner.tick();
      assert.equal(store.job(job.id).status, attempt <= 3 ? 'queued' : 'paused');
      assert.equal(JSON.parse(store.step(job.id, 'crawl-backoff')!.body!).attempts, attempt);
      assert.equal(store.pages(project.id, job.id).length, 0);
      if (attempt <= 3) {
        const eligibleAt = Date.parse(store.job(job.id).availableAt!) + 1;
        t.mock.method(Date, 'now', () => eligibleAt);
      }
    }
    await runner.tick();
    assert.equal(JSON.parse(store.step(job.id, 'crawl-backoff')!.body!).attempts, 4);
  } finally { publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const background of [false, true]) test(`busy robots policy ${background ? 'with a long cooldown' : 'during a manual check'} pauses without fetching pages`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-policy-backoff-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  mock.get('https://example.com').intercept({ path: '/robots.txt' }).reply(429, 'Busy', { headers: { 'retry-after': '172800' } });
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background }), 'busy-policy');
    const started = Date.now();
    await runner.tick();
    assert.equal(store.job(job.id).status, 'paused');
    assert.ok(Date.parse(store.job(job.id).availableAt!) >= started + 172800000);
    assert.equal(store.pages(project.id, job.id).length, 0);
    runner.resume(job.id, false);
    await runner.tick();
    assert.equal(store.job(job.id).status, 'queued');
    assert.equal(JSON.parse(store.step(job.id, 'crawl-backoff')!.body!).attempts, 1);
    mock.assertNoPendingInterceptors();
  } finally { publicAgent.dispatch = original; await runner.stop(); await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restart resumes only automatic read-only crawls and preserves provider and cancellation holds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-crawl-restart-'));
  let store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const cancelled = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true }), 'cancelled');
    store.updateJob(cancelled.id, { status: 'cancelled' });
    const background = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true }), 'background');
    const paid = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'openrouter' }), 'paid');
    store.updateJob(background.id, { status: 'running' });
    store.updateJob(cancelled.id, { status: 'cancelled' });
    store.updateJob(paid.id, { status: 'running' });
    store.close(); store = new Store(directory);
    assert.equal(store.job(background.id).status, 'queued');
    assert.equal(store.job(cancelled.id).status, 'cancelled');
    assert.equal(store.job(paid.id).status, 'paused');
    assert.equal(store.job(paid.id).error, 'interrupted');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('background crawling yields to queued work, exposes page findings and resumes its durable frontier', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-background-crawl-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  const mock = new MockAgent(); mock.disableNetConnect();
  const pool = mock.get('https://example.com');
  pool.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } }).persist();
  pool.intercept({ path: '/sitemap.xml' }).reply(404, '').persist();
  pool.intercept({ path: '/sitemap_index.xml' }).reply(404, '').persist();
  let reads = 0;
  for (const [path, html] of [['/', '<h1>Home</h1><a href="/two">Two</a>'], ['/two', '<h1>Two</h1><a href="/three">Three</a>'], ['/three', '<h1>Three</h1>']]) {
    pool.intercept({ path }).reply(() => { reads++; return { statusCode: 200, data: html, responseOptions: { headers: { 'content-type': 'text/html' } } }; });
  }
  pool.intercept({ path: '/interactive' }).reply(200, '<h1>Interactive</h1>', { headers: { 'content-type': 'text/html' } });
  const original = publicAgent.dispatch; publicAgent.dispatch = mock.dispatch.bind(mock);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const background = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit', background: true, maxPages: 10 }), 'background-test');
    await runner.tick();
    assert.equal(store.job(background.id).status, 'queued');
    assert.equal(store.pages(project.id, background.id).length, 2);
    assert.equal(reads, 2);
    await runner.cancel(background.id);
    assert.equal(store.job(background.id).status, 'cancelled');
    runner.resume(background.id, false);
    assert.equal(store.job(background.id).status, 'queued');
    assert.equal(store.pages(project.id, background.id).length, 2);
    assert.ok(currentFindings(store.findings(project.id), store.jobs(project.id), background.id).length > 0);
    const second = store.createProject(projectInput.parse({ domain: 'https://example.com/interactive', brand: 'Interactive' }));
    const interactive = store.enqueue(jobInput.parse({ projectId: second.id, kind: 'audit', maxPages: 1 }), 'interactive-test');
    await runner.tick();
    assert.equal(store.job(interactive.id).status, 'completed');
    assert.equal(store.job(background.id).status, 'queued');
    store.updateJob(background.id, { availableAt: new Date(0).toISOString() });
    await runner.tick();
    assert.equal(store.job(background.id).status, 'completed');
    assert.equal(reads, 3);
    const pages = store.pages(project.id, background.id);
    assert.equal(pages.length, 3);
    const findings = store.findings(project.id);
    assert.equal(new Set(findings.map(finding => `${finding.targetUrl}:${finding.kind}`)).size, findings.length);
    assert.equal((store.job(background.id).result as { coverage: { truncated: boolean } }).coverage.truncated, false);
  } finally {
    await runner.stop(); publicAgent.dispatch = original; await mock.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('discovery start and resume prevent duplicates without allowing cancelled paid work to restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-discovery-controls-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const runner = new Runner(store, new Providers(vault, new Connections(store, vault)));
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const input = jobInput.parse({ projectId: project.id, kind: 'audit', background: true, maxPages: 1000 });
    const first = store.enqueue(input, 'first-discovery');
    assert.equal(store.enqueue(input, 'first-discovery').id, first.id);
    assert.throws(() => store.enqueue(input, 'duplicate-discovery'), /already saved/);
    await runner.cancel(first.id);
    const second = store.enqueue(input, 'second-discovery');
    assert.throws(() => runner.resume(first.id, false), /Another website discovery/);
    await runner.cancel(second.id);
    assert.equal(runner.resume(first.id, false).status, 'queued');
    const paid = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'openrouter' }), 'cancelled-paid');
    await runner.cancel(paid.id);
    assert.throws(() => runner.resume(paid.id, false), /Only paused jobs/);
  } finally { await runner.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
