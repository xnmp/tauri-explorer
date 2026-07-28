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

export interface UserReportAttachmentFile {
  name: string;
  type: string;
  size: number;
}

export interface UserReportAttachmentUsage {
  count: number;
  bytes: number;
}

export function userReportAttachmentBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

export function validateUserReportAttachmentFiles(
  files: readonly UserReportAttachmentFile[],
  existing: UserReportAttachmentUsage = { count: 0, bytes: 0 },
): string | null {
  if (existing.count + files.length > MAX_USER_REPORT_ATTACHMENTS) {
    return `Attach up to ${MAX_USER_REPORT_ATTACHMENTS} images.`;
  }
  let addedBytes = 0;
  for (const file of files) {
    if (!(USER_REPORT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      return "Attachments must be PNG, JPEG, or GIF images.";
    }
    if (file.size === 0) return `${file.name || "The selected image"} is empty.`;
    if (file.size > MAX_USER_REPORT_ATTACHMENT_BYTES) {
      return `${file.name || "Each image"} must be 2 MiB or smaller.`;
    }
    addedBytes += file.size;
  }
  if (existing.bytes + addedBytes > MAX_USER_REPORT_ATTACHMENTS_BYTES) {
    return "Attachments must total 3 MiB or less.";
  }
  return null;
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
