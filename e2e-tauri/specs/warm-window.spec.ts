import { browser, $ } from "@wdio/globals";
import { parkedWarmWindow, windowOperation } from "./helpers";

/**
 * Warm-window pool, end-to-end against the real Tauri binary.
 *
 *   boot            → main + a parked warm window that registers with the pool
 *   Ctrl+N          → that warm window is revealed, and a replacement parks
 *   close main      → activated window MUST survive
 *
 * The last step is the regression test for the label-lifecycle bug: activated
 * warm windows keep their `explorer-warm-` label, and the run-loop's
 * "close parked warm windows when the last real window closes" logic used to
 * classify them by label alone — closing the original window then destroyed
 * the user's freshly opened window and exited the app.
 *
 * Parked pages are never scripted (#931): `parkedWarmWindow` reads their
 * registration through the main window and their handle from their URL.
 *
 * Assumes settings.warmWindow is on (the default; CI has no user config).
 */

describe("warm-window pool", () => {
  let mainHandle: string;
  let warm: { label: string; handle: string };

  it("primes a hidden warm window shortly after boot", async () => {
    await $(".file-list").waitForExist({ timeout: 15_000 });
    mainHandle = await browser.getWindowHandle();
    // Priming is deferred ~1.5s after mount; registration follows its boot.
    warm = await parkedWarmWindow();
  });

  it("Ctrl+N activates the parked warm window and replenishes the pool", async () => {
    await browser.keys(["Control", "n"]);

    // The claimed warm window itself is revealed: a fresh-window fallback
    // would leave it hidden.
    await browser.waitUntil(async () => {
      const state = await windowOperation("target-state", warm.label) as { visible?: boolean };
      return state.visible === true;
    }, { timeout: 20_000, timeoutMsg: "Ctrl+N did not reveal the parked warm window" });
    const replacement = await parkedWarmWindow([warm.handle]);
    expect(replacement.label).not.toBe(warm.label);

    // And it is a fully working explorer window, not just a visible handle.
    await browser.switchToWindow(warm.handle);
    await $(".file-list").waitForExist({ timeout: 15_000 });
  });

  it("keeps the activated window alive when the original window closes", async () => {
    await browser.switchToWindow(mainHandle);
    await browser.closeWindow();

    // Give the run-loop's Destroyed handling time to (wrongly) cascade.
    await browser.pause(2000);

    const handles = await browser.getWindowHandles();
    expect(handles).toContain(warm.handle);

    // And it's still a live, functional window — the app must not be exiting.
    await browser.switchToWindow(warm.handle);
    await $(".file-list").waitForExist({ timeout: 10_000 });
  });
});
