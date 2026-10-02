import type {
  UserReportAttachment,
  UserReportAttachmentFile,
  UserReportKind,
} from "$lib/domain/user-report";
import {
  userReportAttachmentBytes,
  userReportAttachmentUsage,
  validateUserReportAttachmentFiles,
} from "$lib/domain/user-report";
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

type AttachmentReadKind = "files" | "clipboard";

/** Opaque token from `beginAttachmentRead`, carrying the generation it started
 *  in so a later `clear()` invalidates it without needing to track it in a set. */
interface AttachmentReadToken {
  readonly kind: AttachmentReadKind;
  readonly generation: number;
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
 * Report Issue draft: text (persisted between launches), in-session
 * attachments, and the attach/submit state machines. This is the sole owner
 * of all of it — the dialog derives its fields from here and calls into it
 * rather than keeping its own copies (#893).
 */
export function createUserReportDraftStore() {
  let value = $state<UserReportTextDraft>(
    normalizeDraft(loadPersisted<unknown>(USER_REPORT_DRAFT_KEY, EMPTY_DRAFT)),
  );
  const persister = createCoalescedPersister<UserReportTextDraft>(USER_REPORT_DRAFT_KEY, 300);
  let revision = 0;
  let pending = $state.raw<UserReportSubmission | null>(null);
  let attachments = $state.raw<UserReportAttachment[]>([]);
  // Attachments stay in-session only: storing binary images in localStorage
  // would be both large and unreliable.
  let clipboardAttachmentData = $state<string | null>(null);
  let generation = 0;
  let activeReads = $state<Record<AttachmentReadKind, number>>({ files: 0, clipboard: 0 });

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
    // Invalidate every read in flight rather than tracking each one in a set:
    // a bumped generation makes every existing token stale in one step.
    generation += 1;
    activeReads = { files: 0, clipboard: 0 };
    revision += 1;
    // This also cancels an in-flight trailing write, so submitted text cannot
    // be written back after the relay reports success.
    persister.writeNow(value);
  }

  /** Submission can outlive or close the page before the trailing save. */
  function saveNow(): void {
    persister.writeNow(value);
  }

  function currentUsage() {
    return userReportAttachmentUsage(attachments);
  }

  function beginAttachmentRead(kind: AttachmentReadKind): AttachmentReadToken | null {
    if (pending) return null;
    activeReads = { ...activeReads, [kind]: activeReads[kind] + 1 };
    return { kind, generation };
  }

  function isReadCurrent(read: AttachmentReadToken): boolean {
    return read.generation === generation;
  }

  function finishAttachmentRead(read: AttachmentReadToken): void {
    if (!isReadCurrent(read)) return;
    activeReads = { ...activeReads, [read.kind]: Math.max(0, activeReads[read.kind] - 1) };
  }

  /**
   * Runs the full begin-read → await → validate-against-latest → commit →
   * finish-read sequence for picked files. `readAll` is injected so the
   * store stays free of `File`/browser-IO concerns; it is only invoked once
   * the fast metadata-only validation against the current selection passes.
   * Returns a user-facing error message, or null on success (including when
   * a newer `clear()` made this read moot).
   */
  async function attachFiles(
    files: readonly UserReportAttachmentFile[],
    readAll: () => Promise<UserReportAttachment[]>,
  ): Promise<string | null> {
    const initialError = validateUserReportAttachmentFiles(files, currentUsage());
    if (initialError) return initialError;
    const read = beginAttachmentRead("files");
    if (!read) return null;
    try {
      const next = await readAll();
      if (!isReadCurrent(read)) return null;
      // Concurrent reads validate against the latest shared selection.
      const currentError = validateUserReportAttachmentFiles(files, currentUsage());
      if (currentError) return currentError;
      attachments = [...attachments, ...next.map((entry) => ({ ...entry }))];
      revision += 1;
      return null;
    } catch {
      return isReadCurrent(read)
        ? "Could not read the selected images. Try selecting them again."
        : null;
    } finally {
      finishAttachmentRead(read);
    }
  }

  /** Same sequence as `attachFiles`, for the single clipboard image. */
  async function attachClipboard(
    readImage: () => Promise<UserReportAttachment>,
  ): Promise<string | null> {
    const read = beginAttachmentRead("clipboard");
    if (!read) return null;
    try {
      const image = await readImage();
      if (!isReadCurrent(read)) return null;
      const error = validateUserReportAttachmentFiles(
        [{
          name: image.name,
          type: image.mediaType,
          size: userReportAttachmentBytes(image.data),
        }],
        currentUsage(),
      );
      if (error) return error;
      attachments = [...attachments, image];
      clipboardAttachmentData = image.data;
      revision += 1;
      return null;
    } catch {
      return isReadCurrent(read)
        ? "Could not read the clipboard image. Try saving it and selecting the file."
        : null;
    } finally {
      finishAttachmentRead(read);
    }
  }

  function removeAttachment(index: number): void {
    if (index < 0 || index >= attachments.length) return;
    attachments = attachments.filter((_, entryIndex) => entryIndex !== index);
    revision += 1;
  }

  function beginSubmission(): UserReportSubmission | null {
    if (pending || activeReads.files > 0 || activeReads.clipboard > 0) return null;
    saveNow();
    pending = { draft: { ...value }, revision };
    return pending;
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
    get readingAttachments() { return activeReads.files > 0 || activeReads.clipboard > 0; },
    get readingClipboard() { return activeReads.clipboard > 0; },
    update,
    attachFiles,
    attachClipboard,
    removeAttachment,
    saveNow,
    clear,
    beginSubmission,
    finishSubmission,
    dispose: () => persister.dispose(),
  };
}

export const userReportDraftStore = createUserReportDraftStore();
