/**
 * Tests for embedded-terminal cd-command construction (issue #139).
 */

import { describe, it, expect } from "vitest";
import { buildCdCommand, buildCdSyncSequence, shellSingleQuote } from "$lib/domain/terminal-command";

describe("shellSingleQuote", () => {
  it("wraps plain paths", () => {
    expect(shellSingleQuote("/home/user")).toBe("'/home/user'");
  });

  it("survives spaces, globs and double quotes untouched", () => {
    expect(shellSingleQuote('/tmp/my dir/*"x"')).toBe(`'/tmp/my dir/*"x"'`);
  });

  it("escapes embedded single quotes", () => {
    expect(shellSingleQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
  });

  it("handles empty input", () => {
    expect(shellSingleQuote("")).toBe("''");
  });
});

describe("buildCdCommand", () => {
  it("builds a POSIX cd with quoting and carriage return", () => {
    expect(buildCdCommand("/home/user/My Photos", false)).toBe(
      "cd '/home/user/My Photos'\r"
    );
  });

  it("builds a cmd.exe cd with /d for drive changes", () => {
    expect(buildCdCommand("D:\\Media\\New Folder", true)).toBe(
      'cd /d "D:\\Media\\New Folder"\r'
    );
  });

  it("keeps hostile POSIX paths inert", () => {
    // $(...) and backticks must not be interpretable — single quotes prevent it.
    expect(buildCdCommand("/tmp/$(rm -rf ~)/`x`", false)).toBe(
      "cd '/tmp/$(rm -rf ~)/`x`'\r"
    );
  });

  // Characterization test (#154): documents the known cmd.exe `%VAR%`
  // limitation. There is no reliable interactive-cmd escape for `%` inside
  // double quotes, so the percent passes through verbatim. This is correct for
  // the common cases (cmd leaves a percent literal unless it names a *defined*
  // env var). If a robust escaping technique is ever adopted, this expectation
  // is the thing that must change — see buildCdCommand's doc comment.
  it("passes cmd.exe paths with percent signs through unescaped (documented #154 limitation)", () => {
    expect(buildCdCommand("C:\\builds\\100%done", true)).toBe(
      'cd /d "C:\\builds\\100%done"\r'
    );
    // A path that superficially looks like a variable reference is likewise
    // left verbatim — no doubling, no caret (both would corrupt the path).
    expect(buildCdCommand("C:\\logs\\%DATE%\\out", true)).toBe(
      'cd /d "C:\\logs\\%DATE%\\out"\r'
    );
  });
});

describe("buildCdSyncSequence", () => {
  it("prefixes Ctrl+U (readline kill-line) on POSIX", () => {
    expect(buildCdSyncSequence("/home/user", false)).toBe("\x15cd '/home/user'\r");
  });

  it("prefixes ESC (console clear-line) on Windows — cmd/PowerShell don't grok Ctrl+U (#150)", () => {
    expect(buildCdSyncSequence("D:\\Media", true)).toBe('\x1bcd /d "D:\\Media"\r');
    expect(buildCdSyncSequence("D:\\Media", true)).not.toContain("\x15");
  });
});
