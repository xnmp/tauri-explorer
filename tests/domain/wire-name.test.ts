/**
 * Wire names (#1592, ADR 0031): display text and typed-text encoding for
 * file names that are not valid UTF-8. The vectors are shared with the Rust
 * encoder's tests, so both sides agree on every spelling.
 */
import { describe, it, expect } from "vitest";
import fixture from "../fixtures/wire-path.json";
import { displayName, renameRequest, toWireText } from "$lib/domain/wire-name";

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** The native bytes a canonical wire string names (test oracle). */
function wireBytes(wire: string): number[] {
  return Array.from(wire).flatMap((c) => {
    const code = c.codePointAt(0)!;
    return code >= 0xef80 && code <= 0xefff
      ? [code - 0xef00]
      : Array.from(new TextEncoder().encode(c));
  });
}

describe("displayName", () => {
  it.each(fixture.vectors)("shows $label as the Rust lossy display text", ({ wire, display }) => {
    expect(displayName(wire)).toBe(display);
  });

  it("matches lossy decoding of the native bytes", () => {
    for (const { bytes, wire } of fixture.vectors) {
      expect(displayName(wire)).toBe(new TextDecoder().decode(bytesOf(bytes)));
    }
  });

  it("returns ordinary text unchanged", () => {
    for (const text of ["", "a.txt", "日本語 ümlaut.txt", "", "�"]) {
      expect(displayName(text)).toBe(text);
    }
  });

  it("decodes each run of escapes on its own", () => {
    // "é" escaped twice around a slash: each run is complete UTF-8.
    expect(displayName("/a/b")).toBe("/aé/bé");
    // Separated by ASCII, a split sequence stays invalid in both halves.
    expect(displayName("x")).toBe("�x�");
  });

  it("handles very long names", () => {
    const wire = "".repeat(100_000);
    expect(displayName(wire)).toBe("�".repeat(100_000));
  });
});

describe("toWireText", () => {
  it.each(fixture.vectors.filter(({ bytes }) => isUtf8(bytesOf(bytes))))(
    "spells typed $label as the Rust encoder does",
    ({ bytes, wire }) => {
      expect(toWireText(new TextDecoder().decode(bytesOf(bytes)))).toBe(wire);
    },
  );

  it("names the same bytes as the typed UTF-8 text", () => {
    for (const typed of ["x.txt", "", "ab", "plain"]) {
      expect(wireBytes(toWireText(typed))).toEqual(Array.from(new TextEncoder().encode(typed)));
    }
  });

  it("leaves text without reserved characters unchanged", () => {
    for (const text of ["", "New folder", "é€", "", "", "�"]) {
      expect(toWireText(text)).toBe(text);
    }
  });

  it("is displayed as what was typed", () => {
    for (const typed of ["x.txt", "", "ok"]) {
      expect(displayName(toWireText(typed))).toBe(typed);
    }
  });
});

describe("renameRequest", () => {
  it.each(fixture.rename)("$label", ({ current, typed, request }) => {
    expect(renameRequest(current, typed)).toBe(request);
  });
});

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

describe("toWireText on extreme input", () => {
  it("escapes very long runs of reserved characters", () => {
    const typed = "".repeat(200_000);
    expect(toWireText(typed)).toBe("".repeat(200_000));
  });
});
