import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/directory-wire.json";
import { decodeDirectoryListing, decodeDirectoryListingExtra } from "$lib/api/directory-wire";
import { encodeDirectoryListing } from "$lib/api/directory-wire-encode";
import type { DirectoryListing, FileEntry } from "$lib/domain/file";

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const hexOf = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const decode = (bytes: Uint8Array | ArrayBuffer) => {
  const { path, entries } = decodeDirectoryListing(bytes);
  return { path, entries };
};
const file = (name: string, path = `/d/${name}`): FileEntry =>
  ({ name, path, kind: "file", size: 0, modified: "", is_symlink: false, is_git_repo: false });
const listing = (entries: FileEntry[], path = "/d"): DirectoryListing => ({ path, entries });
const INVALID = "Invalid native directory snapshot";

/** Offsets into an encoded listing, for corrupting one part of it. */
function layout(bytes: Uint8Array) {
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  return { headerEnd: 8 + headerLength, header: JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) };
}

describe("native directory transport", () => {
  it("restores the shared Rust contract without path normalization or metadata loss", () => {
    for (const { wire, listing } of fixtures) expect(decode(bytesOf(wire))).toEqual(listing);
  });

  it("encodes each listing byte for byte as the Rust encoder does", () => {
    // The fixture's bytes are produced by the Rust encoder, so the mock's
    // encoder cannot drift from the native format unnoticed (#868).
    for (const { wire, listing } of fixtures) {
      expect(hexOf(encodeDirectoryListing(listing as DirectoryListing))).toBe(wire);
    }
  });

  it("round-trips unicode, surrogate pairs, escapes and every optional field", () => {
    const entries: FileEntry[] = [
      { ...file("😀 émoji"), kind: "directory", is_empty: true, is_git_repo: true },
      { ...file("plain"), is_symlink: true, symlink_target: "../é" },
      { ...file('quote " back \\ tab\t'), size: 2 ** 53, modified: "2026-01-02T03:04:05" },
      { ...file("Ünïcödé 日本語"), is_empty: false },
      { ...file("broken-link"), is_symlink: true, symlink_target: "" },
    ];
    expect(decode(encodeDirectoryListing(listing(entries)))).toEqual(listing(entries));
    const unprefixed = [file("a", "/x/a"), file("é", "/y/é")];
    expect(decode(encodeDirectoryListing(listing(unprefixed)))).toEqual(listing(unprefixed));
  });

  it("round-trips very long ASCII and non-ASCII names and paths", () => {
    const longWide = "日本語😀é".repeat(400); // 2,400 UTF-16 units, 4,000 UTF-8 bytes
    const longAscii = "a".repeat(4_096);
    const entries = [file(longWide), file(longAscii), { ...file("link", `/elsewhere/${longWide}/link`), symlink_target: longWide }];
    expect(decode(encodeDirectoryListing(listing(entries)))).toEqual(listing(entries));
  });

  it("rejects a header that declares more rows than the body holds before allocating them", () => {
    const encoded = encodeDirectoryListing(listing([file("a")]));
    const { headerEnd, header } = layout(encoded);
    const next = new TextEncoder().encode(JSON.stringify({ ...header, count: 2 ** 31 }));
    const out = new Uint8Array(8 + next.length + encoded.length - headerEnd);
    out.set(encoded.subarray(0, 4));
    new DataView(out.buffer).setUint32(4, next.length, true);
    out.set(next, 8);
    out.set(encoded.subarray(headerEnd), 8 + next.length);
    expect(() => decodeDirectoryListing(out)).toThrow(INVALID);
  });

  it("keeps a leading U+FEFF in every string column instead of dropping it as a BOM", () => {
    const bom = "\ufeff";
    const entries = [
      { ...file(`${bom}first`, `/x/${bom}first`), is_symlink: true, symlink_target: `${bom}target` },
      file(`${bom}second`, `/y/${bom}second`),
    ];
    expect(decode(encodeDirectoryListing(listing(entries)))).toEqual(listing(entries));
  });

  it("accepts the number array that Tauri's postMessage IPC fallback delivers", () => {
    const entries = [file("a"), file("é")];
    const encoded = encodeDirectoryListing(listing(entries), { watch_lease: { id: "l", path: "/d" } });
    expect(decode(Array.from(encoded) as unknown as Uint8Array)).toEqual(listing(entries));
    expect(decodeDirectoryListingExtra(Array.from(encoded))).toEqual({ watch_lease: { id: "l", path: "/d" } });
  });

  it("decodes an empty listing", () => {
    expect(decode(encodeDirectoryListing(listing([], "/empty")))).toEqual(listing([], "/empty"));
  });

  it("accepts a view into a larger buffer, as well as a whole ArrayBuffer", () => {
    const encoded = encodeDirectoryListing(listing([file("a"), file("é")]));
    const padded = new Uint8Array(encoded.length + 3);
    padded.set(encoded, 3);
    expect(decode(padded.subarray(3))).toEqual(listing([file("a"), file("é")]));
    expect(decode(encoded.buffer as ArrayBuffer)).toEqual(listing([file("a"), file("é")]));
  });

  it("returns header fields beyond the listing, such as a watch lease", () => {
    const lease = { id: "lease-1", path: "/d" };
    const encoded = encodeDirectoryListing(listing([file("a")]), { watch_lease: lease });
    expect(decodeDirectoryListing(encoded).extra).toEqual({ watch_lease: lease });
    expect(decodeDirectoryListingExtra(encoded)).toEqual({ watch_lease: lease });
    // A reply whose rows are corrupt still yields its lease for release.
    const corrupt = encoded.slice(0, -1);
    expect(() => decodeDirectoryListing(corrupt)).toThrow(INVALID);
    expect(decodeDirectoryListingExtra(corrupt)).toEqual({ watch_lease: lease });
    expect(decodeDirectoryListingExtra(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("rejects malformed input instead of publishing partial entries", () => {
    const good = encodeDirectoryListing(listing([file("a", "/x/a"), { ...file("é", "/y/é"), symlink_target: "t", is_symlink: true }]));
    const { headerEnd, header } = layout(good);
    const count = header.count as number;
    const flagsAt = headerEnd + count * (8 + 4 * 4);
    const corrupt = (change: (bytes: Uint8Array) => void) => { const copy = good.slice(); change(copy); return copy; };
    const withHeader = (patch: Record<string, unknown>) => {
      const next = new TextEncoder().encode(JSON.stringify({ ...header, ...patch }));
      const out = new Uint8Array(8 + next.length + good.length - headerEnd);
      out.set(good.subarray(0, 4));
      new DataView(out.buffer).setUint32(4, next.length, true);
      out.set(next, 8);
      out.set(good.subarray(headerEnd), 8 + next.length);
      return out;
    };
    const cases: unknown[] = [
      null, {}, [1, 2, 3], "TEL1", new Uint8Array(0), new Uint8Array([0x54, 0x45, 0x4c, 0x31]),
      fixtures[0].listing, // the pre-binary shape
      corrupt((b) => { b[0] = 0x58; }), // magic
      corrupt((b) => { new DataView(b.buffer).setUint32(4, 1e9, true); }), // header past the end
      corrupt((b) => { b[8] = 0x5b; }), // header JSON
      good.slice(0, -1), // truncated strings
      new Uint8Array([...good, 0]), // trailing byte
      corrupt((b) => { b[flagsAt] |= 0x80; }), // unknown flag
      corrupt((b) => { b[flagsAt] |= 3 << 5; }), // impossible is_empty
      (() => { // a target flag in a listing that carries no target column
        const plain = encodeDirectoryListing(listing([file("a")]));
        plain[plain.length - 2] |= 1 << 4;
        return plain;
      })(),
      corrupt((b) => { new DataView(b.buffer).setFloat64(headerEnd, -1, true); }), // negative size
      corrupt((b) => { new DataView(b.buffer).setFloat64(headerEnd, 0.5, true); }), // fractional size
      corrupt((b) => { new DataView(b.buffer).setFloat64(headerEnd, NaN, true); }),
      corrupt((b) => { new DataView(b.buffer).setUint32(headerEnd + 8 * count, 9, true); }), // name runs past its column
      corrupt((b) => { new DataView(b.buffer).setUint32(headerEnd + 8 * count, 0, true); }), // name leaves text over
      corrupt((b) => { b[b.length - 1] = 0xff; }), // invalid UTF-8
      withHeader({ count: count + 1 }),
      withHeader({ bytes: [1, 2, 3] }),
      withHeader({ path: 7 }),
      withHeader({ path_prefix: 3 }),
      withHeader({ targets: false }),
    ];
    for (const bad of cases) expect(() => decodeDirectoryListing(bad as Uint8Array), String(bad)).toThrow(INVALID);
  });

  it("rejects unit counts that cut a surrogate pair, even when the totals add up", () => {
    const good = encodeDirectoryListing(listing([file("😀", "/x/😀"), { ...file("é", "/y/é"), symlink_target: "😀", is_symlink: true }]));
    const { headerEnd, header } = layout(good);
    const count = header.count as number;
    const moveUnit = (column: number) => {
      const copy = good.slice();
      const view = new DataView(copy.buffer);
      const at = headerEnd + 8 * count + 4 * count * column;
      view.setUint32(at, view.getUint32(at, true) - 1, true);
      view.setUint32(at + 4, view.getUint32(at + 4, true) + 1, true);
      return copy;
    };
    expect(decode(good).entries.map((e) => e.name)).toEqual(["😀", "é"]);
    expect(() => decodeDirectoryListing(moveUnit(0)), "names").toThrow(INVALID);
    expect(() => decodeDirectoryListing(moveUnit(2)), "paths").toThrow(INVALID);
  });

  it("decodes a large listing completely and preserves its final row", () => {
    const count = 100_000;
    const entries = Array.from({ length: count }, (_, i) => file(`entry-${i}`, `/exact/entry-${i}`));
    const result = decode(encodeDirectoryListing(listing(entries, "/requested")));
    expect(result.entries).toHaveLength(count);
    expect(result.entries.at(-1)).toMatchObject({ name: "entry-99999", path: "/exact/entry-99999", is_symlink: false, is_git_repo: false });
  });
});
