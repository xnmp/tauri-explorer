/** Real warm reservation, activation ACK/fallback and abandoned-claim expiry. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import path from "node:path";
import { domTexts, navigateTo, parkedWarmWindow, switchToWindowLabel } from "./helpers";
import { monitorWarmClaimExpiry } from "../diagnostics/warm-claim";
import { createNativeFixtureDirectory } from "../native-qualification";

const scratch = createNativeFixtureDirectory("explorer-warm-lifetime-");
const requested = path.join(scratch, "requested");
let mainHandle: string;
let survivor: string;

async function operation(op: string, target?: string): Promise<any> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail })), { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 20_000, timeoutMsg: `${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

async function listingHas(name: string) {
  await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes(name), { timeout: 15_000, timeoutMsg: `listing missing ${name}` });
}

describe("warm window lifetime", () => {
  before(async () => {
    fs.mkdirSync(requested);
    fs.writeFileSync(path.join(scratch, "source.txt"), "source");
    fs.writeFileSync(path.join(requested, "requested.txt"), "requested");
    await navigateTo(scratch);
    mainHandle = await browser.getWindowHandle();
  });

  it("returns the warm destination after it reveals the requested real directory", async () => {
    await operation("warm-prime");
    const parked = await parkedWarmWindow();
    const opened = await operation("warm-open", requested);
    expect(opened).toEqual({ kind: "warm", label: parked.label });
    survivor = parked.handle;
    await browser.switchToWindow(survivor);
    await listingHas("requested.txt");
    expect(await $(".status-path").getAttribute("title")).toBe(requested);
    await navigateTo(scratch);
    await listingHas("source.txt");
    await browser.switchToWindow(mainHandle);
    await listingHas("source.txt");
  });

  it("retires rejected warm navigation and falls back to a fresh destination", async () => {
    const parked = await parkedWarmWindow([survivor]);
    const opened = await operation("warm-open", path.join(scratch, "missing"));
    expect(opened.kind).toBe("fresh");
    expect(opened.label).not.toBe(parked.label);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(parked.handle), { timeout: 10_000, timeoutMsg: "rejected warm destination leaked" });
    await switchToWindowLabel(opened.label);
    await $(".explorer-pane .error-state").waitForDisplayed({ timeout: 15_000 });
    await browser.switchToWindow(mainHandle);
    await listingHas("source.txt");
  });

  it("expires an undispatched claim after its source window dies", async () => {
    await operation("warm-prime");
    const parked = await parkedWarmWindow([survivor]);
    expect(await operation("warm-claim")).toBe(parked.label);
    await monitorWarmClaimExpiry({
      sourceHandle: mainHandle,
      survivorHandle: survivor,
      parkedHandle: parked.handle,
      parkedLabel: parked.label,
    }, async (mark) => {
      mark("source-close-requested");
      try { await $("button[aria-label='Close']").click(); }
      catch (error) { if (!String(error).includes("no such window")) throw error; }
      mark("source-close-command-settled");
      await browser.switchToWindow(survivor);
      mark("survivor-selected");
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(mainHandle), { timeout: 10_000 });
      mark("source-handle-gone");
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(parked.handle), { timeout: 40_000, timeoutMsg: "abandoned warm claim remained alive" });
      mark("parked-handle-gone");
    });
    fs.writeFileSync(path.join(scratch, "survived-claim-expiry.txt"), "watcher");
    await listingHas("survived-claim-expiry.txt");
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-warm-lifetime.png");
  });
});
