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
});
