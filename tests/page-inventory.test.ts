import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, auditFindings } from '../server/audit.js';
import { projectInput } from '../server/contracts.js';
import { visibleAuditFindings } from '../src/finding-groups.js';
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
  const project = { ...projectInput.parse({ domain: 'example.com', brand: 'Example' }), id: 'project', createdAt: new Date().toISOString() };
  const publicPage = parsePage('https://example.com/public', 200, '<h1>Public</h1>');
  const privatePage = parsePage('https://example.com/private', 200, '<meta name="robots" content="noindex"><h1>Private</h1>');
  const missingPage = parsePage('https://example.com/older', 200, '<h1>Older</h1>');
  const findings = auditFindings(project, 'audit', [publicPage, privatePage, missingPage]);
  const visible = visibleAuditFindings(findings, [publicPage, privatePage]);
  assert.deepEqual(visible, findings.filter(finding => finding.targetUrl !== privatePage.url));
  assert.ok(visible.some(finding => finding.targetUrl === missingPage.url));
  assert.deepEqual(visibleAuditFindings(findings, []), findings);
});
