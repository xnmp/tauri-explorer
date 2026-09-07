/** Native destruction must reclaim an acknowledged lease with no JS cleanup. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-watch-owner-"));
const repository = path.join(scratch, "repository");
const reloadRepository = (generation: number) => path.join(scratch, `reload-repository-${generation}`);
let mainHandle: string;

async function operation(op: string, target?: string): Promise<unknown> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

function readLogs(directory: string): string {
  return fs.readdirSync(directory).filter(name => name.endsWith(".log"))
    .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
}

describe("Git observation native window ownership", () => {
  before(() => {
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", ["init", "--quiet", reloadRepository(0)]);
    fs.writeFileSync(path.join(scratch, "survivor.txt"), "main window stays usable");
  });
  after(async () => {
    if (mainHandle) {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === mainHandle) continue;
        await browser.switchToWindow(handle);
        await browser.closeWindow();
      }
      await browser.switchToWindow(mainHandle);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("drops a leaked native observation when its source window is destroyed", async () => {
    await navigateTo(scratch);
    mainHandle = await browser.getWindowHandle();
    const opened = await operation("warm-open", scratch) as { label: string };
    expect(typeof opened.label).toBe("string");
    let childHandle = "";
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === opened.label) {
          childHandle = handle;
          return true;
        }
      }
      return false;
    }, { timeout: 20_000, timeoutMsg: "child window never became usable" });
    await $(".file-list").waitForExist();
    const { lease, logDir } = await operation("watch-acquire", repository) as {
      lease: { id: string; repoRoot: string }; logDir: string;
    };
    expect(lease.id).toMatch(/^\d+$/);
    const reclamation = `Reclaimed Git observation for closed native owner: ${lease.repoRoot}`;
    expect(readLogs(logDir)).not.toContain(reclamation);
    // Dispatch once. Destruction removes the DOM before an IPC result can be
    // published, and bypasses the app's ordinary frontend close/lease cleanup.
    await browser.execute(() => {
      window.dispatchEvent(new CustomEvent("e2e-window-operation", {
        detail: { token: "destroy-watch-owner", op: "native-destroy" },
      }));
    });
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle),
      { timeout: 20_000, timeoutMsg: "native owner window did not disappear" });
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(() => readLogs(logDir).includes(reclamation),
      { timeout: 10_000, timeoutMsg: "native destruction left its acknowledged Git observer retained" });
    // App shutdown would also release resources; the surviving window must
    // still accept real navigation and render a new directory listing.
    await navigateTo(repository);
    await navigateTo(scratch);
    expect(await domTexts(".entry-name")).toContain("survivor.txt");
  });

  it("reclaims an abandoned renderer lease when the same native window reloads", async () => {
    await navigateTo(scratch);
    mainHandle = await browser.getWindowHandle();
    let acquired = await operation("watch-acquire", reloadRepository(0)) as {
      lease: { id: string; repoRoot: string }; logDir: string;
    };
    for (let cycle = 0; cycle < 2; cycle++) {
      const { lease, logDir } = acquired;
      const reclamation = `Reclaimed Git observation for closed native owner: ${lease.repoRoot}`;
      const count = () => readLogs(logDir).split(reclamation).length - 1;
      const before = count();
      // The probe deliberately has no frontend cleanup. Reload destroys its JS
      // realm while keeping the native window and application process alive.
      await browser.refresh();
      await navigateTo(scratch);
      expect(await browser.getWindowHandle()).toBe(mainHandle);
      expect(await domTexts(".entry-name")).toContain("survivor.txt");
      await browser.waitUntil(() => count() > before, {
        timeout: 10_000, timeoutMsg: "reload retained the previous renderer's Git observation",
      });
      const currentRepository = reloadRepository(cycle + 1);
      execFileSync("git", ["init", "--quiet", currentRepository]);
      acquired = await operation("watch-acquire", currentRepository) as {
        lease: { id: string; repoRoot: string }; logDir: string;
      };
      expect(acquired.lease.id).toMatch(/^\d+$/);
      const mutationStartedAt = Date.now();
      fs.writeFileSync(path.join(currentRepository, `observed-after-reload-${cycle + 1}.txt`), String(cycle));
      await browser.waitUntil(async () => {
        const changes = await browser.execute(() =>
          JSON.parse(document.documentElement.dataset.e2eGitChanges ?? "[]") as {
            repoRoot: string; source: string; receivedAt: number;
          }[]);
        return changes.some(change => change.repoRoot === acquired.lease.repoRoot
          && change.source === "watcher" && change.receivedAt >= mutationStartedAt);
      }, { timeout: 20_000, timeoutMsg: `renderer ${cycle + 1} did not receive the real Git mutation` });
      await navigateTo(currentRepository);
      expect(await domTexts(".entry-name")).toContain(`observed-after-reload-${cycle + 1}.txt`);
    }
    // Visual evidence establishes post-reload usability; reclamation itself is
    // established by the acknowledgements and worker log above, not this image.
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-renderer-reload.png");
  });
});
