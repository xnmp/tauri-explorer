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
  timeoutMs: number;
}

export type RendererWaitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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
    error: `native ${request.op} did not finish`,
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
    finish({ ok: false, error: String(error) });
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
    if ([...entries].some((entry) => entry.textContent === request.name)) {
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
    error: `native listing did not contain ${request.name}`,
  }), request.timeoutMs);
  checkListing();
}
