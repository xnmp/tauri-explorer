/**
 * One DOM request/response protocol for native E2E probes (#884).
 *
 * WebKitWebDriver may evaluate `browser.execute` in an isolated JavaScript
 * world, so a spec cannot call application functions. It dispatches
 * `new CustomEvent(event, { detail: { token, op, ... } })` on `window` instead,
 * and polls `document.documentElement.dataset[resultKey]` for the JSON
 * `{ token, result }` or `{ token, error }` carrying its own token.
 *
 * Every accepted request settles exactly once: a handler that throws or
 * rejects reports `error` rather than leaving the spec to time out. Nothing is
 * published after `signal` aborts, and the result/ready markers are removed.
 */

export interface DomRpcRequest {
  token: string;
  op?: string;
}

type Handler<R> = (request: R) => unknown;

export interface DomRpcOptions<R extends DomRpcRequest> {
  /** Window event name the spec dispatches. */
  event: string;
  /** `dataset` key receiving `{ token, result | error }`. */
  resultKey: string;
  /** Owner lifetime; aborting removes the listener and published markers. */
  signal: AbortSignal;
  /**
   * Handlers keyed by `request.op`. A probe whose requests carry no `op`
   * supplies a single `default` handler.
   */
  handlers: Partial<Record<string, Handler<R>>>;
  /** Extra `dataset` keys owned by this probe, cleared on abort. */
  ownedKeys?: readonly string[];
  /** `dataset` key set to `"true"` once the listener is installed. */
  readyKey?: string;
  formatError?: (error: unknown) => string;
}

function isRequest(value: unknown): value is DomRpcRequest {
  return typeof value === "object" && value !== null &&
    typeof (value as { token?: unknown }).token === "string";
}

function describeFailure(failure: unknown): string {
  try {
    return ` (formatting failed: ${String(failure)})`;
  } catch {
    return "";
  }
}

export function createDomRpc<R extends DomRpcRequest>(options: DomRpcOptions<R>): void {
  const { signal, resultKey, handlers } = options;
  if (signal.aborted) return;
  const root = document.documentElement;
  // Every request must publish a result, so formatting an error never throws:
  // a value whose `toString` throws, or a custom formatter that fails, still
  // settles the request with a fallback message.
  const formatError = (error: unknown): string => {
    try {
      return (options.formatError ?? String)(error);
    } catch (formatFailure) {
      return `Unprintable ${options.event} error${describeFailure(formatFailure)}`;
    }
  };
  const publish = (payload: { token: string; result?: unknown; error?: string }) => {
    if (signal.aborted) return;
    let encoded: string;
    try {
      encoded = JSON.stringify(payload);
    } catch (error) {
      // An unserializable result still settles the request.
      encoded = JSON.stringify({ token: payload.token, error: formatError(error) });
    }
    root.dataset[resultKey] = encoded;
  };

  window.addEventListener(options.event, ((event: CustomEvent<unknown>) => {
    const request = event.detail;
    if (!isRequest(request)) return; // No token: nothing the spec could correlate.
    const op = request.op ?? "default";
    const handler = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
    void (async () => {
      if (!handler) throw new Error(`Unknown ${options.event} operation: ${request.op ?? "(none)"}`);
      return await handler(request as R);
    })().then(
      (result) => publish({ token: request.token, result }),
      (error: unknown) => publish({ token: request.token, error: formatError(error) }),
    );
  }) as EventListener, { signal });

  signal.addEventListener("abort", () => {
    for (const key of [resultKey, ...(options.ownedKeys ?? []), ...(options.readyKey ? [options.readyKey] : [])]) {
      delete root.dataset[key];
    }
  }, { once: true });
  if (options.readyKey) root.dataset[options.readyKey] = "true";
}
