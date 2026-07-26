/**
 * SCM sidebar fuzzy filter (#517) — narrowing rules for the pending/changed
 * file list. Behaviour only: what comes out for a given query, in what order.
 */
import { describe, it, expect } from "vitest";
import {
  filterScmEntries,
  filterScmSummary,
  scmEmptyState,
  showScmFilterInput,
} from "$lib/domain/scm-filter";
import type { GitFileEntry } from "$lib/domain/git";

function entry(path: string): GitFileEntry {
  return { path, old_path: null, status: "Modified" };
}

function paths(rows: { path: string }[]): string[] {
  return rows.map((r) => r.path);
}

/** The mock repo's pending files, mirroring what the SCM sidebar shows. */
const REPO = [
  entry("src/App.tsx"),
  entry("src/index.css"),
  entry("README.md"),
  entry("src/router.tsx"),
  entry(".env.example"),
  entry("assets/logo.png"),
];

describe("filterScmEntries", () => {
  it("returns every entry, in order, for a blank query", () => {
    expect(paths(filterScmEntries(REPO, ""))).toEqual(paths(REPO));
  });

  it("treats a whitespace-only query as no filter", () => {
    expect(paths(filterScmEntries(REPO, "   \t "))).toEqual(paths(REPO));
  });

  it("keeps only fuzzy (subsequence) matches and drops the rest", () => {
    // "idx" is NOT a substring of any path — a plain `includes` filter would
    // return nothing here. index.css matches i-d-x as a subsequence.
    expect(paths(filterScmEntries(REPO, "idx"))).toEqual(["src/index.css"]);
  });

  it("matches on the directory part of the path too", () => {
    expect(paths(filterScmEntries(REPO, "assets"))).toEqual(["assets/logo.png"]);
  });

  it("narrows to the several files that match a shared query", () => {
    expect(paths(filterScmEntries(REPO, "tsx")).sort()).toEqual([
      "src/App.tsx",
      "src/router.tsx",
    ]);
  });

  it("is case-insensitive in both directions", () => {
    expect(paths(filterScmEntries(REPO, "readme"))).toEqual(["README.md"]);
    expect(paths(filterScmEntries(REPO, "IDX"))).toEqual(["src/index.css"]);
  });

  it("orders the best match first", () => {
    const rows = [entry("src/components/readme-and-more.md"), entry("docs/readme.md")];
    expect(paths(filterScmEntries(rows, "readme"))[0]).toBe("docs/readme.md");
  });

  it("keeps the original relative order for equally good matches", () => {
    const rows = [entry("bbb/x.ts"), entry("aaa/x.ts")];
    expect(paths(filterScmEntries(rows, "x.ts"))).toEqual(["bbb/x.ts", "aaa/x.ts"]);
  });

  it("returns nothing when no entry matches", () => {
    expect(filterScmEntries(REPO, "zzzz")).toEqual([]);
  });

  it("handles an empty entry list", () => {
    expect(filterScmEntries([], "anything")).toEqual([]);
    expect(filterScmEntries([], "")).toEqual([]);
  });

  it("returns nothing for a query longer than any path", () => {
    expect(filterScmEntries(REPO, "x".repeat(500))).toEqual([]);
  });

  it("treats regex-special characters literally", () => {
    const rows = [entry("a.b.ts"), entry("axbxts")];
    // As a regex, `a.b` would also match "axb"; as a literal subsequence it
    // must not.
    expect(paths(filterScmEntries(rows, "a.b"))).toEqual(["a.b.ts"]);
    expect(filterScmEntries(rows, "*+")).toEqual([]);
  });

  it("handles a very long path without throwing", () => {
    const long = entry("deep/" + "segment/".repeat(1000) + "target.ts");
    expect(paths(filterScmEntries([long, entry("other.md")], "target"))).toEqual([long.path]);
  });

  it("excludes an empty path for a non-blank query but keeps it unfiltered", () => {
    const rows = [entry(""), entry("README.md")];
    expect(paths(filterScmEntries(rows, "readme"))).toEqual(["README.md"]);
    expect(paths(filterScmEntries(rows, ""))).toEqual(["", "README.md"]);
  });

  it("does not mutate the input array", () => {
    const rows = [entry("b.ts"), entry("a.ts")];
    filterScmEntries(rows, "ts");
    expect(paths(rows)).toEqual(["b.ts", "a.ts"]);
  });
});

describe("scmEmptyState", () => {
  it("shows no message while rows are visible", () => {
    expect(scmEmptyState(6, 6, "")).toBe("none");
    expect(scmEmptyState(6, 1, "idx")).toBe("none");
  });

  it("calls an unfiltered empty list a clean tree", () => {
    expect(scmEmptyState(0, 0, "")).toBe("clean");
  });

  it("calls a filtered-away list a filter miss", () => {
    expect(scmEmptyState(6, 0, "zzzz")).toBe("no-match");
  });

  it("still says clean when a stale query outlives the last pending file", () => {
    // The pane moved into a folder with no changes (or everything was
    // committed) while a query was set: nothing was filtered away, so
    // "no files match" would misreport a genuinely clean tree.
    expect(scmEmptyState(0, 0, "logo")).toBe("clean");
  });

  it("treats a whitespace-only query as no filter", () => {
    expect(scmEmptyState(6, 0, "  ")).toBe("clean");
  });
});

describe("showScmFilterInput", () => {
  it("shows the input whenever there is something to filter", () => {
    expect(showScmFilterInput(6, "")).toBe(true);
  });

  it("hides the input on a clean tree with no query", () => {
    expect(showScmFilterInput(0, "")).toBe(false);
    expect(showScmFilterInput(0, "   ")).toBe(false);
  });

  it("keeps the input while a query is set, even with nothing left to filter", () => {
    // Otherwise the query becomes unclearable: no input, no clear button,
    // and every later file silently filtered out.
    expect(showScmFilterInput(0, "logo")).toBe(true);
  });
});

describe("filterScmSummary", () => {
  const summary = {
    is_repo: true,
    repo_root: "/repo",
    branch: "main",
    detached: false,
    staged: [entry("src/App.tsx")],
    changes: [entry("src/index.css"), entry("README.md")],
    untracked: [entry("src/router.tsx"), entry(".env.example"), entry("assets/logo.png")],
    merge: [entry("src/conflict.ts")],
    op_state: "clean" as const,
  };

  it("filters every section", () => {
    const out = filterScmSummary(summary, "src");
    expect(paths(out.staged)).toEqual(["src/App.tsx"]);
    expect(paths(out.changes)).toEqual(["src/index.css"]);
    expect(paths(out.untracked)).toEqual(["src/router.tsx"]);
    expect(paths(out.merge)).toEqual(["src/conflict.ts"]);
  });

  it("can empty out sections that have no match", () => {
    const out = filterScmSummary(summary, "logo");
    expect(paths(out.untracked)).toEqual(["assets/logo.png"]);
    expect(out.staged).toEqual([]);
    expect(out.changes).toEqual([]);
    expect(out.merge).toEqual([]);
  });

  it("leaves the non-list fields untouched", () => {
    const out = filterScmSummary(summary, "logo");
    expect(out.is_repo).toBe(true);
    expect(out.repo_root).toBe("/repo");
    expect(out.branch).toBe("main");
    expect(out.detached).toBe(false);
    expect(out.op_state).toBe("clean");
  });

  it("returns the summary unchanged for a blank query", () => {
    const out = filterScmSummary(summary, "  ");
    expect(paths(out.staged)).toEqual(paths(summary.staged));
    expect(paths(out.changes)).toEqual(paths(summary.changes));
    expect(paths(out.untracked)).toEqual(paths(summary.untracked));
    expect(paths(out.merge)).toEqual(paths(summary.merge));
  });
});
