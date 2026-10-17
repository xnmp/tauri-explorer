import { describe, expect, it } from "vitest";
import { loadView, optionalViewFor } from "$lib/components/view-loaders";

describe("view loaders", () => {
  it("shares one in-flight import per view so early preloading is joined, not repeated", async () => {
    const first = loadView("tiles");
    expect(loadView("tiles")).toBe(first);
    expect(loadView("list")).not.toBe(first);
    expect((await first).default).toBeTypeOf("function");
  });
  it("picks the renderer for a pane configuration; Details is built in", () => {
    expect(optionalViewFor("details", true)).toBeNull();
    expect(optionalViewFor("list", true)).toBe("list-columns");
    expect(optionalViewFor("list", false)).toBe("list");
    expect(optionalViewFor("tiles", true)).toBe("tiles");
  });
});
