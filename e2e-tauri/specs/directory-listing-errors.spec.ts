/** Native directory-listing failures must reach the visible Explorer state. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domText, entryNames, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-listing-error-"));
const restrictedDirectory = path.join(scratch, "permission-denied");
const marker = "permission-restored-marker.txt";
const restrictedMode = 0o000;
const restoredMode = 0o700;
const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

async function navigateAndWaitForAcknowledgement(target: string): Promise<void> {
  await browser.waitUntil(
    async () => await browser.execute(
      () => document.documentElement.dataset.e2eHooksReady === "true",
    ),
    { timeout: 15_000, timeoutMsg: "dev e2e hooks never became ready" },
  );

  const token = crypto.randomUUID();
  await browser.execute((directory: string, navigationToken: string) => {
    delete document.documentElement.dataset.e2eNavigationComplete;
    window.dispatchEvent(new CustomEvent("e2e-reset-view"));
    window.dispatchEvent(new CustomEvent("e2e-navigate", {
      detail: { path: directory, token: navigationToken },
    }));
  }, target, token);

  await browser.waitUntil(
    async () => await browser.execute(
      (navigationToken: string) =>
        document.documentElement.dataset.e2eNavigationComplete === navigationToken,
      token,
    ),
    {
      timeout: 25_000,
      timeoutMsg: `navigation to ${target} was not acknowledged`,
    },
  );
}

function runnerBypassesDirectoryPermissions(): boolean {
  try {
    fs.readdirSync(restrictedDirectory);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return false;
    throw error;
  }
}

linuxDescribe("directory listing errors against the real backend", () => {
  before(() => {
    fs.mkdirSync(restrictedDirectory);
    fs.writeFileSync(path.join(restrictedDirectory, marker), "permissions restored");
    // Prevent a persisted auto-enter preference from descending into the sole
    // child while establishing a known accessible starting location.
    fs.writeFileSync(path.join(scratch, "starting-location.txt"), "accessible");
  });

  after(() => {
    try {
      fs.chmodSync(restrictedDirectory, restoredMode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("identifies a missing navigation target while retaining the prior location", async () => {
    await navigateTo(scratch);
    const missing = path.join(scratch, "missing-target");
    await navigateAndWaitForAcknowledgement(missing);

    await $(".file-list .error-state").waitForDisplayed();
    expect(await domText(".file-list .error-message")).toContain(missing);
    expect(await $(".status-path").getAttribute("title")).toBe(scratch);
  });

  it("shows permission denial and recovers after access is restored", async function () {
    await navigateTo(scratch);
    let permissionsRestricted = false;

    try {
      fs.chmodSync(restrictedDirectory, restrictedMode);
      permissionsRestricted = true;
      if (runnerBypassesDirectoryPermissions()) {
        console.warn(JSON.stringify({
          case: "directory-permission-denial",
          skipped: "runner can read a chmod 000 directory",
          uid: process.getuid?.() ?? null,
        }));
        this.skip();
        return;
      }

      // Failed navigation intentionally may retain the previous status path,
      // so completion is correlated by the application acknowledgement only.
      await navigateAndWaitForAcknowledgement(restrictedDirectory);
      const errorState = $(".file-list .error-state");
      await errorState.waitForDisplayed();
      fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
      await browser.saveScreenshot(
        "screenshots/refactor/repo-health-cleanup/native-directory-permission-error.png",
      );
      expect(await domText(".file-list .error-title")).toBe("Unable to access folder");
      expect((await domText(".file-list .error-message")).toLowerCase())
        .toContain("permission denied");

      fs.chmodSync(restrictedDirectory, restoredMode);
      permissionsRestricted = false;
      await navigateTo(restrictedDirectory);
      await browser.waitUntil(
        async () => (await entryNames()).includes(marker),
        {
          timeout: 20_000,
          timeoutMsg: "marker did not appear after directory permissions were restored",
        },
      );
      expect(await entryNames()).toContain(marker);
    } finally {
      if (permissionsRestricted) {
        fs.chmodSync(restrictedDirectory, restoredMode);
      }
    }
  });
});
