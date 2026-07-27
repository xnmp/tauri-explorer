export type UserReportKind = "bug" | "feature";

export interface UserReportDraft {
  title: string;
  body: string;
  kind: UserReportKind;
  contact?: string;
}

export interface SubmittedUserReport {
  url: string;
  number: number;
}

export type UserReportErrorKind =
  | "malformed_input"
  | "network_unreachable"
  | "rate_limited"
  | "daily_cap"
  | "server_rejected";

export interface UserReportError {
  kind: UserReportErrorKind;
  message: string;
}

const REPO_ISSUES_URL = "https://github.com/xnmp/tauri-explorer/issues/new";

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Build the no-data-loss browser fallback from the user's current draft. */
export function userReportFallbackUrl(draft: UserReportDraft): string {
  const title = stripControls(draft.title).replace(/\s*\r?\n\s*/g, " ").trim();
  const description = stripControls(draft.body).trim();
  const contact = stripControls(draft.contact ?? "").trim();
  const body = contact
    ? `${description}\n\nHow to reach me: ${contact}`
    : description;
  const params = new URLSearchParams({
    title,
    body,
    labels: draft.kind === "bug" ? "bug" : "enhancement",
  });
  return `${REPO_ISSUES_URL}?${params.toString()}`;
}
