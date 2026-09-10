/** A crashed WebKit renderer must retire its acknowledged native resource leases. */
import { browser } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo } from "./helpers";
import { exactApplicationPid, isolatedProcessEnvironment, terminateRendererDescendants } from "../native-process";
import { inotifyWatchesForPath, nativeProcessIdentity } from "../native-resources";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-renderer-crash-"));
const repository = path.join(scratch, "repository");
const rawDirectory = path.join(scratch, "raw-directory");

async function operation(op: string, target?: string): Promise<unknown> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() =>
      JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

function readLogs(directory: string): string {
  return fs.readdirSync(directory).filter(name => name.endsWith(".log"))
    .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n");
}

(process.platform === "linux" ? describe : describe.skip)("Git observation renderer crash ownership", () => {
  before(() => {
    execFileSync("git", ["init", "--quiet", repository]);
    fs.mkdirSync(rawDirectory);
    fs.writeFileSync(path.join(rawDirectory, "retained.txt"), "raw directory watch fixture");
  });
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("reclaims an acknowledged lease when the renderer crashes", async () => {
    await navigateTo(scratch);
    const { lease, logDir } = await operation("watch-acquire", repository) as {
      lease: { id: string; repoRoot: string }; logDir: string;
    };
    expect(lease.id).toMatch(/^\d+$/);
    const reclamation = `Reclaimed Git observation for retired ownership: ${lease.repoRoot}`;
    const count = () => readLogs(logDir).split(reclamation).length - 1;

    const directoryLease = await operation("directory-watch-acquire", rawDirectory) as {
      id: string; path: string;
    };
    expect(directoryLease.path).toBe(rawDirectory);
    expect(directoryLease.id).not.toBe("");

    const before = count();
    const applicationPid = exactApplicationPid();
    const application = nativeProcessIdentity(applicationPid);
    const descriptorBefore = inotifyWatchesForPath(application, rawDirectory);
    expect(descriptorBefore.length).toBeGreaterThan(0);
    const renderers = terminateRendererDescendants(applicationPid, isolatedProcessEnvironment(process.env));
    process.kill(applicationPid, 0);

    // Do not issue a DOM/WebDriver command after the renderer is blank.
    // WebKitWebDriver deletes its session on a renderer crash, so this test can
    // prove native cleanup and application survival but cannot drive recovery.
    await browser.waitUntil(() => {
      process.kill(applicationPid, 0);
      return count() > before;
    }, {
      timeout: 10_000,
      timeoutMsg: `renderer crash retained the acknowledged Git observer (${renderers.join(",")})`,
    });
    await browser.waitUntil(() => {
      process.kill(applicationPid, 0);
      return inotifyWatchesForPath(application, rawDirectory).length === 0;
    }, {
      timeout: 10_000,
      timeoutMsg: "renderer crash retained the acknowledged directory watch",
    });
    expect(fs.existsSync(rawDirectory)).toBe(true);
    const retained = inotifyWatchesForPath(application, rawDirectory);
    expect(retained).toHaveLength(0);
    process.kill(applicationPid, 0);
    console.log(JSON.stringify({
      case: "directory-watch-renderer-crash",
      path: rawDirectory,
      lease: directoryLease,
      descriptorBefore: descriptorBefore.map(({ fd, watchDescriptor }) => ({
        fd,
        watchDescriptor: watchDescriptor.toString(16),
      })),
      retained: 0,
    }));
  });
});
