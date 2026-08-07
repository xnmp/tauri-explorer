/**
 * Toast store replacement semantics (#596).
 *
 * `show` deliberately keeps only one toast per type, so a repeated
 * notification supersedes itself instead of stacking. That is also the rule
 * that made an in-flight indicator typed `info` vanish when any unrelated
 * info toast arrived — including one broadcast from another window. These
 * tests pin the rule and the `progress` type that exists because of it.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { toastStore } from "$lib/state/toast.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  toastStore.clear();
});

afterEach(() => {
  toastStore.clear();
  vi.useRealTimers();
});

const messages = () => toastStore.toasts.map((toast) => toast.message);
const types = () => toastStore.toasts.map((toast) => toast.type);

describe("toastStore.show", () => {
  it("keeps only the newest toast of a given type", () => {
    toastStore.show("Refreshed", "info");
    toastStore.show("Already up to date", "info");
    expect(messages()).toEqual(["Already up to date"]);
  });

  it("does not displace toasts of other types", () => {
    toastStore.show("Submitting report…", "progress");
    toastStore.show("Refreshed", "info");
    toastStore.show("Copied", "clipboard");
    expect(types()).toEqual(expect.arrayContaining(["progress", "info", "clipboard"]));
    expect(messages()).toContain("Submitting report…");
  });

  it("lets an in-flight progress toast survive unrelated info chatter", () => {
    // The #596 regression in one assertion: an info-typed indicator would be
    // gone here, leaving the user with no sign the work is still running.
    const pending = toastStore.show("Submitting report…", "progress");
    toastStore.show("Refreshed", "info");
    toastStore.show("Already up to date", "info");
    expect(messages()).toContain("Submitting report…");

    toastStore.dismiss(pending);
    expect(messages()).not.toContain("Submitting report…");
  });

  it("gives progress toasts a duration that outlives ordinary ones", () => {
    // The explicit dismissal is the normal path; this is the backstop for an
    // operation that never settles, so it must not expire mid-flight.
    toastStore.show("Refreshed", "info");
    toastStore.show("Submitting report…", "progress");

    vi.advanceTimersByTime(5000);
    expect(messages()).toEqual(["Submitting report…"]);

    vi.advanceTimersByTime(30_000);
    expect(messages()).toEqual([]);
  });

  it("dismissing an already-replaced id is a harmless no-op", () => {
    // A second submission supersedes the first one's toast; the first's
    // `finally` still runs and must not remove the live one.
    const first = toastStore.show("Submitting report…", "progress");
    const second = toastStore.show("Submitting report…", "progress");
    expect(first).not.toBe(second);

    toastStore.dismiss(first);
    expect(toastStore.toasts.map((toast) => toast.id)).toEqual([second]);
  });
});
