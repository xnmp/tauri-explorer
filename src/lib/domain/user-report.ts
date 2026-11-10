export type UserReportKind = "bug" | "feature";

export const USER_REPORT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
] as const;
export type UserReportImageType = (typeof USER_REPORT_IMAGE_TYPES)[number];
export const USER_REPORT_MEDIA_TYPES = [...USER_REPORT_IMAGE_TYPES, "video/mp4", "video/webm", "video/quicktime"] as const;
export type UserReportMediaType = (typeof USER_REPORT_MEDIA_TYPES)[number];

// Mirrors the native boundary and the relay; all three assert these against
// tests/contract/fixtures/report_relay.json.
export const MAX_USER_REPORT_ATTACHMENTS = 3;
export const MAX_USER_REPORT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_USER_REPORT_ATTACHMENTS_BYTES = 3 * 1024 * 1024;
export const MAX_USER_REPORT_TITLE_UNITS = 120;
export const MAX_USER_REPORT_DESCRIPTION_UNITS = 8000;
export const MAX_USER_REPORT_CONTACT_UNITS = 100;

export interface UserReportAttachment {
  name: string;
  mediaType: UserReportMediaType;
  /** Base64-encoded media bytes without a data-URL prefix. */
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

/** Current count/byte usage of an attachment list, for validating an addition against it. */
export function userReportAttachmentUsage(
  attachments: readonly UserReportAttachment[],
): UserReportAttachmentUsage {
  return {
    count: attachments.length,
    bytes: attachments.reduce(
      (total, attachment) => total + userReportAttachmentBytes(attachment.data),
      0,
    ),
  };
}

export function validateUserReportAttachmentFiles(
  files: readonly UserReportAttachmentFile[],
  existing: UserReportAttachmentUsage = { count: 0, bytes: 0 },
): string | null {
  if (existing.count + files.length > MAX_USER_REPORT_ATTACHMENTS) {
    return `Attach up to ${MAX_USER_REPORT_ATTACHMENTS} images and videos.`;
  }
  let addedBytes = 0;
  for (const file of files) {
    if (!(USER_REPORT_MEDIA_TYPES as readonly string[]).includes(file.type)) {
      return "Attachments must be PNG, JPEG, GIF, MP4, WebM, or MOV.";
    }
    if (file.size === 0) return `${file.name || "The selected attachment"} is empty.`;
    if (file.size > MAX_USER_REPORT_ATTACHMENT_BYTES) {
      return file.type.startsWith("video/")
        ? `${file.name || "The clip"} is too large (2 MiB maximum). Try a shorter clip or a recording at lower quality.`
        : `${file.name || "Each image"} must be 2 MiB or smaller.`;
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
  /** Reporter-approved slow folder-load diagnostics (#1022), shown verbatim
   *  in the dialog before submission. Not persisted with the text draft. */
  diagnostics?: string;
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
  | "server_rejected"
  | "submission_uncertain"
  | "attachment_uploader_unavailable"
  | "attachment_upload_failed"
  | "clipboard_unavailable"
  | "authentication_failed"
  | "credential_unavailable";

export interface UserReportError {
  kind: UserReportErrorKind;
  message: string;
}

const NOTHING_SENT = "Couldn't reach the report server — nothing was sent";

/** Toast for a definite in-app failure that falls back to GitHub's form.
 *  `submission_uncertain` never reaches here: it must not invite a retry. */
export function userReportFallbackNotice(kind: UserReportErrorKind | undefined): string {
  if (kind === "network_unreachable") return `${NOTHING_SENT}. Opening GitHub instead`;
  if (kind === "daily_cap") return "Reports are temporarily unavailable — opening GitHub instead";
  if (kind === "authentication_failed") {
    return "GitHub didn't accept your saved token, so nothing was sent — opening GitHub instead. Update the token in Settings → Issue Reports";
  }
  if (kind === "credential_unavailable") {
    return "Couldn't read your saved GitHub token (credential storage is locked) — opening GitHub instead";
  }
  return "Could not submit in-app — opening GitHub instead";
}

export function userReportAttachmentFailureMessage(
  kind: UserReportErrorKind | undefined,
  detail?: string,
): string {
  const retry = "Your text is saved; images and videos remain available until this window closes.";
  const message = detail?.trim();
  const reason = message ? ` Reason: ${message}${/[.!?]$/.test(message) ? "" : "."}` : "";
  if (kind === "attachment_uploader_unavailable") {
    return `Could not reach an attachment uploader. ${retry}`;
  }
  if (kind === "attachment_upload_failed") {
    return `Could not upload the attachment. ${retry}`;
  }
  if (kind === "malformed_input") {
    return `One of your attached images or videos is not valid.${reason} ${retry} Reopen Report Issue, remove it, and try again.`;
  }
  if (kind === "daily_cap") {
    return `Reports are temporarily unavailable. ${retry}`;
  }
  if (kind === "network_unreachable") {
    return `${NOTHING_SENT}. ${retry}`;
  }
  if (kind === "rate_limited") {
    return `Too many reports were submitted. ${retry} Try again later.`;
  }
  return `Could not submit the report with its attachments.${reason} ${retry}`;
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
  const body = [
    description,
    contact ? `How to reach me: ${contact}` : "",
  ].filter(Boolean).join("\n\n");
  return boundedGitHubIssueUrl(
    title,
    body,
    draft.kind === "bug" ? "bug" : "enhancement",
  );
}

/** Validate the decoded bytes at the draft admission seam, before displaying or submitting them. */
export function validateUserReportAttachments(
  attachments: readonly UserReportAttachment[],
  existing: UserReportAttachmentUsage = { count: 0, bytes: 0 },
): string | null {
  for (const attachment of attachments) {
    try {
      const binary = atob(attachment.data);
      if (btoa(binary) !== attachment.data || !validUserReportMediaMagic(attachment.mediaType, Uint8Array.from(binary, (char) => char.charCodeAt(0)))) {
        return `${attachment.name} is invalid: its bytes do not match its media type.`;
      }
    } catch { return `${attachment.name} has invalid attachment data.`; }
  }
  return validateUserReportAttachmentFiles(attachments.map((attachment) => ({
    name: attachment.name,
    type: attachment.mediaType,
    size: userReportAttachmentBytes(attachment.data),
  })), existing);
}

function validUserReportMediaMagic(type: string, bytes: Uint8Array): boolean {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (type === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === "image/jpeg") return starts([255, 216, 255]);
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.subarray(0, 6)));
  if (type === "video/webm") return starts([26, 69, 223, 163]);
  if (type !== "video/mp4" && type !== "video/quicktime") return false;
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (boxSize < 16 || boxSize > bytes.length) return false;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return type === "video/quicktime" ? brand === "qt  " : ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso8", "iso9", "avc1", "mp41", "mp42", "M4V ", "MSNV", "dash"].includes(brand);
}
