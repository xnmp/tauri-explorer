import { describe, it, expect } from "vitest";
import { isWslPath, isWslDistroRoot, isWslHome } from "$lib/domain/wsl";

describe("isWslPath", () => {
  it("matches wsl.localhost and legacy wsl$ shares, any separator/case", () => {
    expect(isWslPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me")).toBe(true);
    expect(isWslPath("//wsl.localhost/Ubuntu/etc")).toBe(true);
    expect(isWslPath("\\\\wsl$\\Debian\\root")).toBe(true);
    expect(isWslPath("\\\\WSL.LOCALHOST\\Ubuntu")).toBe(true);
  });

  it("rejects non-WSL paths", () => {
    expect(isWslPath("C:\\Users\\me")).toBe(false);
    expect(isWslPath("\\\\fileserver\\share\\x")).toBe(false);
    expect(isWslPath("/home/me")).toBe(false);
  });
});

describe("isWslDistroRoot", () => {
  it("matches the distro share root only (no deeper path)", () => {
    expect(isWslDistroRoot("\\\\wsl.localhost\\Ubuntu-24.04")).toBe(true);
    expect(isWslDistroRoot("//wsl.localhost/Ubuntu/")).toBe(true); // trailing slash tolerated
    expect(isWslDistroRoot("\\\\wsl$\\Debian")).toBe(true);
  });

  it("rejects deeper paths and the bare server", () => {
    expect(isWslDistroRoot("\\\\wsl.localhost\\Ubuntu\\home")).toBe(false);
    expect(isWslDistroRoot("\\\\wsl.localhost")).toBe(false);
    expect(isWslDistroRoot("\\\\fileserver\\share")).toBe(false);
  });
});

describe("isWslHome", () => {
  it("matches a user's home directory inside a distro", () => {
    expect(isWslHome("\\\\wsl.localhost\\Ubuntu-24.04\\home\\chong")).toBe(true);
    expect(isWslHome("//wsl.localhost/ubuntu/home/myuser")).toBe(true);
  });

  it("rejects non-home depths and non-home second segment", () => {
    expect(isWslHome("\\\\wsl.localhost\\Ubuntu\\home")).toBe(false); // missing user
    expect(isWslHome("\\\\wsl.localhost\\Ubuntu\\home\\me\\Documents")).toBe(false); // too deep
    expect(isWslHome("\\\\wsl.localhost\\Ubuntu\\etc\\me")).toBe(false); // not /home
  });
});
