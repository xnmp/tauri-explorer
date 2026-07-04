import { browser, $ } from "@wdio/globals";

/**
 * Warm-window pool, end-to-end against the real Tauri binary.
 *
 * WebDriver window handles include HIDDEN webview windows, which is exactly
 * what makes the pool observable here:
 *   boot            → 2 handles (main + parked warm window)
 *   Ctrl+N          → 3 handles (main + activated warm + replenished warm)
 *   close main      → activated window MUST survive
 *
 * The last step is the regression test for the label-lifecycle bug: activated
 * warm windows keep their `explorer-warm-` label, and the run-loop's
 * "close parked warm windows when the last real window closes" logic used to
 * classify them by label alone — closing the original window then destroyed
 * the user's freshly opened window and exited the app.
 *
 * Assumes settings.warmWindow is on (the default; CI has no user config).
 */

async function currentLabel(): Promise<string> {
  return await browser.execute(
    () =>
      (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
        .__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "",
  );
}

async function labelledHandles(): Promise<Map<string, string>> {
  const byLabel = new Map<string, string>();
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle);
    byLabel.set(await currentLabel(), handle);
  }
  return byLabel;
}

describe("warm-window pool", () => {
  let mainHandle: string;
  let firstWarmHandle: string;

  it("primes a hidden warm window shortly after boot", async () => {
    await $(".file-list").waitForExist({ timeout: 15_000 });

    // Priming is deferred ~1.5s after mount, then the warm window boots.
    // A window HANDLE appears before __TAURI_INTERNALS__ is injected into
    // its webview, so poll until the warm label is actually readable —
    // a single-shot label query right after handle-count races boot.
    let byLabel = new Map<string, string>();
    await browser.waitUntil(
      async () => {
        byLabel = await labelledHandles();
        return [...byLabel.keys()].some((l) => l.startsWith("explorer-warm-"));
      },
      { timeout: 20_000, timeoutMsg: "warm window never spawned" },
    );
    mainHandle = byLabel.get("main")!;
    expect(mainHandle).toBeDefined();
    const warm = [...byLabel.keys()].find((l) => l.startsWith("explorer-warm-"));
    expect(warm).toBeDefined();
    firstWarmHandle = byLabel.get(warm!)!;

    await browser.switchToWindow(mainHandle);
  });

  it("Ctrl+N activates the parked warm window and replenishes the pool", async () => {
    await browser.keys(["Control", "n"]);

    // The claim consumes the parked window (it becomes the visible new
    // window) and a replacement warm window spawns: 3 handles total.
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length >= 3,
      { timeout: 20_000, timeoutMsg: "Ctrl+N never produced a new window + replenished pool" },
    );

    // The activated window IS the pre-existing warm handle — and it must be
    // a fully working explorer window, not just an existing handle.
    const handles = await browser.getWindowHandles();
    expect(handles).toContain(firstWarmHandle);
    await browser.switchToWindow(firstWarmHandle);
    await $(".file-list").waitForExist({ timeout: 15_000 });
  });

  it("keeps the activated window alive when the original window closes", async () => {
    await browser.switchToWindow(mainHandle);
    await browser.closeWindow();

    // Give the run-loop's Destroyed handling time to (wrongly) cascade.
    await browser.pause(2000);

    const handles = await browser.getWindowHandles();
    expect(handles).toContain(firstWarmHandle);

    // And it's still a live, functional window — the app must not be exiting.
    await browser.switchToWindow(firstWarmHandle);
    await $(".file-list").waitForExist({ timeout: 10_000 });
  });
});
