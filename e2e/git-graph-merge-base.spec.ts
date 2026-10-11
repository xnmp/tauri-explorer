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

import type { MockControl } from '../src/lib/api/mock-control';
import type { Page } from './fixtures';
async function startDelayedJump(page: Page) {
  await page.goto('/?path=/home/user/Documents/project');
  await waitForEntries(page);
  await page.keyboard.press('Control+Shift+p');
  await page.locator('input:focus').fill('Toggle Commit Graph');
  await page.keyboard.press('Enter');
  await expect(page.locator('.commit-row').first()).toContainText('Uncommitted Changes');
  await page.locator('.commit-row', { hasText: 'Update README with usage' }).click();
  await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-oid', '000b000');
  await page.getByRole('button', { name: 'Filter branches', exact: true }).click();
  await page.getByLabel('First merge-base branch').selectOption('refs/heads/experiment');
  await page.getByLabel('Second merge-base branch').selectOption('refs/heads/feature');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => {
    ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).latency = { git_merge_base: 10_000 };
  });
  await page.getByRole('button', { name: 'Jump to merge-base', exact: true }).click();
  await page.clock.runFor(50);
  await expect(page.getByRole('button', { name: 'Finding merge-base…' })).toBeDisabled();
}

test('a watcher refresh retires a pending ancestor lookup before it can select a stale commit', async ({ page }) => {
  await startDelayedJump(page);
  await page.evaluate(() => {
    (window as unknown as { __mockControl: MockControl }).__mockControl.gitPoll!();
  });
  await page.clock.runFor(11_000);
  await expect(page.locator('.commit-row.selected')).toHaveAttribute('data-oid', '000b000');
  await expect(page.locator('.gh-message')).toHaveText('Message');
});

test('opening PR details survives late completion of an interrupted ancestor lookup', async ({ page }) => {
  await startDelayedJump(page);
  await page.getByRole('button', { name: 'Close branch filter', exact: true }).click();
  await page.locator('.commit-row', { hasText: 'Add tests for feature X' }).locator('.ref-pr').click();
  await page.clock.runFor(11_000);
  await expect(page.locator('[data-testid="git-graph-pr-detail"]')).toContainText('Implements feature X end to end.');
  await expect(page.locator('.commit-row.selected')).toHaveCount(0);
  await expect(page.locator('.gh-message')).toHaveText('Message');
});
