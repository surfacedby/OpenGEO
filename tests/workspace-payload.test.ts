import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { parsePage } from '../server/audit.js';
import { jobInput, projectInput } from '../server/contracts.js';

const session = 'synthetic-workspace-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };

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
    store.updateJob(audit.id, { status: 'completed' });
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.pages.length, 40);
    for (const page of workspace.pages) {
      assert.equal('text' in page, false);
      assert.equal('links' in page, false);
    }
    assert.deepEqual(Object.keys(workspace.pages[0]).sort(), ['canonical', 'description', 'fetchedAt', 'h1', 'id', 'noindex', 'schemaTypes', 'status', 'title', 'url']);
    assert.equal(workspace.pages[0].title, 'Example reports');
    assert.ok(JSON.stringify(workspace.pages).length < pages.reduce((sum, page) => sum + page.text.length, 0) / 10, 'Page summaries stay a small part of the full text');
    assert.match(store.pages(project.id, audit.id)[0].text, /shared with the whole team/, 'Stored evidence keeps the full text');
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
