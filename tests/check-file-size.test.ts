import { describe, expect, it } from "vitest";
import { FILE_LINE_LIMIT, checkFileSizes, countLines } from "../scripts/check-file-size.mjs";

describe("countLines", () => {
  it("counts like wc -l for newline-terminated text", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
  });
  it("counts a final unterminated line", () => {
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("\n\n")).toBe(2);
  });
});

describe("checkFileSizes", () => {
  const limit = 10;
  it("passes files at or below the limit", () => {
    expect(checkFileSizes([{ path: "src/a.ts", lines: 10 }, { path: "src/b.ts", lines: 0 }], {}, limit)).toEqual({ errors: [], notes: [] });
  });
  it("fails a file over the limit without an entry", () => {
    const { errors } = checkFileSizes([{ path: "src/big.ts", lines: 11 }], {}, limit);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/big.ts: 11 lines exceeds the 10-line limit");
  });
  it("passes an allowlisted file at its entry", () => {
    expect(checkFileSizes([{ path: "src/big.ts", lines: 40 }], { "src/big.ts": 40 }, limit)).toEqual({ errors: [], notes: [] });
  });
  it("passes an allowlisted file below its entry, noting the tighter value", () => {
    const result = checkFileSizes([{ path: "src/big.ts", lines: 30 }], { "src/big.ts": 40 }, limit);
    expect(result.errors).toEqual([]);
    expect(result.notes[0]).toContain("lower the entry");
  });
  it("fails an allowlisted file that grew past its entry", () => {
    const { errors } = checkFileSizes([{ path: "src/big.ts", lines: 41 }], { "src/big.ts": 40 }, limit);
    expect(errors[0]).toContain("grew to 41 lines, past its allowlist entry of 40");
  });
  it("fails a stale entry for a file now within the limit", () => {
    const { errors } = checkFileSizes([{ path: "src/split.ts", lines: 10 }], { "src/split.ts": 900 }, limit);
    expect(errors[0]).toContain("remove its stale allowlist entry");
  });
  it("fails an entry whose file no longer exists", () => {
    const { errors } = checkFileSizes([], { "src/gone.ts": 900 }, limit);
    expect(errors[0]).toContain("src/gone.ts: allowlisted (900) but no longer exists");
  });
  it("does not treat inherited object keys as entries", () => {
    const { errors } = checkFileSizes([{ path: "constructor", lines: 11 }], {}, limit);
    expect(errors[0]).toContain("exceeds");
  });
  it("reports every failure, not just the first", () => {
    const { errors } = checkFileSizes([{ path: "src/a.ts", lines: 11 }, { path: "src/b.ts", lines: 50 }], { "src/b.ts": 20, "src/c.ts": 30 }, limit);
    expect(errors).toHaveLength(3);
  });
  it("defaults to the 800-line limit", () => {
    expect(FILE_LINE_LIMIT).toBe(800);
    expect(checkFileSizes([{ path: "src/a.ts", lines: 800 }], {}).errors).toEqual([]);
    expect(checkFileSizes([{ path: "src/a.ts", lines: 801 }], {}).errors).toHaveLength(1);
  });
});
