import { describe, it, expect } from "vitest";
import {
  applyWordEdit,
  findNextWordBoundary,
  findPrevWordBoundary,
  wordEditCommand,
  type TextFieldState,
} from "$lib/domain/word-boundary";

describe("findNextWordBoundary", () => {
  it("stops at underscores", () => {
    expect(findNextWordBoundary("hello_world", 0)).toBe(5);
    expect(findNextWordBoundary("hello_world", 5)).toBe(6);
    expect(findNextWordBoundary("hello_world", 6)).toBe(11);
  });

  it("stops at hyphens", () => {
    expect(findNextWordBoundary("my-file-name", 0)).toBe(2);
    expect(findNextWordBoundary("my-file-name", 3)).toBe(7);
  });

  it("stops at dots", () => {
    expect(findNextWordBoundary("file.txt", 0)).toBe(4);
    expect(findNextWordBoundary("file.txt", 4)).toBe(5);
    expect(findNextWordBoundary("file.txt", 5)).toBe(8);
  });

  it("stops at camelCase boundaries", () => {
    expect(findNextWordBoundary("camelCase", 0)).toBe(5);
    expect(findNextWordBoundary("camelCase", 5)).toBe(9);
  });

  it("handles consecutive uppercase (acronyms)", () => {
    expect(findNextWordBoundary("XMLParser", 0)).toBe(3);
    expect(findNextWordBoundary("XMLParser", 3)).toBe(9);
  });

  it("stops at digit boundaries", () => {
    expect(findNextWordBoundary("file123name", 0)).toBe(4);
    expect(findNextWordBoundary("file123name", 4)).toBe(7);
    expect(findNextWordBoundary("file123name", 7)).toBe(11);
  });

  it("returns text.length at end", () => {
    expect(findNextWordBoundary("abc", 3)).toBe(3);
  });
});

describe("findPrevWordBoundary", () => {
  it("stops at underscores", () => {
    expect(findPrevWordBoundary("hello_world", 11)).toBe(6);
    expect(findPrevWordBoundary("hello_world", 6)).toBe(5);
    expect(findPrevWordBoundary("hello_world", 5)).toBe(0);
  });

  it("stops at hyphens", () => {
    expect(findPrevWordBoundary("my-file-name", 12)).toBe(8);
    expect(findPrevWordBoundary("my-file-name", 7)).toBe(3);
  });

  it("stops at dots", () => {
    expect(findPrevWordBoundary("file.txt", 8)).toBe(5);
    expect(findPrevWordBoundary("file.txt", 5)).toBe(4);
    expect(findPrevWordBoundary("file.txt", 4)).toBe(0);
  });

  it("stops at camelCase boundaries", () => {
    expect(findPrevWordBoundary("camelCase", 9)).toBe(5);
    expect(findPrevWordBoundary("camelCase", 5)).toBe(0);
  });

  it("handles consecutive uppercase (acronyms)", () => {
    expect(findPrevWordBoundary("XMLParser", 9)).toBe(3);
    expect(findPrevWordBoundary("XMLParser", 3)).toBe(0);
  });

  it("stops at digit boundaries", () => {
    expect(findPrevWordBoundary("file123name", 11)).toBe(7);
    expect(findPrevWordBoundary("file123name", 7)).toBe(4);
    expect(findPrevWordBoundary("file123name", 4)).toBe(0);
  });

  it("returns 0 at start", () => {
    expect(findPrevWordBoundary("abc", 0)).toBe(0);
  });
});

// #1746: every punctuation character separates words, not only whitespace
// and a handful of filename characters.
describe("punctuation separators (#1746)", () => {
  const stopsRight = (text: string) => {
    const stops: number[] = [];
    for (let pos = 0; pos < text.length; ) stops.push((pos = findNextWordBoundary(text, pos)));
    return stops;
  };
  const stopsLeft = (text: string) => {
    const stops: number[] = [];
    for (let pos = text.length; pos > 0; ) stops.push((pos = findPrevWordBoundary(text, pos)));
    return stops;
  };

  it.each(["'", "!", "&", "+", "@", "#", "~", ";", "=", ",", "%", "$", "^", "`", "\u2014", "\u00b7"])(
    "stops on both sides of %s",
    (sep) => {
      const text = `one${sep}two`;
      expect(stopsRight(text)).toEqual([3, 4, 7]);
      expect(stopsLeft(text)).toEqual([4, 3, 0]);
    },
  );

  it("treats a punctuation run as one separator", () => {
    expect(stopsRight("Tom's - draft (v2)!.txt")).toEqual([3, 4, 5, 8, 13, 15, 16, 17, 20, 23]);
  });

  it("keeps accented and non-Latin letters inside words", () => {
    expect(findNextWordBoundary("café-crème", 0)).toBe(4);
    expect(findNextWordBoundary("日本語.txt", 0)).toBe(3);
  });
});

describe("wordEditCommand", () => {
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("uses Ctrl on Windows/Linux", () => {
    expect(wordEditCommand(key("ArrowLeft", { ctrlKey: true }), false)).toEqual({ kind: "move", forward: false });
    expect(wordEditCommand(key("ArrowRight", { ctrlKey: true }), false)).toEqual({ kind: "move", forward: true });
    expect(wordEditCommand(key("Backspace", { ctrlKey: true }), false)).toEqual({ kind: "delete", forward: false });
    expect(wordEditCommand(key("Delete", { ctrlKey: true }), false)).toEqual({ kind: "delete", forward: true });
    expect(wordEditCommand(key("ArrowLeft", { altKey: true }), false)).toBeNull();
    expect(wordEditCommand(key("ArrowLeft"), false)).toBeNull();
  });

  it("uses Option on macOS and leaves Cmd+Arrow native", () => {
    expect(wordEditCommand(key("ArrowLeft", { altKey: true }), true)).toEqual({ kind: "move", forward: false });
    expect(wordEditCommand(key("Backspace", { altKey: true }), true)).toEqual({ kind: "delete", forward: false });
    expect(wordEditCommand(key("ArrowLeft", { metaKey: true }), true)).toBeNull();
    expect(wordEditCommand(key("Backspace", { metaKey: true }), true)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(wordEditCommand(key("a", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("applyWordEdit", () => {
  const caret = (value: string, at: number): TextFieldState =>
    ({ value, selectionStart: at, selectionEnd: at, selectionDirection: "none" });

  it("moves the caret by punctuation-delimited words", () => {
    expect(applyWordEdit(caret("a+b", 0), { kind: "move", forward: true }, false))
      .toEqual(caret("a+b", 1));
    expect(applyWordEdit(caret("a+b", 3), { kind: "move", forward: false }, false))
      .toEqual(caret("a+b", 2));
  });

  it("collapses a selection toward the direction of travel", () => {
    const selected: TextFieldState = { value: "one&two&six", selectionStart: 4, selectionEnd: 7, selectionDirection: "forward" };
    expect(applyWordEdit(selected, { kind: "move", forward: true }, false).selectionStart).toBe(8);
    expect(applyWordEdit(selected, { kind: "move", forward: false }, false).selectionStart).toBe(3);
  });

  it("extends and shrinks a selection from its anchor", () => {
    const grown = applyWordEdit(caret("one&two", 0), { kind: "move", forward: true }, true);
    expect(grown).toEqual({ value: "one&two", selectionStart: 0, selectionEnd: 3, selectionDirection: "forward" });
    const back = applyWordEdit(caret("one&two", 7), { kind: "move", forward: false }, true);
    expect(back).toEqual({ value: "one&two", selectionStart: 4, selectionEnd: 7, selectionDirection: "backward" });
    const further = applyWordEdit(back, { kind: "move", forward: false }, true);
    expect(further).toEqual({ value: "one&two", selectionStart: 3, selectionEnd: 7, selectionDirection: "backward" });
  });

  it("deletes the previous or next word up to punctuation", () => {
    expect(applyWordEdit(caret("report(final).pdf", 12), { kind: "delete", forward: false }, false))
      .toEqual(caret("report().pdf", 7));
    expect(applyWordEdit(caret("report(final).pdf", 7), { kind: "delete", forward: true }, false))
      .toEqual(caret("report().pdf", 7));
  });

  it("deletes a non-empty selection instead of a word", () => {
    const selected: TextFieldState = { value: "a.b.c", selectionStart: 1, selectionEnd: 4, selectionDirection: "forward" };
    expect(applyWordEdit(selected, { kind: "delete", forward: false }, false)).toEqual(caret("ac", 1));
  });
});
