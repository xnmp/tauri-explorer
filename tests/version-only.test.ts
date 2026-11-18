import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUMP_FILES, bumpVersion, type VersionSources } from "../scripts/bump-version.mjs";
import {
  cargoLockVersionOnly,
  cargoTomlVersionOnly,
  classifyVersionOnly,
  jsonVersionOnly,
  pkgbuildVersionOnly,
} from "../scripts/version-only.mjs";
import { selectRust } from "../scripts/rust-affected.mjs";
import { selectUnit } from "../scripts/unit-affected.mjs";

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "tauri-explorer", version, scripts: { test: "vitest" }, ...extra }, null, 2)}\n`;
const toml = (version: string, deps = 'serde = "1"') =>
  `[package]\nname = "tauri-explorer"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\n${deps}\n`;
const lock = (local: string, serde = "1.0.0") => [
  "version = 4",
  "",
  "[[package]]",
  'name = "serde"',
  `version = "${serde}"`,
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  "",
  "[[package]]",
  'name = "tauri-explorer"',
  `version = "${local}"`,
  "dependencies = [",
  ' "serde",',
  "]",
  "",
].join("\n");
const pkgbuild = (version: string) => `pkgname=tauri-explorer\npkgver=${version}\npkgrel=1\n`;

describe("per-format version comparison", () => {
  it("accepts a JSON manifest whose only change is its version", () => {
    expect(jsonVersionOnly(pkg("1.0.0"), pkg("1.0.1"))).toBe(true);
  });

  it.each([
    ["another key", pkg("1.0.0"), pkg("1.0.1", { private: true })],
    ["a nested value", pkg("1.0.0"), pkg("1.0.1", { scripts: { test: "vitest run" } })],
    ["nothing", pkg("1.0.0"), pkg("1.0.0")],
    ["malformed JSON", pkg("1.0.0"), "{ \"version\": \"1.0.1\","],
    ["a non-object", "[]", "[]"],
    ["a missing version", JSON.stringify({ name: "x" }), JSON.stringify({ name: "x", version: "1" })],
  ])("rejects a JSON diff changing %s", (_label, before, after) => {
    expect(jsonVersionOnly(before, after)).toBe(false);
  });

  it("accepts Cargo.toml when only [package] version changes", () => {
    expect(cargoTomlVersionOnly(toml("1.0.0"), toml("1.0.1"))).toBe(true);
  });

  it.each([
    ["a dependency", toml("1.0.0"), toml("1.0.1", 'serde = "2"')],
    ["a dependency version line", toml("1.0.0", 'version = "1"'), toml("1.0.0", 'version = "2"')],
    ["nothing", toml("1.0.0"), toml("1.0.0")],
    ["formatting", toml("1.0.0"), toml("1.0.1").replace("edition = ", "edition= ")],
    ["a duplicated version", toml("1.0.0"), toml("1.0.1").replace("edition", 'version = "9"\nedition')],
    ["malformed TOML", toml("1.0.0"), "[package\nversion = \"1.0.1\""],
  ])("rejects a Cargo.toml diff changing %s", (_label, before, after) => {
    expect(cargoTomlVersionOnly(before, after)).toBe(false);
  });

  it("accepts Cargo.lock when only a local package's version changes", () => {
    expect(cargoLockVersionOnly(lock("1.0.0"), lock("1.0.1"))).toBe(true);
  });

  it("rejects Cargo.lock when a registry dependency's version changes", () => {
    expect(cargoLockVersionOnly(lock("1.0.0"), lock("1.0.1", "1.0.1"))).toBe(false);
    expect(cargoLockVersionOnly(lock("1.0.0"), lock("1.0.0", "1.0.1"))).toBe(false);
  });

  it("rejects Cargo.lock when a dependency list or entry changes", () => {
    expect(cargoLockVersionOnly(lock("1.0.0"), lock("1.0.1").replace(' "serde",', ' "serde",\n "bytes",'))).toBe(false);
    expect(cargoLockVersionOnly(lock("1.0.0"), `${lock("1.0.1")}\n[[package]]\nname = "x"\nversion = "1"\n`)).toBe(false);
  });

  it("accepts a PKGBUILD whose only change is pkgver", () => {
    expect(pkgbuildVersionOnly(pkgbuild("1.0.0"), pkgbuild("1.0.1"))).toBe(true);
    expect(pkgbuildVersionOnly(pkgbuild("1.0.0"), pkgbuild("1.0.1").replace("pkgrel=1", "pkgrel=2"))).toBe(false);
    expect(pkgbuildVersionOnly(pkgbuild("1.0.0"), pkgbuild("1.0.0"))).toBe(false);
  });
});

describe("classifyVersionOnly", () => {
  const files: Record<string, [string | null, string | null]> = {
    "package.json": [pkg("1.0.0"), pkg("1.0.1")],
    "src-tauri/Cargo.toml": [toml("1.0.0"), toml("1.0.1")],
    "src-tauri/Cargo.lock": [lock("1.0.0"), lock("1.0.1")],
    PKGBUILD: [pkgbuild("1.0.0"), pkgbuild("1.0.1")],
    "CHANGELOG.md": ["# Changes\n", "# Changes\n## v1.0.1\n"],
  };
  const reader = (overrides: Record<string, [string | null, string | null]> = {}) =>
    (side: "base" | "head", path: string) => ({ ...files, ...overrides })[path]?.[side === "base" ? 0 : 1] ?? null;

  it("recognises a release bump across every aligned file plus release notes", () => {
    expect(classifyVersionOnly(Object.keys(files), reader())).toEqual({
      versionOnly: true,
      reason: "version-only change: package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, PKGBUILD",
    });
  });

  it("does not treat tauri.conf.json as a version file: it reads package.json's version (#1800)", () => {
    const conf = (version: string) => `${JSON.stringify({ productName: "tauri-explorer", version }, null, 2)}\n`;
    const overrides = { "src-tauri/tauri.conf.json": [conf("1.0.0"), conf("1.0.1")] as [string, string] };
    expect(classifyVersionOnly(["package.json", "src-tauri/tauri.conf.json"], reader(overrides)))
      .toEqual({ versionOnly: false, reason: "not a version-file-only diff" });
  });

  it("recognises a Cargo.lock-only version change", () => {
    expect(classifyVersionOnly(["src-tauri/Cargo.lock"], reader()).versionOnly).toBe(true);
  });

  it("does not treat CHANGELOG.md alone as a version bump", () => {
    expect(classifyVersionOnly(["CHANGELOG.md"], reader())).toEqual({ versionOnly: false, reason: "no version file changed" });
  });

  it("rejects a diff with any other file", () => {
    expect(classifyVersionOnly(["package.json", "src/app.css"], reader()).versionOnly).toBe(false);
    expect(classifyVersionOnly([], reader()).versionOnly).toBe(false);
  });

  it("rejects a version file whose other keys changed", () => {
    expect(classifyVersionOnly(["package.json"], reader({ "package.json": [pkg("1.0.0"), pkg("1.0.1", { dependencies: { a: "1" } })] })))
      .toEqual({ versionOnly: false, reason: "package.json changes more than its version" });
  });

  it("rejects malformed, added or deleted version files", () => {
    expect(classifyVersionOnly(["package.json"], reader({ "package.json": [pkg("1.0.0"), "not json"] })).versionOnly).toBe(false);
    expect(classifyVersionOnly(["src-tauri/Cargo.toml"], reader({ "src-tauri/Cargo.toml": [null, toml("1.0.1")] })).versionOnly).toBe(false);
    expect(classifyVersionOnly(["PKGBUILD"], reader({ PKGBUILD: [pkgbuild("1.0.0"), null] })).versionOnly).toBe(false);
  });

  it("recognises scripts/bump-version.mjs's edit of the checked-in files plus a changelog entry", () => {
    const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    const sources = Object.fromEntries(Object.entries(BUMP_FILES).map(([key, rel]) => [key, read(rel)])) as VersionSources;
    const changelog = read("CHANGELOG.md");
    const bumpedChangelog = `## v99.0.0 — 2099-01-01\n\n- Release notes.\n\n${changelog}`;
    const bumped = bumpVersion(sources, bumpedChangelog, "99.0.0");
    const byPath: Record<string, [string, string]> = { "CHANGELOG.md": [changelog, bumpedChangelog] };
    for (const [key, rel] of Object.entries(BUMP_FILES)) {
      byPath[rel] = [sources[key as keyof VersionSources], bumped[key as keyof VersionSources]];
    }
    const verdict = classifyVersionOnly(Object.keys(byPath), (side, path) => byPath[path]?.[side === "base" ? 0 : 1] ?? null);
    expect(verdict).toEqual({
      versionOnly: true,
      reason: "version-only change: package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, PKGBUILD",
    });
  });
});

describe("tier selections for a version-only diff", () => {
  const bump = ["CHANGELOG.md", "PKGBUILD", "package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml"];
  const tests = [
    { rel: "tests/version-alignment.test.ts", content: 'readFileSync("src-tauri/Cargo.toml")', scansDirs: false },
    { rel: "tests/unrelated.test.ts", content: "expect(1).toBe(1)", scansDirs: false },
  ];

  it("runs only the unit tests that read the bumped files", () => {
    expect(selectUnit(bump, tests, { maxFiles: 50, versionOnly: true })).toEqual({
      mode: "selected",
      reason: "version-only change: tests related to 1 input(s) from 5 changed file(s)",
      items: ["tests/version-alignment.test.ts"],
    });
  });

  it("still runs every unit test for the same files when the diff is not version-only", () => {
    expect(selectUnit(bump, tests, { maxFiles: 50 }).mode).toBe("all");
  });

  it("runs no Rust tests, without reading cargo metadata", () => {
    const metadata = () => { throw new Error("must not be called"); };
    expect(selectRust(bump, [], { maxFiles: 50, metadata, versionOnly: true })).toEqual({
      mode: "none", reason: "version-only change; native smoke still builds and boots the binary", items: [],
    });
    expect(selectRust(bump, [], { maxFiles: 50, metadata }).mode).toBe("all");
  });
});
