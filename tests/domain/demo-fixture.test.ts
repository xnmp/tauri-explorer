import { describe, expect, it } from "vitest";
import { convertDemoFixture } from "$lib/domain/demo-fixture";
import {
  parseFixtureDate,
  parseFixtureDuration,
  parseFixturePixels,
  parseFixtureSize,
  resolveFixtureUrl,
} from "$lib/domain/demo-fixture-values";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 18 Oct 2026, 12:00 UTC

describe("fixture values", () => {
  it("parses sizes as numbers or 1024-based units", () => {
    expect(parseFixtureSize(512)).toBe(512);
    expect(parseFixtureSize("2 KB")).toBe(2048);
    expect(parseFixtureSize("5.3 MB")).toBe(Math.round(5.3 * 1024 * 1024));
    expect(parseFixtureSize("12 bytes")).toBe(12);
    expect(parseFixtureSize("-4")).toBeNull();
    expect(parseFixtureSize("lots")).toBeNull();
    expect(parseFixtureSize(Number.NaN)).toBeNull();
    expect(parseFixtureSize(null)).toBeNull();
  });

  it("parses absolute, year-less and relative dates against now", () => {
    expect(parseFixtureDate("2026-10-11T05:41:00Z", NOW)).toBe(Date.UTC(2026, 9, 11, 5, 41));
    expect(parseFixtureDate(1_700_000_000, NOW)).toBe(1_700_000_000_000);
    // A year-less date is the most recent one not after now.
    expect(new Date(parseFixtureDate("Oct 11, 07:04", NOW)!).getFullYear()).toBe(2026);
    expect(new Date(parseFixtureDate("Dec 24, 09:00", NOW)!).getFullYear()).toBe(2025);
    expect(parseFixtureDate("just now", NOW)).toBe(NOW);
    expect(parseFixtureDate("3 days ago", NOW)).toBe(NOW - 3 * 86_400_000);
    expect(parseFixtureDate("an hour ago", NOW)).toBe(NOW - 3_600_000);
  });

  it("rejects dates that do not exist instead of rolling them over", () => {
    expect(parseFixtureDate("Feb 31 2026, 10:00", NOW)).toBeNull();
    expect(parseFixtureDate("someday", NOW)).toBeNull();
    expect(parseFixtureDate({}, NOW)).toBeNull();
  });

  it("parses durations, pixel sizes and asset URLs", () => {
    expect(parseFixtureDuration("4:12")).toBe(252);
    expect(parseFixtureDuration("1:02:03")).toBe(3723);
    expect(parseFixtureDuration("soon")).toBeNull();
    expect(parseFixturePixels("2880x2880")).toEqual({ width: 2880, height: 2880 });
    expect(parseFixturePixels("0x10")).toBeNull();
    expect(resolveFixtureUrl("../peel-mock/assets/a.webp", "http://site.test/overhaul/real.html"))
      .toBe("http://site.test/peel-mock/assets/a.webp");
    expect(resolveFixtureUrl("https://cdn.test/x.png", "http://site.test/")).toBe("https://cdn.test/x.png");
  });
});

const fixture = {
  title: "Hollin Marsh",
  users: [
    { id: "ines", name: "Ines", home: "/home/ines", bookmarks: ["/home/ines/Fieldwork", "/home/ines/missing", "relative"] },
    { id: "tomas", name: "Tomas", home: "/home/tomas" },
  ],
  tree: {
    kids: [
      { name: "home", kids: [
        { name: "ines", kids: [
          { name: ".bashrc", text: "alias ll='ls -l'" },
          { name: "Fieldwork", date: "2026-10-01T00:00:00Z", kids: [
            { name: "notes.md", text: "# Notes\nCount at dawn.", date: "Oct 11, 07:04" },
            { name: "crane.webp", src: "../assets/crane.webp", px: "1200x800", size: "1.2 MB" },
            { name: "dawn.mp4", type: "video", src: "../assets/dawn.mp4", poster: "../assets/dawn.webp" },
            { name: "permit.pdf", src: "../assets/permit.pdf" },
          ] },
          { name: "Projects", kids: [{ name: "repo", kids: [{ name: "README.md", text: "hi" }] }] },
        ] },
        { name: "tomas", kids: [] },
      ] },
      { name: "media", kids: [{ name: "backup", kids: [] }] },
    ],
  },
  trash: [{ from: "/home/ines/Fieldwork", node: { name: "old.txt", text: "gone" }, deleted: "2 days ago" }],
  repos: {
    "/home/ines/Projects/repo": {
      branch: "main",
      commits: [
        { hash: "bbb2222", msg: "Second", author: "Ines", date: "2026-10-02T00:00:00Z", parents: ["aaa1111"], refs: ["HEAD -> main"], files: [{ path: "README.md", status: "M", diff: "@@ -1 +1 @@\n-h\n+hi" }] },
        { hash: "aaa1111", msg: "First", author: "Ines", date: "2026-10-01T00:00:00Z", parents: [] },
      ],
    },
  },
};

describe("convertDemoFixture", () => {
  const world = convertDemoFixture(fixture, { now: NOW, assetBase: "http://site.test/overhaul/real.html" });

  it("lists folders with files, sizes, dates and dot entries", () => {
    const home = world.listings["/home/ines"].map((e) => e.name);
    expect(home).toEqual(expect.arrayContaining([".bashrc", "Fieldwork", "Projects"]));
    const notes = world.listings["/home/ines/Fieldwork"].find((e) => e.name === "notes.md")!;
    expect(notes).toMatchObject({ kind: "file", path: "/home/ines/Fieldwork/notes.md", size: 22 });
    expect(new Date(notes.modified).getFullYear()).toBe(2026);
    expect(world.listings["/home/ines/Fieldwork"].find((e) => e.name === "crane.webp")!.size).toBe(Math.round(1.2 * 1024 * 1024));
    expect(world.texts["/home/ines/Fieldwork/notes.md"]).toBe("# Notes\nCount at dawn.");
  });

  it("presents the first user (or the chosen one) with their home and bookmarks", () => {
    expect(world.user).toEqual({ id: "ines", name: "Ines", home: "/home/ines" });
    expect(world.bookmarks).toEqual([{ name: "Fieldwork", path: "/home/ines/Fieldwork" }]);
    expect(world.warnings.some((w) => /missing/.test(w))).toBe(true);
    const tomas = convertDemoFixture(fixture, { now: NOW, userId: "tomas" });
    expect(tomas.user.home).toBe("/home/tomas");
    expect(tomas.bookmarks).toEqual([]);
  });

  it("defaults absent bookmarks to the visible folders in the user's home, and keeps an explicit empty list", () => {
    const users = [{ id: "ines", home: "/home/ines" }];
    expect(convertDemoFixture({ ...fixture, users }, { now: NOW }).bookmarks.map((b) => b.path))
      .toEqual(["/home/ines/Fieldwork", "/home/ines/Projects"]);
    expect(convertDemoFixture({ ...fixture, users: [{ ...users[0], bookmarks: [] }] }, { now: NOW }).bookmarks).toEqual([]);
  });

  it("resolves media against the asset base by kind", () => {
    expect(world.media["/home/ines/Fieldwork/crane.webp"]).toEqual({
      kind: "image", src: "http://site.test/assets/crane.webp", pixels: { width: 1200, height: 800 },
    });
    expect(world.media["/home/ines/Fieldwork/dawn.mp4"]).toMatchObject({
      kind: "video", src: "http://site.test/assets/dawn.mp4", poster: "http://site.test/assets/dawn.webp",
    });
    expect(world.media["/home/ines/Fieldwork/permit.pdf"]).toEqual({ kind: "pdf", src: "http://site.test/assets/permit.pdf" });
    expect(world.types["/home/ines/Fieldwork/dawn.mp4"]).toBe("video");
  });

  it("offers / and every /media folder as drives", () => {
    expect(world.drives).toEqual([
      { name: "Hollin Marsh", path: "/", kind: "fixed" },
      expect.objectContaining({ path: "/media/backup", kind: "removable" }),
    ]);
  });

  it("keeps trash restorable to where it came from", () => {
    expect(world.trash).toHaveLength(1);
    expect(world.trash[0]).toMatchObject({ originalPath: "/home/ines/Fieldwork/old.txt", entry: { name: "old.txt" } });
    expect(world.trash[0].texts["/home/ines/Fieldwork/old.txt"]).toBe("gone");
    expect(world.listings["/home/ines/Fieldwork"].some((e) => e.name === "old.txt")).toBe(false);
  });

  it("marks repository roots and converts their history", () => {
    const repoEntry = world.listings["/home/ines/Projects"].find((e) => e.name === "repo")!;
    expect(repoEntry.is_git_repo).toBe(true);
    expect(world.repos).toHaveLength(1);
    expect(world.repos[0].commits.map((c) => c.summary)).toEqual(["Second", "First"]);
  });

  it.each([null, undefined, 42, "fs", []])("serves an empty world for %j without throwing", (raw) => {
    const empty = convertDemoFixture(raw, { now: NOW });
    expect(empty.user.home).toBe("/");
    expect(empty.listings["/"]).toEqual([]);
    expect(empty.warnings.length).toBeGreaterThan(0);
  });

  it("treats an empty object as an empty filesystem rooted at /", () => {
    const empty = convertDemoFixture({}, { now: NOW });
    expect(empty.user.home).toBe("/");
    expect(empty.listings["/"]).toEqual([]);
    expect(empty.trash).toEqual([]);
    expect(empty.repos).toEqual([]);
  });

  it("skips malformed nodes with warnings instead of failing", () => {
    const messy = convertDemoFixture({
      users: [{ id: "a", home: "relative/home" }, { id: "b", home: "/home/b" }],
      tree: { kids: [
        { name: "home", kids: [{ name: "b", kids: [
          null, { name: "" }, { name: "a/b" }, { name: ".." }, { name: "ok.txt", text: 5 },
          { name: "dup" }, { name: "dup" }, { name: "bad-date", date: "Feb 31 2026, 10:00" },
        ] }] },
      ] },
      trash: [{ from: "nowhere", node: { name: "x" } }, "junk"],
      repos: { "/not/a/folder": { commits: [] }, "relative": {} },
    }, { now: NOW });
    expect(messy.user.home).toBe("/home/b");
    const names = messy.listings["/home/b"].map((e) => e.name);
    expect(names).toContain("ok.txt");
    expect(names.filter((n) => n === "dup")).toHaveLength(1);
    expect(messy.warnings.some((w) => /dup/.test(w))).toBe(true);
    expect(names).not.toContain("a/b");
    expect(names).not.toContain("..");
    expect(messy.trash).toEqual([]);
    expect(messy.repos).toEqual([]);
    expect(messy.warnings.length).toBeGreaterThan(3);
  });

  it("truncates huge fixtures at the node budget and caps warnings", () => {
    const kids = Array.from({ length: 5000 }, (_, i) => ({ name: `f${i}.txt`, text: "x" }));
    const big = convertDemoFixture({ users: [{ id: "u", home: "/" }], tree: { kids } }, { now: NOW, maxNodes: 1000 });
    expect(big.listings["/"].length).toBeLessThanOrEqual(1000);
    expect(big.warnings.some((w) => /budget|truncat|node/i.test(w))).toBe(true);
    expect(big.warnings.length).toBeLessThanOrEqual(200);
  });

  it("stops at an absurd nesting depth", () => {
    let node: Record<string, unknown> = { name: "leaf.txt", text: "deep" };
    for (let i = 0; i < 200; i++) node = { name: `d${i}`, kids: [node] };
    const deep = convertDemoFixture({ users: [{ id: "u", home: "/" }], tree: { kids: [node] } }, { now: NOW });
    expect(Object.keys(deep.listings).length).toBeLessThan(100);
    expect(deep.warnings.some((w) => /depth|deep/i.test(w))).toBe(true);
  });
});

describe("out-of-range dates (review A)", () => {
  it.each([1e20, -5, Number.POSITIVE_INFINITY, 9e15, "99999999 years ago", "275760-09-14T00:00:00Z", "0999-01-01"])(
    "parseFixtureDate(%j) is null rather than an unrepresentable time", (value) => {
      expect(parseFixtureDate(value, NOW)).toBeNull();
    });

  it("never throws for unrepresentable dates on files, trash items or commits", () => {
    const world = convertDemoFixture({
      users: [{ id: "u", home: "/r" }],
      tree: { kids: [{ name: "r", date: "2026-10-01T00:00:00Z", kids: [
        { name: "far.txt", text: "x", date: 1e20 },
        { name: "ancient.txt", text: "x", date: "99999999 years ago" },
      ] }] },
      trash: [{ from: "/r", node: { name: "old.txt", text: "x" }, deleted: 9e15 }],
      repos: { "/r": { commits: [{ hash: "abc", msg: "x", date: 1e20, parents: [] }] } },
    }, { now: NOW });
    const times = [
      ...world.listings["/r"].map((e) => e.modified),
      world.trash[0].deletedAt,
    ].map((iso) => Date.parse(iso));
    expect(times.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(world.repos[0].commits[0].author_time)).toBe(true);
  });
});
