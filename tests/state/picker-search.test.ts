import { describe, it, expect, vi, afterEach } from "vitest";
import { createPickerSearch } from "$lib/state/picker-search";
import type { SearchResult } from "$lib/api/search";
const result = (name: string): SearchResult => ({ name, path: `/${name}`, relativePath: name, kind: "file", score: 1 });
afterEach(() => vi.useRealTimers());
describe("picker search lifecycle", () => {
  it("publishes local history immediately and walks only the final query", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (_query: string) => [result("remote")]);
    const publish = vi.fn();
    const controller = createPickerSearch({ local: (q, remote = []) => [result(q || "recent"), ...remote], search, publish });
    controller.update("");
    expect(publish).toHaveBeenLastCalledWith([result("recent")]);
    controller.update("n"); controller.update("nltk");
    expect(publish).toHaveBeenLastCalledWith([result("nltk")]);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(search.mock.calls.map(call => call[0])).toEqual(["nltk"]);
    expect(publish).toHaveBeenLastCalledWith([result("nltk"), result("remote")]);
    controller.cancel();
  });
  it("drops an older result during debounce and after closure", async () => {
    vi.useFakeTimers();
    let finish!: (results: SearchResult[]) => void;
    const publish = vi.fn();
    const controller = createPickerSearch({ local: q => [result(q)], search: () => new Promise(resolve => { finish = resolve; }), publish });
    controller.update("old"); await vi.advanceTimersByTimeAsync(150);
    controller.update("new"); finish([result("old")]); await Promise.resolve();
    expect(publish).toHaveBeenLastCalledWith([result("new")]);
    await vi.advanceTimersByTimeAsync(150);
    controller.cancel(); finish([result("late")]); await Promise.resolve();
    expect(publish).toHaveBeenLastCalledWith([result("new")]);
    controller.update("pending"); controller.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenLastCalledWith([result("pending")]);
  });
});
