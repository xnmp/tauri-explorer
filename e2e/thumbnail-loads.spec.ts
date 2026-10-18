/**
 * Thumbnail loads outlive their tile (#1241 review): a tile that scrolls out of
 * a virtual list unmounts while its requests are in flight. The responses must
 * still reach the shared cache, and a remount must join a load still in flight,
 * so scrolling away and back never asks the backend for a thumbnail twice. Runs
 * in classic Tiles (Folder Peek off) and the panels renderer (on).
 */
import { test, expect } from "./fixtures";
import { seedSettings } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const DIR = "/perf/images-400";
const LATENCY = 700;
const COMMANDS = ["get_micro_thumbnail", "get_thumbnail_data"] as const;

for (const folderPeek of [false, true]) {
  test(`scrolling away and back mid-load requests no thumbnail twice (Folder Peek ${folderPeek ? "on" : "off"})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await seedSettings(page, { folderPeek });
    await page.addInitScript((commands) => {
      ((globalThis as { __mockControl?: MockControl }).__mockControl ??= {}).invokeArgs = Object.fromEntries(commands.map(name => [name, []]));
    }, [...COMMANDS]);
    await page.goto(`/?path=${DIR}&viewMode=tiles&mockLatency=${COMMANDS.map(name => `${name}:${LATENCY}`).join(",")}`);
    const scroller = page.locator(".pane-tree:not(.retained) .virtual-viewport").first();
    await expect(page.locator(".pane-tree:not(.retained) .entry-item").first()).toBeVisible();
    const log = () => page.evaluate((commands) => {
      const args = (globalThis as { __mockControl?: MockControl }).__mockControl!.invokeArgs!;
      return Object.fromEntries(commands.map(name => [name, args[name].map(call => String(call.path))]));
    }, [...COMMANDS]);
    // The first screen's micro requests are in flight (none has answered yet).
    await expect.poll(async () => (await log()).get_micro_thumbnail.length).toBeGreaterThanOrEqual(8);
    expect((await log()).get_thumbnail_data).toHaveLength(0);
    // Away (the top tiles unmount mid-request) and back.
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(250);
    await scroller.evaluate(el => { el.scrollTop = 0; });
    // Every tile on screen ends with its full thumbnail.
    await expect.poll(() => page.evaluate(() => {
      const port = document.querySelector(".pane-tree:not(.retained) .virtual-viewport")!.getBoundingClientRect();
      const tiles = [...document.querySelectorAll<HTMLElement>(".pane-tree:not(.retained) .thumbnail-container")].filter(el => {
        const r = el.getBoundingClientRect();
        return r.bottom > port.top && r.top < port.bottom;
      });
      return tiles.length > 0 && tiles.every(el => el.querySelector("img.thumbnail-full.loaded"));
    }), { timeout: 15_000 }).toBe(true);
    const calls = await log();
    for (const name of COMMANDS) {
      const twice = calls[name].filter((path, i) => calls[name].indexOf(path) !== i);
      expect(twice, `${name} asked twice`).toEqual([]);
    }
  });
}
