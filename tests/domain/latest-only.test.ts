/**
 * Latest-only task runner (#1054): while one rendition decode runs, only the
 * newest waiting request runs next; skipped selections never start.
 */
import { describe, expect, it } from "vitest";
import { createLatestOnlyRunner, SKIPPED } from "$lib/domain/latest-only";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const wanted = () => true;

describe("createLatestOnlyRunner", () => {
  it("runs a task immediately when idle", async () => {
    const runner = createLatestOnlyRunner();
    expect(await runner.run(async () => "a", wanted)).toBe("a");
  });

  it("while one task runs, only the newest waiting task starts next", async () => {
    const runner = createLatestOnlyRunner();
    const started: string[] = [];
    const first = deferred<string>();
    const task = (name: string, result: Promise<string> = Promise.resolve(name)) => () => {
      started.push(name);
      return result;
    };

    const a = runner.run(task("a", first.promise), wanted);
    const b = runner.run(task("b"), wanted);
    const c = runner.run(task("c"), wanted);
    const d = runner.run(task("d"), wanted);
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe(SKIPPED);
    expect(await c).toBe(SKIPPED);
    expect(await d).toBe("d");
    expect(started).toEqual(["a", "d"]);
  });

  it("skips a waiting task that is no longer wanted when its turn comes", async () => {
    const runner = createLatestOnlyRunner();
    const first = deferred<string>();
    let stillWanted = true;
    let ran = false;

    void runner.run(() => first.promise, wanted);
    const next = runner.run(async () => { ran = true; return "late"; }, () => stillWanted);
    stillWanted = false;
    first.resolve("done");

    expect(await next).toBe(SKIPPED);
    expect(ran).toBe(false);
    // The runner is idle again afterwards.
    expect(await runner.run(async () => "again", wanted)).toBe("again");
  });

  it("does not start an unwanted task even when idle", async () => {
    const runner = createLatestOnlyRunner();
    let ran = false;
    expect(await runner.run(async () => { ran = true; }, () => false)).toBe(SKIPPED);
    expect(ran).toBe(false);
  });

  it("a failing task rejects its caller and lets the next task run", async () => {
    const runner = createLatestOnlyRunner();
    const failing = deferred<string>();
    const a = runner.run(() => failing.promise, wanted);
    const b = runner.run(async () => "b", wanted);
    failing.reject(new Error("decode failed"));

    await expect(a).rejects.toThrow("decode failed");
    expect(await b).toBe("b");
  });

  it("a task that throws synchronously rejects instead of wedging the runner", async () => {
    const runner = createLatestOnlyRunner();
    await expect(runner.run(() => { throw new Error("boom"); }, wanted)).rejects.toThrow("boom");
    expect(await runner.run(async () => "next", wanted)).toBe("next");
  });
});
