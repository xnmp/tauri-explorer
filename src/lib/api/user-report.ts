import type {
  SubmittedUserReport,
  UserReportAttachment,
  UserReportDraft,
} from "$lib/domain/user-report";
import { invoke } from "./common";

export function submitUserReport(
  draft: UserReportDraft,
): Promise<SubmittedUserReport> {
  return invoke<SubmittedUserReport>("submit_user_report", {
    title: draft.title,
    body: draft.body,
    kind: draft.kind,
    contact: draft.contact || null,
    attachments: draft.attachments ?? [],
    diagnostics: draft.diagnostics || null,
  });
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
