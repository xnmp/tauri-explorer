import { describe, it, expect } from "vitest";
import { rankPickerResults } from "$lib/domain/picker-search";
const now = 10_000_000;
const recent = [
  { name: "notes.md", path: "/docs/notes.md", kind: "file" as const, timestamp: now },
  { name: "photo.png", path: "/pics/photo.png", kind: "file" as const, timestamp: now - 3_600_000 },
];
const base = { query: "", recent, directories: [{ path: "/data/nltk_data" }], scores: new Map([["/data/nltk_data", 3]]), directoriesOnly: false, now };
describe("picker history ranking", () => {
  it("shows frequently used folders and recent files before a query", () => {
    expect(rankPickerResults(base).map(entry => entry.path)).toEqual(["/data/nltk_data", "/docs/notes.md", "/pics/photo.png"]);
  });
  it("matches history outside the search root and applies picker restrictions", () => {
    expect(rankPickerResults({ ...base, query: "nltk", directoriesOnly: true }).map(entry => entry.path)).toEqual(["/data/nltk_data"]);
    expect(rankPickerResults({ ...base, extensions: ["MD"] }).map(entry => entry.path)).toEqual(["/data/nltk_data", "/docs/notes.md"]);
    expect(rankPickerResults({ ...base, query: "missing" })).toEqual([]);
  });
  it("deduplicates local/backend matches without losing stronger ranking and caps rows", () => {
    const remote = Array.from({ length: 1000 }, (_, i) => ({ name: `notes-${i}.md`, path: `/docs/notes-${i}.md`, relativePath: "", kind: "file" as const, score: i }));
    remote.push({ ...remote[0], name: "notes.md", path: "/docs/notes.md", score: 9999 });
    const results = rankPickerResults({ ...base, query: "notes", remote });
    expect(results).toHaveLength(20);
    expect(results[0].path).toBe("/docs/notes.md");
    expect(new Set(results.map(entry => entry.path)).size).toBe(20);
  });
  it("ignores malformed persisted history and dismissed folders", () => {
    expect(rankPickerResults({ ...base, recent: [null] as any, directories: [{ path: "/data/nltk_data", dismissedFromRecent: true }] })).toEqual([]);
  });
});
