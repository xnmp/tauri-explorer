/**
 * Shell-dialect path translation for the embedded terminal (#409, #418).
 */

import { describe, it, expect } from "vitest";
import { defaultShellProfile, toShellPath, fromShellCwd, type ShellProfile } from "$lib/domain/terminal-shell";

const WSL: ShellProfile = { kind: "posix", wslDistro: "Ubuntu-24.04" };
const PLAIN_POSIX: ShellProfile = { kind: "posix", wslDistro: null };
const CMD: ShellProfile = { kind: "cmd", wslDistro: null };

describe("defaultShellProfile", () => {
  it("assumes cmd on Windows, posix elsewhere", () => {
    expect(defaultShellProfile(true)).toEqual({ kind: "cmd", wslDistro: null });
    expect(defaultShellProfile(false)).toEqual({ kind: "posix", wslDistro: null });
  });
});

describe("toShellPath (explorer → shell)", () => {
  it("maps WSL UNC paths to their Linux path", () => {
    expect(toShellPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj", WSL)).toBe("/home/me/proj");
    expect(toShellPath("\\\\wsl$\\Ubuntu-24.04\\tmp", WSL)).toBe("/tmp");
    expect(toShellPath("//wsl.localhost/Ubuntu-24.04/home/me", WSL)).toBe("/home/me");
  });

  it("maps distro roots to /", () => {
    expect(toShellPath("\\\\wsl.localhost\\Ubuntu-24.04", WSL)).toBe("/");
  });

  it("maps drive paths to the /mnt automount", () => {
    expect(toShellPath("C:\\Users\\me\\Repos\\Autohotkey", WSL)).toBe("/mnt/c/Users/me/Repos/Autohotkey");
    expect(toShellPath("D:\\", WSL)).toBe("/mnt/d");
  });

  it("passes already-POSIX paths through", () => {
    expect(toShellPath("/home/me", WSL)).toBe("/home/me");
  });

  it("is the identity for non-WSL shells", () => {
    expect(toShellPath("C:\\Users\\me", CMD)).toBe("C:\\Users\\me");
    expect(toShellPath("/home/me", PLAIN_POSIX)).toBe("/home/me");
  });
});

describe("fromShellCwd (shell → explorer)", () => {
  it("maps Linux paths back to the distro UNC share (#418)", () => {
    expect(fromShellCwd("/home/user/myfolder", WSL)).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\myfolder",
    );
  });

  it("maps /mnt automount paths back to the drive", () => {
    expect(fromShellCwd("/mnt/c/Users/me/Repos", WSL)).toBe("C:\\Users\\me\\Repos");
    expect(fromShellCwd("/mnt/d", WSL)).toBe("D:\\");
  });

  it("is the identity for non-WSL shells", () => {
    expect(fromShellCwd("/home/me", PLAIN_POSIX)).toBe("/home/me");
    expect(fromShellCwd("C:\\Users\\me", CMD)).toBe("C:\\Users\\me");
  });

  it("round-trips through toShellPath", () => {
    const unc = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\proj";
    expect(fromShellCwd(toShellPath(unc, WSL), WSL)).toBe(unc);
    const win = "C:\\Users\\me\\Repos";
    expect(fromShellCwd(toShellPath(win, WSL), WSL)).toBe(win);
  });
});
