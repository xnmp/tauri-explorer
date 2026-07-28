import type {
  SubmittedUserReport,
  UserReportAttachment,
  UserReportDraft,
} from "$lib/domain/user-report";
import { invoke } from "./files";

export function submitUserReport(
  draft: UserReportDraft,
): Promise<SubmittedUserReport> {
  return invoke<SubmittedUserReport>("submit_user_report", {
    title: draft.title,
    body: draft.body,
    kind: draft.kind,
    contact: draft.contact || null,
    attachments: draft.attachments ?? [],
  });
}

export function readClipboardReportImage(): Promise<UserReportAttachment> {
  return invoke<UserReportAttachment>("clipboard_read_report_image");
}
