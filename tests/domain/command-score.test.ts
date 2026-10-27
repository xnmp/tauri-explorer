/**
 * Tests for command-palette scoring.
 */
import { describe, it, expect } from "vitest";
import { commandFrecencyPoints, scoreCommand } from "$lib/domain/command-score";

describe("scoreCommand", () => {
  const fields = (label: string, category = "", shortcut = "") => ({
    label,
    category,
    shortcut,
  });

  it("matches token-wise: every term must land in label, category or shortcut", () => {
    // A category hit now satisfies a token (VSCode-style) …
    expect(scoreCommand(fields("open folder", "git", "ctrl+g"), "git", 0)).toBeGreaterThan(0);
    // … but a token matching nothing kills the command.
    expect(scoreCommand(fields("open folder", "git", ""), "git zebra", 0)).toBe(0);
    expect(scoreCommand(fields("toggle git panel"), "git", 0)).toBeGreaterThan(0);
  });

  it("is word-order agnostic: 'git graph' and 'graph git' both match", () => {
    const f = fields("git: show commit graph", "general", "ctrl+alt+g");
    expect(scoreCommand(f, "git graph", 0)).toBeGreaterThan(0);
    expect(scoreCommand(f, "graph git", 0)).toBeGreaterThan(0);
    expect(scoreCommand(f, "show graph", 0)).toBeGreaterThan(0);
    expect(scoreCommand(f, "graphite", 0)).toBe(0);
  });

  it("ranks label prefix above bare substring above scattered subsequence", () => {
    const prefix = scoreCommand(fields("git commit"), "git", 0);
    const substring = scoreCommand(fields("open git panel"), "git", 0);
    const scattered = scoreCommand(fields("grep in tree"), "git", 0);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  it("caps the frecency contribution", () => {
    expect(commandFrecencyPoints(1000)).toBe(30);
    const cold = scoreCommand(fields("git commit"), "git", 0);
    const hot = scoreCommand(fields("git commit"), "git", 1000);
    expect(hot - cold).toBe(30);
  });
});

describe("scoreCommand keywords (synonyms)", () => {
  const kb = {
    label: "keyboard shortcuts",
    category: "general",
    shortcut: "",
    keywords: ["hotkeys", "keybindings"],
  };
  const noAlias = { label: "keyboard shortcuts", category: "general", shortcut: "" };

  it("finds a command by a keyword that is not in its visible text", () => {
    expect(scoreCommand(noAlias, "hotkeys", 0)).toBe(0);
    expect(scoreCommand(kb, "hotkeys", 0)).toBeGreaterThan(0);
    expect(scoreCommand(kb, "hotkeys keyboard", 0)).toBeGreaterThan(0);
  });

  it("ranks a label match above a keyword-only match", () => {
    const labelHit = scoreCommand({ ...noAlias, label: "hotkeys panel" }, "hotkeys", 0);
    expect(labelHit).toBeGreaterThan(scoreCommand(kb, "hotkeys", 0));
  });

  it("a token matching nothing still rejects the command", () => {
    expect(scoreCommand(kb, "hotkeys zebra", 0)).toBe(0);
  });

  it("behaves as before for empty, whitespace and huge queries", () => {
    expect(scoreCommand(kb, "", 0)).toBe(0);
    expect(scoreCommand(kb, "   ", 0)).toBe(0);
    expect(scoreCommand(kb, "x".repeat(10_000), 0)).toBe(0);
    expect(scoreCommand(noAlias, "keyboard", 0)).toBe(scoreCommand({ ...noAlias, keywords: [] }, "keyboard", 0));
  });
});
