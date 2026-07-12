/**
 * Mock-side filesystem-ops contract tests.
 *
 * Mirrored by #[test]s in src-tauri/src/files/dir_listing.rs which drive the
 * real filesystem commands through the same scenarios and the same fixtures
 * (./fixtures/fs_ops.json). Covers the list_directory ordering contract
 * (directories first, then case-insensitive by name, dotfiles included) and
 * rename/delete shape + semantics.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DirectoryListing, FileEntry } from "../../src/lib/domain/file";

vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);
const { mockInvoke } = await import("../../src/lib/api/mock-invoke");

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/fs_ops.json", import.meta.url)), "utf8"),
) as {
  listing_order: { input_dirs: string[]; input_files: string[]; expected_order: string[] };
  rename: { original: string; new_name: string; expected_kind: string };
  delete: { target: string };
};

// A unique parent per test keeps the shared in-memory mockFiles map isolated.
let counter = 0;
async function freshDir(): Promise<string> {
  const name = `contract-${Date.now()}-${counter++}`;
  await mockInvoke<FileEntry>("create_directory", { parentPath: "/home/user", name });
  return `/home/user/${name}`;
}

const list = (path: string) => mockInvoke<DirectoryListing>("list_directory", { path });

describe("fs-ops contract — mock agrees with real backend (fixtures)", () => {
  it("list_directory: directories first, then case-insensitive by name (dotfiles kept)", async () => {
    const parent = await freshDir();
    // Materialize the scenario in insertion order deliberately unsorted.
    for (const d of fx.listing_order.input_dirs) {
      await mockInvoke("create_directory", { parentPath: parent, name: d });
    }
    for (const f of fx.listing_order.input_files) {
      await mockInvoke("write_text_file", { path: `${parent}/${f}`, content: "x" });
    }
    const { entries } = await list(parent);
    expect(entries.map((e) => e.name)).toEqual(fx.listing_order.expected_order);
  });

  it("rename_entry: returns the renamed entry and the listing reflects it", async () => {
    const parent = await freshDir();
    await mockInvoke("write_text_file", { path: `${parent}/${fx.rename.original}`, content: "x" });

    const renamed = await mockInvoke<FileEntry>("rename_entry", {
      path: `${parent}/${fx.rename.original}`,
      newName: fx.rename.new_name,
    });
    expect(renamed.name).toBe(fx.rename.new_name);
    expect(renamed.path).toBe(`${parent}/${fx.rename.new_name}`);
    expect(renamed.kind).toBe(fx.rename.expected_kind);

    const names = (await list(parent)).entries.map((e) => e.name);
    expect(names).toContain(fx.rename.new_name);
    expect(names).not.toContain(fx.rename.original);
  });

  it("delete_entry_permanent: entry disappears from the listing", async () => {
    const parent = await freshDir();
    await mockInvoke("write_text_file", { path: `${parent}/${fx.delete.target}`, content: "x" });
    expect((await list(parent)).entries.map((e) => e.name)).toContain(fx.delete.target);

    await mockInvoke("delete_entry_permanent", { path: `${parent}/${fx.delete.target}` });
    expect((await list(parent)).entries.map((e) => e.name)).not.toContain(fx.delete.target);
  });
});
