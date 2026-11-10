/** Contract test for #869: the mock backend (`mock-invoke.ts` and its command
 * family modules) must handle exactly the commands the Rust backend registers.
 * Rust's set is parsed from source; the mock's comes from its family tables. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MOCK_SESSION_COMMANDS, mockCommandFamilies } from "../../src/lib/api/mock-invoke";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Commands `tauri::generate_handler![...]` registers in src-tauri/src/lib.rs. */
function rustRegisteredCommands(): string[] {
  const source = readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  const start = source.indexOf("tauri::generate_handler![");
  if (start === -1) throw new Error("Could not find tauri::generate_handler![ in lib.rs");
  const bodyStart = start + "tauri::generate_handler![".length;
  const end = source.indexOf("])", bodyStart);
  if (end === -1) throw new Error("Could not find the end of generate_handler![...] in lib.rs");
  const body = source.slice(bodyStart, end);
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#["))
    .map((line) => line.replace(/,$/, ""))
    .map((line) => line.split("::").pop()!.trim())
    .filter((name) => name.length > 0);
}

/** Every command the mock family tables handle, plus the commands
 * (`copy_entries`, `move_entries`) that `mockInvoke` runs itself as ordered
 * sessions before consulting any table. Duplicate names across families are
 * kept so the uniqueness test below can see them. */
function mockHandledCommands(): string[] {
  return [...Object.values(mockCommandFamilies).flatMap((family) => Object.keys(family)), ...MOCK_SESSION_COMMANDS];
}

/** Commands Rust registers that the mock deliberately does not implement,
 * because they are never reachable from the browser/mock build. Each entry
 * must say why — this is not a place to silence real drift. */
const BROWSER_UNREACHABLE_ALLOWLIST = new Set([
  // state/shared-history gates these on usesNativeHistory (isTauri).
  // Browser history deliberately remains localStorage; a mock cannot prove
  // native cross-process SQLite coherence (covered by Rust process tests).
  "shared_history_read",
  "shared_history_mutate",
  // `loadDirectory` in src/lib/api/files.ts only takes the observed-watch
  // path when `isTauri()` is true; the mock/browser build always calls
  // `list_directory_fresh` instead, so `start_observed_directory` is never
  // invoked outside a real Tauri window.
  "start_observed_directory",
  // Registered for completeness, but the frontend never calls it directly —
  // Rust invalidates its own directory cache internally via
  // `invalidate_dir_cache_sync` (src-tauri/src/files/fs_watcher.rs).
  "invalidate_dir_cache",
  // Qualification-only native streaming metrics are deliberately not mocked.
  // Browser UI tests cannot provide evidence about native reads or handles.
  "e2e_video_preview_stats",
]);

describe("mock-invoke / Rust command registration parity (#869)", () => {
  const rustCommands = rustRegisteredCommands();
  const mockCommands = mockHandledCommands();

  it("parses a plausible number of commands from both sources", () => {
    // Sanity bound so a parser regression (e.g. an empty match) fails loudly
    // here instead of masquerading as "perfect parity".
    expect(rustCommands.length).toBeGreaterThan(100);
    expect(mockCommands.length).toBeGreaterThan(100);
  });

  it("names each mock command in exactly one family", () => {
    const seen = new Map<string, number>();
    for (const name of mockCommands) seen.set(name, (seen.get(name) ?? 0) + 1);
    expect([...seen].filter(([, count]) => count > 1).map(([name]) => name)).toEqual([]);
  });

  it("every allowlisted command is actually registered by Rust", () => {
    const rustSet = new Set(rustCommands);
    for (const name of BROWSER_UNREACHABLE_ALLOWLIST) {
      expect(rustSet.has(name), `${name} is allowlisted but not registered in lib.rs — remove it`).toBe(true);
    }
  });

  it("has no mock-only commands (every mocked command is registered in Rust)", () => {
    const rustSet = new Set(rustCommands);
    const mockOnly = mockCommands.filter((name) => !rustSet.has(name));
    expect(mockOnly, "the mock handles commands Rust no longer registers").toEqual([]);
  });

  it("has no unmocked commands beyond the documented allowlist", () => {
    const mockSet = new Set(mockCommands);
    const missing = rustCommands.filter(
      (name) => !mockSet.has(name) && !BROWSER_UNREACHABLE_ALLOWLIST.has(name),
    );
    expect(missing, "Rust registers commands the mock does not handle and are not allowlisted").toEqual([]);
  });

  it("does not allowlist a command the mock already handles", () => {
    // Keeps the allowlist honest: if a mock is later added for one of these,
    // its allowlist entry becomes stale and must be deleted.
    const mockSet = new Set(mockCommands);
    const stale = [...BROWSER_UNREACHABLE_ALLOWLIST].filter((name) => mockSet.has(name));
    expect(stale, "these allowlisted commands are now mocked — remove them from the allowlist").toEqual([]);
  });
});
