import type {
  SubmittedUserReport,
  UserReportAttachment,
  UserReportDraft,
} from "$lib/domain/user-report";
import type { ReportTokenState } from "$lib/domain/user-report-route";
import { invoke } from "./common";

/** `useGitHubToken` files the issue as the saved token's user (#1455). */
export function submitUserReport(
  draft: UserReportDraft,
  useGitHubToken = false,
): Promise<SubmittedUserReport> {
  return invoke<SubmittedUserReport>("submit_user_report", {
    title: draft.title,
    body: draft.body,
    kind: draft.kind,
    contact: draft.contact || null,
    attachments: draft.attachments ?? [],
    diagnostics: draft.diagnostics || null,
    useGitHubToken,
  });
}

export function userReportTokenState(): Promise<ReportTokenState> {
  return invoke<ReportTokenState>("user_report_token_state");
}

/** Write-only: the saved token is never returned to the renderer. */
export function saveUserReportToken(token: string): Promise<void> {
  return invoke<void>("save_user_report_token", { token });
}

export function clearUserReportToken(): Promise<void> {
  return invoke<void>("clear_user_report_token");
}

export function readClipboardReportImage(): Promise<UserReportAttachment> {
  return invoke<UserReportAttachment>("clipboard_read_report_image");
}

export function readClipboardReportAttachment(): Promise<UserReportAttachment> {
  return invoke<UserReportAttachment>("clipboard_read_report_attachment");
}

export async function clipboardHasReportAttachment(): Promise<boolean> {
  try { return await invoke<boolean>("clipboard_has_report_attachment"); }
  catch { return false; }
}
