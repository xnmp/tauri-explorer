import { describe, expect, it } from "vitest";
import { shouldRetireOnDragEnd } from "$lib/domain/drop-feedback";

describe("shouldRetireOnDragEnd", () => {
  it("retires feedback for a cancelled drag whose native hover had no session id", () => {
    expect(shouldRetireOnDragEnd({ endedSession: "a", liveSession: "a", hovering: true })).toBe(true);
    expect(shouldRetireOnDragEnd({ liveSession: "a", hovering: true })).toBe(true);
    expect(shouldRetireOnDragEnd({ hovering: true })).toBe(true);
  });
  it("retires when nothing is hovering", () => {
    expect(shouldRetireOnDragEnd({ hovering: false })).toBe(true);
    expect(shouldRetireOnDragEnd({ endedSession: "a", hovering: false })).toBe(true);
  });
  it("ignores a stale dragend while a different drag is live", () => {
    expect(shouldRetireOnDragEnd({ endedSession: "old", liveSession: "new", hovering: false })).toBe(false);
    expect(shouldRetireOnDragEnd({ endedSession: "old", liveSession: "new", hovering: true })).toBe(false);
  });
  it("ignores a stale dragend echo over a sessionless external hover", () => {
    expect(shouldRetireOnDragEnd({ endedSession: "old", hovering: true })).toBe(false);
  });
  it("only the session that owns the hover retires it", () => {
    expect(shouldRetireOnDragEnd({ endedSession: "a", liveSession: "a", hoverSession: "a", hovering: true })).toBe(true);
    expect(shouldRetireOnDragEnd({ endedSession: "b", hoverSession: "a", hovering: true })).toBe(false);
    expect(shouldRetireOnDragEnd({ liveSession: "b", hoverSession: "a", hovering: true })).toBe(false);
    expect(shouldRetireOnDragEnd({ liveSession: "a", hoverSession: "a", hovering: true })).toBe(true);
  });
});
