import type { UserReportAttachment, UserReportKind } from "$lib/domain/user-report";
import { createCoalescedPersister, loadPersisted } from "./persisted";

export const USER_REPORT_DRAFT_KEY = "user-report-draft";

export interface UserReportTextDraft {
  kind: UserReportKind;
  title: string;
  body: string;
  contact: string;
}

export interface UserReportSubmission {
  readonly draft: UserReportTextDraft;
  readonly revision: number;
}

export interface UserReportAttachmentRead {
  readonly kind: "files" | "clipboard";
}

const EMPTY_DRAFT: UserReportTextDraft = {
  kind: "bug",
  title: "",
  body: "",
  contact: "",
};

function normalizeDraft(value: unknown): UserReportTextDraft {
  const draft = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Partial<UserReportTextDraft>
    : {};
  return {
    kind: draft.kind === "feature" ? "feature" : "bug",
    title: typeof draft.title === "string" ? draft.title : "",
    body: typeof draft.body === "string" ? draft.body : "",
    contact: typeof draft.contact === "string" ? draft.contact : "",
  };
}

/**
 * Text-only Report Issue draft shared by the dialog and persisted between
 * launches. Attachments stay in the store's in-session state because
 * storing binary images in localStorage would be both large and unreliable.
 */
export function createUserReportDraftStore() {
  let value = $state<UserReportTextDraft>(
    normalizeDraft(loadPersisted<unknown>(USER_REPORT_DRAFT_KEY, EMPTY_DRAFT)),
  );
  const persister = createCoalescedPersister<UserReportTextDraft>(USER_REPORT_DRAFT_KEY, 300);
  let revision = 0;
  let pending = $state.raw<UserReportSubmission | null>(null);
  let attachments = $state.raw<UserReportAttachment[]>([]);
  let clipboardAttachmentData = $state<string | null>(null);
  let attachmentReads = $state.raw<ReadonlySet<UserReportAttachmentRead>>(new Set());

  function update(next: Partial<UserReportTextDraft>): void {
    const normalized = normalizeDraft({ ...value, ...next });
    if (normalized.kind === value.kind && normalized.title === value.title
      && normalized.body === value.body && normalized.contact === value.contact) return;
    value = normalized;
    revision += 1;
    persister.schedule(value);
  }

  function clear(): void {
    value = { ...EMPTY_DRAFT };
    attachments = [];
    clipboardAttachmentData = null;
    attachmentReads = new Set();
    revision += 1;
    // This also cancels an in-flight trailing write, so submitted text cannot
    // be written back after the relay reports success.
    persister.writeNow(value);
  }

  /** Submission can outlive or close the page before the trailing save. */
  function saveNow(): void {
    persister.writeNow(value);
  }

  /** Binary drafts are window-lifetime only; never write them to localStorage. */
  function updateAttachments(next: UserReportAttachment[], clipboardData: string | null): void {
    if (clipboardData === clipboardAttachmentData && next.length === attachments.length
      && next.every((entry, index) => entry.name === attachments[index].name
        && entry.mediaType === attachments[index].mediaType && entry.data === attachments[index].data)) return;
    attachments = next.map((entry) => ({ ...entry }));
    clipboardAttachmentData = clipboardData;
    revision += 1;
  }

  function beginSubmission(): UserReportSubmission | null {
    if (pending || attachmentReads.size > 0) return null;
    saveNow();
    pending = { draft: { ...value }, revision };
    return pending;
  }

  function beginAttachmentRead(kind: UserReportAttachmentRead["kind"]): UserReportAttachmentRead | null {
    if (pending) return null;
    const read = { kind };
    attachmentReads = new Set([...attachmentReads, read]);
    return read;
  }

  function hasAttachmentRead(read: UserReportAttachmentRead): boolean {
    return attachmentReads.has(read);
  }

  function finishAttachmentRead(read: UserReportAttachmentRead): void {
    attachmentReads = new Set([...attachmentReads].filter((entry) => entry !== read));
  }

  function hasCurrentDraft(submission: UserReportSubmission): boolean {
    return pending === submission && revision === submission.revision;
  }

  /** Only this request may settle its pending state or clear its unchanged draft. */
  function finishSubmission(submission: UserReportSubmission, accepted = false): boolean {
    if (pending !== submission) return false;
    const shouldClear = accepted && hasCurrentDraft(submission);
    pending = null;
    if (shouldClear) clear();
    else saveNow();
    return shouldClear;
  }

  return {
    get value() {
      return value;
    },
    get submitting() { return pending !== null; },
    get attachments() { return attachments; },
    get clipboardAttachmentData() { return clipboardAttachmentData; },
    get readingAttachments() { return attachmentReads.size > 0; },
    get readingClipboard() { return [...attachmentReads].some((read) => read.kind === "clipboard"); },
    update,
    updateAttachments,
    saveNow,
    clear,
    beginSubmission,
    beginAttachmentRead,
    hasAttachmentRead,
    finishAttachmentRead,
    hasCurrentDraft,
    finishSubmission,
    dispose: () => persister.dispose(),
  };
}

export const userReportDraftStore = createUserReportDraftStore();
