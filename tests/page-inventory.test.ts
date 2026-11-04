import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, auditFindings } from '../server/audit.js';
import { projectInput, jobInput } from '../server/contracts.js';
import { Store } from '../server/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageSuggestions } from '../src/page-suggestions.js';

test('large saved inventories remain searchable beyond the first suggestion page', () => {
  const base = parsePage('https://example.com/start', 200, '<title>Product documentation</title><h1>Guide</h1>');
  const pages = Array.from({ length: 10000 }, (_, index) => ({ ...base, id: 'page-' + index, url: `https://example.com/docs/${index}`, title: `Guide ${index}` }));
  const privatePage = { ...base, id: 'private', url: 'https://example.com/private', noindex: true };
  const unavailable = { ...base, id: 'unavailable', url: 'https://example.com/unavailable', status: 301 };
  assert.equal(pageSuggestions([privatePage, unavailable, ...pages], [], '').length, 20);
  assert.deepEqual(pageSuggestions(pages, [], 'Guide 9999').map(page => page.id), ['page-9999']);
  assert.deepEqual(pageSuggestions(pages, [pages[9999].url], 'Guide 9999'), []);
  assert.deepEqual(pageSuggestions([privatePage, unavailable], [], ''), []);
  assert.deepEqual(pageSuggestions([pages[0], pages[0]], [], '').map(page => page.id), ['page-0']);
});

test('audit filtering preserves unknown evidence while excluding intentional private pages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-inventory-'));
  const store = new Store(directory);
  try {
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
  const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'inventory-fixture');
  const publicPage = parsePage('https://example.com/public', 200, '<h1>Public</h1>');
  const privatePage = parsePage('https://example.com/private', 200, '<meta name="robots" content="noindex"><h1>Private</h1>');
  const missingPage = parsePage('https://example.com/older', 200, '<h1>Older</h1>');
  const findings = auditFindings(project, job.id, [publicPage, privatePage, missingPage]);
  for (const page of [publicPage, privatePage]) store.put('page', project.id, job.id, page);
  for (const finding of findings) store.put('finding', project.id, job.id, finding);
  const visible = store.pageCatalog.list(project.id, job.id, { query: '', tab: 'attention', grouping: 'none', offset: 0, limit: 10, groupOffset: 0 });
  assert.deepEqual(visible.rows.map(row => row.page.id), [publicPage.id]);
  assert.deepEqual(store.pageCatalog.findings(project.id, job.id, missingPage.url).map(finding => finding.id).sort(), findings.filter(finding => finding.targetUrl === missingPage.url).map(finding => finding.id).sort());
  assert.deepEqual(store.findings(project.id).map(finding => finding.id).sort(), findings.map(finding => finding.id).sort(), 'Navigation never deletes excluded or missing-page evidence');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
