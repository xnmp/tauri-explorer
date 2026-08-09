import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("public repository hygiene", () => {
  it("groups routine Dependabot updates once per configured ecosystem", () => {
    const dependabot = readRepositoryFile(".github/dependabot.yml");

    for (const ecosystem of ["npm", "cargo", "github-actions"]) {
      expect(dependabot).toMatch(
        new RegExp(
          `package-ecosystem: "${ecosystem}"[\\s\\S]*?groups:[\\s\\S]*?routine-dependencies:[\\s\\S]*?patterns:[\\s\\S]*?- "\\*"`,
        ),
      );
    }
  });

  it("keeps committed visual proof eligible for review", () => {
    const gitignore = readRepositoryFile(".gitignore");

    expect(gitignore).not.toMatch(/^\/?evidence\/?$/m);
  });
});
