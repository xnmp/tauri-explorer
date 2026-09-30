import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_REPORT_DRAFT_KEY,
  createUserReportDraftStore,
} from "$lib/state/user-report-draft.svelte";
import type { UserReportAttachment } from "$lib/domain/user-report";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A controllable file-read promise: resolves only when the test calls `release`. */
function deferredRead<T>(): {
  read: () => Promise<T>;
  release: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { read: () => promise, release: resolve, reject };
}

describe("user report drafts", () => {
  const image: UserReportAttachment = { name: "proof.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
  const imageFile = { name: image.name, type: image.mediaType, size: 8 };

  it("blocks submission while any image read is pending across reopening", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Wait for selected images" });
    const files = deferredRead<UserReportAttachment[]>();
    const clipboard = deferredRead<UserReportAttachment>();
    const filesPromise = store.attachFiles([imageFile], files.read);
    const clipboardPromise = store.attachClipboard(clipboard.read);
    expect(store.readingAttachments).toBe(true);
    expect(store.readingClipboard).toBe(true);
    expect(store.beginSubmission()).toBeNull();

    files.release([image]);
    await filesPromise;
    expect(store.beginSubmission()).toBeNull();

    clipboard.release({ ...image, name: "clip.png" });
    await clipboardPromise;
    const submission = store.beginSubmission()!;
    expect(submission).not.toBeNull();
    store.finishSubmission(submission);
    store.dispose();
  });

  it("does not commit a stale read invalidated by a clear() while it was in flight", async () => {
    const store = createUserReportDraftStore();
    const oldRead = deferredRead<UserReportAttachment[]>();
    const attachPromise = store.attachFiles([imageFile], oldRead.read);
    expect(store.readingAttachments).toBe(true);

    store.clear();
    expect(store.readingAttachments).toBe(false);

    oldRead.release([image]);
    const error = await attachPromise;
    expect(error).toBeNull();
    // The stale read must not have committed its attachment after the clear.
    expect(store.attachments).toEqual([]);
    store.dispose();
  });

  it("lets a new read proceed normally after an older one was invalidated by clear()", async () => {
    const store = createUserReportDraftStore();
    const oldRead = deferredRead<UserReportAttachment[]>();
    const attachPromise = store.attachFiles([imageFile], oldRead.read);
    store.clear();

    const newError = await store.attachFiles([imageFile], () => Promise.resolve([image]));
    expect(newError).toBeNull();
    expect(store.attachments).toEqual([image]);

    oldRead.release([image]);
    await attachPromise;
    expect(store.attachments).toEqual([image]);
    store.dispose();
  });

  it("surfaces a read failure only for the read that is still current", async () => {
    const store = createUserReportDraftStore();
    const failing = deferredRead<UserReportAttachment[]>();
    const attachPromise = store.attachFiles([imageFile], failing.read);
    store.clear();
    failing.reject(new Error("disk error"));
    expect(await attachPromise).toBeNull();
    store.dispose();
  });

  it("reports a read failure for the current read", async () => {
    const store = createUserReportDraftStore();
    await expect(
      store.attachFiles([imageFile], () => Promise.reject(new Error("disk error"))),
    ).resolves.toBe("Could not read the selected images. Try selecting them again.");
    expect(store.readingAttachments).toBe(false);
    store.dispose();
  });

  it("retains current images for failure retries but never persists their bytes", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Image report" });
    expect(await store.attachClipboard(() => Promise.resolve(image))).toBeNull();
    const submission = store.beginSubmission()!;
    store.finishSubmission(submission);
    expect(store.attachments).toEqual([image]);
    expect(store.clipboardAttachmentData).toBe(image.data);
    expect(localStorage.getItem(USER_REPORT_DRAFT_KEY)).not.toContain(image.data);
    store.update({ title: "Edited after failure" });
    store.removeAttachment(0);
    expect(store.attachments).toEqual([]);
    expect(store.value.title).toBe("Edited after failure");
    vi.advanceTimersByTime(300);
    const restored = createUserReportDraftStore();
    expect(restored.value.title).toBe("Edited after failure");
    expect(restored.attachments).toEqual([]);
    restored.dispose();
    store.dispose();
  });

  it("clears attachments once an accepted submission's draft is still current", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Image report" });
    expect(await store.attachClipboard(() => Promise.resolve(image))).toBeNull();
    const submission = store.beginSubmission()!;
    expect(store.finishSubmission(submission, true)).toBe(true);
    expect(store.attachments).toEqual([]);
    store.dispose();
  });

  it("retains an attachment change made after a submission began instead of clearing it", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Second report" });
    expect(await store.attachFiles([imageFile], () => Promise.resolve([image]))).toBeNull();
    const submission = store.beginSubmission()!;
    // Bumps revision after the submission captured its own — e.g. the user
    // removes the attached image while the earlier request is still in flight.
    store.removeAttachment(0);
    expect(store.finishSubmission(submission, true)).toBe(false);
    expect(store.attachments).toEqual([]);
    expect(store.value.title).toBe("Second report");
    store.dispose();
  });

  it("rejects a new attachment that exceeds the shared limit without discarding the draft", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Limit test" });
    const oversized = { name: "big.png", type: "image/png", size: 3 * 1024 * 1024 + 1 };
    const error = await store.attachFiles([oversized], () => Promise.resolve([image]));
    expect(error).toContain("2 MiB");
    expect(store.attachments).toEqual([]);
    expect(store.value.title).toBe("Limit test");
    store.dispose();
  });

  it("does not start a read while a submission is pending", async () => {
    const store = createUserReportDraftStore();
    store.update({ title: "Pending submission" });
    const submission = store.beginSubmission()!;
    expect(await store.attachFiles([imageFile], () => Promise.resolve([image]))).toBeNull();
    expect(store.attachments).toEqual([]);
    store.finishSubmission(submission);
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

  it("saves the draft immediately once a submission begins, ahead of the debounce", () => {
    const draft = createUserReportDraftStore();
    draft.update({ title: "Last second report", body: "Recent details" });
    const submission = draft.beginSubmission()!;

    const restored = createUserReportDraftStore();
    expect(restored.value.title).toBe("Last second report");
    expect(restored.value.body).toBe("Recent details");
    restored.dispose();
    draft.finishSubmission(submission);
    draft.dispose();
  });
});
