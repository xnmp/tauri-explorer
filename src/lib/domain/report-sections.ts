/**
 * Opt-in diagnostics sections for Report Issue (#1685 recent errors, #1688
 * recent actions; the crash notice, #1686, reuses the same model).
 *
 * Every section is off until the reporter ticks it, is previewed verbatim,
 * and is omitted from the submitted draft while unticked. Sections share the
 * room the description leaves, in the order listed here, so each preview is
 * exactly what the relay receives. Only ticked sections consume budget.
 */
import {
  budgetAfter,
  fitTextForReport,
  sectionBudget,
  type ReportDiagnostic,
  type ReportDiagnosticKind,
} from "./report-diagnostics";

export type OptInSectionKind = Extract<ReportDiagnosticKind, "recent-errors" | "recent-actions">;

export interface OptInSectionSpec {
  kind: OptInSectionKind;
  /** Accessible label of the section. */
  label: string;
  /** Checkbox text. */
  toggle: string;
  /** What the section contains and what stays out, shown above the preview. */
  hint: string;
}

export const OPT_IN_SECTIONS: readonly OptInSectionSpec[] = [
  {
    kind: "recent-errors",
    label: "Recent errors",
    toggle: "Include recent errors",
    hint:
      "Warning and error lines from this session and the previous one, as Tauri Explorer logged them. " +
      "Your home folder is shown as ~, but lines can still mention other folder or file names; " +
      "they will be public in the issue.",
  },
  {
    kind: "recent-actions",
    label: "Recent actions",
    toggle: "Include my recent actions",
    hint:
      "The last commands, view changes and navigation steps of this session, by name only. " +
      "No folder paths, file names or typed text are recorded.",
  },
];

export interface PlannedSection extends OptInSectionSpec {
  /** The text that would be sent, fitted to the room left; "" when there is nothing to offer. */
  text: string;
  offered: boolean;
  included: boolean;
}

/**
 * Fit each section's `candidates` text into `budget` (the room left after the
 * description and any earlier sections) and decide which ones are sent.
 */
export function planOptInSections(
  candidates: Partial<Record<OptInSectionKind, string>>,
  included: Partial<Record<OptInSectionKind, boolean>>,
  budget: number,
): PlannedSection[] {
  let remaining = budget;
  return OPT_IN_SECTIONS.map((spec) => {
    const text = fitTextForReport(candidates[spec.kind] ?? "", sectionBudget(remaining));
    const offered = text.length > 0;
    const sent = offered && included[spec.kind] === true;
    if (sent) remaining = budgetAfter(remaining, text);
    return { ...spec, text, offered, included: sent };
  });
}

/** The diagnostics a draft carries: ticked sections only. */
export function includedDiagnostics(plan: readonly PlannedSection[]): ReportDiagnostic[] {
  return plan
    .filter((section) => section.included)
    .map(({ kind, text }) => ({ kind, text }));
}
