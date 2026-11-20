/**
 * The Homebrew cask (#1876): release.yml renders it for every release and
 * writes it to the tap, so a malformed cask would break `brew install` for
 * everyone until the next release.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderCask, sha256File } from "../scripts/homebrew-cask.mjs";

const SHA = "c795efa771bea18504dfb5b582f600d9724d13e390e7996f365880e67541504e";
const hasRuby = spawnSync("ruby", ["--version"]).status === 0;

describe("renderCask (#1876)", () => {
  it("pins the release's version and digest to its Apple Silicon DMG", () => {
    const cask = renderCask({ version: "0.30.1", sha256: SHA });
    expect(cask).toContain('version "0.30.1"');
    expect(cask).toContain(`sha256 "${SHA}"`);
    // Homebrew interpolates #{version}, so the URL names this release's DMG.
    expect(cask).toContain("/releases/download/v#{version}/tauri-explorer_#{version}_aarch64.dmg");
    expect(cask).toContain("depends_on arch: :arm64");
    expect(cask).toContain('app "tauri-explorer.app"');
  });

  it("defers upgrades to the in-app updater and needs no quarantine workaround", () => {
    const cask = renderCask({ version: "0.30.1", sha256: SHA });
    expect(cask).toContain("auto_updates true");
    expect(cask).not.toMatch(/caveats|xattr|quarantine/);
  });

  it("accepts a prerelease version", () => {
    expect(renderCask({ version: "1.0.0-beta.2", sha256: SHA })).toContain('version "1.0.0-beta.2"');
  });

  it.each([
    ["a tag instead of a version", "v0.30.1"],
    ["a partial version", "0.30"],
    ["an empty version", ""],
    ["a version with a quote", '0.30.1" do'],
    ["a non-string version", 30],
    ["a missing version", undefined],
  ])("rejects %s", (_, version) => {
    expect(() => renderCask({ version: version as string, sha256: SHA })).toThrow(/release version/);
  });

  it.each([
    ["an uppercase digest", SHA.toUpperCase()],
    ["a short digest", SHA.slice(0, 63)],
    ["a long digest", `${SHA}0`],
    ["a non-hex digest", `${SHA.slice(0, 63)}g`],
    ["an empty digest", ""],
    ["a missing digest", undefined],
  ])("rejects %s", (_, sha256) => {
    expect(() => renderCask({ version: "0.30.1", sha256: sha256 as string })).toThrow(/SHA-256/);
  });

  it.runIf(hasRuby)("renders valid Ruby", () => {
    const dir = mkdtempSync(join(tmpdir(), "cask-"));
    try {
      const file = join(dir, "tauri-explorer.rb");
      writeFileSync(file, renderCask({ version: "0.30.1", sha256: SHA }));
      expect(execFileSync("ruby", ["-c", file], { encoding: "utf8" })).toContain("Syntax OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sha256File (#1876)", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("digests the file's bytes", () => {
    dir = mkdtempSync(join(tmpdir(), "cask-"));
    const file = join(dir, "empty.dmg");
    writeFileSync(file, "");
    expect(sha256File(file)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
