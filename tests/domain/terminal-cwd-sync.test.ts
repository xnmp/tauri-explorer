import { describe, it, expect } from "vitest";
import { decideCdSync, createInjectedCdTracker } from "$lib/domain/terminal-cwd-sync";

describe("decideCdSync", () => {
  it("writes when idle and the shell is elsewhere", () => {
    expect(decideCdSync("/a", "/b", false)).toBe("write");
  });

  it("writes when the shell's cwd is unknown (null)", () => {
    expect(decideCdSync("/a", null, false)).toBe("write");
  });

  it("queues when busy and the shell is elsewhere", () => {
    expect(decideCdSync("/a", "/b", true)).toBe("queue");
  });

  it("skips when the shell is already at the target (idle)", () => {
    expect(decideCdSync("/a", "/a", false)).toBe("skip");
  });

  it("skip wins over queue when busy but already at the target", () => {
    expect(decideCdSync("/a", "/a", true)).toBe("skip");
  });

  it("does not skip against a null cwd even for the same string path", () => {
    // null means 'unknown', never equal to a real path.
    expect(decideCdSync("", null, false)).toBe("write");
  });
});

describe("createInjectedCdTracker (#266, #364)", () => {
  it("consumes one echo per injection", () => {
    const t = createInjectedCdTracker();
    t.add("/a");
    expect(t.consume("/a")).toBe(true);
    expect(t.consume("/a")).toBe(false); // second echo is a genuine user cd
  });

  it("counts duplicate injections instead of deduping (fast A→B→A switch)", () => {
    const t = createInjectedCdTracker();
    t.add("/a"); // switch to tab A
    t.add("/b"); // switch to tab B
    t.add("/a"); // back to tab A before A's first echo lands
    expect(t.consume("/a")).toBe(true);
    expect(t.consume("/b")).toBe(true);
    // The second /a echo is still ours — a Set-based tracker dropped it and
    // dragged the active tab to the stale path.
    expect(t.consume("/a")).toBe(true);
    expect(t.consume("/a")).toBe(false);
  });

  it("normalizes paths so a differing echo still matches", () => {
    const t = createInjectedCdTracker();
    t.add("/home/user/repo");
    expect(t.consume("/home/user/repo/")).toBe(true); // trailing slash echo
    t.add("C:\\Users\\Me");
    expect(t.consume("c:/users/me")).toBe(true); // Windows case + separators
  });

  it("evicts oldest entries beyond the cap (shells without OSC 7)", () => {
    const t = createInjectedCdTracker(2);
    t.add("/a");
    t.add("/b");
    t.add("/c"); // evicts /a
    expect(t.consume("/a")).toBe(false);
    expect(t.consume("/b")).toBe(true);
    expect(t.consume("/c")).toBe(true);
  });

  it("clear() drops everything", () => {
    const t = createInjectedCdTracker();
    t.add("/a");
    t.clear();
    expect(t.consume("/a")).toBe(false);
  });
});

describe("decideCdSync virtual paths (#152)", () => {
  it("never syncs a virtual location into the real shell", () => {
    expect(decideCdSync("demo://", null, false)).toBe("skip");
    expect(decideCdSync("demo://notes/a.txt", null, true)).toBe("skip");
    expect(decideCdSync("keep://x", "/home/user", false)).toBe("skip");
  });
});
