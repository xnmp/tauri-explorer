import type { UserReportKind } from "$lib/domain/user-report";
import { createCoalescedPersister, loadPersisted } from "./persisted";

export const USER_REPORT_DRAFT_KEY = "user-report-draft";

export interface UserReportTextDraft {
  kind: UserReportKind;
  title: string;
  body: string;
  contact: string;
}

const EMPTY_DRAFT: UserReportTextDraft = {
  kind: "bug",
  title: "",
  body: "",
  contact: "",
};

function normalizeDraft(value: Partial<UserReportTextDraft>): UserReportTextDraft {
  return {
    kind: value.kind === "feature" ? "feature" : "bug",
    title: typeof value.title === "string" ? value.title : "",
    body: typeof value.body === "string" ? value.body : "",
    contact: typeof value.contact === "string" ? value.contact : "",
  };
}

/**
 * Text-only Report Issue draft shared by the dialog and persisted between
 * launches. Attachments stay in the dialog's in-session retry state because
 * storing binary images in localStorage would be both large and unreliable.
 */
export function createUserReportDraftStore() {
  let value = $state<UserReportTextDraft>(
    normalizeDraft(loadPersisted<Partial<UserReportTextDraft>>(USER_REPORT_DRAFT_KEY, EMPTY_DRAFT)),
  );
  const persister = createCoalescedPersister<UserReportTextDraft>(USER_REPORT_DRAFT_KEY, 300);

  function update(next: Partial<UserReportTextDraft>): void {
    value = normalizeDraft({ ...value, ...next });
    persister.schedule(value);
  }

  function clear(): void {
    value = { ...EMPTY_DRAFT };
    // This also cancels an in-flight trailing write, so submitted text cannot
    // be written back after the relay reports success.
    persister.writeNow(value);
  }

  return {
    get value() {
      return value;
    },
    update,
    clear,
    dispose: () => persister.dispose(),
  };
}

export const userReportDraftStore = createUserReportDraftStore();
