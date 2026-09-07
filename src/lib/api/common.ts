/**
 * Shared API primitives: mock-aware invoke, error extraction, and result types.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isVirtualPath, virtualScheme } from "$lib/domain/virtual-path";

// Cached Tauri detection. Only the positive result is latched: an invoke
// racing ahead of __TAURI_INTERNALS__ injection must not permanently stick
// the real app on the mock, so we re-detect until Tauri is found.
let cachedIsTauri = false;

/** Keep runtime detection independent of the browser-only fixture backend. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Mock-aware invoke: dispatches to the real Tauri IPC when available,
 * otherwise to the in-memory mock (browser E2E). All API modules should use
 * this instead of importing `invoke` from @tauri-apps/api directly.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!cachedIsTauri && isTauri()) {
    cachedIsTauri = true;
  }
  // Native windows never load or initialize browser fixtures. Dynamic import
  // also lets the bundler keep their data out of the cold-start import graph.
  if (cachedIsTauri) {
    return args !== undefined ? tauriInvoke<T>(cmd, args) : tauriInvoke<T>(cmd);
  }
  const { mockInvoke } = await import("./mock-invoke");
  return args !== undefined ? mockInvoke<T>(cmd, args) : mockInvoke<T>(cmd);
}

/** Structured error from Tauri backend */
export type AppErrorKind = "not_found" | "permission_denied" | "already_exists" | "invalid_path" | "io" | "other";

export interface AppError {
  kind: AppErrorKind;
  message: string;
}

const APP_ERROR_KINDS: ReadonlySet<string> = new Set<AppErrorKind>([
  "not_found", "permission_denied", "already_exists", "invalid_path", "io", "other",
]);

/** Extract error message from Tauri command error (structured or string) */
export function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    // Plain object without a usable message — serialize rather than "[object Object]"
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Extract structured error kind from Tauri command error.
 *  Returns null unless the kind is a known AppErrorKind. */
export function extractErrorKind(err: unknown): AppErrorKind | null {
  if (err && typeof err === "object" && "kind" in err) {
    const kind = (err as { kind: unknown }).kind;
    if (typeof kind === "string" && APP_ERROR_KINDS.has(kind)) {
      return kind as AppErrorKind;
    }
  }
  return null;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Reject real-fs operations on virtual (`scheme://…`) paths with a graceful
 * error instead of letting them reach the OS backend (#152). Virtual entries
 * are read-only plugin views; only listing (fetchDirectory / streaming) is
 * provider-routed today.
 */
export function virtualPathGuard(...paths: (string | undefined)[]): { ok: false; error: string } | null {
  const virtual = paths.find((p) => p && isVirtualPath(p));
  if (!virtual) return null;
  return {
    ok: false,
    error: `${virtualScheme(virtual)}:// is a read-only virtual location`,
  };
}

/** Convert a `data:` URI into an object-URL (blob:) for use in <img>/<video>. */
export function dataUriToBlobUrl(dataUri: string): string {
  const comma = dataUri.indexOf(",");
  if (comma === -1) return dataUri;
  const meta = dataUri.slice(0, comma);
  const mimeMatch = meta.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const raw = atob(dataUri.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
