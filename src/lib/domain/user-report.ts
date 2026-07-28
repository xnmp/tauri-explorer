export type UserReportKind = "bug" | "feature";

export const USER_REPORT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
] as const;
export type UserReportImageType = (typeof USER_REPORT_IMAGE_TYPES)[number];

export const MAX_USER_REPORT_ATTACHMENTS = 3;
export const MAX_USER_REPORT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_USER_REPORT_ATTACHMENTS_BYTES = 3 * 1024 * 1024;

export interface UserReportAttachment {
  name: string;
  mediaType: UserReportImageType;
  /** Base64-encoded image bytes without a data-URL prefix. */
  data: string;
}

export interface UserReportDraft {
  title: string;
  body: string;
  kind: UserReportKind;
  contact?: string;
  attachments?: UserReportAttachment[];
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
export const MAX_GITHUB_ISSUE_URL_CHARS = 6000;

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function boundedGitHubIssueUrl(
  title: string,
  body: string,
  labels?: string,
): string | null {
  const params = new URLSearchParams({ title, body });
  if (labels) params.set("labels", labels);
  const url = `${REPO_ISSUES_URL}?${params.toString()}`;
  return url.length <= MAX_GITHUB_ISSUE_URL_CHARS ? url : null;
}

/**
 * Build the no-data-loss browser fallback from the user's current draft.
 * Returns null rather than truncating user-authored text when GitHub's encoded
 * new-issue URL would exceed the browser-safe ceiling.
 */
export function userReportFallbackUrl(draft: UserReportDraft): string | null {
  const title = stripControls(draft.title).replace(/\s*\r?\n\s*/g, " ").trim();
  const description = stripControls(draft.body).trim();
  const contact = stripControls(draft.contact ?? "").trim();
  const body = contact
    ? `${description}\n\nHow to reach me: ${contact}`
    : description;
  return boundedGitHubIssueUrl(
    title,
    body,
    draft.kind === "bug" ? "bug" : "enhancement",
  );
}
