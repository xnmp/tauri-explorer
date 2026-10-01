import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frecencyStore } from "$lib/state/frecency.svelte";

const target = "/home/user/Work";
const other = "/home/user/Other";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); frecencyStore.clear(); });
afterEach(() => vi.useRealTimers());
function seed(path = target) { for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(3_600_000); frecencyStore.recordFileAction(`${path}/file.txt`); } }

it("dismissal hides the Recent row and strictly downvotes without erasing all history", () => {
  seed(); seed(other);
  const original = frecencyStore.getScore(target);
  const unaffected = frecencyStore.getScore(other);
  frecencyStore.dismissRecent(target);
  expect(frecencyStore.getScore(target)).toBeGreaterThan(0);
  expect(frecencyStore.getScore(target)).toBeLessThan(original);
  expect(frecencyStore.getScore(other)).toBe(unaffected);
  expect(frecencyStore.recentEntries.map(entry => entry.path)).toEqual([other]);
});
it("dismissal survives a new store loaded from persisted history", async () => {
  seed(); frecencyStore.dismissRecent(target);
  const reduced = frecencyStore.getScore(target);
  vi.resetModules();
  const reloaded = (await import("$lib/state/frecency.svelte")).frecencyStore;
  expect(reloaded.getScore(target)).toBe(reduced);
  expect(reloaded.recentEntries).toHaveLength(0);
  reloaded.recordFileAction(`${target}/new.txt`);
  expect(reloaded.getScore(target)).toBeGreaterThan(reduced);
  expect(reloaded.recentEntries.map(entry => entry.path)).toEqual([target]);
});
it("canonical Windows aliases share dismissal and qualifying-use recovery", () => {
  seed("C:/Users/Chong/Work");
  frecencyStore.dismissRecent("c:\\users\\chong\\work\\");
  expect(frecencyStore.recentEntries).toHaveLength(0);
  const reduced = frecencyStore.getScore("C:/Users/Chong/Work");
  frecencyStore.recordFileAction("C:\\Users\\CHONG\\Work\\again.txt");
  expect(frecencyStore.getScore("c:/users/chong/work")).toBeGreaterThan(reduced);
  expect(frecencyStore.recentEntries).toHaveLength(1);
});
it("repeated downvotes safely reach zero without changing another score", () => {
  seed(); seed(other);
  const unaffected = frecencyStore.getScore(other);
  const scores = [frecencyStore.getScore(target)];
  for (let i = 0; i < 5; i++) { frecencyStore.dismissRecent(target); scores.push(frecencyStore.getScore(target)); }
  expect(scores.every((score, index) => Number.isFinite(score) && score >= 0 && (index === 0 || score <= scores[index - 1]))).toBe(true);
  expect(scores.at(-1)).toBe(0);
  expect(frecencyStore.getScore(other)).toBe(unaffected);
});
it("single-access and unknown locations are safe and can return after new use", () => {
  frecencyStore.recordFileAction(`${target}/file.txt`);
  frecencyStore.dismissRecent(target);
  expect(frecencyStore.getScore(target)).toBe(0);
  frecencyStore.dismissRecent("/missing");
  expect(frecencyStore.recentEntries).toHaveLength(0);
  frecencyStore.recordFileAction(`${target}/again.txt`);
  expect(frecencyStore.recentEntries.map(entry => entry.path)).toEqual([target]);
});
