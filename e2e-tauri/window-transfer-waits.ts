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
  _request: WindowOperationWaitRequest,
  _done: (result: RendererWaitResult<WindowOperationResponse>) => void,
): void {
  throw new Error("not implemented");
}

export function waitForListingEntry(
  _request: ListingWaitRequest,
  _done: (result: RendererWaitResult<true>) => void,
): void {
  throw new Error("not implemented");
}
