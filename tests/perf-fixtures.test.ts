import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { create, parseSize, remove } from "../scripts/perf-fixtures.mjs";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-fixtures-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("parseSize", () => {
  it("accepts k/m suffixes and plain counts", () => {
    expect(parseSize("1k")).toBe(1_000);
    expect(parseSize("500K")).toBe(500_000);
    expect(parseSize("1m")).toBe(1_000_000);
    expect(parseSize("250")).toBe(250);
  });

  it("rejects malformed or too-small sizes", () => {
    for (const label of ["", "k", "1.5k", "-3", "10g", "1"]) {
      expect(() => parseSize(label)).toThrow();
    }
  });
});

describe("create/remove", () => {
  it("creates exactly the requested entries, counting dot-files as hidden", () => {
    const root = path.join(tempRoot(), "fx");
    const manifest = create(root, ["300"]);
    const folder = manifest.folders["300"];
    const names = fs.readdirSync(folder.path);
    expect(names).toHaveLength(300);
    expect(names).toContain("000-subdir");
    expect(folder.visibleEntries).toBe(names.filter((name) => !name.startsWith(".")).length);
    expect(folder.visibleEntries).toBeLessThan(300);
    expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("is deterministic across runs", () => {
    const first = create(path.join(tempRoot(), "a"), ["200"]).folders["200"];
    const second = create(path.join(tempRoot(), "b"), ["200"]).folders["200"];
    expect(fs.readdirSync(first.path).sort()).toEqual(fs.readdirSync(second.path).sort());
  });

  it("refuses a root inside the repository", () => {
    expect(() => create(path.resolve("tmp-perf-fixtures"), ["10"])).toThrow(/inside the repository/);
    expect(fs.existsSync(path.resolve("tmp-perf-fixtures"))).toBe(false);
  });

  it("never writes into or deletes a directory it did not create", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "keep.txt"), "user data");
    expect(() => create(root, ["10"])).toThrow(/refusing/);
    expect(() => remove(root)).toThrow(/refusing/);
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("user data");
  });

  it("removes a fixture root", () => {
    const root = path.join(tempRoot(), "fx");
    create(root, ["10"]);
    remove(root);
    expect(fs.existsSync(root)).toBe(false);
  });
});
