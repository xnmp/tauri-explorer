#!/usr/bin/env node
/**
 * Live JavaScriptCore heap of one flat directory listing, step by step (#1416).
 *
 *   node scripts/perf-listing-heap.mjs [--entries 100000] [--jsc PATH] [--max-bytes-per-entry N]
 *
 * Bundles the app's own listing pipeline (wire decode, hidden filter, sort,
 * flat peek projection and rows; `src/lib`) with Bun and runs it in the `jsc`
 * shell of the WebKitGTK build the app runs on, which offers `fullGC()` and
 * `gcHeapSize()`: neither is reachable from the release WebView. Each step's
 * retained heap is measured after full collections, so the numbers are the
 * live cost of keeping a listing on screen, not garbage.
 *
 * `--max-bytes-per-entry` exits non-zero when the total exceeds the budget.
 * The default `jsc` is WebKitGTK 4.1's (Arch: webkit2gtk-4.1; Debian/Ubuntu:
 * libjavascriptcoregtk-4.1-bin installs `jsc` on PATH).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { entries: 100_000, jsc: null, maxBytesPerEntry: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--entries": options.entries = Number(value); i++; break;
      case "--jsc": options.jsc = value; i++; break;
      case "--max-bytes-per-entry": options.maxBytesPerEntry = Number(value); i++; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!Number.isInteger(options.entries) || options.entries < 1) throw new Error("--entries must be a positive integer");
  return options;
}

function findJsc(explicit) {
  const candidates = explicit ? [explicit] : ["/usr/lib/webkit2gtk-4.1/jsc", "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/jsc", "jsc"];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["-e", "print(typeof gcHeapSize)"], { encoding: "utf8" }).stdout?.trim() === "function") return candidate;
  }
  throw new Error(`no JavaScriptCore shell with gcHeapSize() found (tried ${candidates.join(", ")}); pass --jsc PATH`);
}

const lib = (file) => JSON.stringify(path.join(REPO, "src/lib", file));
// The jsc shell has no TextEncoder/TextDecoder (they are WebCore APIs): the
// harness installs minimal UTF-8 ones. Like WebKit's, the decoder returns an
// 8-bit string for ASCII input and a 16-bit one otherwise.
const TEXT_CODING = `
globalThis.TextEncoder ??= class {
  encode(text) {
    const out = [];
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
};
globalThis.TextDecoder ??= class {
  decode(bytes) {
    const units = [];
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      let c, n;
      if (b < 0x80) { c = b; n = 1; }
      else if (b < 0xe0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); n = 2; }
      else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); n = 3; }
      else { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); n = 4; }
      if (c > 0xffff) { c -= 0x10000; units.push(0xd800 | (c >> 10), 0xdc00 | (c & 1023)); } else units.push(c);
      i += n;
    }
    const parts = [];
    for (let i = 0; i < units.length; i += 8192) parts.push(String.fromCharCode.apply(null, units.slice(i, i + 8192)));
    const text = parts.join("");
    text.charCodeAt(0); // resolve the rope, as a decoded string is flat
    return text;
  }
};
`;

const HARNESS = `
${TEXT_CODING}
import { decodeDirectoryListing, encodeDirectoryListing } from ${lib("api/directory-wire.ts")};
import { filterHidden, sortEntries } from ${lib("domain/file.ts")};
import { flatPeekEntries, flatPeekRows } from ${lib("domain/folder-peek-flat.ts")};
import { resolveFileCursor } from ${lib("domain/file-list-navigation.ts")};
const N = Number(globalThis.arguments[0]);
const root = "/tmp/te-perf-fixtures/files-listing";
// Fixture-like names: mixed case, digits, spaces, non-ASCII, ~20% dot-files.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const words = ["report", "Invoice", "photo", "draft", "Résumé", "data", "notes", "backup", "日本", "final"];
const exts = ["txt", "pdf", "md", "json", "csv", "log", "rs", "ts"];
const source = Array.from({ length: N }, (_, i) => {
  const name = (rnd() < 0.2 ? "." : "") + words[i % 10] + " " + Math.floor(rnd() * 1e6) + " " + i + "." + exts[i % 8];
  return { name, path: root + "/" + name, kind: "file", size: Math.floor(rnd() * 1e9), modified: new Date(1.6e12 + rnd() * 1e11).toISOString(), is_symlink: false, is_git_repo: false };
});
// The IPC payload as the webview receives it; the source objects are dropped.
const wire = encodeDirectoryListing({ path: root, entries: source });
source.length = 0;
const used = () => { for (let i = 0; i < 4; i++) fullGC(); return gcHeapSize(); };
const keep = [];
const steps = [];
const step = (label, make) => { const before = used(); const value = make(); keep.push(value); steps.push({ label, bytesPerEntry: (used() - before) / N }); return value; };
const start = used();
const listing = step("decoded listing (payload dropped)", () => { const { path, entries } = decodeDirectoryListing(wire); return { path, entries }; });
const visible = step("filterHidden", () => filterHidden(listing.entries, false));
const sorted = step("sortEntries by name", () => sortEntries(visible, "name", true));
const tree = step("flatPeekEntries", () => flatPeekEntries(root, sorted));
step("flatPeekRows", () => flatPeekRows(tree, false));
step("resolveFileCursor (no cursor)", () => resolveFileCursor(tree.entries, null, new Set()));
print(JSON.stringify({ entries: N, steps, totalBytesPerEntry: (used() - start) / N }));
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const jsc = findJsc(options.jsc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-explorer-listing-heap-"));
  try {
    fs.writeFileSync(path.join(dir, "harness.ts"), HARNESS);
    const bundle = path.join(dir, "harness.js");
    const built = spawnSync("bun", ["build", path.join(dir, "harness.ts"), "--outfile", bundle, "--target", "browser", "--format", "esm"], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`bun build failed:\n${built.stderr}`);
    // jsc runs a classic script: drop the bundle's (empty) export clause.
    fs.writeFileSync(bundle, fs.readFileSync(bundle, "utf8").replace(/^export \{[^}]*\};?$/m, ""));
    const run = spawnSync(jsc, [bundle, "--", String(options.entries)], { encoding: "utf8", maxBuffer: 1 << 20 });
    if (run.status !== 0) throw new Error(`jsc failed:\n${run.stdout}${run.stderr}`);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
    for (const { label, bytesPerEntry } of result.steps) console.log(`${label.padEnd(34)} ${bytesPerEntry.toFixed(0).padStart(5)} B/entry`);
    console.log(`${"total live".padEnd(34)} ${result.totalBytesPerEntry.toFixed(0).padStart(5)} B/entry (${((result.totalBytesPerEntry * result.entries) / 1048576).toFixed(1)} MB for ${result.entries} entries)`);
    if (options.maxBytesPerEntry !== null && result.totalBytesPerEntry > options.maxBytesPerEntry) {
      console.error(`listing heap budget exceeded: ${result.totalBytesPerEntry.toFixed(0)} B/entry > ${options.maxBytesPerEntry}`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
