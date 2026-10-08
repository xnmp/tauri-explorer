import { browser, $, $$ } from "@wdio/globals";
// Keep command types available to standalone fixture-contract tests too.
import type {} from "webdriverio";
import { beginFreshWindowLookup, beginFreshWindowSelection } from "../diagnostics/fresh-window";
import { isWarmWindowUrl, scanWindows, selectWindowByLabel, type WindowScanDriver } from "../owned-windows";
import {
  waitForWindowOperation, type RendererWaitResult, type WindowOperationResponse, type WindowOperationWaitRequest,
} from "../window-transfer-waits";

/** Exact entry selector for native paths, including Windows `\` and quotes. */
export function entryPathSelector(
  entryPath: string,
  scope = ".entry-item",
): string {
  const escaped = Array.from(entryPath, character => {
    const code = character.charCodeAt(0);
    if (character === "\\" || character === '"') return `\\${character}`;
    if (code === 0) return "\uFFFD";
    if (code <= 0x1f || code === 0x7f) return `\\${code.toString(16)} `;
    return character;
  }).join("");
  return `${scope}[data-path="${escaped}"]`;
}

/**
 * Wait for the first element of a freshly opened window. Session-loss
 * evidence is recorded on failure (#781); the existence contract and the
 * rejection are unchanged.
 */
export async function waitForFreshWindowElement(
  selector: string,
  timeout: number,
): Promise<void> {
  const evidence = beginFreshWindowLookup(selector, timeout);
  try {
    await $(selector).waitForExist({ timeout });
  } catch (error) {
    evidence.failed(error);
    throw error;
  } finally {
    evidence.stop();
  }
}

const windows: WindowScanDriver = {
  listHandles: () => browser.getWindowHandles(),
  switchTo: (handle) => browser.switchToWindow(handle),
  currentUrl: () => browser.getUrl(),
  pause: (ms) => browser.pause(ms),
  now: () => Date.now(),
};
const pageLabel = () => browser.execute(() => document.documentElement.dataset.e2eWindowLabel);

/** Run one `e2e-window-operation` in the current page and return its result. */
export async function windowOperation(op: string, target?: string, token = crypto.randomUUID()): Promise<unknown> {
  const observed = await browser.executeAsync<
    RendererWaitResult<WindowOperationResponse>, [WindowOperationWaitRequest]
  >(waitForWindowOperation, { token, op, target, timeoutMs: 20_000 });
  if (!observed.ok) throw new Error(observed.reason);
  if (observed.value.error) throw new Error(observed.value.error);
  return observed.value.result;
}

/** Select the owned window labelled `label` and return its handle; warm pages are never scripted. */
export function switchToWindowLabel(label: string, timeoutMs = 20_000): Promise<string> {
  return selectWindowByLabel({ ...windows, currentLabel: pageLabel }, label, timeoutMs);
}

/** Select the window whose URL matches, without running script in any page. */
export function switchToWindowUrl(matches: (url: string) => boolean, timeoutMsg: string): Promise<string> {
  return scanWindows(windows, async (handle) => handle, { timeoutMs: 20_000, timeoutMsg }, matches);
}

/** Close every window except `keep` and the application's warm windows, then select `keep`. */
export async function closeOtherWindows(keep: string): Promise<void> {
  for (const handle of await browser.getWindowHandles()) {
    if (handle === keep) continue;
    await browser.switchToWindow(handle);
    if (!isWarmWindowUrl(await browser.getUrl())) await browser.closeWindow();
  }
  if ((await browser.getWindowHandles()).includes(keep)) await browser.switchToWindow(keep);
}

/**
 * The registered parked warm window, found without scripting it (#931): the
 * current page reports registered hidden warm labels, and the handle is the
 * one warm URL outside `exclude` (activated warm windows the test knows).
 */
export async function parkedWarmWindow(exclude: Iterable<string> = []): Promise<{ label: string; handle: string }> {
  const owner = await browser.getWindowHandle();
  const known = new Set([owner, ...exclude]);
  let parked: { label: string; handle: string } | undefined;
  await browser.waitUntil(async () => {
    const labels = await windowOperation("warm-ready") as string[];
    const handles: string[] = [];
    try {
      for (const handle of await browser.getWindowHandles()) {
        if (known.has(handle)) continue;
        await browser.switchToWindow(handle);
        if (isWarmWindowUrl(await browser.getUrl())) handles.push(handle);
      }
    } finally {
      await browser.switchToWindow(owner);
    }
    if (labels.length === 1 && handles.length === 1) parked = { label: labels[0], handle: handles[0] };
    return parked !== undefined;
  }, { timeout: 20_000, timeoutMsg: "no registered parked warm window" });
  return parked!;
}

/** A fresh launch must introduce a new handle and expose its requested label. */
export async function switchToFreshWindow(
  label: string,
  existingHandles: readonly string[],
): Promise<string> {
  const evidence = beginFreshWindowSelection(label, existingHandles);
  // Existing pages cannot satisfy fresh-open; only new, owned pages are scripted.
  const existing = new Set(existingHandles);
  let selected: string;
  try {
    selected = await scanWindows(windows, async (handle) =>
      !existing.has(handle) && await pageLabel() === label ? handle : undefined,
    { timeoutMs: 20_000, timeoutMsg: `fresh native window ${label} did not become ready` });
  } catch (error) {
    evidence.failed(error);
    throw error;
  }
  await evidence.selected(selected);
  return selected;
}

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

/** Read the matching text in one renderer task. Retaining WebElement handles
 * across separate reads races row replacement and can strand polling on stale
 * elements even after the expected content has already been published. */
export async function domTexts(selector: string): Promise<string[]> {
  return browser.execute(
    (query: string) => Array.from(
      document.querySelectorAll(query),
      element => element.textContent ?? "",
    ),
    selector,
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
 * appear in them verbatim. The backend resolves each request to one native
 * spelling per directory (#799); pass `resolved` when `dir` is another
 * spelling of it, such as a trailing-separator or Windows case variant.
 */
export async function navigateTo(dir: string, resolved = dir): Promise<void> {
  // Close any commit graph restored from a prior spec's persisted state.
  // localStorage is shared across every tauri-driver
  // session (same origin), so a spec that left the graph open would relaunch
  // this one into graph mode and `.file-list` would never render (#447). The
  // pane's onMount registers the hook. Wait for its DOM readiness marker before
  // dispatching so exactly one real navigation/listing is queued.
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () => document.documentElement.dataset.e2eHooksReady === "true",
      ),
    { timeout: 15_000, timeoutMsg: "dev e2e hooks never became ready" },
  );

  // A prior spec can persist a temporary path and then delete its fixture.
  // The next session correctly starts on an error surface with no file list,
  // but its navigation hook is ready and can recover to the requested path.
  await browser.execute(() => {
    window.dispatchEvent(new CustomEvent("e2e-reset-view"));
  });

  const token = `${Date.now()}-${Math.random()}`;
  await browser.execute((target: string, navigationToken: string) => {
    delete document.documentElement.dataset.e2eNavigationComplete;
    window.dispatchEvent(
      new CustomEvent("e2e-navigate", {
        detail: { path: target, token: navigationToken },
      }),
    );
  }, dir, token);

  let shown: string | null = null;
  try {
    await browser.waitUntil(async () => {
      const completedToken = await browser.execute(
        () => document.documentElement.dataset.e2eNavigationComplete,
      );
      shown = await $(".status-path").getAttribute("title");
      return completedToken === token && shown === resolved;
    });
  } catch (error) {
    throw new Error(
      `status bar never showed ${resolved} for ${dir}; last showed ${shown}`,
      { cause: error },
    );
  }
}
