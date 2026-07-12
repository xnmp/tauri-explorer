/**
 * Pure helpers for local crash capture + bug-report log tails (#302).
 *
 * No framework, Tauri, or IO deps — everything here is a pure function and is
 * unit-tested directly. Used by `src/lib/api/crash.ts`. Privacy: nothing here
 * sends anything anywhere; it only shapes text that the user later chooses to
 * submit through the GitHub issue form.
 */

/**
 * Decide whether a freshly-observed webview error should be recorded as a
 * crash, given the set of message keys already recorded this session.
 *
 * Dedupe is per identical message so a tight error loop yields a single crash
 * record rather than flooding the crashes dir. Immutable in/out: returns the
 * decision plus the next seen-set, leaving the input untouched.
 */
export function dedupeFrontendCrash(
  seen: ReadonlySet<string>,
  message: string,
): { record: boolean; seen: Set<string> } {
  const key = message.trim();
  if (seen.has(key)) return { record: false, seen: new Set(seen) };
  const next = new Set(seen);
  next.add(key);
  return { record: true, seen: next };
}

/** Markdown heading for the recent-logs section of a bug report. */
export const RECENT_LOGS_HEADING = "## Recent logs";

/**
 * Render a raw log tail as a fenced "Recent logs" markdown section, dropping
 * the OLDEST lines until the whole section fits within `maxChars`. Oldest-first
 * trimming preserves the most recent (most relevant) lines. A single
 * over-long line is hard-truncated. Returns "" for empty input so callers can
 * omit the section entirely.
 */
export function recentLogsSection(logTail: string, maxChars: number): string {
  const trimmed = logTail.replace(/\s+$/, "");
  if (trimmed.length === 0) return "";

  const wrap = (body: string): string =>
    `${RECENT_LOGS_HEADING}\n\n\`\`\`\n${body}\n\`\`\`\n`;

  let lines = trimmed.split("\n");
  // Drop oldest lines until within budget (always keep at least one).
  while (lines.length > 1 && wrap(lines.join("\n")).length > maxChars) {
    lines = lines.slice(1);
  }

  let body = lines.join("\n");
  // Even the single most-recent line can blow the budget — hard-truncate it.
  if (wrap(body).length > maxChars) {
    const overhead = wrap("").length;
    body = body.slice(0, Math.max(0, maxChars - overhead));
  }
  return wrap(body);
}
