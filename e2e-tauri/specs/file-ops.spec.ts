/**
 * Real-IPC file operation round-trip against the built Tauri binary:
 * navigate to a scratch directory, create a folder, rename it, trash it.
 * This is the only suite exercising the actual Rust backend end to end —
 * browser-mode Playwright runs against mock-invoke and cannot catch real
 * filesystem/IPC regressions.
 *
 * Operations are triggered through dev-only e2e hooks (see +page.svelte)
 * rather than the inline UI inputs: under Xvfb (no window manager) the
 * autofocused new-folder/rename inputs blur and self-cancel before a test
 * can type into them. The hooks call the SAME explorer methods the UI does
 * (createFolder → create_directory, rename → rename_entry,
 * confirmDelete → trash), so the real backend round-trip is still covered;
 * assertions verify both the on-disk result and the refreshed listing.
 */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, entryNames } from "./helpers";

// Under $HOME (not /tmp) so trashing works on tmpfs-mounted /tmp setups —
// Freedesktop trash needs a Trash dir on the same mount or the home fallback.
const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-"));

async function fileOp(detail: { op: string; name?: string; path?: string }): Promise<void> {
  await browser.execute((d) => {
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: d }));
  }, detail);
}

describe("file operations against the real backend", () => {
  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("creates a folder on the real filesystem", async () => {
    await navigateTo(scratchDir);

    await fileOp({ op: "new-folder", name: "roundtrip" });

    await browser.waitUntil(async () => (await entryNames()).includes("roundtrip"), {
      timeoutMsg: "created folder never appeared in the listing",
    });
    // The command must have hit the real filesystem
    expect(fs.existsSync(path.join(scratchDir, "roundtrip"))).toBe(true);
  });

  it("renames the folder", async () => {
    await fileOp({
      op: "rename",
      path: path.join(scratchDir, "roundtrip"),
      name: "renamed-roundtrip",
    });

    await browser.waitUntil(async () => (await entryNames()).includes("renamed-roundtrip"), {
      timeoutMsg: "renamed folder never appeared",
    });
    expect(fs.existsSync(path.join(scratchDir, "renamed-roundtrip"))).toBe(true);
    expect(fs.existsSync(path.join(scratchDir, "roundtrip"))).toBe(false);
  });

  it("moves the folder to trash", async () => {
    await fileOp({ op: "delete", path: path.join(scratchDir, "renamed-roundtrip") });

    await browser.waitUntil(
      async () => !(await entryNames()).includes("renamed-roundtrip"),
      { timeoutMsg: "trashed folder still listed" },
    );
    expect(fs.existsSync(path.join(scratchDir, "renamed-roundtrip"))).toBe(false);
  });
});
