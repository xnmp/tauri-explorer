import { describe, it, expect } from "vitest";
import { gitStatusLetter } from "../../src/lib/domain/git";

describe("gitStatusLetter", () => {
  it("returns M for Modified", () => {
    expect(gitStatusLetter("Modified")).toBe("M");
  });

  it("returns A for Added", () => {
    expect(gitStatusLetter("Added")).toBe("A");
  });

  it("returns D for Deleted", () => {
    expect(gitStatusLetter("Deleted")).toBe("D");
  });

  it("returns R for Renamed", () => {
    expect(gitStatusLetter("Renamed")).toBe("R");
  });

  it("returns C for Copied", () => {
    expect(gitStatusLetter("Copied")).toBe("C");
  });

  it("returns U for Untracked", () => {
    expect(gitStatusLetter("Untracked")).toBe("U");
  });

  it("returns I for Ignored", () => {
    expect(gitStatusLetter("Ignored")).toBe("I");
  });

  it("returns ! for Conflict", () => {
    expect(gitStatusLetter("Conflict")).toBe("!");
  });

  it("returns T for TypeChange", () => {
    expect(gitStatusLetter("TypeChange")).toBe("T");
  });

  it("returns ? for unknown status", () => {
    expect(gitStatusLetter("SomethingElse")).toBe("?");
  });

  it("returns ? for empty string", () => {
    expect(gitStatusLetter("")).toBe("?");
  });
});
