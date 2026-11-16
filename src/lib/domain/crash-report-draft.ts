/**
 * Turning a saved crash into a Report Issue draft (#1684). Pure; loaded
 * only when the reporter chooses to report, so it stays out of startup.
 */
/** The `panic:` line of a crash file (Rust panic or recorded webview error). */
export function crashPanicMessage(contents: string): string {
  return (
    contents
      .split("\n")
      .find((line) => line.startsWith("panic: "))
      ?.slice("panic: ".length)
      .trim() || "unknown error"
  );
}

/** Report title for a crash: short enough for the dialog's title limit. */
export function crashReportTitle(contents: string): string {
  const message = crashPanicMessage(contents).replace(/\s+/g, " ");
  const clipped = message.length > 80 ? `${message.slice(0, 79).replace(/[\uD800-\uDBFF]$/, "")}…` : message;
  return `Crash: ${clipped}`;
}

/**
 * Draft changes for reporting a crash: an empty draft becomes a bug titled
 * after the crash; an existing draft keeps the reporter's own title and kind.
 */
export function crashDraftUpdate(
  draft: { title: string },
  contents: string,
): { title: string; kind: "bug" } | null {
  return draft.title.trim() ? null : { title: crashReportTitle(contents), kind: "bug" };
}
