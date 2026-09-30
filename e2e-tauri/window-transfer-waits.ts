export interface WindowOperationWaitRequest {
  token: string;
  op: string;
  target?: string;
  timeoutMs: number;
}

export interface WindowOperationResponse {
  token?: string;
  result?: unknown;
  error?: string;
}

export interface ListingWaitRequest {
  name: string;
  match?: "exact" | "contains";
  minCount?: number;
  timeoutMs: number;
}

export type RendererWaitResult<T> =
  | { ok: true; value: T }
  // WDIO interprets a top-level `error` as a WebDriver protocol failure.
  | { ok: false; reason: string };

export interface WindowLabelScanDriver {
  listHandles(): Promise<string[]>;
  switchTo(handle: string): Promise<void>;
  /** The selected page's URL, answered by the driver without running page script. */
  currentUrl(): Promise<string>;
  currentLabel(): Promise<string | undefined>;
  pause(ms: number): Promise<void>;
  now(): number;
}

/** Label prefix of every warm window (`WARM_LABEL_PREFIX` in `src/lib/state/warm-window.ts`). */
const WARM_LABEL_PREFIX = "explorer-warm-";

/** A warm window, parked or activated: launched with `?warm=1`, which it keeps. */
export function isWarmWindowUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get("warm") === "1";
  } catch {
    return false;
  }
}

/**
 * Whether a scan looking for `label` may run script in the page at `url`.
 * Never script a page the test does not own (#885, #931): a parked warm window
 * belongs to the application, and a script it cannot answer ends the whole
 * WebDriver session. Only a warm window carries a warm label, so a scan for
 * any other label skips every warm page.
 */
export function mayHostLabel(url: string, label: string): boolean {
  return label.startsWith(WARM_LABEL_PREFIX) || !isWarmWindowUrl(url);
}

/** Let each complete handle scan finish before testing the overall deadline. */
export async function selectWindowByLabel(
  driver: WindowLabelScanDriver,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = driver.now() + timeoutMs;
  for (;;) {
    for (const handle of await driver.listHandles()) {
      try {
        await driver.switchTo(handle);
        if (!mayHostLabel(await driver.currentUrl(), label)) continue;
        if (await driver.currentLabel() === label) return;
      } catch (error) {
        // A window can close while the handle list is being scanned. Preserve
        // real driver failures when that handle still exists.
        if ((await driver.listHandles()).includes(handle)) throw error;
      }
    }
    if (driver.now() >= deadline) {
      throw new Error(`window ${label} did not become ready`);
    }
    await driver.pause(250);
  }
}

export function waitForWindowOperation(
  request: WindowOperationWaitRequest,
  done: (result?: RendererWaitResult<WindowOperationResponse>) => void,
): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const observer = new MutationObserver(checkResult);
  const finish = (result: RendererWaitResult<WindowOperationResponse>) => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    clearTimeout(timer);
    done(result);
  };
  function checkResult(): void {
    try {
      const response = JSON.parse(
        document.documentElement.dataset.e2eWindowResult ?? "{}",
      ) as WindowOperationResponse;
      if (response.token === request.token) finish({ ok: true, value: response });
    } catch {
      // A partial or stale value is not the correlated operation response.
    }
  }

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-e2e-window-result"],
  });
  timer = setTimeout(() => finish({
    ok: false,
    reason: `native ${request.op} did not finish`,
  }), request.timeoutMs);

  checkResult();
  if (settled) return;
  try {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", {
      detail: { token: request.token, op: request.op, target: request.target },
    }));
    // A synchronous listener may publish before MutationObserver's microtask.
    checkResult();
  } catch (error) {
    finish({ ok: false, reason: String(error) });
  }
}

export function waitForListingEntry(
  request: ListingWaitRequest,
  done: (result?: RendererWaitResult<true>) => void,
): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const observer = new MutationObserver(checkListing);
  const finish = (result: RendererWaitResult<true>) => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    clearTimeout(timer);
    done(result);
  };
  function checkListing(): void {
    const entries = document.querySelectorAll(".explorer-pane .entry-name");
    const matches = [...entries].filter((entry) => request.match === "contains"
      ? entry.textContent?.includes(request.name)
      : entry.textContent === request.name);
    if (matches.length >= (request.minCount ?? 1)) {
      finish({ ok: true, value: true });
    }
  }

  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  timer = setTimeout(() => finish({
    ok: false,
    reason: request.match === "contains" || (request.minCount ?? 1) !== 1
      ? `native listing did not contain ${request.minCount ?? 1} match(es) for ${request.name}`
      : `native listing did not contain ${request.name}`,
  }), request.timeoutMs);
  checkListing();
}
