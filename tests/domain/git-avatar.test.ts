import { describe, expect, it } from "vitest";
import { avatarFallback } from "$lib/domain/git-avatar";

describe("git author avatar fallback", () => {
  it("keeps the same visible initial and colour for the same author after reload", () => {
    const first = avatarFallback({ name: "  Alice Coder ", email: "ALICE@example.com" });
    const reloaded = avatarFallback({ name: "Alice Coder", email: "alice@example.com" });

    expect(reloaded).toEqual(first);
    expect(first.initial).toBe("A");
    expect(first.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("still produces a usable disc when author metadata is missing", () => {
    expect(avatarFallback({ name: "", email: "" })).toEqual({
      initial: "?",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
  });
});
