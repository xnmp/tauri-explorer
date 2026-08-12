import type { ApiResult } from "$lib/api/common";

type OpenRecycleBin = () => Promise<ApiResult<void>>;
type ReportError = (message: string) => void;

/**
 * Opens the native recycle-bin surface from a UI event. The feedback callback
 * keeps this policy importable and testable outside the sidebar component.
 */
export async function openRecycleBinWithFeedback(
  openRecycleBin: OpenRecycleBin,
  reportError: ReportError,
): Promise<void> {
  const result = await openRecycleBin();
  if (!result.ok) {
    reportError(`Could not open Recycle Bin: ${result.error}`);
  }
}
