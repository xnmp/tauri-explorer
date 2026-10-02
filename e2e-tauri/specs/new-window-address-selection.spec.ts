import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, parkedWarmWindow, switchToWindowLabel, windowOperation, entryPathSelector } from "./helpers";
const proof = "screenshots/test/820-highlight-address-bar-on-making-new-window";
let scratch: string;
let source: string;
let requested: string;
let replacement: string;
let owner: string;
let childLabel: string | undefined;
let childHandle: string | undefined;
function xdotool(args: string[]): string {
  try { return execFileSync("xdotool", args, { encoding: "utf8" }); }
  catch (error) {
    const failure = error as { message: string; code?: string; stdout?: string; stderr?: string };
    throw new Error(`xdotool ${args.join(" ")}: ${failure.message}; code=${failure.code}; stdout=${failure.stdout}; stderr=${failure.stderr}`);
  }
}
function nativeActive() {
  const line = execFileSync("xprop", ["-root", "_NET_ACTIVE_WINDOW"], { encoding: "utf8" });
  const id = line.match(/0x[0-9a-f]+/i)?.[0];
  if (!id || id === "0x0") throw new Error(`No native active window: ${line}`);
  const title = execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" });
  return { id, title };
}
async function selection() {
  return browser.execute(() => {
    const input = document.querySelector<HTMLInputElement>(".path-input");
    return input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd, active: input === document.activeElement } : null;
  });
}
async function assertChild(label: string, initial: string, previous: ReturnType<typeof nativeActive>, name: string, ownedHandle?: string, lateValidation?: { token: string; entry: string }) {
  // Native focus is observed before changing WebDriver's selected window.
  await browser.waitUntil(() => {
    const active = nativeActive();
    return active.id !== previous.id && active.title.includes(`${path.basename(initial)} - Tauri Explorer`);
  }, { timeout: 15_000, timeoutMsg: `${name} did not receive native focus` });
  const active = nativeActive();
  if (ownedHandle) {
    const state = await windowOperation("target-state", label) as { visible: boolean };
    expect(state.visible).toBe(true);
    await browser.switchToWindow(ownedHandle);
  } else await switchToWindowLabel(label);
  childHandle = await browser.getWindowHandle();
  await $(".path-input").waitForDisplayed({ timeout: 20_000 });
  await browser.waitUntil(async () => {
    const selected = await selection();
    return selected?.active === true && selected.value === initial && selected.start === 0 && selected.end === initial.length;
  }, { timeoutMsg: `${name} did not select its complete requested path` });
  expect(nativeActive().id).toBe(active.id);
  fs.mkdirSync(proof, { recursive: true });
  await browser.saveScreenshot(`${proof}/${name}-complete-path-selected.png`);
  if (lateValidation) await expect($(entryPathSelector(lateValidation.entry))).not.toBeDisplayed();
  // Real key input replaces the native selection; do not setValue or select it here.
  const typing = browser.action("key");
  for (const character of replacement) typing.down(character).up(character);
  await typing.perform();
  expect((await selection())?.value).toBe(replacement);
  if (lateValidation) {
    await browser.execute((token: string) => window.dispatchEvent(new CustomEvent("e2e-launch-listing-release", { detail: { token } })), lateValidation.token);
    await expect($(entryPathSelector(lateValidation.entry))).toBeDisplayed();
    expect(await selection()).toEqual({ value: replacement, start: replacement.length, end: replacement.length, active: true });
    expect(nativeActive().id).toBe(active.id);
    await browser.saveScreenshot(`${proof}/${name}-late-reply-preserved-typing.png`);
  }
  await browser.keys("Enter");
  await expect($(".status-path")).toHaveAttribute("title", replacement);
  await expect($(entryPathSelector(path.join(replacement, "replacement-proof.txt")))).toBeDisplayed();
  await browser.saveScreenshot(`${proof}/${name}-typed-directory-navigated.png`);
  await browser.keys(["Control", "l"]);
  await $(".path-input").waitForDisplayed();
  await browser.keys("Escape");
  await expect($(".path-input")).not.toBeDisplayed();
  await browser.switchToWindow(owner);
  await expect($(".status-path")).toHaveAttribute("title", source);
  await expect($(entryPathSelector(path.join(source, "origin-proof.txt")))).toHaveElementClass("selected");
  await windowOperation("native-close", label);
  await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle!), { timeoutMsg: "closed child handle survived" });
  childLabel = undefined;
  childHandle = undefined;
  console.log(JSON.stringify({ name, nativeActive: active, initial, selectedRange: [0, initial.length], replacement }));
}
async function armListing(label: string, token: string, targetPath: string): Promise<void> {
  await browser.execute((label: string, token: string, targetPath: string) => {
    localStorage.setItem(`e2e-launch-listing-gate:${label}`, JSON.stringify({ token, targetPath }));
  }, label, token, targetPath);
}
async function waitGate(label: string, token: string, status: string): Promise<void> {
  await browser.waitUntil(async () => browser.execute((label: string, token: string, status: string) => {
    const raw = localStorage.getItem(`e2e-launch-listing-receipt:${label}`);
    const receipt = raw ? JSON.parse(raw) : null;
    return receipt?.token === token && receipt?.status === status;
  }, label, token, status), { timeout: 15_000, timeoutMsg: `exact ${label}/${token} listing did not become ${status}` });
}
async function dispatchLaunch(op: string, token: string, target: string, seedOmit?: string): Promise<void> {
  // Dispatch once without blocking WebDriver in executeAsync while a reply is held.
  await browser.execute((op: string, token: string, target: string, seedOmit?: string) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail: { op, token, target, seedOmit } }));
  }, op, token, target, seedOmit);
}
async function launchResult(token: string): Promise<{ kind: string; label: string }> {
  await browser.waitUntil(async () => browser.execute((token: string) => {
    return JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}").token === token;
  }, token), { timeoutMsg: "held launch did not settle" });
  const reply = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
  expect(reply.error).toBeUndefined();
  return reply.result;
}
(process.platform === "linux" ? describe : describe.skip)("new native window address selection (#820)", () => {
  before(async () => {
    if (process.platform !== "linux" || !process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND !== "x11") throw new Error("Run this native-focus fixture on a private Linux X11 display");
    scratch = createNativeFixtureDirectory("address-selection-");
    source = path.join(scratch, "origin");
    requested = path.join(scratch, "requested");
    replacement = path.join(scratch, "replacement");
    for (const directory of [source, requested, replacement]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(source, "origin-proof.txt"), "origin stays unchanged");
    fs.writeFileSync(path.join(source, "late-validation-proof.txt"), "real listing validation marker");
    fs.writeFileSync(path.join(requested, "requested-proof.txt"), "requested directory");
    fs.writeFileSync(path.join(replacement, "replacement-proof.txt"), "typed directory");
    // Wait for restored tabs to mount before counting; the initial DOM can be empty.
    await navigateTo(source);
    // A preceding native spec or restored private profile may leave several tabs.
    // Establish the one-tab fixture through normal UI actions before measuring detach.
    while (await browser.execute(() => document.querySelectorAll(".tab-list > .tab").length > 1)) {
      const count = await browser.execute(() => document.querySelectorAll(".tab-list > .tab").length);
      await browser.keys(["Control", "w"]);
      await browser.waitUntil(async () => browser.execute((previous: number) => document.querySelectorAll(".tab-list > .tab").length < previous, count));
    }
    await navigateTo(source);
    await $(entryPathSelector(path.join(source, "origin-proof.txt"))).click();
    owner = await browser.getWindowHandle();
  });
  afterEach(async () => {
    if (!owner) return;
    await browser.switchToWindow(owner);
    if (childLabel) {
      await windowOperation("native-close", childLabel);
      if (childHandle) await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle!), { timeoutMsg: "failed child cleanup left its handle alive" });
      childLabel = undefined;
      childHandle = undefined;
    }
  });
  for (const kind of ["fresh", "warm"] as const) it(`${kind} launch selects its requested path before immediate typing`, async () => {
    const parked = kind === "warm" ? await parkedWarmWindow() : undefined;
    const previous = nativeActive();
    const opened = await windowOperation(kind === "fresh" ? "fresh-open" : "warm-open", requested) as { kind: string; label: string };
    childLabel = opened.label;
    expect(opened.kind).toBe(kind);
    if (parked) expect(opened.label).toBe(parked.label);
    await assertChild(opened.label, requested, previous, kind, parked?.handle);
  });
  for (const entrypoint of ["shortcut", "palette"] as const) it(`the actual New Window ${entrypoint} selects its inherited path`, async () => {
    const warm = await parkedWarmWindow();
    const previous = nativeActive();
    childLabel = warm.label;
    if (entrypoint === "shortcut") await browser.keys(["Control", "n"]);
    else {
      await browser.keys(["Control", "Shift", "p"]);
      await $(".command-palette-dialog .search-input").setValue("New Window");
      const command = $(".command-palette-dialog .command-item");
      expect(await command.$(".command-label").getProperty("textContent")).toBe("New Window");
      await command.click();
    }
    await assertChild(warm.label, source, previous, entrypoint === "shortcut" ? "ctrl-n" : "palette", warm.handle);
  });
  it("an unseeded fresh child waits for its real first response before selecting the address", async () => {
    const token = crypto.randomUUID();
    childLabel = `explorer-${token}`;
    await armListing(childLabel, token, requested);
    const previous = nativeActive();
    const opened = await windowOperation("fresh-open", requested, token) as { kind: string; label: string };
    expect(opened).toMatchObject({ kind: "fresh", label: childLabel });
    await waitGate(childLabel, token, "held");
    await browser.waitUntil(() => nativeActive().id !== previous.id);
    await switchToWindowLabel(childLabel);
    childHandle = await browser.getWindowHandle();
    await expect($(".path-input")).not.toBeDisplayed();
    await expect($(entryPathSelector(path.join(requested, "requested-proof.txt")))).not.toBeDisplayed();
    await browser.execute((token: string) => window.dispatchEvent(new CustomEvent("e2e-launch-listing-release", { detail: { token } })), token);
    await assertChild(childLabel, requested, previous, "fresh-first-response", childHandle);
  });
  it("late real validation in a seeded fresh child preserves immediate typing and its caret", async () => {
    const token = crypto.randomUUID();
    childLabel = `explorer-${token}`;
    const marker = path.join(source, "late-validation-proof.txt");
    await expect($(entryPathSelector(marker))).toBeDisplayed();
    await armListing(childLabel, token, source);
    const previous = nativeActive();
    await dispatchLaunch("fresh-open", token, source, "late-validation-proof.txt");
    const opened = await launchResult(token);
    expect(opened).toMatchObject({ kind: "fresh", label: childLabel });
    await waitGate(childLabel, token, "held");
    await assertChild(childLabel, source, previous, "fresh-late-validation", undefined, { token, entry: marker });
  });
  it("a parked warm child completes held real navigation before reveal, focus and selection", async () => {
    const parked = await parkedWarmWindow();
    const token = crypto.randomUUID();
    childLabel = parked.label;
    await armListing(parked.label, token, requested);
    await waitGate(parked.label, token, "armed");
    const previous = nativeActive();
    await dispatchLaunch("warm-open", token, requested);
    await waitGate(parked.label, token, "held");
    expect(nativeActive().id).toBe(previous.id);
    // The parent releases by exact label/token without scripting the parked webview.
    await browser.execute((label: string, token: string) => localStorage.setItem(`e2e-launch-listing-release:${label}`, token), parked.label, token);
    const opened = await launchResult(token);
    expect(opened).toMatchObject({ kind: "warm", label: parked.label });
    await assertChild(parked.label, requested, previous, "warm-held-navigation", parked.handle);
  });
  for (const gesture of ["vertical", "desktop"] as const) it(`the actual ${gesture} tab tear-off selects the moved path and preserves the other tab`, async () => {
    await browser.keys(["Control", "t"]);
    await navigateTo(requested);
    await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll(".tab-list > .tab").length === 2));
    const existing = await windowOperation("window-states") as Array<{ label: string; visible: boolean }>;
    await browser.setWindowSize(900, 600);
    const previous = nativeActive();
    xdotool(["windowmove", previous.id, "100", "100"]);
    const geometry = xdotool(["getwindowgeometry", "--shell", previous.id]);
    const originX = Number(geometry.match(/^X=(\d+)$/m)?.[1]);
    const originY = Number(geometry.match(/^Y=(\d+)$/m)?.[1]);
    const tab = await browser.execute(() => {
      const rect = document.querySelector(".tab-list > .tab.active")!.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    });
    const x = originX + tab.x, y = originY + tab.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("private test window geometry unavailable");
    xdotool(["mousemove", "--sync", String(x), String(y), "mousedown", "1"]);
    try {
      xdotool(["mousemove", "--sync", String(gesture === "vertical" ? x + 15 : 1500), String(gesture === "vertical" ? y + 100 : y)]);
      if (gesture === "vertical") await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll(".tab-list > .tab").length === 1));
    } finally { xdotool(["mouseup", "1"]); }
    await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll(".tab-list > .tab").length === 1));
    const current = await windowOperation("window-states") as Array<{ label: string; visible: boolean }>;
    const opened = current.filter(item => item.visible && !existing.some(before => before.label === item.label));
    expect(opened).toHaveLength(1);
    childLabel = opened[0].label;
    await assertChild(childLabel, requested, previous, `tear-off-${gesture}`);
  });
  it("the actual closed-window restore shortcut selects the recovered window path", async () => {
    const opened = await windowOperation("fresh-open", requested) as { label: string };
    childLabel = opened.label;
    await switchToWindowLabel(opened.label);
    childHandle = await browser.getWindowHandle();
    await $(".path-input").waitForDisplayed();
    await browser.keys("Escape");
    await $(".path-input").waitForDisplayed({ reverse: true });
    // Native input retires this webview before a WebDriver actions reply can finish.
    // Send the trusted chord outside that retiring driver context, then observe closure.
    xdotool(["key", "--clearmodifiers", "ctrl+w"]);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle!));
    childLabel = undefined; childHandle = undefined;
    await browser.switchToWindow(owner);
    const warm = await parkedWarmWindow();
    const previous = nativeActive();
    childLabel = warm.label;
    await browser.keys(["Control", "Shift", "t"]);
    await assertChild(warm.label, requested, previous, "closed-window-restore", warm.handle);
  });

});
