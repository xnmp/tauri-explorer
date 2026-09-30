import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_REPORT_DRAFT_KEY,
  createUserReportDraftStore,
} from "$lib/state/user-report-draft.svelte";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("user report drafts", () => {
  const image = { name: "proof.png", mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

  it("blocks submission while any image read is pending across reopening", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Wait for selected images" });
    const file = store.beginAttachmentRead("files")!;
    const clipboard = store.beginAttachmentRead("clipboard")!;
    expect(store.readingAttachments).toBe(true);
    expect(store.readingClipboard).toBe(true);
    expect(store.beginSubmission()).toBeNull();
    store.finishAttachmentRead(file);
    expect(store.beginSubmission()).toBeNull();
    store.finishAttachmentRead(clipboard);
    const submission = store.beginSubmission()!;
    expect(submission).not.toBeNull();
    expect(store.beginAttachmentRead("files")).toBeNull();
    store.finishSubmission(submission);
    store.dispose();
  });

  it("invalidates old image reads when a draft is cleared without ending a newer read", () => {
    const store = createUserReportDraftStore();
    const oldRead = store.beginAttachmentRead("files")!;
    store.clear();
    const newRead = store.beginAttachmentRead("files")!;
    expect(store.hasAttachmentRead(oldRead)).toBe(false);
    store.finishAttachmentRead(oldRead);
    expect(store.hasAttachmentRead(newRead)).toBe(true);
    expect(store.readingAttachments).toBe(true);
    store.finishAttachmentRead(newRead);
    store.dispose();
  });

  it("retains current images for failure retries but never persists their bytes", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Image report" });
    store.updateAttachments([image], image.data);
    const submission = store.beginSubmission()!;
    store.finishSubmission(submission);
    expect(store.attachments).toEqual([image]);
    expect(store.clipboardAttachmentData).toBe(image.data);
    expect(localStorage.getItem(USER_REPORT_DRAFT_KEY)).not.toContain(image.data);
    store.update({ title: "Edited after failure" });
    store.updateAttachments([], null);
    expect(store.attachments).toEqual([]);
    expect(store.value.title).toBe("Edited after failure");
    vi.advanceTimersByTime(300);
    const restored = createUserReportDraftStore();
    expect(restored.value.title).toBe("Edited after failure");
    expect(restored.attachments).toEqual([]);
    restored.dispose();
    store.dispose();
  });

  it("clears accepted unchanged images but retains a newer image selection", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Image report" });
    store.updateAttachments([image], image.data);
    let submission = store.beginSubmission()!;
    store.updateAttachments([{ ...image }], image.data);
    expect(store.finishSubmission(submission, true)).toBe(true);
    expect(store.attachments).toEqual([]);
    store.update({ title: "Second report" });
    submission = store.beginSubmission()!;
    store.updateAttachments([image], null);
    expect(store.finishSubmission(submission, true)).toBe(false);
    expect(store.attachments).toEqual([image]);
    expect(store.value.title).toBe("Second report");
    store.dispose();
  });

  it("keeps a pending submission exclusive across repeated opens and updates", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Pending report" });
    const submission = store.beginSubmission()!;
    expect(store.submitting).toBe(true);
    store.update({ ...store.value });
    expect(store.beginSubmission()).toBeNull();
    expect(store.finishSubmission(submission, true)).toBe(true);
    expect(store.submitting).toBe(false);
    expect(store.value.title).toBe("");
    store.dispose();
  });

  it("preserves and persists a newer draft when the older report succeeds", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Sent report" });
    const submission = store.beginSubmission()!;
    store.update({ title: "New unsent report", body: "Keep these new details" });
    expect(store.finishSubmission(submission, true)).toBe(false);
    expect(store.submitting).toBe(false);
    const restored = createUserReportDraftStore();
    expect(restored.value.title).toBe("New unsent report");
    expect(restored.value.body).toBe("Keep these new details");
    restored.dispose();
    store.dispose();
  });

  it("does not let an old completion settle or clear a replacement request", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "First report" });
    const first = store.beginSubmission()!;
    store.finishSubmission(first);
    store.update({ title: "Second report" });
    const second = store.beginSubmission()!;
    expect(store.finishSubmission(first, true)).toBe(false);
    expect(store.submitting).toBe(true);
    expect(store.value.title).toBe("Second report");
    expect(store.finishSubmission(second, true)).toBe(true);
    store.dispose();
  });

  it("retains failed text and allows an explicit retry", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Retry report" });
    const submission = store.beginSubmission()!;
    expect(store.finishSubmission(submission)).toBe(false);
    expect(store.value.title).toBe("Retry report");
    expect(store.beginSubmission()).not.toBeNull();
    store.dispose();
  });

  it("preserves edits even if the user changes the text back before completion", () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Same final text" });
    const submission = store.beginSubmission()!;
    store.update({ title: "Changed text" });
    store.update({ title: "Same final text" });
    expect(store.finishSubmission(submission, true)).toBe(false);
    expect(store.value.title).toBe("Same final text");
    store.dispose();
  });

  it("falls back to an empty draft when persisted JSON is not an object", () => {
    localStorage.setItem(USER_REPORT_DRAFT_KEY, "null");

    const draft = createUserReportDraftStore();

    expect(draft.value).toEqual({
      kind: "bug",
      title: "",
      body: "",
      contact: "",
    });
    draft.dispose();
  });

  it("restores the unsent text and report kind after the store is recreated", () => {
    const draft = createUserReportDraftStore();

    draft.update({
      kind: "feature",
      title: "Keep my report",
      body: "The dialog should keep this description.",
      contact: "@reporter",
    });
    vi.advanceTimersByTime(300);
    draft.dispose();

    const restored = createUserReportDraftStore();
    expect(restored.value).toEqual({
      kind: "feature",
      title: "Keep my report",
      body: "The dialog should keep this description.",
      contact: "@reporter",
    });
    restored.dispose();
  });

  it("resets persisted text after a successful submission", () => {
    localStorage.setItem(USER_REPORT_DRAFT_KEY, JSON.stringify({
      kind: "feature",
      title: "Already submitted",
      body: "Old description",
      contact: "@reporter",
    }));
    const draft = createUserReportDraftStore();

    draft.clear();
    draft.dispose();

    const reopened = createUserReportDraftStore();
    expect(reopened.value).toEqual({
      kind: "bug",
      title: "",
      body: "",
      contact: "",
    });
    reopened.dispose();
  });

  it("saves the submitted draft immediately for an uncertain network outcome", () => {
    const draft = createUserReportDraftStore();
    draft.update({ title: "Last second report", body: "Recent details" });
    draft.saveNow();

    const restored = createUserReportDraftStore();
    expect(restored.value.title).toBe("Last second report");
    expect(restored.value.body).toBe("Recent details");
    restored.dispose();
    draft.dispose();
  });
});
