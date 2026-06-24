import { describe, it, expect } from "vitest";
import { disambiguateTabTitles } from "../../src/lib/domain/tab-title";

describe("disambiguateTabTitles", () => {
  it("uses the bare folder name when basenames are unique", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "/home/user/Pictures" },
      { id: "b", path: "/home/user/Documents" },
    ]);
    expect(r.get("a")).toBe("Pictures");
    expect(r.get("b")).toBe("Documents");
  });

  it("appends the parent folder when two tabs share a basename", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "/work/featureA/components" },
      { id: "b", path: "/work/featureB/components" },
    ]);
    expect(r.get("a")).toBe("components · featureA");
    expect(r.get("b")).toBe("components · featureB");
  });

  it("walks further up when the immediate parents also collide", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "/x/shared/src" },
      { id: "b", path: "/y/shared/src" },
    ]);
    expect(r.get("a")).toBe("src · x/shared");
    expect(r.get("b")).toBe("src · y/shared");
  });

  it("only disambiguates the colliding group, leaving unique tabs bare", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "/work/featureA/components" },
      { id: "b", path: "/work/featureB/components" },
      { id: "c", path: "/home/user/Music" },
    ]);
    expect(r.get("a")).toBe("components · featureA");
    expect(r.get("b")).toBe("components · featureB");
    expect(r.get("c")).toBe("Music");
  });

  it("handles Windows backslash paths", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "C:\\proj\\app\\src" },
      { id: "b", path: "C:\\proj\\lib\\src" },
    ]);
    expect(r.get("a")).toBe("src · app");
    expect(r.get("b")).toBe("src · lib");
  });

  it("gives identical paths the same label without looping", () => {
    const r = disambiguateTabTitles([
      { id: "a", path: "/repo" },
      { id: "b", path: "/repo" },
    ]);
    expect(r.get("a")).toBe("repo");
    expect(r.get("b")).toBe("repo");
  });
});
