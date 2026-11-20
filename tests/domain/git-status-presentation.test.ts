import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitStatusPresentation } from "$lib/domain/git-status-presentation";
import type { GitStatusCode } from "$lib/domain/git";

const ALL: readonly GitStatusCode[] = [
  "Modified", "Added", "Deleted", "Renamed", "Copied", "Untracked", "Ignored", "Conflicted", "TypeChange",
];

describe("gitStatusPresentation (#1852)", () => {
  it("tints a modified entry with the modified theme colour and an M chip", () => {
    expect(gitStatusPresentation("Modified")).toMatchObject({
      tone: "modified", color: "var(--git-modified)", letter: "M", dimmed: false, emphasis: false,
    });
  });

  it("tints an untracked entry green-toned with a U chip", () => {
    expect(gitStatusPresentation("Untracked")).toMatchObject({
      tone: "untracked", color: "var(--git-untracked)", letter: "U", dimmed: false,
    });
  });

  it("dims an ignored entry and gives it no chip", () => {
    expect(gitStatusPresentation("Ignored")).toMatchObject({
      color: "var(--git-ignored)", letter: null, dimmed: true,
    });
  });

  it("emphasises only conflicts", () => {
    const emphasised = ALL.filter((status) => gitStatusPresentation(status)?.emphasis);
    expect(emphasised).toEqual(["Conflicted"]);
    expect(gitStatusPresentation("Conflicted")?.letter).toBe("!");
  });

  it("gives every status a chip letter except Ignored", () => {
    const letters = Object.fromEntries(ALL.map((status) => [status, gitStatusPresentation(status)?.letter]));
    expect(letters).toEqual({
      Modified: "M", Added: "A", Deleted: "D", Renamed: "R", Copied: "C",
      Untracked: "U", Ignored: null, Conflicted: "!", TypeChange: "T",
    });
  });

  it("treats clean, missing, malformed and unknown statuses as undecorated", () => {
    for (const status of [null, undefined, "", "modified", "Unknown", "constructor", "__proto__", "M".repeat(100_000)]) {
      expect(gitStatusPresentation(status), String(status).slice(0, 20)).toBeNull();
    }
  });

  it("returns a stable, immutable value per status", () => {
    const first = gitStatusPresentation("Modified");
    expect(gitStatusPresentation("Modified")).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("names only theme variables that have light and dark defaults", () => {
    const css = readFileSync("src/lib/themes/git-status.css", "utf8");
    for (const status of ALL) {
      const variable = gitStatusPresentation(status)!.color.match(/^var\((--git-[a-z]+)\)$/)?.[1];
      expect(variable, status).toBeDefined();
      const declaration = css.match(new RegExp(`${variable}:\\s*([^;]+);`))?.[1];
      expect(declaration, `${variable} default`).toMatch(/^(light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)|var\(--[a-z-]+\))$/);
    }
  });
});
