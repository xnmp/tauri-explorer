/**
 * SCM panel operations (#156).
 *
 * Outcome-based coverage of the Source Control panel against the stateful
 * mock-invoke git backend (which mirrors src-tauri/src/git.rs: staging moves
 * an entry from Changes/Untracked into Staged, commit clears the index, the
 * watcher event re-fetches on external edits, etc.). Every test asserts a
 * user-visible result — a row changing section, a badge count, the commit
 * input clearing, the recorded commit message — not just that a node rendered.
 */
import { test, expect, type Page } from "@playwright/test";

interface MockGitCommit {
  message: string;
  amend: boolean;
  files: string[];
  commit_id: string;
}

declare global {
  interface Window {
    __mockGitCommits?: MockGitCommit[];
    __mockGitExternalModify?: (path: string) => void;
    __mockGitSetClean?: () => void;
    __mockGitReset?: () => void;
  }
}

async function openScmOnRepo(page: Page, opts: { preview?: boolean } = {}): Promise<void> {
  await page.goto("/");
  await page.evaluate((preview) => {
    const raw = localStorage.getItem("explorer-settings");
    const s = raw ? JSON.parse(raw) : {};
    s.showGitStatus = true;
    s.showScmPanel = true;
    if (preview) s.showPreviewPane = true;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  }, opts.preview ?? false);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });
}

function badge(page: Page, section: string) {
  return page.locator(`[data-section="${section}"] .count-badge`);
}

test.describe("SCM panel operations", () => {
  test("staging a changed file moves it into Staged and updates counts", async ({ page }) => {
    await openScmOnRepo(page);

    await expect(badge(page, "staged")).toHaveText("1");
    await expect(badge(page, "changes")).toHaveText("2");

    const row = page.locator('[data-section="changes"] .row', { hasText: "index.css" });
    await row.hover();
    await row.locator('.row-btn[title="Stage"]').click();

    // Row left Changes and joined Staged; counts moved with it.
    await expect(
      page.locator('[data-section="staged"] .row', { hasText: "index.css" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-section="changes"] .row', { hasText: "index.css" }),
    ).toHaveCount(0);
    await expect(badge(page, "staged")).toHaveText("2");
    await expect(badge(page, "changes")).toHaveText("1");
  });

  test("staging an untracked file shows it as Added, and unstaging returns it to Untracked", async ({ page }) => {
    await openScmOnRepo(page);

    const untracked = page.locator('[data-section="untracked"] .row', { hasText: "router.tsx" });
    await untracked.hover();
    await untracked.locator('.row-btn[title="Stage"]').click();

    // Now staged with an "A" (Added) status letter.
    const stagedRow = page.locator('[data-section="staged"] .row', { hasText: "router.tsx" });
    await expect(stagedRow).toBeVisible();
    await expect(stagedRow.locator(".status-letter")).toHaveText("A");
    await expect(badge(page, "untracked")).toHaveText("2");

    // Unstage → back to Untracked.
    await stagedRow.hover();
    await stagedRow.locator('.row-btn[title="Unstage"]').click();
    await expect(
      page.locator('[data-section="untracked"] .row', { hasText: "router.tsx" }),
    ).toBeVisible();
    await expect(badge(page, "untracked")).toHaveText("3");
    await expect(badge(page, "staged")).toHaveText("1");
  });

  test("commit clears the input, empties Staged, and records the message", async ({ page }) => {
    await openScmOnRepo(page);

    await page.getByLabel("Commit message").fill("feat: ship the thing");
    const commitBtn = page.getByRole("button", { name: /^Commit$/ });
    await expect(commitBtn).toBeEnabled();
    await commitBtn.click();

    // Staged emptied and the input reset.
    await expect(badge(page, "staged")).toHaveText("0");
    await expect(page.getByLabel("Commit message")).toHaveValue("");
    // The button disables again (nothing staged, empty message).
    await expect(commitBtn).toBeDisabled();

    // The backend actually recorded the message.
    const messages = await page.evaluate(() => window.__mockGitCommits?.map((c) => c.message) ?? []);
    expect(messages).toContain("feat: ship the thing");

    // Working-tree changes survive the commit.
    await expect(badge(page, "changes")).toHaveText("2");
  });

  test("pressing Enter in the commit box commits; Shift+Enter does not", async ({ page }) => {
    await openScmOnRepo(page);

    const input = page.getByLabel("Commit message");

    // Shift+Enter inserts a newline and must NOT commit.
    await input.fill("line one");
    await input.press("Shift+Enter");
    await expect(badge(page, "staged")).toHaveText("1");
    expect(await page.evaluate(() => window.__mockGitCommits?.length ?? 0)).toBe(0);

    // Plain Enter commits.
    await input.fill("commit via enter");
    await input.press("Enter");
    await expect(badge(page, "staged")).toHaveText("0");
    const messages = await page.evaluate(() => window.__mockGitCommits?.map((c) => c.message) ?? []);
    expect(messages).toContain("commit via enter");
  });

  test("amend toggle relabels the commit control and amends the previous commit", async ({ page }) => {
    await openScmOnRepo(page);

    // Establish a base commit to amend.
    await page.getByLabel("Commit message").fill("base commit");
    await page.getByRole("button", { name: /^Commit$/ }).click();
    await expect(badge(page, "staged")).toHaveText("0");

    // Stage a change so the amend has content, then turn on Amend.
    const row = page.locator('[data-section="changes"] .row', { hasText: "index.css" });
    await row.hover();
    await row.locator('.row-btn[title="Stage"]').click();
    await expect(badge(page, "staged")).toHaveText("1");

    const amend = page.locator(".amend-toggle input");
    await amend.check();

    // Control relabels and becomes usable even with an empty message.
    await expect(page.locator(".commit-btn")).toHaveText("Commit (Amend)");
    await expect(page.getByLabel("Commit message")).toHaveAttribute(
      "placeholder",
      /Amend commit message/i,
    );

    await page.getByLabel("Commit message").fill("amended message");
    await page.locator(".commit-btn").click();

    // Amend collapsed into the single prior commit (not a second commit) and
    // the checkbox reset.
    await expect(badge(page, "staged")).toHaveText("0");
    await expect(amend).not.toBeChecked();
    const commits = await page.evaluate(() => window.__mockGitCommits ?? []);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("amended message");
  });

  test("branch name is displayed", async ({ page }) => {
    await openScmOnRepo(page);
    await expect(page.locator(".branch-name")).toHaveText("main");
  });

  test("an external edit (watcher event) refreshes the panel without a local action", async ({ page }) => {
    await openScmOnRepo(page);
    await expect(badge(page, "changes")).toHaveText("2");

    // Simulate another process modifying a file; the store must re-fetch off
    // the watcher event, not a click.
    await page.evaluate(() => window.__mockGitExternalModify?.("src/service.ts"));

    await expect(
      page.locator('[data-section="changes"] .row', { hasText: "service.ts" }),
    ).toBeVisible();
    await expect(badge(page, "changes")).toHaveText("3");
  });

  test("error state: a non-repo folder offers Initialize Repository", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Default pane (/home/user) is not a repo.
    await expect(page.getByText(/Not a git repository/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Initialize Repository/i })).toBeVisible();
    // And no file sections are shown.
    await expect(page.locator('[data-section="staged"]')).toHaveCount(0);
  });

  test("empty state: a clean working tree shows 'Working tree clean'", async ({ page }) => {
    await openScmOnRepo(page);
    await expect(page.locator(".clean-state")).toHaveCount(0);

    // Everything committed/discarded elsewhere → clean tree via watcher event.
    await page.evaluate(() => window.__mockGitSetClean?.());

    await expect(page.locator(".clean-state")).toHaveText(/Working tree clean/i);
    await expect(badge(page, "staged")).toHaveText("0");
    await expect(badge(page, "changes")).toHaveText("0");
    await expect(badge(page, "untracked")).toHaveText("0");
  });
});

test.describe("SCM diff view", () => {
  test("opening a diff, staging from it, then closing", async ({ page }) => {
    await openScmOnRepo(page, { preview: true });

    // Open the diff for an unstaged change.
    await page.locator('[data-section="changes"] .row', { hasText: "index.css" }).click();
    const preview = page.locator(".preview-pane");
    await expect(preview.locator(".preview-filename")).toHaveText("index.css");
    await expect(preview.locator(".diff-unstaged")).toBeVisible();
    await expect(preview.locator('.diff-line[data-line-kind="add"]').first()).toBeVisible();

    // Stage from the diff: file moves to Staged and the diff follows it.
    await preview.locator('.diff-action-btn', { hasText: "Stage" }).click();
    await expect(
      page.locator('[data-section="staged"] .row', { hasText: "index.css" }),
    ).toBeVisible();
    await expect(badge(page, "changes")).toHaveText("1");
    await expect(preview.locator(".diff-staged")).toBeVisible();
    await expect(preview.locator('.diff-action-btn', { hasText: "Unstage" })).toBeVisible();

    // Close returns the pane to the file-preview empty state.
    await preview.locator('.diff-action-btn', { hasText: "Close" }).click();
    await expect(preview.locator(".diff-staged")).toHaveCount(0);
    await expect(preview.locator(".diff-unstaged")).toHaveCount(0);
  });

  test("unstaging from a staged diff moves the file back to Changes", async ({ page }) => {
    await openScmOnRepo(page, { preview: true });

    // App.tsx starts staged.
    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();
    const preview = page.locator(".preview-pane");
    await expect(preview.locator(".diff-staged")).toBeVisible();

    await preview.locator('.diff-action-btn', { hasText: "Unstage" }).click();
    await expect(
      page.locator('[data-section="changes"] .row', { hasText: "App.tsx" }),
    ).toBeVisible();
    await expect(badge(page, "staged")).toHaveText("0");
  });
});
