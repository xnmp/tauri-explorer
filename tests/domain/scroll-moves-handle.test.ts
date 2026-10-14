import { describe, expect, it } from "vitest";
import { scrollMovesHandle } from "$lib/domain/scroll-moves-handle";

/** A tiny tree with DOM-like `contains` (inclusive, like Node.contains). */
function node(children: object[] = []): { contains(other: unknown): boolean } {
  const self = { contains: (other: unknown): boolean => other === self || children.some((child) => (child as typeof self).contains(other)) };
  return self;
}

describe("scrollMovesHandle", () => {
  const handle = node();
  const panel = node([handle]);
  const workspace = node([panel]);
  const document = node([workspace]);
  const fileList = node([node()]);
  const headerBody = node();

  it("ends the drag for a scroll that carries the handle", () => {
    expect(scrollMovesHandle(document, handle, document)).toBe(true);
    expect(scrollMovesHandle(workspace, handle, document)).toBe(true);
    expect(scrollMovesHandle(panel, handle, document)).toBe(true);
  });

  it("keeps the drag through a scroll of an unrelated scroller", () => {
    expect(scrollMovesHandle(fileList, handle, document)).toBe(false);
    expect(scrollMovesHandle(headerBody, handle, document)).toBe(false);
  });

  it("ends the drag for a synced scroller outside the handle's ancestors", () => {
    expect(scrollMovesHandle(headerBody, handle, document, [headerBody])).toBe(true);
    expect(scrollMovesHandle(fileList, handle, document, [null, undefined, headerBody])).toBe(false);
  });

  it("treats targets it cannot inspect as moving the handle", () => {
    for (const target of [null, undefined, {}, "window", 42]) {
      expect(scrollMovesHandle(target, handle, document), String(target)).toBe(true);
    }
  });

  it("still recognises the document once the handle is detached", () => {
    const detached = node();
    expect(scrollMovesHandle(document, detached, document)).toBe(true);
    expect(scrollMovesHandle(workspace, detached, document)).toBe(false);
  });
});
