import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findViolations } from "./support/text-field-scanner";

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "test-support" ? [] : svelteFiles(p);
    return p.endsWith(".svelte") ? [p] : [];
  });
}

describe("findViolations (scanner)", () => {
  const ok = 'autocorrect="off" autocapitalize="none" spellcheck="false"';

  it("accepts a fully attributed input", () => {
    expect(findViolations(`<input type="text" ${ok} />`)).toEqual([]);
  });

  it("names each missing attribute", () => {
    expect(findViolations('<input type="text" autocorrect="off" />')).toEqual([
      { line: 1, missing: ["autocapitalize", "spellcheck"] },
    ]);
  });

  it("flags a textarea and a bare input with the line number", () => {
    const v = findViolations("<div>\n<textarea bind:value={x}></textarea>\n<input bind:value={y} />\n</div>");
    expect(v.map((x) => x.line)).toEqual([2, 3]);
  });

  it("handles multi-line tags and > inside expressions", () => {
    const src = `<input\n  value={a > b ? "x" : "y"}\n  onkeydown={(e) => e.key === ">" && go()}\n  ${ok}\n/>`;
    expect(findViolations(src)).toEqual([]);
    expect(findViolations(src.replace('spellcheck="false"', ""))).toHaveLength(1);
  });

  it("does not mistake attribute names inside values for attributes", () => {
    expect(findViolations('<input placeholder="spellcheck autocorrect autocapitalize" />')[0].missing).toHaveLength(3);
  });

  it("skips statically non-text inputs but not text or dynamic types", () => {
    expect(findViolations('<input type="checkbox" />')).toEqual([]);
    expect(findViolations("<input type={'range'} />")).toEqual([]);
    expect(findViolations('<input type="search" />')).toHaveLength(1);
    expect(findViolations("<input type={kind} />")).toHaveLength(1);
  });

  it("does not let a spread exempt a field", () => {
    expect(findViolations("<input {...rest} />")).toHaveLength(1);
    expect(findViolations(`<input {...rest} ${ok} />`)).toEqual([]);
  });

  it("ignores lookalike tags", () => {
    expect(findViolations("<inputs /><Input /><textarea-x />")).toEqual([]);
  });
});

describe("text fields in src components", () => {
  it("every text input and textarea disables autocorrect, autocapitalize and spellcheck", () => {
    const root = join(process.cwd(), "src");
    const failures = svelteFiles(root).flatMap((file) =>
      findViolations(readFileSync(file, "utf8")).map(
        (v) => `${relative(process.cwd(), file)}:${v.line} missing ${v.missing.join(", ")}`,
      ),
    );
    expect(failures).toEqual([]);
  });
});
