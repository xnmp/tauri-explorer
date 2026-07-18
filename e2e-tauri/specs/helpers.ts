import { browser, $, $$ } from "@wdio/globals";

/**
 * Raw DOM textContent of the element(s) matching `selector`, joined.
 *
 * WebKitWebDriver's "Get Element Text" returns *rendered* text, which is
 * empty for elements clipped to zero width by `overflow:hidden` +
 * `white-space:nowrap` when they lack `flex:1` (e.g. the content-search
 * `.file-name` and the file-list `.entry-name`). textContent is the raw
 * DOM string and is immune to that, so assertions stay stable headless.
 */
export async function domText(selector: string): Promise<string> {
  const el = $(selector);
  return ((await el.getProperty("textContent")) as string | null) ?? "";
}

/** textContent of every match for `selector`, as an array. */
export async function domTexts(selector: string): Promise<string[]> {
  return await $$(selector).map(
    async (el) => ((await el.getProperty("textContent")) as string | null) ?? "",
  );
}

/** Visible file/folder names in the active listing (CSS-clip-immune). */
export async function entryNames(): Promise<string[]> {
  return await domTexts(".entry-item .entry-name");
}

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
  // Close any commit graph restored from a prior spec's persisted state before
  // waiting for the listing. localStorage is shared across every tauri-driver
  // session (same origin), so a spec that left the graph open would relaunch
  // this one into graph mode and `.file-list` would never render (#447). The
  // pane's onMount registers the hook, so re-dispatch on every poll until the
  // listing appears — a single early dispatch can race listener registration.
  await browser.waitUntil(
    async () => {
      await browser.execute(() => {
        window.dispatchEvent(new CustomEvent("e2e-reset-view"));
      });
      return await $(".file-list").isExisting();
    },
    { timeout: 15_000, timeoutMsg: "file listing never rendered (graph stuck open?)" },
  );
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
