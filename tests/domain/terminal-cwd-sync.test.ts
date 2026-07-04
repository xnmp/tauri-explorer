import { describe, it, expect } from "vitest";
import { decideCdSync } from "$lib/domain/terminal-cwd-sync";

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

describe("decideCdSync virtual paths (#152)", () => {
  it("never syncs a virtual location into the real shell", () => {
    expect(decideCdSync("demo://", null, false)).toBe("skip");
    expect(decideCdSync("demo://notes/a.txt", null, true)).toBe("skip");
    expect(decideCdSync("keep://x", "/home/user", false)).toBe("skip");
  });
});
