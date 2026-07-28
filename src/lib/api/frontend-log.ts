/**
 * Forward a diagnosable webview failure into the native rotating application
 * log. Console output alone is unavailable to users of production builds.
 */
import { invoke } from "./common";

export function logFrontendDiagnostic(
  event: string,
  context: Record<string, string | number | boolean | null>,
): void {
  const message = `[${event}] ${JSON.stringify(context)}`;
  void invoke<void>("log_frontend_error", { message }).catch(() => undefined);
}
