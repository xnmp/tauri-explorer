import { test, expect } from './fixtures';
import { waitForEntries } from './helpers';

test('jump to the common ancestor of two chosen branches, clearing a path filter', async ({ page }) => {
  await page.goto('/?path=/home/user/Documents/project');
  await waitForEntries(page);
  await page.keyboard.press('Control+Shift+p');
  await page.locator('input:focus').fill('Toggle Commit Graph');
  await page.keyboard.press('Enter');
  await expect(page.locator('.commit-row').first()).toContainText('Uncommitted Changes');
  await page.getByRole('button', { name: 'Filter branches', exact: true }).click();
  await page.getByLabel('Filter commits by file path').fill('README.md');
  await page.getByLabel('First merge-base branch').selectOption('refs/heads/experiment');
  await page.getByLabel('Second merge-base branch').selectOption('refs/heads/feature');
  await page.getByRole('button', { name: 'Jump to merge-base', exact: true }).click();
  const selected = page.locator('.commit-row.selected');
  await expect(selected).toHaveAttribute('data-oid', '0009000');
  await expect(selected).toContainText('Implement feature X');
  await expect(selected).toBeInViewport();
  await expect(page.locator('.gh-message')).toHaveText('Fork point: experiment / feature');
  await page.mouse.move(1100, 670);
  await page.screenshot({ path: 'evidence/ac-1-merge-base.png' });
  await page.getByRole('button', { name: 'Filter branches', exact: true }).click();
  await expect(page.getByLabel('Filter commits by file path')).toHaveValue('');
  await expect(page.getByLabel('First merge-base branch')).toHaveValue('refs/heads/experiment');
  await expect(page.getByLabel('Second merge-base branch')).toHaveValue('refs/heads/feature');
  await page.screenshot({ path: 'evidence/ac-3-cleared-filters.png' });
});

test('a remote branch participates in the fork-point jump', async ({ page }) => {
  await page.goto('/?path=/home/user/Documents/project');
  await waitForEntries(page);
  await page.keyboard.press('Control+Shift+p');
  await page.locator('input:focus').fill('Toggle Commit Graph');
  await page.keyboard.press('Enter');
  await expect(page.locator('.commit-row').first()).toContainText('Uncommitted Changes');
  await page.getByRole('button', { name: 'Filter branches', exact: true }).click();
  await page.getByLabel('First merge-base branch').selectOption('refs/remotes/origin/legacy-import');
  await page.getByLabel('Second merge-base branch').selectOption('refs/heads/feature');
  await page.getByRole('button', { name: 'Jump to merge-base', exact: true }).click();
  const selected = page.locator('.commit-row.selected');
  await expect(selected).toHaveAttribute('data-oid', '0008000');
  await expect(selected).toContainText('Refactor config loader');
  await expect(selected).toBeInViewport();
  await expect(page.locator('.gh-message')).toHaveText('Fork point: origin/legacy-import / feature');
  await page.mouse.move(1100, 670);
  await page.screenshot({ path: 'evidence/ac-2-remote-merge-base.png' });
});
