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
async function assertChild(label: string, initial: string, previous: ReturnType<typeof nativeActive>, name: string, ownedHandle?: string) {
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
  // Real key input replaces the native selection; do not setValue or select it here.
  const typing = browser.action("key");
  for (const character of replacement) typing.down(character).up(character);
  await typing.perform();
  expect((await selection())?.value).toBe(replacement);
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
(process.platform === "linux" ? describe : describe.skip)("new native window address selection (#820)", () => {
  before(async () => {
    if (process.platform !== "linux" || !process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND !== "x11") throw new Error("Run this native-focus fixture on a private Linux X11 display");
    scratch = createNativeFixtureDirectory("address-selection-");
    source = path.join(scratch, "origin");
    requested = path.join(scratch, "requested");
    replacement = path.join(scratch, "replacement");
    for (const directory of [source, requested, replacement]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(source, "origin-proof.txt"), "origin stays unchanged");
    fs.writeFileSync(path.join(requested, "requested-proof.txt"), "requested directory");
    fs.writeFileSync(path.join(replacement, "replacement-proof.txt"), "typed directory");
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
});
