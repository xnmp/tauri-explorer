import { expect, it } from "vitest";
import { prRepositorySlug } from "$lib/domain/git-graph";

it("binds the displayed PR identity rather than current repository configuration", () => {
  expect(prRepositorySlug({ htmlUrl: "https://github.com/owner/A/pull/15", number: 15 })).toBe("owner/A");
  for (const htmlUrl of ["https://evil.example/owner/A/pull/15", "https://github.com/owner/A/pull/16", "https://github.com/owner/A/pull/15/extra", "https://user@github.com/owner/A/pull/15", "not a URL"]) {
    expect(prRepositorySlug({ htmlUrl, number: 15 })).toBeNull();
  }
});
