import { browser, $, $$ } from "@wdio/globals";
// Keep command types available to standalone fixture-contract tests too.
import type {} from "webdriverio";
import path from "node:path";
import {
  collectNativeProcessEvidence,
  writeFreshWindowDiagnostics,
  type FreshWindowDiagnostics,
  type FreshWindowPageSnapshot,
} from "../fresh-window-diagnostics";

const applicationBinary = path.resolve(
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer",
);

const diagnosticsDirectory =
  process.env.TAURI_NATIVE_DIAGNOSTICS_DIR
  ?? path.resolve("e2e-tauri", "logs", "fresh-window");

/**
 * Evidence for the most recent fresh-window selection (#703).
 *
 * The Linux session loss happened between selection and the first element
 * lookup, so this is captured unconditionally at selection and replayed if the
 * lookup fails — by then the session can already be invalid.
 */
let lastFreshWindow: FreshWindowDiagnostics | null = null;

/**
 * One atomic renderer sample. WebKitWebDriver may evaluate injected scripts in
 * an isolated world, so read DOM state only — never application globals.
 */
async function captureFreshWindowPage(): Promise<FreshWindowPageSnapshot | { error: string }> {
  try {
    return await browser.execute(() => {
      const data = document.documentElement.dataset;
      const status = document.querySelector(".status-path");
      return {
        capturedAt: Date.now(),
        label: data.e2eWindowLabel ?? null,
        hooksReady: data.e2eHooksReady === "true",
        fileListCount: document.querySelectorAll(".file-list").length,
        entryCount: document.querySelectorAll(".entry-item").length,
        statusPath: status ? status.getAttribute("title") : null,
        url: location.href,
        readyState: document.readyState,
        visibility: document.visibilityState,
      };
    }) as FreshWindowPageSnapshot;
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Record why a first lookup in a fresh window failed, using process evidence
 * only: a lost session cannot answer another WebDriver command. Exported for
 * contract tests; specs reach it through `waitForFreshWindowElement`.
 */
export function recordFreshWindowLookupFailure(
  selector: string,
  error: unknown,
): string | null {
  const selected = lastFreshWindow;
  if (!selected) return null;
  return writeFreshWindowDiagnostics({
    ...selected,
    phase: "lookup-failed",
    lookup: { selector, failedAt: Date.now(), error: String(error) },
    nativeAfterFailure: collectNativeProcessEvidence({ applicationPath: applicationBinary }),
  }, diagnosticsDirectory);
}

/**
 * Wait for the first element of a freshly opened window, retaining diagnostics
 * when it never resolves. The existence contract is unchanged; only the
 * failure path gains evidence.
 */
export async function waitForFreshWindowElement(
  selector: string,
  timeout: number,
): Promise<void> {
  try {
    await $(selector).waitForExist({ timeout });
  } catch (error) {
    recordFreshWindowLookupFailure(selector, error);
    throw error;
  }
}

/** A fresh launch must introduce a new handle and expose its requested label. */
export async function switchToFreshWindow(
  label: string,
  existingHandles: readonly string[],
): Promise<string> {
  // Existing pages cannot satisfy fresh-open. Avoid probing their renderers:
  // a parked/retiring WebKit page can block script execution indefinitely.
  const existing = new Set(existingHandles);
  let selected = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (existing.has(handle)) continue;
      await browser.switchToWindow(handle);
      if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
        selected = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: `fresh native window ${label} did not become ready` });

  // Always-on: one renderer round trip plus one /proc scan, recorded before the
  // first element lookup can lose the session (#703).
  lastFreshWindow = {
    issue: 703,
    phase: "selected",
    requestedLabel: label,
    handle: selected,
    selectedAt: Date.now(),
    pageAtSelection: await captureFreshWindowPage(),
    nativeAtSelection: collectNativeProcessEvidence({ applicationPath: applicationBinary }),
  };
  writeFreshWindowDiagnostics(lastFreshWindow, diagnosticsDirectory);
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
 * appear in them verbatim.
 */
export async function navigateTo(dir: string): Promise<void> {
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

  await browser.waitUntil(
    async () => {
      const completedToken = await browser.execute(
        () => document.documentElement.dataset.e2eNavigationComplete,
      );
      return completedToken === token && (await $(".status-path").getAttribute("title")) === dir;
    },
    { timeoutMsg: `status bar never showed ${dir}` },
  );
}
