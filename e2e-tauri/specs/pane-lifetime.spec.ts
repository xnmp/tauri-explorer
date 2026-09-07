/** Real native watches must follow pane close/restore while the surviving
 * pane continues observing its own directory. No mock listing or refresh. */
import { browser, $, $$ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-panes-"));
const first = path.join(scratch, "first");
const second = path.join(scratch, "second");

async function ready(directory: string) {
  await browser.waitUntil(async () => await browser.execute((target: string) => {
    const data = document.documentElement.dataset;
    const paths: string[] = JSON.parse(data.e2eReadyDirectoryWatches ?? "[]");
    return data.e2eDirectoryWatcherListenerReady === "true" && paths.includes(target);
  }, directory), { timeoutMsg: `watch not ready for ${directory}` });
}

describe("pane resource lifetime", () => {
  before(() => {
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "first.txt"), "first");
    fs.writeFileSync(path.join(second, "second.txt"), "second");
    execFileSync("git", ["init", "--quiet", second]);
    execFileSync("git", ["add", "second.txt"], { cwd: second });
    execFileSync("git", ["-c", "user.name=Pane Test", "-c", "user.email=pane@example.test",
      "commit", "--quiet", "-m", "initial"], { cwd: second });
  });
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("both directories still receive external changes after closing and restoring a pane", async () => {
    await navigateTo(first);
    // Native sessions restore the previous window layout across spec runs.
    if (await $$(".explorer-pane").length > 1) {
      await browser.keys(["Control", "\\"]);
      await browser.waitUntil(async () => await $$(".explorer-pane").length === 1);
    }
    await browser.keys(["Control", "m"]);
    await browser.waitUntil(async () => await $$(".explorer-pane").length === 2);
    await navigateTo(second);
    await ready(second);
    await browser.keys(["Control", "w"]);
    await browser.waitUntil(async () => await $$(".explorer-pane").length === 1);
    await browser.keys(["Control", "Shift", "t"]);
    await browser.waitUntil(async () => await $$(".explorer-pane").length === 2);
    await browser.waitUntil(async () =>
      (await domTexts(".explorer-pane.active .entry-name")).includes("second.txt"));
    await Promise.all([ready(first), ready(second)]);

    fs.writeFileSync(path.join(first, "first-external.txt"), "new first");
    fs.writeFileSync(path.join(second, "second-external.txt"), "new second");
    await browser.waitUntil(async () => {
      const active = await domTexts(".explorer-pane.active .entry-name");
      const inactive = await domTexts(".explorer-pane:not(.active) .entry-name");
      return active.includes("second-external.txt") && inactive.includes("first-external.txt");
    }, { timeout: 25_000, timeoutMsg: "restored and surviving panes did not observe their own changes" });
  });

  it("the restored SCM store observes real Git changes after the previous store is destroyed", async () => {
    async function openScm() {
      if (!(await $(".explorer-pane.active .scm-panel").isExisting())) {
        await browser.keys(["Alt", "m"]);
        await browser.keys("g");
      }
      await $(".explorer-pane.active .scm-panel").waitForExist();
      await browser.waitUntil(async () =>
        (await domTexts('.explorer-pane.active [data-section="untracked"] .file-name'))
          .includes("second-external.txt"));
    }
    await openScm();
    await browser.keys(["Control", "w"]);
    await browser.waitUntil(async () => await $$(".explorer-pane").length === 1);
    await browser.keys(["Control", "Shift", "t"]);
    await browser.waitUntil(async () => await $$(".explorer-pane").length === 2);
    await openScm();

    fs.writeFileSync(path.join(second, "second.txt"), "changed after SCM restoration");
    await browser.waitUntil(async () =>
      (await domTexts('.explorer-pane.active [data-section="changes"] .file-name')).includes("second.txt"),
    { timeout: 25_000, timeoutMsg: "the restored SCM store did not receive the native Git watcher change" });
  });
});
