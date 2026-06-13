/**
 * Real content search (Ctrl+Shift+F) against the built binary: actual
 * ripgrep walk, actual event streaming (listener-before-invoke), actual
 * walker config (hidden files skipped, subdirectories recursed).
 *
 * Browser-mode Playwright covers the dialog UI against an inline mock —
 * it cannot catch streaming races or backend walker regressions.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo } from "./helpers";

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-search-"));

describe("content search against the real backend", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "alpha.txt"), "the needle is here\nplain line\n");
    fs.mkdirSync(path.join(scratchDir, "sub"));
    fs.writeFileSync(path.join(scratchDir, "sub", "beta.txt"), "another needle below\n");
    // Hidden files must be skipped by the walker.
    fs.writeFileSync(path.join(scratchDir, ".secret.txt"), "hidden needle\n");
    // A file with many matches exercises streaming + the collapse limit.
    fs.writeFileSync(
      path.join(scratchDir, "many.txt"),
      Array.from({ length: 8 }, (_, i) => `needle number ${i}`).join("\n") + "\n",
    );
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("streams real matches from disk, recursing subdirectories", async () => {
    await navigateTo(scratchDir);

    await browser.keys(["Control", "Shift", "f"]);
    const input = $(".content-search-dialog .search-input");
    await input.waitForDisplayed();
    await input.setValue("needle");

    // Results arrive via streamed events from the Rust thread.
    await browser.waitUntil(
      async () => (await $$(".result-item").length) > 0,
      { timeoutMsg: "no streamed results appeared" },
    );

    const text = await $(".content-search-dialog").getText();
    expect(text).toContain("alpha.txt");
    expect(text).toContain("many.txt");
    // Subdirectory file found, listed with its relative path.
    expect(text).toContain(path.join("sub", "beta.txt"));
    // Hidden files are excluded by the walker.
    expect(text).not.toContain(".secret.txt");

    // 1 + 1 + 8 = 10 real matches across 3 files.
    await browser.waitUntil(
      async () => (await $(".footer .stats").getText()).includes("10 matches in 3 files"),
      { timeoutMsg: "footer never reported the full match count" },
    );
  });

  it("collapses the many-match file and expands it on demand", async () => {
    const showMore = $(".show-more-row");
    await showMore.waitForDisplayed();
    expect(await showMore.getText()).toContain("3 more matches");

    const collapsedCount = await $$(".result-item").length;
    await showMore.click();

    await browser.waitUntil(
      async () => (await $$(".result-item").length) > collapsedCount,
      { timeoutMsg: "expanding never revealed the hidden matches" },
    );
    expect(await $$(".show-more-row").length).toBe(0);
  });

  it("re-searching supersedes the previous stream without mixing results", async () => {
    const input = $(".content-search-dialog .search-input");
    await input.setValue("plain line"); // setValue clears the previous query first

    await browser.waitUntil(async () => {
      const stats = await $(".footer .stats").getText();
      return stats.includes("1 matches in 1 files") || stats.includes("1 match");
    }, { timeoutMsg: "narrowed search never settled on the single match" });

    const text = await $(".content-search-dialog").getText();
    expect(text).toContain("alpha.txt");
    expect(text).not.toContain("many.txt");

    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () => !(await $(".content-search-dialog").isExisting()),
      { timeoutMsg: "dialog never closed" },
    );
  });
});
