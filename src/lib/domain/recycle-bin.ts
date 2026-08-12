import type { ApiResult } from "$lib/api/common";

type OpenRecycleBin = () => Promise<ApiResult<void>>;
type ReportError = (message: string) => void;

/**
 * Opens the native recycle-bin surface from a UI event. The feedback callback
 * keeps this policy importable and testable outside the sidebar component.
 */
export async function openRecycleBinWithFeedback(
  openRecycleBin: OpenRecycleBin,
  _reportError: ReportError,
): Promise<void> {
  await openRecycleBin();
}
