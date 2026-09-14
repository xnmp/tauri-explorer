/**
 * Author-avatar acceptance against the built binary, real git and production
 * `git_author_avatar` IPC. Browser Playwright cannot cover this contract: its
 * backend is a mock and returns a fixture SVG instead of downloading GitHub.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";

const repository = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-avatar-"));
const subject = "native GitHub avatar resolution";
const githubAvatarUrl = "https://avatars.githubusercontent.com/u/583231?s=64";

function cacheDirectory(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "tauri-explorer", "avatars");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tauri-explorer", "avatars");
}

function createHistory(): void {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository });
  const timestamp = Math.floor(Date.now() / 1000) - 240;
  const commits = Array.from({ length: 180 }, (_, index) => {
    const message = index === 179 ? subject : `avatar history ${index + 1}`;
    const parent = index === 0 ? "" : `from :${index}\n`;
    return [
      "commit refs/heads/main",
      `mark :${index + 1}`,
      `author The Octocat <583231+octocat@users.noreply.github.com> ${timestamp + index} +0000`,
      `committer The Octocat <583231+octocat@users.noreply.github.com> ${timestamp + index} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      parent,
    ].join("\n");
  }).join("\n");
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repository, input: commits });
}

async function openGraph(): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const palette = $(".command-palette-dialog .search-input");
  await palette.waitForDisplayed();
  await palette.setValue("Toggle Commit Graph");
  await $(".command-item").waitForDisplayed();
  await browser.keys(["Enter"]);
  await $('[data-testid="git-graph-view"]').waitForExist({ timeout: 15_000 });
}

describe("native GitHub author avatar", () => {
  before(() => {
    createHistory();
    // Force this run through the downloader instead of inheriting a prior
    // machine-local result. The command still owns all cache publication.
    const key = createHash("sha256").update(githubAvatarUrl).digest("hex");
    fs.rmSync(path.join(cacheDirectory(), `${key}.image`), { force: true });
    fs.rmSync(path.join(cacheDirectory(), `${key}.missing`), { force: true });
  });

  after(async () => {
    await browser.execute(() => window.dispatchEvent(new CustomEvent("e2e-reset-view")));
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it("renders a GitHub noreply avatar through production IPC without breaking virtualized rows", async () => {
    await navigateTo(repository);
    await browser.execute(() => {
      localStorage.setItem("git-graph-avatar-preferences", JSON.stringify({ visible: true, gravatarEnabled: false }));
    });
    await openGraph();

    await browser.waitUntil(
      async () => (await domTexts(".commit-row .summary")).some(text => text.trim() === subject),
      { timeout: 20_000, timeoutMsg: "real git history never rendered the avatar acceptance commit" },
    );
    const row = $(`//div[contains(@class,'commit-row')][.//span[normalize-space()='${subject}']]`);
    const image = row.$('[data-testid="author-avatar"] img');
    await image.waitForDisplayed({ timeout: 20_000 });
    expect(await image.getAttribute("src")).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
    expect(await image.getSize()).toEqual({ width: 20, height: 20 });
    expect((await row.getSize()).height).toBe(28);
    await row.saveScreenshot(path.resolve("evidence/ac-1-resolved-avatar.png"));

    const initialFirst = (await domTexts(".commit-row .summary"))[0];
    await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>(".graph-scroller");
      if (!scroller) throw new Error("graph scroller is missing");
      scroller.scrollTop = 2_000;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await browser.waitUntil(
      async () => (await domTexts(".commit-row .summary"))[0] !== initialFirst,
      { timeoutMsg: "virtualized graph rows did not recycle after scrolling" },
    );
    expect((await $$(".commit-row")).length).toBeLessThan(100);
    expect((await $(".commit-row").getSize()).height).toBe(28);
  });
});
