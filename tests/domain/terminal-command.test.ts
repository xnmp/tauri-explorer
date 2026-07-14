/**
 * Tests for embedded-terminal cd-command construction (issue #139),
 * shell-dialect aware since #409.
 */

import { describe, it, expect } from "vitest";
import { buildCdCommand, buildCdSyncSequence, buildPathsInsertion, shellSingleQuote } from "$lib/domain/terminal-command";
import type { ShellProfile } from "$lib/domain/terminal-shell";

const POSIX: ShellProfile = { kind: "posix", wslDistro: null };
const CMD: ShellProfile = { kind: "cmd", wslDistro: null };
const POWERSHELL: ShellProfile = { kind: "powershell", wslDistro: null };
const WSL: ShellProfile = { kind: "posix", wslDistro: "Ubuntu" };

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
    expect(buildCdCommand("/home/user/My Photos", POSIX)).toBe(
      "cd '/home/user/My Photos'\r"
    );
  });

  it("builds a cmd.exe cd with /d for drive changes", () => {
    expect(buildCdCommand("D:\\Media\\New Folder", CMD)).toBe(
      'cd /d "D:\\Media\\New Folder"\r'
    );
  });

  it("builds a PowerShell cd without the cmd-only /d switch", () => {
    expect(buildCdCommand("D:\\Media\\New Folder", POWERSHELL)).toBe(
      'cd "D:\\Media\\New Folder"\r'
    );
  });

  it("translates explorer paths for a WSL shell (#409)", () => {
    expect(buildCdCommand("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", WSL)).toBe(
      "cd '/home/me/proj'\r"
    );
    expect(buildCdCommand("C:\\Users\\me\\Repos", WSL)).toBe(
      "cd '/mnt/c/Users/me/Repos'\r"
    );
  });

  it("keeps hostile POSIX paths inert", () => {
    // $(...) and backticks must not be interpretable — single quotes prevent it.
    expect(buildCdCommand("/tmp/$(rm -rf ~)/`x`", POSIX)).toBe(
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
    expect(buildCdCommand("C:\\builds\\100%done", CMD)).toBe(
      'cd /d "C:\\builds\\100%done"\r'
    );
    // A path that superficially looks like a variable reference is likewise
    // left verbatim — no doubling, no caret (both would corrupt the path).
    expect(buildCdCommand("C:\\logs\\%DATE%\\out", CMD)).toBe(
      'cd /d "C:\\logs\\%DATE%\\out"\r'
    );
  });
});

describe("buildCdSyncSequence", () => {
  it("prefixes Ctrl+U (readline kill-line) on POSIX", () => {
    expect(buildCdSyncSequence("/home/user", POSIX)).toBe("\x15cd '/home/user'\r");
  });

  it("prefixes ESC (console clear-line) for cmd/PowerShell — they don't grok Ctrl+U (#150)", () => {
    expect(buildCdSyncSequence("D:\\Media", CMD)).toBe('\x1bcd /d "D:\\Media"\r');
    expect(buildCdSyncSequence("D:\\Media", CMD)).not.toContain("\x15");
    expect(buildCdSyncSequence("D:\\Media", POWERSHELL)).toBe('\x1bcd "D:\\Media"\r');
  });

  it("never sends ESC to a WSL shell — it's the meta prefix and eats the next char (#409)", () => {
    const seq = buildCdSyncSequence("C:\\Users\\me\\Repos\\Autohotkey", WSL);
    expect(seq).toBe("\x15cd '/mnt/c/Users/me/Repos/Autohotkey'\r");
    expect(seq).not.toContain("\x1b");
    expect(seq).not.toContain("/d ");
  });
});

describe("buildPathsInsertion (#265)", () => {
  it("space-joins shell-quoted paths with a trailing space and no newline", () => {
    expect(buildPathsInsertion(["/a/b.txt", "/c d/e.png"], POSIX)).toBe(
      "'/a/b.txt' '/c d/e.png' ",
    );
  });

  it("escapes embedded single quotes on POSIX", () => {
    expect(buildPathsInsertion(["/it's here"], POSIX)).toBe("'/it'\\''s here' ");
  });

  it("double-quotes on Windows", () => {
    expect(buildPathsInsertion(["C:\\My Files\\a.txt", "D:\\b"], CMD)).toBe(
      '"C:\\My Files\\a.txt" "D:\\b" ',
    );
  });

  it("translates paths for a WSL shell", () => {
    expect(buildPathsInsertion(["\\\\wsl$\\Ubuntu\\tmp\\a b.txt"], WSL)).toBe(
      "'/tmp/a b.txt' ",
    );
  });

  it("never appends a carriage return (nothing may auto-execute)", () => {
    expect(buildPathsInsertion(["/x"], POSIX)).not.toContain("\r");
    expect(buildPathsInsertion(["C:\\x"], CMD)).not.toContain("\r");
  });
});
