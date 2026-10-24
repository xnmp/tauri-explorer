import { describe, expect, it } from "vitest";
import {
  MAX_CLOSED_PANES,
  prefersPaneRestore,
  pushClosedPane,
  repeatsWindowClose,
  type ClosedPaneSnapshot,
} from "$lib/domain/closed-panes";

const pane = (ts: number): ClosedPaneSnapshot => ({
  tabId: "tab", path: `/p/${ts}`, siblingId: "s", placement: "right", ratio: 0.5,
  fileView: undefined, peeks: [], ts,
});

describe("pushClosedPane", () => {
  it("pushes on top without mutating the previous stack", () => {
    const stack = [pane(1)];
    const next = pushClosedPane(stack, pane(2));
    expect(next.map((p) => p.ts)).toEqual([1, 2]);
    expect(stack.map((p) => p.ts)).toEqual([1]);
  });

  it("keeps only the newest MAX_CLOSED_PANES snapshots", () => {
    let stack: ClosedPaneSnapshot[] = [];
    for (let ts = 1; ts <= MAX_CLOSED_PANES + 3; ts++) stack = pushClosedPane(stack, pane(ts));
    expect(stack).toHaveLength(MAX_CLOSED_PANES);
    expect(stack[0].ts).toBe(4);
    expect(stack.at(-1)!.ts).toBe(MAX_CLOSED_PANES + 3);
  });
});

describe("prefersPaneRestore", () => {
  it("restores the pane when it closed at the same time as, or after, the last tab", () => {
    expect(prefersPaneRestore(pane(10), 5)).toBe(true);
    expect(prefersPaneRestore(pane(10), 10)).toBe(true);
    expect(prefersPaneRestore(pane(10), undefined)).toBe(true);
  });

  it("restores the tab when it is newer or there is no pane", () => {
    expect(prefersPaneRestore(pane(10), 11)).toBe(false);
    expect(prefersPaneRestore(undefined, undefined)).toBe(false);
  });
});

describe("repeatsWindowClose", () => {
  const closing = { fromClosedWindow: true, path: "/home", closedAt: 0 };

  it("detects a repeated close of the same last tab", () => {
    expect(repeatsWindowClose(closing, { ...closing })).toBe(true);
  });

  it("allows ordinary tab closes and different window closes", () => {
    expect(repeatsWindowClose(undefined, closing)).toBe(false);
    expect(repeatsWindowClose({ ...closing, fromClosedWindow: false }, closing)).toBe(false);
    expect(repeatsWindowClose(closing, { ...closing, fromClosedWindow: false })).toBe(false);
    expect(repeatsWindowClose(closing, { ...closing, path: "/other" })).toBe(false);
    expect(repeatsWindowClose(closing, { ...closing, closedAt: 1 })).toBe(false);
  });
});
