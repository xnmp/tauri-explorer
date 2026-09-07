/** Real Git mutations must invalidate hidden graph snapshots before remount. */
import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domText, domTexts } from "./helpers";

const repository = fs.mkdtempSync(path.join(os.tmpdir(), process.platform === "win32" ? "explorer-cache-" : "explorer-cache-|"));
function git(...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Cache Test", "-c", "user.email=cache@example.test", ...args], { cwd: repository });
}
async function toggleGraph() {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue("Toggle Commit Graph");
  let command: Awaited<ReturnType<typeof $$>>[number] | undefined;
  await browser.waitUntil(async () => {
    const candidates = await $$(".command-item");
    if (candidates.length !== 1) return false;
    const text = ((await candidates[0].getProperty("textContent")) as string | null)?.trim() ?? "";
    if (!text.includes("Git: Toggle Commit Graph")) return false;
    command = candidates[0];
    return true;
  }, { timeoutMsg: "Git: Toggle Commit Graph never became the sole filtered palette result" });
  await command!.click();
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

describe("native graph cache lifetime", () => {
  before(() => {
    git("init", "--quiet");
    fs.writeFileSync(path.join(repository, "initial.txt"), "initial");
    git("add", "."); git("commit", "--quiet", "-m", "cache initial commit");
  });
  after(() => fs.rmSync(repository, { recursive: true, force: true }));
  it("reopening a hidden graph includes an external commit in a path containing a delimiter", async () => {
    await navigateTo(repository);
    await toggleGraph();
    await $('[data-testid="git-graph-view"]').waitForExist({ timeout: 15_000 });
    await browser.waitUntil(async () => (await domTexts(".commit-row .summary")).map((text) => text.trim()).includes("cache initial commit"), { timeout: 20_000 });
    await toggleGraph();
    await $(".file-list").waitForExist();

    fs.writeFileSync(path.join(repository, "external.txt"), "external");
    git("add", "."); git("commit", "--quiet", "-m", "cache external commit");
    // Observe the actual filesystem change before opening the graph. The
    // assertion below verifies real history; no mock invalidation is injected.
    await browser.waitUntil(async () => (await domTexts(".entry-name")).includes("external.txt"), { timeout: 20_000 });
    await toggleGraph();
    await $('[data-testid="git-graph-view"]').waitForExist({ timeout: 15_000 });
    await browser.waitUntil(async () => (await domTexts(".commit-row .summary")).map((text) => text.trim()).includes("cache external commit"), {
      timeout: 20_000, timeoutMsg: "hidden graph retained history from before the real Git commit",
    });
    await toggleGraph();
    await $(".file-list").waitForExist();
  });

  it("a cached graph can reach history beyond its retained first page through real Git", async () => {
    // Fast-import produces a real linear history without hundreds of shell
    // invocations. These empty-tree commits exercise native cursor pagination.
    const timestamp = Math.floor(Date.now() / 1000);
    const stream = Array.from({ length: 360 }, (_, index) => {
      const message = `pagination history ${String(index + 1).padStart(3, "0")}`;
      return `commit refs/heads/pagination\ncommitter Cache Test <cache@example.test> ${timestamp + index} +0000\ndata ${message.length}\n${message}\n\n`;
    }).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repository, input: stream });
    git("checkout", "--quiet", "pagination");
    await navigateTo(repository);
    await toggleGraph();
    const summaries = async () => (await domTexts(".commit-row .summary")).map((text) => text.trim());
    await browser.waitUntil(async () => (await summaries()).includes("pagination history 360"), { timeout: 20_000 });
    await toggleGraph();
    await $(".file-list").waitForExist();
    await toggleGraph();
    await browser.waitUntil(async () => (await summaries()).includes("pagination history 360"), { timeout: 20_000 });
    await browser.waitUntil(async () => {
      await browser.execute(() => {
        const scroller = document.querySelector<HTMLElement>(".graph-scroller");
        if (!scroller) return;
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event("scroll"));
      });
      return (await summaries()).includes("pagination history 001");
    }, { timeout: 20_000, interval: 250, timeoutMsg: "cached native graph did not paginate beyond its first 300 commits" });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-graph-pagination.png");
    await toggleGraph();
    await $(".file-list").waitForExist();
  });

  it("shows the staged and unstaged diffs of the same real file independently", async () => {
    const file = path.join(repository, "partial.txt");
    fs.writeFileSync(file, "base content\n");
    git("add", "partial.txt");
    git("commit", "--quiet", "-m", "partial file base");
    fs.writeFileSync(file, "staged content\n");
    git("add", "partial.txt");
    fs.writeFileSync(file, "working content\n");
    await navigateTo(repository);
    await toggleGraph();
    const dirty = $('.commit-row[data-oid="*"]');
    await dirty.waitForDisplayed({ timeout: 20_000 });
    await dirty.click();
    const staged = '.stage-group[data-section="staged"]';
    const unstaged = '.stage-group[data-section="unstaged"]';
    await $(`${staged} .detail-file`).waitForDisplayed();
    await $(`${unstaged} .detail-file`).waitForDisplayed();

    await $(`${staged} .detail-file`).click();
    await browser.waitUntil(async () => (await domText(`${staged} .file-diff`)).includes("staged content"));
    await expect($$(".file-diff")).toBeElementsArrayOfSize(1);
    await expect($(`${unstaged} .file-diff`)).not.toExist();
    await expect(await domText(`${staged} .file-diff`)).toContain("base content");
    await expect(await domText(`${staged} .file-diff`)).not.toContain("working content");

    await $(`${unstaged} .detail-file`).click();
    await browser.waitUntil(async () => (await domText(`${unstaged} .file-diff`)).includes("working content"));
    await expect($$(".file-diff")).toBeElementsArrayOfSize(1);
    await expect($(`${staged} .file-diff`)).not.toExist();
    await expect(await domText(`${unstaged} .file-diff`)).toContain("staged content");
    await expect(await domText(`${unstaged} .file-diff`)).not.toContain("base content");
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-graph-partial-diff.png");
    // Unstaging changes the meaning of the still-visible working-tree row.
    // Its old index-to-worktree patch must retire before it can be reopened.
    await $(`${staged} .stage-all-btn`).click();
    await $(`${staged}`).waitForExist({ reverse: true });
    await expect($$(".file-diff")).toBeElementsArrayOfSize(0);
    await $(`${unstaged} .detail-file`).click();
    await browser.waitUntil(async () => (await domText(`${unstaged} .file-diff`)).includes("working content"));
    await expect(await domText(`${unstaged} .file-diff`)).toContain("base content");
    await expect(await domText(`${unstaged} .file-diff`)).not.toContain("staged content");
    await toggleGraph();
    await $(".file-list").waitForExist();
  });
});
