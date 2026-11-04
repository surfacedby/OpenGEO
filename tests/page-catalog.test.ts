import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { parsePage, auditFindings } from '../server/audit.js';
import { projectInput, jobInput } from '../server/contracts.js';
import { workspacePresentation } from '../server/presentation.js';

const window = { query: '', tab: 'all', grouping: 'type', offset: 0, limit: 10, groupOffset: 0 } as const;

test('bounded page navigation preserves full totals, search, scopes and older accepted work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-page-catalog-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault, 'page-catalog-session');
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const older = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), randomUUID());
    store.updateJob(older.id, { status: 'completed' });
    const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), randomUUID());
    const pages = Array.from({ length: 101 }, (_, index) => parsePage(`https://example.com/folder-${index}/page`, index === 0 ? 404 : 200,
      `<title>Page ${index}</title><h1>Guide</h1>${index === 1 ? '<meta name="robots" content="noindex">' : ''}<p>${'Useful explanation. '.repeat(100)}</p>`));
    store.db.transaction(() => { for (const page of pages) store.put('page', project.id, audit.id, page); })();
    store.updateJob(audit.id, { status: 'completed' });
    const finding = auditFindings(project, older.id, [pages[2]])[0];
    store.put('finding', project.id, older.id, finding);
    store.updateJob(older.id, { status: 'completed' });
    let result = store.pageCatalog.list(project.id, audit.id, window);
    assert.equal(result.total, 101); assert.equal(result.rows.length, 10);
    assert.equal(result.counts.attention, 1, 'Unstarted advice from another audit is not a current issue');
    store.patchFinding(project.id, finding.id, 'doing');
    result = store.pageCatalog.list(project.id, audit.id, window);
    assert.deepEqual(result.counts, { allPages: 101, attention: 2, unavailable: 1, excluded: 1 });
    assert.equal(result.rows[0].page.id, pages[100].id);
    assert.equal('text' in result.rows[0].page, false); assert.equal('links' in result.rows[0].page, false);
    const next = store.pageCatalog.list(project.id, audit.id, { ...window, offset: 10 });
    assert.equal(new Set([...result.rows, ...next.rows].map(row => row.page.id)).size, 20);
    const searched = store.pageCatalog.list(project.id, audit.id, { ...window, query: 'PAGE 99' });
    assert.equal(searched.total, 1); assert.equal(searched.rows[0].page.id, pages[99].id);
    assert.equal(store.pageCatalog.list(project.id, audit.id, { ...window, query: '%' }).total, 0, 'Search is literal, not SQL wildcard matching');
    const folders = store.pageCatalog.list(project.id, audit.id, { ...window, grouping: 'folder' });
    assert.equal(folders.groupCount, 101); assert.equal(folders.groups.length, 20);
    assert.equal(store.pageCatalog.list(project.id, audit.id, { ...window, grouping: 'folder', group: '/folder-99/' }).rows[0].page.id, pages[99].id);
    assert.deepEqual(store.pageCatalog.summary(project.id, audit.id), workspacePresentation([], undefined, [], [], 0, pages).audit);
    store.patchFinding(project.id, finding.id, 'done');
    assert.equal(store.pageCatalog.list(project.id, audit.id, window).counts.attention, 1);
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer page-catalog-session' };
    const path = `/api/projects/${project.id}/checks/${audit.id}/pages`;
    assert.equal((await app.inject({ url: path + '?limit=51', headers })).statusCode, 422);
    const response = await app.inject({ url: path + '?query=Page%2099', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().rows[0].page.id, pages[99].id);
    assert.equal(response.json().groups[0].rows[0].page.id, pages[99].id);
    const full = await app.inject({ url: `/api/projects/${project.id}/workspace`, headers });
    const readPages = store.pageSummaries, readFindings = store.findings;
    store.pageSummaries = () => { throw new Error('Lazy workspace must not load the crawl'); };
    store.findings = () => { throw new Error('Lazy workspace must not load every audit finding'); };
    const lazy = await app.inject({ url: `/api/projects/${project.id}/workspace?pages=lazy`, headers: { ...headers, 'if-none-match': String(full.headers.etag) } });
    store.pageSummaries = readPages; store.findings = readFindings;
    assert.equal(lazy.statusCode, 200, 'Different representations cannot share a validator');
    assert.equal(lazy.json().auditId, audit.id);
    assert.equal(full.json().pages.length, 101);
    assert.deepEqual(lazy.json().pages, []);
    assert.deepEqual(lazy.json().presentation.audit, full.json().presentation.audit);
    assert.deepEqual(lazy.json().findingCounts, full.json().findingCounts);
    const detail = await app.inject({ url: path + '/' + pages[2].id, headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().page.id, pages[2].id);
    assert.equal(detail.json().findings[0].id, finding.id);
    assert.equal(detail.json().findings[0].status, 'done', 'Historical completed work remains available in the page drawer');
    const suggestions = await app.inject({ url: path.replace('/pages', '/page-suggestions') + '?query=Page%2099', headers });
    assert.deepEqual(suggestions.json().pages.map((page: any) => page.id), [pages[99].id]);
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    assert.equal((await app.inject({ url: path.replace(project.id, other.id), headers })).statusCode, 404);
    assert.equal((await app.inject({ url: path, headers: { host: headers.host } })).statusCode, 401);
    assert.throws(() => store.put('page', project.id, audit.id, { ...pages[0], id: randomUUID(), url: 'invalid-url' }));
    assert.equal(store.pageCount(project.id, audit.id), 101, 'Failed derived metadata must roll back original insertion too');
    store.deleteProject(project.id, project.domain);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM page_catalog').get() as { n: number }).n, 0);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('older crawl artifacts migrate once without altering their original bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-page-catalog-upgrade-'));
  let store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), randomUUID());
    const page = parsePage('https://example.com/docs/start', 200, '<title>Start</title><h1>Guide</h1>');
    store.put('page', project.id, job.id, page); store.updateJob(job.id, { status: 'completed' });
    const original = (store.db.prepare('SELECT body FROM artifacts WHERE id=?').get(page.id) as { body: string }).body;
    store.db.exec('DROP TABLE page_catalog; DELETE FROM migrations WHERE version=4');
    store.close(); store = new Store(directory);
    assert.equal(store.pageCatalog.list(project.id, job.id, window).rows[0].page.id, page.id);
    assert.equal((store.db.prepare('SELECT body FROM artifacts WHERE id=?').get(page.id) as { body: string }).body, original);
    store.close(); store = new Store(directory);
    assert.equal(store.pageCatalog.summary(project.id, job.id).pages, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
