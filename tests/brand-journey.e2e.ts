import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { projectInput } from '../server/contracts.js';

test('brand journey separates prompts and results, saves edits and confirms deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-journey-'));
  const store = new Store(dir);
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example Domain' }));
  store.set('usageConsent', { enabled: false });
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault, undefined, resolve('dist'));
  const browser = await chromium.launch({ executablePath: process.env.OPENGEO_TEST_BROWSER || undefined });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + address.port);
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect AI to discover prompts' })).toBeVisible();
    await page.getByRole('tab', { name: /Tracked prompts/ }).click();
    await page.getByRole('button', { name: 'Add a question', exact: true }).click();
    await page.getByRole('textbox', { name: 'Question 1', exact: true }).fill('What does Example Domain offer?');
    await page.getByRole('tab', { name: 'Suggested by AI', exact: true }).click();
    await expect(page.getByText('Save or cancel your prompt changes before switching tabs.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Question 1', exact: true })).toHaveText('What does Example Domain offer?');
    await page.getByRole('button', { name: 'Save prompts', exact: true }).click();
    await expect(page.getByText('Prompts saved. Your next visibility check will use this list.')).toBeVisible();
    assert.deepEqual(store.project(project.id).prompts, ['What does Example Domain offer?']);
    if (process.env.OPENGEO_REVIEW_SCREENSHOTS) await page.locator('.shell').screenshot({ path: join(process.env.OPENGEO_REVIEW_SCREENSHOTS, 'prompts.png') });
    await page.getByRole('button', { name: 'Brand', exact: true }).click();
    await page.getByRole('textbox', { name: 'Brand name', exact: true }).fill('Example Brand');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Brand name', exact: true })).toHaveValue('Example Brand');
    await page.getByRole('button', { name: 'Save brand details' }).click();
    await expect(page.getByText('Brand details saved.')).toBeVisible();
    assert.equal(store.project(project.id).brand, 'Example Brand');
    assert.deepEqual(store.project(project.id).prompts, ['What does Example Domain offer?']);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Applies to every brand on this device')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Brand name', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Scans', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI visibility', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Website health', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal page overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.OPENGEO_REVIEW_SCREENSHOTS) {
      for (const name of ['Overview', 'Scans', 'Visibility', 'Responses', 'Sources', 'Opportunities', 'Content', 'Competitors', 'Reports', 'Brand', 'Settings']) {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await page.locator('.shell').screenshot({ path: join(process.env.OPENGEO_REVIEW_SCREENSHOTS, name.toLowerCase() + '.png') });
      }
    }
    await page.getByRole('button', { name: 'Brand', exact: true }).click();
    await page.getByRole('button', { name: 'Delete brand', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Delete permanently', exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByRole('textbox', { name: 'Type example.com to confirm' }).fill('example.com');
    await confirm.click();
    await expect.poll(() => store.projects().length).toBe(0);
    await page.getByRole('button', { name: 'App settings', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'About', exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
