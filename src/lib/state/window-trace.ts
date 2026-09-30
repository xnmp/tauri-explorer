/**
 * Tracing for window launch, tab hand-off and tab-seed adoption (#884).
 *
 * Failures and timeouts go to the native rotating application log in every
 * build, so a user's log shows why a tear-off or new window did not complete.
 * Successful phases are high-volume and only useful while investigating a
 * native flake, so they are logged only in hook builds.
 *
 * Retire-when: #710 closed (the hook-build progress trace only; failure
 * logging is permanent product behaviour)
 */
import { logFrontendDiagnostic } from "$lib/api/frontend-log";
import { E2E_HOOKS_ENABLED } from "$lib/api/e2e-hooks";

export type WindowTraceContext = Record<string, string | number | boolean | null>;

/** A launch or hand-off did not complete. Logged in every build. */
export function traceWindowFailure(event: string, context: WindowTraceContext): void {
  logFrontendDiagnostic(event, context);
}

/** An intermediate or successful phase. Logged only in hook builds. */
export function traceWindowProgress(event: string, context: WindowTraceContext): void {
  if (E2E_HOOKS_ENABLED) logFrontendDiagnostic(event, context);
}

/** Bounded, log-safe rendering of an arbitrary rejection. */
export function traceError(error: unknown): string | null {
  return error === undefined ? null : String(error).slice(0, 240);
}
