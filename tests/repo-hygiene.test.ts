import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("public repository hygiene", () => {
  it("groups routine Dependabot updates once per configured ecosystem", () => {
    const dependabot = readRepositoryFile(".github/dependabot.yml");
    const updates = dependabot.split(/^  - package-ecosystem: /m).slice(1);

    for (const ecosystem of ["npm", "cargo", "github-actions"]) {
      const update = updates.find((entry) => entry.startsWith(`"${ecosystem}"`));

      expect(update).toMatch(
        /groups:\n      routine-dependencies:\n        patterns:\n          - "\*"/,
      );
    }
  });

  it("keeps committed visual proof eligible for review", () => {
    const gitignore = readRepositoryFile(".gitignore");

    expect(gitignore).not.toMatch(/^\/?evidence\/?$/m);
  });
});
