/**
 * Commit-panel store (#466): the in-flight commit guard must survive the panel
 * closing and reopening. Behavior under test (contracts, not internals):
 * - begin() enters the committing phase and returns true once;
 * - a second begin() while committing returns false (no second commit starts);
 * - resetIfIdle() (what close/reopen calls) is a no-op while committing, so the
 *   guard is not droppable via close + reopen;
 * - succeed()/fail() return to idle, after which begin() works again;
 * - stores are independent per pane.
 */
import { describe, it, expect } from "vitest";
import {
  getCommitPanelStore,
  disposeCommitPanelStore,
} from "../../src/lib/state/commit-panel.svelte";

describe("commit-panel store in-flight guard", () => {
  it("begin() starts a commit once and blocks a concurrent second start", () => {
    disposeCommitPanelStore("p1");
    const store = getCommitPanelStore("p1");
    store.setMessage("feat: x");

    expect(store.begin()).toBe(true);
    expect(store.committing).toBe(true);
    // Second attempt while in flight is refused.
    expect(store.begin()).toBe(false);
  });

  it("close + reopen mid-flight does NOT drop the guard", () => {
    disposeCommitPanelStore("p2");
    const store = getCommitPanelStore("p2");
    store.setMessage("feat: y");
    expect(store.begin()).toBe(true);

    // Simulate Escape (closeDetails) then reopen (selectCommit → closeDetails):
    // both call resetIfIdle(). While committing this must be a no-op.
    store.resetIfIdle();
    store.resetIfIdle();
    expect(store.committing).toBe(true);
    expect(store.message).toBe("feat: y"); // draft preserved, not reset

    // Re-opening the panel and hitting commit again cannot start a 2nd commit.
    expect(store.begin()).toBe(false);
  });

  it("succeed() clears the draft and re-enables begin()", () => {
    disposeCommitPanelStore("p3");
    const store = getCommitPanelStore("p3");
    store.setMessage("feat: z");
    expect(store.begin()).toBe(true);

    store.succeed();
    expect(store.committing).toBe(false);
    expect(store.message).toBe("");
    expect(store.begin()).toBe(true); // a fresh commit can start again
  });

  it("fail() preserves the message, surfaces the error, re-enables begin()", () => {
    disposeCommitPanelStore("p4");
    const store = getCommitPanelStore("p4");
    store.setMessage("keep me");
    expect(store.begin()).toBe(true);

    store.fail("commit rejected");
    expect(store.committing).toBe(false);
    expect(store.message).toBe("keep me");
    expect(store.error).toBe("commit rejected");
    expect(store.begin()).toBe(true);
  });

  it("resetIfIdle() clears the draft when idle", () => {
    disposeCommitPanelStore("p5");
    const store = getCommitPanelStore("p5");
    store.setMessage("draft");
    store.resetIfIdle();
    expect(store.message).toBe("");
  });

  it("stores are independent per pane", () => {
    disposeCommitPanelStore("a");
    disposeCommitPanelStore("b");
    const a = getCommitPanelStore("a");
    const b = getCommitPanelStore("b");
    a.setMessage("in A");
    expect(a.begin()).toBe(true);
    expect(b.committing).toBe(false);
    expect(b.message).toBe("");
  });
});
