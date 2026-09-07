/** Real warm reservation, activation ACK/fallback and abandoned-claim expiry. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domTexts, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-warm-lifetime-"));
const requested = path.join(scratch, "requested");
const used = new Set<string>();
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

async function switchTo(label: string): Promise<string> {
  let found = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
        found = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 15_000, timeoutMsg: `${label} did not become ready` });
  return found;
}

async function parkedWindow(): Promise<{ label: string; handle: string }> {
  const original = await browser.getWindowHandle();
  let parked!: { label: string; handle: string };
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      const candidate = await browser.execute(() => ({ label: document.documentElement.dataset.e2eWindowLabel, ready: document.documentElement.dataset.e2eWarmReady }));
      if (candidate.ready === "1" && candidate.label && !used.has(candidate.label)) {
        parked = { label: candidate.label, handle };
        return true;
      }
    }
    return false;
  }, { timeout: 15_000, timeoutMsg: "warm pool did not become ready" });
  await browser.switchToWindow(original);
  return parked;
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
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("returns the warm destination after it reveals the requested real directory", async () => {
    await operation("warm-prime");
    const parked = await parkedWindow();
    const opened = await operation("warm-open", requested);
    expect(opened).toEqual({ kind: "warm", label: parked.label });
    used.add(parked.label);
    survivor = await switchTo(parked.label);
    await listingHas("requested.txt");
    expect(await $(".status-path").getAttribute("title")).toBe(requested);
    await navigateTo(scratch);
    await listingHas("source.txt");
    await browser.switchToWindow(mainHandle);
    await listingHas("source.txt");
  });

  it("retires rejected warm navigation and falls back to a fresh destination", async () => {
    const parked = await parkedWindow();
    const opened = await operation("warm-open", path.join(scratch, "missing"));
    expect(opened.kind).toBe("fresh");
    expect(opened.label).not.toBe(parked.label);
    used.add(parked.label);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(parked.handle), { timeout: 10_000, timeoutMsg: "rejected warm destination leaked" });
    await switchTo(opened.label);
    await $(".explorer-pane .error-state").waitForDisplayed({ timeout: 15_000 });
    await browser.switchToWindow(mainHandle);
    await listingHas("source.txt");
  });

  it("expires an undispatched claim after its source window dies", async () => {
    await operation("warm-prime");
    const parked = await parkedWindow();
    expect(await operation("warm-claim")).toBe(parked.label);
    used.add(parked.label);
    try { await $("button[aria-label='Close']").click(); }
    catch (error) { if (!String(error).includes("no such window")) throw error; }
    await browser.switchToWindow(survivor);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(mainHandle), { timeout: 10_000 });
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(parked.handle), { timeout: 40_000, timeoutMsg: "abandoned warm claim remained alive" });
    fs.writeFileSync(path.join(scratch, "survived-claim-expiry.txt"), "watcher");
    await listingHas("survived-claim-expiry.txt");
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-warm-lifetime.png");
  });
});
