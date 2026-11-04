import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { auditFindings, parsePage } from '../server/audit.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { reportMarkdown } from '../server/export.js';

const session = 'synthetic-workspace-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };

test('workspace and report preserve brand advice while a Topic recheck retires only its own open advice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-scoped-advice-')), store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault, session);
  try {
    const topicId = randomUUID();
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['How do reports work?'], topics: [{ id: topicId, name: 'Reports', prompts: ['How do reports work?'], createdAt: new Date().toISOString() }] }));
    const addAdvice = (topic?: string) => {
      const scan = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'chatgpt', ...(topic ? { topicId: topic } : {}) }), randomUUID());
      store.updateJob(scan.id, { status: 'completed' });
      const analysis = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'diagnose', provider: 'chatgpt', measurementJobId: scan.id }), randomUUID());
      const finding = { id: randomUUID(), projectId: project.id, jobId: analysis.id, title: topic ? 'Topic advice' : 'Brand advice', description: 'Review the report explanation.', priority: 'medium', kind: 'analysis', status: 'open', targetUrl: 'https://example.com/reports', steps: ['Explain report exports.'], evidenceIds: [], confidence: 'inferred' };
      store.put('finding', project.id, analysis.id, finding);
      store.updateJob(analysis.id, { status: 'completed', result: { findings: 1, measurementJobId: scan.id } });
      return finding;
    };
    const brand = addAdvice(), topic = addAdvice(topicId);
    const initial = await app.inject({ url: `/api/projects/${project.id}/workspace`, headers });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json().findings.map((finding: any) => finding.id).sort(), [brand.id, topic.id].sort());
    assert.match(reportMarkdown(store, project.id), /Scope: Topic: Reports/);
    assert.match(reportMarkdown(store, project.id), /Scope: Brand-wide check/);
    const next = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'recheck', provider: 'chatgpt', topicId }), randomUUID());
    store.updateJob(next.id, { status: 'completed' });
    const updated = await app.inject({ url: `/api/projects/${project.id}/workspace`, headers });
    assert.deepEqual(updated.json().findings.map((finding: any) => finding.id), [brand.id]);
    assert.match(reportMarkdown(store, project.id), /Brand advice/);
    assert.doesNotMatch(reportMarkdown(store, project.id), /Topic advice/);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the polled workspace leaves page text and links to the evidence views', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-workspace-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault, session);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['Which example tools publish reports?'] }));
    const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'audit');
    const pages = Array.from({ length: 40 }, (_, index) => parsePage('https://example.com/page/' + index, 200,
      '<title>Example reports</title><h1>Publish reports</h1><p>' + 'Example reports are shared with the whole team. '.repeat(200) + '</p><a href="/page/' + (index + 1) + '">Next</a>'));
    for (const page of pages) store.put('page', project.id, audit.id, page);
    const originalPages = store.pages.bind(store);
    store.pages = () => { throw new Error('Polling must not load the full crawl'); };
    store.updateJob(audit.id, { status: 'completed' });
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.pages.length, 40);
    for (const page of workspace.pages) {
      assert.equal('text' in page, false);
      assert.equal('links' in page, false);
    }
    assert.deepEqual(Object.keys(workspace.pages[0]).sort(), ['canonical', 'description', 'fetchedAt', 'h1', 'id', 'noindex', 'schemaTypes', 'status', 'structuredDataLimitations', 'title', 'url']);
    assert.deepEqual(workspace.pages[0].structuredDataLimitations, []);
    assert.equal(workspace.pages[0].title, 'Example reports');
    assert.ok(JSON.stringify(workspace.pages).length < pages.reduce((sum, page) => sum + page.text.length, 0) / 10, 'Page summaries stay a small part of the full text');
    assert.match(originalPages(project.id, audit.id)[0].text, /shared with the whole team/, 'Stored evidence keeps the full text');
    const findings = auditFindings(project, audit.id, [pages[0]]);
    for (const finding of findings) store.put('finding', project.id, audit.id, finding);
    const evidence = store.pageEvidence.bind(store);
    const reads: string[] = [];
    store.pageEvidence = (projectId, id) => { reads.push(id); return evidence(projectId, id); };
    const withFindings = await app.inject({ url: `/api/projects/${project.id}/workspace`, headers });
    assert.equal(withFindings.statusCode, 200);
    assert.deepEqual(reads, [pages[0].id], 'All findings on one page share a single scoped evidence read');
    assert.deepEqual(withFindings.json().findings.map((finding: any) => finding.title).sort(), findings.map(finding => finding.title).sort());
    const detail = await app.inject({ url: `/api/projects/${project.id}/findings/${findings[0].id}/evidence`, headers });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().pages.map((page: any) => page.id), [pages[0].id]);
    assert.equal(detail.json().pages[0].text, pages[0].text);
    assert.equal(detail.json().missing, 0);
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    assert.deepEqual(store.evidenceRecords(other.id, [pages[0].id]), { pages: [], sources: [], observations: [] });
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
