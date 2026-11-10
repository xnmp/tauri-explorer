import { describe, expect, it } from "vitest";
import type { SearchResult } from "$lib/domain/search";
import { TRASH_PATH } from "$lib/domain/trash";
import { directoryKey } from "$lib/domain/path";
import {
  DIRECTORY_BONUS,
  FRECENCY_WEIGHT,
  clampSelection,
  effectiveScore,
  localQuickOpenMatches,
  matchHistoryEntries,
  matchPaneEntries,
  mergeResultsByScore,
  quickOpenDisplayPath,
  quickOpenScoreBreakdown,
  rankBackendResults,
  recentQuickOpenResults,
} from "$lib/domain/quick-open-ranking";
import { QUICK_OPEN_RESULT_LIMIT } from "$lib/domain/quick-open-search";

const hit = (path: string, score: number, kind: SearchResult["kind"] = "file"): SearchResult => ({
  name: path.split("/").pop() ?? path,
  path,
  relativePath: path,
  score,
  kind,
});
const paths = (rows: readonly SearchResult[]) => rows.map((r) => r.path);
const noScores = new Map<string, number>();

describe("effectiveScore", () => {
  it("boosts directories only", () => {
    expect(effectiveScore(hit("/a", 100, "directory"))).toBe(100 * DIRECTORY_BONUS);
    expect(effectiveScore(hit("/a", 100))).toBe(100);
  });
});

describe("rankBackendResults", () => {
  it("adds frecency and the filename bonus, then orders by effective score", () => {
    const ranked = rankBackendResults(
      [hit("/w/other.txt", 100), hit("/w/notes/report.md", 100), hit("/w/rep", 100, "directory")],
      "REP",
      new Map([["/w/notes/report.md", 1]]),
    );
    // rep (dir, exact name 200) → 300 × 1.25; report.md (prefix 150 + 50 frecency) → 300; other → 100.
    expect(paths(ranked)).toEqual(["/w/rep", "/w/notes/report.md", "/w/other.txt"]);
    expect(ranked.map((r) => r.score)).toEqual([300, 100 + 150 + FRECENCY_WEIGHT, 100]);
  });

  it("keeps backend order for ties and does not mutate its input", () => {
    const input = [hit("/x/a", 10), hit("/x/b", 10), hit("/x/c", 10)];
    const ranked = rankBackendResults(input, "zzz", noScores);
    expect(paths(ranked)).toEqual(["/x/a", "/x/b", "/x/c"]);
    expect(input.map((r) => r.score)).toEqual([10, 10, 10]);
  });

  it("returns an empty list for no hits", () => {
    expect(rankBackendResults([], "a", noScores)).toEqual([]);
  });
});

describe("mergeResultsByScore", () => {
  it("dedupes extras against the primary list and among themselves", () => {
    const merged = mergeResultsByScore(
      [hit("/p/a", 50)],
      [hit("/p/a", 999), hit("/p/b", 40), hit("/p/b", 30), hit("/p/c", 60)],
    );
    expect(paths(merged)).toEqual(["/p/c", "/p/a", "/p/b"]);
    expect(merged.find((r) => r.path === "/p/a")?.score).toBe(50);
    expect(merged.find((r) => r.path === "/p/b")?.score).toBe(40);
  });

  it("treats paths that differ only by separator or case-folded key as duplicates", () => {
    const merged = mergeResultsByScore([hit("C:\\Users\\me", 10)], [hit("C:/Users/me", 20)]);
    expect(merged).toHaveLength(1);
  });

  it("caps at the result limit after sorting", () => {
    const extras = Array.from({ length: 1000 }, (_, i) => hit(`/big/${i}`, i));
    const merged = mergeResultsByScore([], extras);
    expect(merged).toHaveLength(QUICK_OPEN_RESULT_LIMIT);
    expect(merged[0].path).toBe("/big/999");
    expect(merged.at(-1)?.path).toBe(`/big/${1000 - QUICK_OPEN_RESULT_LIMIT}`);
  });

  it("prefers a directory over a file with the same raw score, and keeps primary first among exact ties", () => {
    const merged = mergeResultsByScore([hit("/t/file", 10)], [hit("/t/extra", 10), hit("/t/dir", 10, "directory")]);
    expect(paths(merged)).toEqual(["/t/dir", "/t/file", "/t/extra"]);
  });

  it("handles empty inputs", () => {
    expect(mergeResultsByScore([], [])).toEqual([]);
  });
});

describe("matchHistoryEntries", () => {
  const recents = [
    { name: "report.pdf", path: "/home/u/Documents/report.pdf", kind: "file" as const },
    { name: "notes.txt", path: "/home/u/notes.txt", kind: "file" as const },
  ];

  it("matches recents and frecency directories, scoring frecency in", () => {
    const scores = new Map([[directoryKey("/home/u/Documents"), 2]]);
    const rows = matchHistoryEntries("doc", recents, [{ path: "/home/u/Documents" }], scores);
    expect(paths(rows)).toEqual(["/home/u/Documents/report.pdf", "/home/u/Documents"]);
    const dir = rows[1];
    expect(dir).toMatchObject({ name: "Documents", kind: "directory" });
    // The directory's 2.0 frecency is worth 100 points on top of its fuzzy and prefix scores.
    const withoutFrecency = matchHistoryEntries("doc", [], [{ path: "/home/u/Documents" }], noScores)[0];
    expect(dir.score - withoutFrecency.score).toBe(2 * FRECENCY_WEIGHT);
  });

  it("offers a path present in both recents and frecency once, as the recent entry", () => {
    const rows = matchHistoryEntries("proj", [{ name: "proj", path: "C:\\work\\proj", kind: "file" }], [{ path: "c:/work/proj" }], noScores);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "C:\\work\\proj", kind: "file" });
  });

  it("hides the Recycle Bin until it has frecency", () => {
    const trashRecent = [{ name: "Recycle Bin", path: TRASH_PATH, kind: "directory" as const }];
    expect(matchHistoryEntries("recycle", trashRecent, [{ path: TRASH_PATH }], noScores)).toEqual([]);
    const scored = matchHistoryEntries("trash", [], [{ path: TRASH_PATH }], new Map([[directoryKey(TRASH_PATH), 1]]));
    expect(scored).toHaveLength(1);
    expect(scored[0]).toMatchObject({ name: "Recycle Bin", path: TRASH_PATH, kind: "directory" });
  });

  it("matches nothing for an empty term", () => {
    expect(matchHistoryEntries("", recents, [{ path: "/home/u" }], noScores)).toEqual([]);
  });
});

describe("matchPaneEntries", () => {
  it("matches direct children by name only and maps non-directories to files", () => {
    const rows = matchPaneEntries("src", [
      { name: "src", path: "/p/src", kind: "directory" },
      { name: "README.md", path: "/p/README.md", kind: "file" },
      { name: "src-link", path: "/p/src-link", kind: "symlink" },
    ]);
    expect(rows.map((r) => [r.path, r.kind, r.relativePath])).toEqual([
      ["/p/src", "directory", "src"],
      ["/p/src-link", "file", "src-link"],
    ]);
  });

  it("ranks an exact name above a prefix match", () => {
    const [exact, prefix] = matchPaneEntries("src", [
      { name: "src", path: "/p/src", kind: "directory" },
      { name: "src-link", path: "/p/src-link", kind: "file" },
    ]);
    expect(exact.score).toBeGreaterThan(prefix.score);
  });
});

describe("localQuickOpenMatches", () => {
  it("lists history matches before active-pane matches", () => {
    const rows = localQuickOpenMatches("app", {
      recents: [{ name: "app.ts", path: "/r/app.ts", kind: "file" }],
      frecencyPaths: [],
      scoreMap: noScores,
      paneEntries: [{ name: "apple", path: "/cwd/apple", kind: "file" }],
    });
    expect(paths(rows)).toEqual(["/r/app.ts", "/cwd/apple"]);
  });
});

describe("recentQuickOpenResults", () => {
  it("maps recents to unscored rows and hides the Recycle Bin without frecency", () => {
    const recents = [
      { name: "a.txt", path: "/a.txt", kind: "file" as const },
      { name: "Recycle Bin", path: TRASH_PATH, kind: "directory" as const },
    ];
    expect(paths(recentQuickOpenResults(recents, () => 0))).toEqual(["/a.txt"]);
    expect(paths(recentQuickOpenResults(recents, () => 1))).toEqual(["/a.txt", TRASH_PATH]);
    expect(recentQuickOpenResults(recents, () => 1)[0]).toEqual({ name: "a.txt", path: "/a.txt", relativePath: "/a.txt", score: 0, kind: "file" });
  });
});

describe("clampSelection", () => {
  it("keeps the index inside the list", () => {
    expect(clampSelection(5, 3)).toBe(2);
    expect(clampSelection(1, 3)).toBe(1);
    expect(clampSelection(4, 0)).toBe(0);
  });
});

describe("quickOpenDisplayPath", () => {
  it("shows paths under the cwd relative to it and others in full", () => {
    expect(quickOpenDisplayPath("/home/u/proj/src/a.ts", "/home/u/proj")).toBe("src/a.ts");
    expect(quickOpenDisplayPath("/etc/hosts", "/home/u/proj")).toBe("/etc/hosts");
    expect(quickOpenDisplayPath("/home/u/project2/x", "/home/u/proj")).toBe("/home/u/project2/x");
  });

  it("keeps full paths at the filesystem root", () => {
    expect(quickOpenDisplayPath("/etc/hosts", "/")).toBe("/etc/hosts");
  });
});

describe("quickOpenScoreBreakdown", () => {
  it("recovers the backend part from a ranked score", () => {
    const [ranked] = rankBackendResults([hit("/w/rep", 40, "directory")], "rep", new Map([["/w/rep", 1]]));
    expect(quickOpenScoreBreakdown(ranked, "rep", new Map([["/w/rep", 1]]))).toEqual({
      effective: Math.round((40 + 200 + FRECENCY_WEIGHT) * DIRECTORY_BONUS),
      base: 40,
      name: 200,
      frecency: FRECENCY_WEIGHT,
      directoryMultiplier: DIRECTORY_BONUS,
    });
  });
});
