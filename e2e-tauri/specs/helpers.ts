import { browser, $ } from "@wdio/globals";

/**
 * Navigate the active pane to `dir`.
 *
 * Uses the dev-only "e2e-navigate" hook instead of address-bar editing:
 * under Xvfb (no window manager) the breadcrumb path input blurs — and
 * cancels — the instant it opens, so typing into it is untestable there.
 *
 * Confirmation reads the status bar's full-path title attribute — the
 * breadcrumbs apply p10k-style truncation, so long directory names never
 * appear in them verbatim.
 */
export async function navigateTo(dir: string): Promise<void> {
  // App must be initialized before the hook exists.
  await $(".file-list").waitForExist({ timeout: 15_000 });
  // Re-dispatch on every poll: a single dispatch can race listener
  // registration in onMount and then nothing would ever navigate.
  await browser.waitUntil(
    async () => {
      await browser.execute((target: string) => {
        window.dispatchEvent(new CustomEvent("e2e-navigate", { detail: target }));
      }, dir);
      return (await $(".status-path").getAttribute("title")) === dir;
    },
    { timeoutMsg: `status bar never showed ${dir}` },
  );
}
