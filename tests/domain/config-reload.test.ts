/**
 * Config autoreload decision (#599).
 *
 * The whole point of this function is refusing to adopt changes that are our
 * own, so the tests are mostly about the rejection paths — a permissive bug
 * here reverts the user's most recent setting change or loops writes forever.
 */
import { describe, it, expect } from "vitest";
import { decideConfigReload } from "$lib/domain/config-reload";

const base = {
  raw: '{"theme":"nord"}',
  normalized: '{"theme":"nord"}',
  currentNormalized: '{"theme":"light"}',
  lastWritten: null as string | null,
  selfWriteRaced: false,
};

describe("decideConfigReload", () => {
  it("adopts a genuine external edit", () => {
    expect(decideConfigReload(base)).toEqual({ apply: true, reason: "external-change" });
  });

  it("refuses when one of our own writes overlapped the read", () => {
    // The disk snapshot may predate a write we have already issued; adopting
    // it would revert whatever the user just changed.
    expect(decideConfigReload({ ...base, selfWriteRaced: true })).toEqual({
      apply: false,
      reason: "self-write-overlap",
    });
  });

  it("refuses our own write echoing back", () => {
    expect(
      decideConfigReload({ ...base, lastWritten: base.raw }),
    ).toEqual({ apply: false, reason: "own-write-echo" });
  });

  it("adopts an external edit made after one of our writes", () => {
    // lastWritten is set but no longer matches the file: someone else wrote.
    expect(
      decideConfigReload({ ...base, lastWritten: '{"theme":"light"}' }),
    ).toEqual({ apply: true, reason: "external-change" });
  });

  it("keeps current state when the file is unusable", () => {
    for (const raw of ["", "   ", "{ not json", "null", "[1,2]"]) {
      expect(
        decideConfigReload({ ...base, raw, normalized: null }),
      ).toEqual({ apply: false, reason: "unusable" });
    }
  });

  it("treats a semantically identical file as unchanged", () => {
    // Reformatting or reordering settings.json by hand normalizes to the same
    // value; re-seating state for that would repaint for nothing.
    expect(
      decideConfigReload({
        ...base,
        raw: '{\n  "theme":  "light"\n}',
        normalized: base.currentNormalized,
      }),
    ).toEqual({ apply: false, reason: "unchanged" });
  });

  it("reports a self-write as such even when it is also unusable or unchanged", () => {
    // Order matters: a file observed mid-save can be truncated, and calling
    // that "corrupt external edit" would be a misleading diagnosis.
    expect(
      decideConfigReload({ ...base, selfWriteRaced: true, normalized: null }),
    ).toEqual({ apply: false, reason: "self-write-overlap" });
    expect(
      decideConfigReload({
        ...base,
        lastWritten: base.raw,
        normalized: base.currentNormalized,
      }),
    ).toEqual({ apply: false, reason: "own-write-echo" });
  });

  it("does not mistake a never-written file for an echo of empty content", () => {
    // lastWritten === null must never compare equal to a raw "" file.
    expect(
      decideConfigReload({ ...base, raw: "", normalized: null, lastWritten: null }),
    ).toEqual({ apply: false, reason: "unusable" });
  });
});
