/**
 * Reporter-approved diagnostic sections for Report Issue (#1022, #1684).
 *
 * Each section is shown verbatim in the dialog and sent only while its
 * checkbox is on. `user_report.rs` wraps each in its own collapsed block, in
 * the order sent, and omits or truncates later ones when the relay's body
 * ceiling runs out. Fitting here first keeps the preview identical to what
 * the relay receives.
 */

/** Mirrors `DiagnosticKind` in `src-tauri/src/user_report.rs`. */
export type ReportDiagnosticKind = "crash-report" | "slow-loads";

export interface ReportDiagnostic {
  kind: ReportDiagnosticKind;
  text: string;
}

/** Per-section ceiling (`MAX_DIAGNOSTICS_UNITS` in user_report.rs). */
export const MAX_REPORT_DIAGNOSTIC_UNITS = 6000;
/** Below this a section would be too truncated to help; the native side
 *  omits it (`MIN_DIAGNOSTICS_UNITS`), so the dialog does not offer it. */
export const MIN_REPORT_DIAGNOSTIC_UNITS = 200;
/** Room for one section's collapsed-block wrapper in the issue body. */
export const REPORT_DIAGNOSTIC_WRAPPER_UNITS = 100;
/** The relay's body ceiling (`maxRelayBodyUnits` in the relay contract). */
const MAX_RELAY_BODY_UNITS = 8500;
/** Allowance for the contact label, environment block and separators. */
const REPORT_BODY_OVERHEAD_UNITS = 600;
export const REPORT_TEXT_TRUNCATED = "… (truncated to fit the report)";

const units = (value: string): number => value.length;

/** Control characters `sanitize` in user_report.rs drops (Unicode Cc except
 *  line breaks), removed here too so the preview shows exactly what is sent. */
const UNSENT_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Units left for all diagnostic sections after the reporter's own text. */
export function reportDiagnosticsBudget(description: string, contact = ""): number {
  return Math.max(
    0,
    MAX_RELAY_BODY_UNITS - REPORT_BODY_OVERHEAD_UNITS - units(description.trim()) - units(contact.trim()),
  );
}

/** The share of `budget` one section may use, wrapper included. */
export function sectionBudget(budget: number): number {
  return Math.max(0, Math.min(MAX_REPORT_DIAGNOSTIC_UNITS, budget - REPORT_DIAGNOSTIC_WRAPPER_UNITS));
}

/** What a fitted section leaves for the sections after it. */
export function budgetAfter(budget: number, text: string): number {
  return text ? Math.max(0, budget - units(text) - REPORT_DIAGNOSTIC_WRAPPER_UNITS) : budget;
}

/**
 * Keep the leading whole lines of `text` within `maxUnits`, marking a cut
 * with a final truncation line. The head of a crash report (error, location,
 * innermost frames) matters most, so the tail is what goes. Returns "" when
 * the budget is too small for a useful section.
 */
export function fitTextForReport(text: string, maxUnits: number): string {
  const trimmed = text.replace(UNSENT_CONTROLS, "").trim();
  if (!trimmed || maxUnits < MIN_REPORT_DIAGNOSTIC_UNITS) return "";
  if (units(trimmed) <= maxUnits) return trimmed;
  const room = maxUnits - units(REPORT_TEXT_TRUNCATED) - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of trimmed.split("\n")) {
    const cost = units(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    // A single overlong first line: cut it, never splitting a surrogate pair.
    kept.push(trimmed.slice(0, room).replace(/[\uD800-\uDBFF]$/, ""));
  }
  return `${kept.join("\n")}\n${REPORT_TEXT_TRUNCATED}`;
}
