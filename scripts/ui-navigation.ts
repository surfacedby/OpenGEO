import type { Page } from 'playwright';

/** Exercise the labeled menu on compact screens and the sidebar on desktop. */
export async function navigate(page: Page, view: string) {
  await page.locator('.topbar').waitFor({ state: 'visible' });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole('dialog', { name: 'Navigate workspace' }).getByRole('button', { name: view, exact: true }).click();
  } else await page.getByRole('button', { name: view, exact: true }).click();
}
