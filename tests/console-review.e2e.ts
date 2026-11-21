import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import { createApp } from '../server/app.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { navigate } from '../scripts/ui-navigation.js';

test('An unconfirmed Console check offers review without offering to start it again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-console-review-'));
  const assets = join(directory, 'web');
  const store = new Store(directory);
  let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await build({ build: { outDir: assets }, logLevel: 'error' });
    const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
    store.set('onboarding', { completed: true });
    store.set('usageConsent', { enabled: false });
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['Which examples are useful?'] }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, provider: 'console', kind: 'measure', maxCostUsd: 1 }), randomUUID());
    store.setStep(job.id, 'console-scan', 'approved-retry');
    store.updateJob(job.id, { status: 'paused', error: 'interrupted', progress: 'The submission is still unconfirmed.' });
    ({ app } = await createApp(store, vault, 'fixture-session', assets));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.OPENGEO_TEST_BROWSER || undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const mutations: string[] = [];
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || url.pathname.endsWith('/site-icon')) return route.abort();
      if (request.method() === 'POST' && url.pathname.startsWith('/api/jobs/')) mutations.push(url.pathname);
      return route.continue();
    });
    await page.goto(origin);
    await navigate(page, 'Scans');
    const card = page.locator('.job').filter({ hasText: 'The submission is still unconfirmed.' });
    await card.getByRole('button', { name: /^(Review check|Resume)$/ }).click();
    await expect(card.getByRole('heading', { name: 'Check needs review' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Open SurfacedBy Console' })).toHaveAttribute('href', 'https://console.surfacedby.com/dashboard');
    await expect(card.getByRole('button', { name: 'Resume run' })).toHaveCount(0);
    await expect(card.locator('input[name="reviewed"]')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card.getByRole('link', { name: 'Open SurfacedBy Console' })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card.getByRole('heading', { name: 'Check needs review' })).toHaveCount(0);

    store.updateJob(job.id, { status: 'cancelled', error: 'cancel_remote' });
    await page.getByRole('button', { name: 'Refresh workspace' }).click();
    await card.getByRole('button', { name: 'Check cancellation' }).click();
    await expect(card.getByRole('heading', { name: 'Check needs review' })).toBeVisible();
    assert.deepEqual(mutations, []);
    assert.equal(store.step(job.id, 'console-scan')?.state, 'approved-retry');
    assert.equal(store.job(job.id).maxCostUsd, 1);
  } finally {
    await browser?.close();
    await app?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
