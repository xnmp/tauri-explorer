import { browser, $ } from "@wdio/globals";
import path from "node:path";

/**
 * Navigate the active pane to `dir`.
 *
 * Uses the dev-only "e2e-navigate" hook instead of address-bar editing:
 * under Xvfb (no window manager) the breadcrumb path input blurs — and
 * cancels — the instant it opens, so typing into it is untestable there.
 */
export async function navigateTo(dir: string): Promise<void> {
  await browser.execute((target: string) => {
    window.dispatchEvent(new CustomEvent("e2e-navigate", { detail: target }));
  }, dir);
  await browser.waitUntil(
    async () => (await $(".breadcrumbs-container").getText()).includes(path.basename(dir)),
    { timeoutMsg: `breadcrumbs never showed ${dir}` },
  );
}
