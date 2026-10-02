import { describe, expect, it } from "vitest";
import { selectPasteSource, type ClipboardSnapshotView } from "$lib/domain/paste-source";

const entry = (path: string) => ({ path });
const snapshot = (over: Partial<ClipboardSnapshotView<{ path: string }>>): ClipboardSnapshotView<{ path: string }> => ({
  revision: 7, entries: null, paths: [], operation: null, ...over,
});

describe("selectPasteSource", () => {
  it("pastes the app's own Cut while the system clipboard still mirrors it", () => {
    const source = selectPasteSource(snapshot({ entries: [entry("/a")], paths: ["/a"], operation: "cut" }), null);
    expect(source).toEqual({ kind: "internal", entries: [entry("/a")], operation: "cut", revision: 7 });
  });

  it("pastes an external file list when the app holds no entries", () => {
    expect(selectPasteSource(snapshot({ paths: ["/ext/a", "/ext/b"] }), null))
      .toEqual({ kind: "external", paths: ["/ext/a", "/ext/b"] });
  });

  it("does not paste app entries whose system mirror was replaced by an empty clipboard", () => {
    expect(selectPasteSource(snapshot({ entries: [entry("/a")], paths: [], operation: "copy" }), null))
      .toEqual({ kind: "none" });
  });

  it("keeps an in-app Copy usable when the system clipboard cannot be read", () => {
    const source = selectPasteSource(snapshot({ entries: [entry("/a")], operation: "copy" }), "xclip missing");
    expect(source.kind).toBe("internal");
  });

  it("never pastes a Cut from app state alone when the system clipboard cannot be read", () => {
    expect(selectPasteSource(snapshot({ entries: [entry("/a")], operation: "cut" }), "xclip missing"))
      .toEqual({ kind: "none" });
  });

  it("reports nothing to paste without a snapshot", () => {
    expect(selectPasteSource(null, "worker exited")).toEqual({ kind: "none" });
    expect(selectPasteSource(null, null)).toEqual({ kind: "none" });
  });
});
