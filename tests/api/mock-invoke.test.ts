import { describe, it, expect } from "vitest";
import { mockInvoke } from "../../src/lib/api/mock-invoke";

describe("mockInvoke — clipboard file round-trip", () => {
  it("writes then reads back the same file list", async () => {
    const paths = ["/home/user/notes.md", "/home/user/readme.txt"];

    const wrote = await mockInvoke<boolean>("clipboard_write_files", { paths });
    expect(wrote).toBe(true);

    expect(await mockInvoke<boolean>("clipboard_has_files")).toBe(true);
    expect(await mockInvoke<string[]>("clipboard_read_files")).toEqual(paths);
  });

  it("reports no files after writing an empty list", async () => {
    await mockInvoke<boolean>("clipboard_write_files", { paths: [] });

    expect(await mockInvoke<boolean>("clipboard_has_files")).toBe(false);
    expect(await mockInvoke<string[]>("clipboard_read_files")).toEqual([]);
  });

  it("returns an independent copy so callers cannot mutate the clipboard", async () => {
    await mockInvoke<boolean>("clipboard_write_files", { paths: ["/a", "/b"] });

    const read = await mockInvoke<string[]>("clipboard_read_files");
    read.push("/hacked");

    expect(await mockInvoke<string[]>("clipboard_read_files")).toEqual(["/a", "/b"]);
  });
});

describe("mockInvoke — clipboard image paste", () => {
  it("creates the pasted image entry in the target directory listing", async () => {
    const directory = "/home/user/Pictures";
    const path = await mockInvoke<string>("clipboard_paste_image", { directory });

    expect(path).toBe(`${directory}/clipboard-image.png`);

    const listing = await mockInvoke<{ entries: { path: string }[] }>("list_directory", {
      path: directory,
    });
    expect(listing.entries.some((e) => e.path === path)).toBe(true);
  });
});

describe("mockInvoke — no-op external process commands", () => {
  it("resolves the previously-unmocked commands without throwing", async () => {
    await expect(mockInvoke("open_file_with", { path: "/x", app: "vim" })).resolves.toBeUndefined();
    await expect(mockInvoke("open_in_terminal", { path: "/x" })).resolves.toBeUndefined();
    await expect(mockInvoke("set_as_wallpaper", { path: "/x.png" })).resolves.toBeUndefined();
    await expect(mockInvoke<string>("get_log_dir")).resolves.toMatch(/logs/);
    await expect(mockInvoke<number>("start_nano_banana_job", {})).resolves.toBeTypeOf("number");
  });
});
